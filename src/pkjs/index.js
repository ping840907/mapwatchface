// PebbleKit JS for Map Face.
//
// Responsibilities:
//   * Host the Clay configuration page.
//   * Resolve the user's location (prioritising fast WiFi / cell-tower
//     positioning, with a Geoapify IP fallback).
//   * Decide on each check whether the map needs re-downloading (only when the
//     user has moved farther than the configured refresh distance; fixed mode
//     doesn't auto-refresh).
//   * Download the Geoapify monochrome static map (PNG) and stream it to the
//     watch in chunks over AppMessage.

var Clay = require('@rebble/clay');
var clayConfig = require('./config');
var customClay = require('./custom-clay');
var clay = new Clay(clayConfig, customClay, { autoHandleEvents: false });

// UPNG (with pako) lets us decode Geoapify's 24-bit truecolor PNG and
// re-encode it as a palettized indexed PNG, which is the only kind Pebble's
// gbitmap_create_from_png_data() can decode.
var UPNG = require('upng-js');

// Extra margin (px per side) requested around the screen so the watch can
// centre-crop the image, removing the Geoapify attribution band on the bottom
// edge while keeping the location centred. Must exceed the band height.
// Small (144×168) platforms need a larger margin because at that resolution
// Geoapify renders a proportionally taller attribution band.
var ATTR_CROP       = 60;   // 180×180 and larger
var ATTR_CROP_SMALL = 100;  // 144×168 (aplite / basalt / diorite / flint)

// Default map palette (a monochrome ramp matching the classic dark look).
var DEFAULT_MAP_COLORS = [0x000000, 0x555555, 0xAAAAAA, 0xFFFFFF];

// Clay's getSettings() writes a clean, name-keyed, flattened copy of the
// settings here (e.g. { API_KEY: "...", ZOOM: 15 }). The dict it *returns* is
// keyed by numeric message-key IDs for sendAppMessage, so we must read our
// own settings from this localStorage entry, not from that dict.
var CLAY_SETTINGS_KEY = 'clay-settings';
var SRC_META_KEY = 'mapface-srcmeta';   // {lat, lon, sig} of the cached source
var SRC_BYTES_KEY = 'mapface-src';      // cached Geoapify source PNG (bin string)
var CHUNK_SIZE = 1000; // bytes of image data per AppMessage

// Which settings, when changed, require what:
//   SOURCE  - the Geoapify image itself differs -> must refetch from the API
//   RECOLOR - only the on-watch colours differ -> reuse cached source, no API
// Anything else (time/date colour, toggles, interval, distance) is watch-only
// or gating-only: just push config, no fetch and no re-stream.
var SOURCE_KEYS = ['API_KEY', 'LOCATION_MODE', 'FIXED_LAT', 'FIXED_LON',
                   'ZOOM', 'MAP_STYLE', 'SHOW_LABELS'];
var RECOLOR_KEYS = ['MAP_COLOR_BG', 'MAP_COLOR_1', 'MAP_COLOR_2', 'MAP_COLOR_3',
                    'MAP_TONE_BG', 'MAP_TONE_1', 'MAP_TONE_2', 'MAP_TONE_3'];

var sending = false;        // a map transfer is in progress
var pendingUpdate = false;  // an update was requested while sending
var pendingForce = false;
var pendingStream = false;
var sendingWatchdog = null;  // clears `sending` if an update ever gets stuck

// ---------------------------------------------------------------------------
// Serialised AppMessage sender.
//
// PebbleKit JS / AppMessage only handles one outbound message at a time;
// overlapping sends collide and corrupt the data (seen as a flipped byte in
// the streamed PNG). Every outbound message - status, config and image chunks
// alike - goes through this single queue so only one is ever in flight.
// ---------------------------------------------------------------------------
var outQueue = [];
var outBusy = false;

function enqueueSend(dict, onAck, onNack) {
  outQueue.push({ dict: dict, onAck: onAck, onNack: onNack });
  pumpQueue();
}

function pumpQueue() {
  if (outBusy || outQueue.length === 0) { return; }
  outBusy = true;
  var item = outQueue.shift();
  Pebble.sendAppMessage(item.dict, function () {
    outBusy = false;
    if (item.onAck) { item.onAck(); }
    pumpQueue();
  }, function (e) {
    outBusy = false;
    if (item.onNack) { item.onNack(e); }
    pumpQueue();
  });
}

// Start an update now, or queue it if a transfer is in progress (so a request
// arriving mid-transfer isn't lost).
function requestUpdate(force, stream) {
  if (sending) {
    pendingUpdate = true;
    pendingForce = pendingForce || force;
    pendingStream = pendingStream || stream;
  } else {
    performUpdate(force, stream);
  }
}

// Mark the current transfer finished and run any queued update.
function finishSending() {
  if (sendingWatchdog) { clearTimeout(sendingWatchdog); sendingWatchdog = null; }
  sending = false;
  if (pendingUpdate) {
    pendingUpdate = false;
    var f = pendingForce, s = pendingStream;
    pendingForce = false;
    pendingStream = false;
    performUpdate(f, s);
  }
}

// Per-platform target image size. Unknown/new platforms fall back to the most
// common Pebble screen size.
var PLATFORM_SIZES = {
  aplite:  { w: 144, h: 168 },
  basalt:  { w: 144, h: 168 },
  diorite: { w: 144, h: 168 },
  chalk:   { w: 180, h: 180 },
  emery:   { w: 200, h: 228 },
  flint:   { w: 144, h: 168 },
  gabbro:  { w: 260, h: 260 } // round screen
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function defaultSettings() {
  return {
    API_KEY: '',
    LOCATION_MODE: '0',
    FIXED_LAT: '',
    FIXED_LON: '',
    UPDATE_DISTANCE: 500,
    ZOOM: 15,
    SHOW_LABELS: 1,
    MAP_STYLE: 'dark-matter',
    MAP_COLOR_BG: DEFAULT_MAP_COLORS[0],
    MAP_COLOR_1: DEFAULT_MAP_COLORS[1],
    MAP_COLOR_2: DEFAULT_MAP_COLORS[2],
    MAP_COLOR_3: DEFAULT_MAP_COLORS[3],
    // B&W tones: 0=black 1=white 2=dither 3=diagonal lines
    MAP_TONE_BG: '0',
    MAP_TONE_1: '3',
    MAP_TONE_2: '2',
    MAP_TONE_3: '1'
  };
}

function loadSettings() {
  var base = defaultSettings();
  try {
    var raw = localStorage.getItem(CLAY_SETTINGS_KEY);
    if (raw) {
      var parsed = JSON.parse(raw);
      for (var k in parsed) {
        if (parsed.hasOwnProperty(k) && parsed[k] !== null &&
            parsed[k] !== undefined) {
          base[k] = parsed[k];
        }
      }
    }
  } catch (e) {
    console.log('Failed to load settings: ' + e);
  }
  return base;
}

function getPlatform() {
  try {
    var info = Pebble.getActiveWatchInfo && Pebble.getActiveWatchInfo();
    if (info && info.platform) { return info.platform; }
  } catch (e) { /* not available */ }
  return 'basalt';
}

function getPlatformScreenSize(platform) {
  var s = PLATFORM_SIZES[platform] || { w: 144, h: 168 };
  return { w: s.w, h: s.h };
}

function getPlatformSize(platform) {
  var s = PLATFORM_SIZES[platform] || { w: 144, h: 168 };
  var crop = (s.h <= 168) ? ATTR_CROP_SMALL : ATTR_CROP;
  return { w: s.w, h: s.h + 2 * crop };
}

// Black & white platforms have no colour: render the four levels as black,
// white, or one of two 50%-grey patterns (fine checker dither / diagonal
// lines) instead.
function isBwPlatform(platform) {
  return platform === 'aplite' || platform === 'diorite' ||
         platform === 'flint';
}

// Build the 4-entry [r,g,b] palette from the user's map colour settings.
function getMapPalette(settings) {
  var keys = ['MAP_COLOR_BG', 'MAP_COLOR_1', 'MAP_COLOR_2', 'MAP_COLOR_3'];
  return keys.map(function (k, i) {
    var v = settings[k];
    if (typeof v !== 'number') { v = DEFAULT_MAP_COLORS[i]; }
    return { r: (v >> 16) & 0xFF, g: (v >> 8) & 0xFF, b: v & 0xFF };
  });
}

// Build the 4-entry tone codes (0=black 1=white 2=dither 3=lines) for B&W.
function getMapTones(settings) {
  var keys = ['MAP_TONE_BG', 'MAP_TONE_1', 'MAP_TONE_2', 'MAP_TONE_3'];
  return keys.map(function (k) {
    var v = parseInt(settings[k], 10);
    return (v >= 0 && v <= 3) ? v : 0;
  });
}

// The black/white value (0 or 255) for a tone code at pixel (x, y).
function toneValue(code, x, y) {
  switch (code) {
    case 1: return 255;                                  // white
    case 2: return ((x + y) & 1) ? 255 : 0;              // 50% checker dither
    case 3: return (((x + y) & 3) < 2) ? 255 : 0;        // diagonal lines
    default: return 0;                                   // black
  }
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

// Resolve the location to use. In "follow" mode we prioritise the phone's
// network (WiFi / cell-tower) positioning by disabling high accuracy, which
// is fast and battery friendly; if that fails we fall back to Geoapify's IP
// geolocation.
function resolveLocation(settings, cb) {
  if (String(settings.LOCATION_MODE) === '1') {
    var lat = parseFloat(settings.FIXED_LAT);
    var lon = parseFloat(settings.FIXED_LON);
    if (isFinite(lat) && isFinite(lon)) {
      cb(null, { lat: lat, lon: lon });
    } else {
      cb('Invalid fixed location', null);
    }
    return;
  }

  navigator.geolocation.getCurrentPosition(
    function (pos) {
      cb(null, { lat: pos.coords.latitude, lon: pos.coords.longitude });
    },
    function (err) {
      console.log('geolocation failed (' + err.code + '): ' + err.message +
                  ' - falling back to Geoapify IP geolocation');
      ipFallback(settings, cb);
    },
    {
      enableHighAccuracy: false,   // prefer WiFi / cell-tower positioning
      timeout: 15000,
      maximumAge: 30 * 60 * 1000   // accept a position up to 30 min old
    }
  );
}

function ipFallback(settings, cb) {
  if (!settings.API_KEY) { cb('No API key for IP fallback', null); return; }
  var url = 'https://api.geoapify.com/v1/ipinfo?apiKey=' +
            encodeURIComponent(settings.API_KEY);
  var xhr = new XMLHttpRequest();
  xhr.open('GET', url, true);
  xhr.onload = function () {
    if (xhr.status !== 200) { cb('IP geolocation HTTP ' + xhr.status, null); return; }
    try {
      var data = JSON.parse(xhr.responseText);
      var loc = data.location || {};
      var lat = loc.latitude !== undefined ? loc.latitude : (data.latitude);
      var lon = loc.longitude !== undefined ? loc.longitude : (data.longitude);
      if (isFinite(lat) && isFinite(lon)) {
        cb(null, { lat: lat, lon: lon });
      } else {
        cb('IP geolocation returned no coordinates', null);
      }
    } catch (e) {
      cb('IP geolocation parse error: ' + e, null);
    }
  };
  xhr.onerror = function () { cb('IP geolocation network error', null); };
  xhr.ontimeout = function () { cb('IP geolocation timeout', null); };
  xhr.timeout = 15000;
  xhr.send();
}

// Great-circle distance in metres.
function haversine(lat1, lon1, lat2, lon2) {
  var R = 6371000;
  var toRad = Math.PI / 180;
  var dLat = (lat2 - lat1) * toRad;
  var dLon = (lon2 - lon1) * toRad;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
          Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------
// Map URL
// ---------------------------------------------------------------------------

// Canonical colors we force Geoapify to render each semantic layer group as, so
// the phone can bucket pixels into 4 levels deterministically (by maximum RGB channel).
// These are NOT the final colours - the watch shows the user's
// palette; these are just well-separated markers per layer group.
var COLOR_LAND  = '#000000'; // level 0 (black)
var COLOR_WATER = '#ff0000'; // level 1 (red)
var COLOR_ROAD  = '#00ff00'; // level 2 (green)
var COLOR_LABEL = '#0000ff'; // level 3 (blue)

// Fallback recolour (array of {layer,color}) for the canonical dark-matter
// layer ids, used if the style JSON can't be fetched.
function styleCustomFallback(showLabels) {
  // Casings + simple single-line roads get the road color; the black "inner"
  // lines are hidden (see buildStyleCustomization).
  var roadColor = ['highway_motorway_casing', 'highway_motorway_subtle',
    'highway_major_casing', 'highway_major_subtle', 'highway_minor',
    'highway_path', 'railway', 'railway_minor', 'railway_transit'];
  var roadHide = ['highway_motorway_inner', 'highway_major_inner'];
  var list = [
    { layer: 'background', color: COLOR_LAND },
    { layer: 'water', color: COLOR_WATER },
    { layer: 'waterway', color: COLOR_WATER }
  ];
  roadColor.forEach(function (r) { list.push({ layer: r, color: COLOR_ROAD }); });
  roadHide.forEach(function (r) { list.push({ layer: r, color: 'none' }); });
  var labels = ['highway_name_other', 'highway_name_motorway', 'water_name',
    'place_country_major', 'place_country_minor', 'place_country_other',
    'place_state', 'place_city', 'place_town', 'place_village', 'place_suburb',
    'place_other'];
  labels.forEach(function (l) {
    list.push({ layer: l, color: showLabels ? COLOR_LABEL : 'none' });
  });
  return list;
}

// Build the styleCustomization (array of {layer,color}) that paints each layer
// group as one of the four canonical colors (and hides labels when names are
// off). Driven by the style's own layer list so it works for any layer ids.
function buildStyleCustomization(layers, showLabels) {
  var out = [];
  (layers || []).forEach(function (layer) {
    var id = layer.id;
    if (!id) { return; }
    var type = layer.type;
    var sl = (layer['source-layer'] || '') + ' ' + id;
    var isWater = /water|ocean|river|waterway|lake|sea|bay|strait/i.test(sl);
    var isBoundary = /boundary|admin|border/i.test(sl);

    if (type === 'symbol') {
      out.push({ layer: id, color: showLabels ? COLOR_LABEL : 'none' });
    } else if (type === 'background') {
      out.push({ layer: id, color: COLOR_LAND });
    } else if (isWater) {
      out.push({ layer: id, color: COLOR_WATER });
    } else if (type === 'line') {
      // Major roads are a wide "casing" line under a narrower "inner" line. In
      // dark-matter the inner is BLACK (a zoom-stops expression that
      // styleCustomization cannot recolour), which punches a hole and makes the
      // road look hollow. So hide the inner lines and colour the casing (and
      // simple single-line roads) the road color -> a solid road surface.
      if (/casing/i.test(id)) {
        out.push({ layer: id, color: COLOR_ROAD });
      } else if (/inner/i.test(id)) {
        out.push({ layer: id, color: 'none' });
      } else if (isBoundary) {
        out.push({ layer: id, color: COLOR_LAND });
      } else {
        out.push({ layer: id, color: COLOR_ROAD });
      }
    }
    // Non-water fills (land, landuse, buildings) keep the dark style default,
    // which reads as the darkest level (background).
  });
  return out;
}

// Resolve the full styleCustomization for the chosen style. The style JSON is
// fetched once and cached (as JSON) per style+labels.
function resolveStyleCustomization(settings, cb) {
  var showLabels = !!settings.SHOW_LABELS;
  var style = settings.MAP_STYLE || 'dark-matter';
  // The "v" version invalidates caches when the customization logic changes.
  var cacheKey = 'stylecust:v6:' + style + ':' + (showLabels ? 1 : 0);
  var cached = localStorage.getItem(cacheKey);
  if (cached !== null) {
    try { cb(JSON.parse(cached)); return; } catch (e) { /* refetch */ }
  }

  var styleUrl = 'https://maps.geoapify.com/v1/styles/' +
    encodeURIComponent(style) + '/style.json?apiKey=' +
    encodeURIComponent(settings.API_KEY);

  var done = false;
  var finish = function (custom) {
    if (done) { return; }
    done = true;
    try { localStorage.setItem(cacheKey, JSON.stringify(custom)); } catch (e) {}
    cb(custom);
  };

  var xhr = new XMLHttpRequest();
  xhr.open('GET', styleUrl, true);
  xhr.timeout = 15000;
  xhr.onload = function () {
    var custom = styleCustomFallback(showLabels);
    try {
      var styleJson = JSON.parse(xhr.responseText);
      var built = buildStyleCustomization(styleJson.layers, showLabels);
      if (built.length) { custom = built; }
    } catch (e) {
      console.log('style.json parse failed: ' + e);
    }
    finish(custom);
  };
  xhr.onerror = function () {
    console.log('style.json fetch failed; using fallback customization');
    finish(styleCustomFallback(showLabels));
  };
  xhr.ontimeout = function () {
    console.log('style.json fetch timed out; using fallback customization');
    finish(styleCustomFallback(showLabels));
  };
  xhr.send();
}

// ---------------------------------------------------------------------------
// Decide whether a refresh is needed
// ---------------------------------------------------------------------------

// Signature of the parameters that change the Geoapify SOURCE image.
function fetchSignature(settings, size) {
  return ['v3', settings.LOCATION_MODE, settings.MAP_STYLE, settings.ZOOM,
          settings.SHOW_LABELS ? 1 : 0, size.w, size.h].join('|');
}

// ---- Phone-side source cache (avoids re-calling Geoapify) -----------------
// We cache the raw Geoapify PNG so launches and colour changes can be served
// by re-colouring the cached source instead of hitting the API again.

function bytesToBinStr(u8) {
  var CHUNK = 0x8000, parts = [];
  for (var i = 0; i < u8.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK)));
  }
  return parts.join('');
}

function binStrToBytes(str) {
  var u8 = new Uint8Array(str.length);
  for (var i = 0; i < str.length; i++) { u8[i] = str.charCodeAt(i) & 0xFF; }
  return u8;
}

function clearSource() {
  try {
    localStorage.removeItem(SRC_BYTES_KEY);
    localStorage.removeItem(SRC_META_KEY);
  } catch (e) {}
}

function saveSource(u8, settings, loc, size) {
  try {
    localStorage.setItem(SRC_BYTES_KEY, bytesToBinStr(u8));
    localStorage.setItem(SRC_META_KEY, JSON.stringify({
      lat: loc.lat, lon: loc.lon, sig: fetchSignature(settings, size)
    }));
  } catch (e) {
    console.log('Source cache failed: ' + e);
    clearSource(); // don't leave meta without bytes
  }
}

function loadSourceBytes() {
  var s = localStorage.getItem(SRC_BYTES_KEY);
  return s === null ? null : binStrToBytes(s);
}

// True when the cached source still matches the wanted params and location, so
// no new Geoapify call is needed.
function sourceValid(settings, loc, size) {
  if (localStorage.getItem(SRC_BYTES_KEY) === null) { return false; }
  var m = null;
  try { m = JSON.parse(localStorage.getItem(SRC_META_KEY)); } catch (e) {}
  if (!m || m.sig !== fetchSignature(settings, size)) { return false; }
  if (String(settings.LOCATION_MODE) === '1') {
    return m.lat === loc.lat && m.lon === loc.lon;
  }
  return haversine(m.lat, m.lon, loc.lat, loc.lon) <=
         (settings.UPDATE_DISTANCE || 500);
}

// Did any of the given keys change between the previous and current settings?
function anyChanged(keys, oldS, newS) {
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (String(oldS[k]) !== String(newS[k])) { return true; }
  }
  return false;
}

// ---------------------------------------------------------------------------
// PNG conversion: reduce the Geoapify map to 4 brightness levels and render
// each level either with the user's palette colour (colour platforms) or as a
// black/white tone pattern (B&W platforms). Re-encoded losslessly (cnum 0) so
// the exact palette survives; a B&W image is just black + white -> 1-bit PNG.
// `render` = { bw: bool, palette: [{r,g,b}x4], tones: [code x4] }.
// ---------------------------------------------------------------------------

function buildMapImage(arrayBuffer, render) {
  var decoded = UPNG.decode(arrayBuffer);          // parse the Geoapify PNG
  var w = decoded.width, h = decoded.height;

  // Determine target cropped screen dimensions.
  // If targetSize is provided, crop the image centered so the watch receives
  // an exact screen-sized PNG without the Geoapify attribution margins.
  var targetW = (render && render.targetSize) ? Math.min(render.targetSize.w, w) : w;
  var targetH = (render && render.targetSize) ? Math.min(render.targetSize.h, h) : h;
  var cropX = Math.floor((w - targetW) / 2);
  var cropY = Math.floor((h - targetH) / 2);

  console.log('Geoapify returned ' + w + 'x' + h + ', cropping to ' + targetW + 'x' + targetH +
              (render.bw ? ' (b&w)' : ''));

  var srcPx = new Uint8Array(UPNG.toRGBA8(decoded)[0]); // first frame, RGBA bytes
  var dstPx = new Uint8Array(targetW * targetH * 4);

  for (var y = 0; y < targetH; y++) {
    var srcRow = ((cropY + y) * w + cropX) * 4;
    var dstRow = y * targetW * 4;
    for (var x = 0; x < targetW; x++) {
      var sIdx = srcRow + (x * 4);
      var dIdx = dstRow + (x * 4);

      // Geoapify rendered each layer group as pure red, green, blue or black.
      // Categorize the pixel based on its dominant channel.
      var r = srcPx[sIdx], g = srcPx[sIdx + 1], b = srcPx[sIdx + 2];
      var level = 0; // default to background (black)

      var max = Math.max(r, g, b);
      var min = Math.min(r, g, b);

      // Filter out very dark anti-aliasing artifacts from being classified as a color
      if (max >= 43) {
        if (max - min < 20) {
          // Pixel is greyscale (like anti-aliased label halos against background or other bright artifacts)
          if (max > 128) {
            level = 3; // bright greyscale -> labels
          } else {
            level = 0; // dark greyscale -> background
          }
        } else if (b === max) {
          level = 3; // labels (blue)
        } else if (g === max) {
          level = 2; // roads (green)
        } else if (r === max) {
          level = 1; // water (red)
        }
      }

      if (render.bw) {
        var v = toneValue(render.tones[level], x, y);
        dstPx[dIdx] = v; dstPx[dIdx + 1] = v; dstPx[dIdx + 2] = v;
      } else {
        var c = render.palette[level];
        dstPx[dIdx] = c.r; dstPx[dIdx + 1] = c.g; dstPx[dIdx + 2] = c.b;
      }
      dstPx[dIdx + 3] = 255;
    }
  }

  return new Uint8Array(UPNG.encode([dstPx.buffer], targetW, targetH, 0));
}

// ---------------------------------------------------------------------------
// Image download + streaming
// ---------------------------------------------------------------------------

// Re-colour an already-fetched source PNG and stream it to the watch. No API.
function streamRecolored(arrayBuffer, render) {
  var bytes;
  try {
    bytes = buildMapImage(arrayBuffer, render);
  } catch (e) {
    console.log('Recolour failed: ' + e);
    sendStatus('Convert fail');
    finishSending();
    return;
  }
  console.log('Indexed PNG: ' + bytes.length + ' bytes');
  streamImage(bytes, function (ok) {
    if (!ok) { sendStatus('Transfer failed'); }
    finishSending();
  });
}

function fetchSourceAndSend(settings, loc, size, styleCustomization, render) {
  // POST request: the per-layer recolour customization is large, so it goes in
  // a JSON body (no URL-length limit, which truncated the GET version and made
  // roads hollow / dropped labels).
  var url = 'https://maps.geoapify.com/v1/staticmap?apiKey=' +
    encodeURIComponent(settings.API_KEY);
  var body = {
    style: settings.MAP_STYLE || 'dark-matter',
    width: size.w,
    height: size.h,
    center: { lat: loc.lat, lon: loc.lon },
    zoom: settings.ZOOM || 15,
    format: 'png',
    scaleFactor: 1,
    styleCustomization: styleCustomization
  };
  console.log('Requesting map (POST) ' + size.w + 'x' + size.h +
              ', ' + styleCustomization.length + ' layer overrides');

  var xhr = new XMLHttpRequest();
  xhr.open('POST', url, true);
  xhr.responseType = 'arraybuffer';
  xhr.timeout = 30000;
  xhr.setRequestHeader('Content-Type', 'application/json');

  xhr.onload = function () {
    var len = 0;
    try { len = xhr.response ? new Uint8Array(xhr.response).byteLength : 0; }
    catch (e) { len = -1; }

    // Some JS runtimes (notably CloudPebble / pypkjs) honour the HTTP status
    // but return null for responseType='arraybuffer' due to a limitation in
    // the Python↔V8 bridge. The body is still available as a binary string
    // in responseText, so fall back to that and rebuild an ArrayBuffer.
    var responseBuffer = xhr.response;
    if (len <= 0 && xhr.responseText && xhr.responseText.length > 0) {
      var text = xhr.responseText;
      var u8 = new Uint8Array(text.length);
      for (var i = 0; i < text.length; i++) { u8[i] = text.charCodeAt(i) & 0xFF; }
      responseBuffer = u8.buffer;
      len = u8.byteLength;
      console.log('arraybuffer fallback via responseText: ' + len + ' bytes');
    }

    console.log('Map response: HTTP ' + xhr.status + ', ' + len + ' bytes');

    if (xhr.status !== 200) {
      sendStatus('HTTP ' + xhr.status);
      finishSending();
      return;
    }
    if (len <= 0) {
      sendStatus('Empty body n=' + len);
      finishSending();
      return;
    }

    // Cache the raw source so future launches / colour changes can reuse it
    // without another API call, then recolour and stream it.
    var src = new Uint8Array(responseBuffer);
    saveSource(src, settings, loc, size);
    streamRecolored(responseBuffer, render);
  };
  xhr.onerror = function () {
    console.log('Map request network error (status ' + xhr.status + ')');
    sendStatus('Net err s=' + xhr.status);
    finishSending();
  };
  xhr.ontimeout = function () {
    console.log('Map request timed out');
    sendStatus('Map timeout');
    finishSending();
  };

  try {
    xhr.send(JSON.stringify(body));
  } catch (e) {
    console.log('xhr.send threw: ' + e);
    sendStatus('Send threw');
    finishSending();
  }
}

function streamImage(bytes, done) {
  var size = bytes.length;

  // Enqueue the whole transfer; the serialised queue sends one message at a
  // time, in order, so chunks never overlap each other or other traffic.
  enqueueSend({ 'IMG_SIZE': size });
  for (var offset = 0; offset < size; offset += CHUNK_SIZE) {
    var end = Math.min(offset + CHUNK_SIZE, size);
    var chunk = Array.prototype.slice.call(bytes.subarray(offset, end));
    enqueueSend({ 'IMG_OFFSET': offset, 'IMG_DATA': chunk });
  }
  enqueueSend({ 'IMG_COMPLETE': 1 }, function () {
    console.log('Image transfer complete');
    done(true);
  }, function () {
    console.log('Image transfer failed to complete');
    done(false);
  });
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

// force       - force a Geoapify refetch (source-affecting change / API key).
// streamCache - if no fetch is needed, still re-stream the cached source
//               (used on launch and recolour changes so the watch gets an
//               image without an API call). If false and nothing changed, do
//               nothing (the watch keeps showing its current map).
function performUpdate(force, streamCache) {
  if (sending) { return; }
  var settings = loadSettings();

  if (!settings.API_KEY) {
    sendStatus('Set API key');
    return;
  }

  // Claim the transfer slot up-front (not inside the async callback) so a
  // second trigger can't start an overlapping transfer. A watchdog clears it
  // if anything (e.g. geolocation or a request) never calls back, so periodic
  // updates can't be blocked forever by one stuck attempt.
  sending = true;
  if (sendingWatchdog) { clearTimeout(sendingWatchdog); }
  sendingWatchdog = setTimeout(function () {
    if (sending) { console.log('Update watchdog: clearing stuck transfer'); finishSending(); }
  }, 45000);

  var platform = getPlatform();
  var size = getPlatformSize(platform);
  var screenSize = getPlatformScreenSize(platform);
  var render = {
    bw: isBwPlatform(platform),
    palette: getMapPalette(settings),
    tones: getMapTones(settings),
    targetSize: screenSize
  };
  console.log('Platform ' + platform + ', map ' + size.w + 'x' + size.h +
              ' (target ' + screenSize.w + 'x' + screenSize.h + ')' +
              (render.bw ? ' (b&w)' : ''));
  sendStatus('Locating...');
  resolveLocation(settings, function (err, loc) {
    if (err) { sendStatus('No location'); finishSending(); return; }

    var needFetch = force || !sourceValid(settings, loc, size);
    if (needFetch) {
      resolveStyleCustomization(settings, function (styleCustomization) {
        fetchSourceAndSend(settings, loc, size, styleCustomization, render);
      });
      return;
    }
    if (streamCache) {
      // Reuse the cached source — recolour and stream, no Geoapify call.
      var u8 = loadSourceBytes();
      if (u8) {
        console.log('Reusing cached map source (no API call)');
        streamRecolored(u8.buffer, render);
      } else {
        // Cache vanished unexpectedly; fetch as a fallback.
        resolveStyleCustomization(settings, function (styleCustomization) {
          fetchSourceAndSend(settings, loc, size, styleCustomization, render);
        });
      }
      return;
    }
    sendStatus('Map up to date');
    finishSending();
  });
}

// Push a short status/debug line to the watch face (via the serialised queue).
function sendStatus(text) {
  console.log('Status: ' + text);
  enqueueSend({ 'STATUS': text });
}

function sendConfigToWatch(dict, onDone) {
  enqueueSend(dict, function () {
    console.log('Config sent to watch');
    if (onDone) { onDone(); }
  }, function () {
    console.log('Failed to send config to watch');
    if (onDone) { onDone(); } // proceed regardless
  });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

Pebble.addEventListener('ready', function () {
  console.log('Map Face JS ready');
  // On launch the watch has no map: stream one, reusing the cached source (no
  // API call) unless it's missing/stale.
  requestUpdate(false, true);
});

Pebble.addEventListener('showConfiguration', function () {
  Pebble.openURL(clay.generateUrl());
});

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) {
    // Config page closed without submitting (e.g. cancelled / back).
    sendStatus('Cfg: no response');
    return;
  }

  // Snapshot the previous settings BEFORE getSettings overwrites clay-settings,
  // so we can diff message-key values to decide what (if anything) to refetch.
  var oldS = loadSettings();

  var dict;
  try {
    // getSettings also writes the clean, name-keyed copy to clay-settings.
    dict = clay.getSettings(e.response); // numeric-keyed dict for AppMessage
  } catch (err) {
    console.log('getSettings error: ' + err);
    sendStatus('Cfg parse err');
    return;
  }

  var newS = loadSettings();
  var keyLen = newS.API_KEY ? String(newS.API_KEY).length : 0;
  var sourceChanged = anyChanged(SOURCE_KEYS, oldS, newS);
  var recolorChanged = anyChanged(RECOLOR_KEYS, oldS, newS);
  console.log('Config saved: sourceChanged=' + sourceChanged +
              ', recolorChanged=' + recolorChanged);

  // Send the config first, and only start any transfer once it has been acked
  // (concurrent config + image streams corrupt the image).
  sendConfigToWatch(dict, function () {
    if (!keyLen) {
      sendStatus('Cfg: key empty');
      return;
    }
    if (sourceChanged) {
      requestUpdate(true, true);   // map image differs -> refetch
    } else if (recolorChanged) {
      requestUpdate(false, true);  // colours only -> recolour cached, no API
    }
    // Otherwise only watch-side / gating settings changed: nothing to fetch.
  });
});

Pebble.addEventListener('appmessage', function (e) {
  if (e.payload && e.payload.REQUEST_UPDATE !== undefined) {
    // mode 1 = periodic check (fetch only if moved beyond the refresh distance)
    // mode 2 = watch hit a corrupt transfer (re-stream from the cached source)
    requestUpdate(false, e.payload.REQUEST_UPDATE === 2);
  }
});
