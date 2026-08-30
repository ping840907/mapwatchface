#include <pebble.h>

// ---------------------------------------------------------------------------
// Map Face
//
// A watchface that shows a Geoapify monochrome map (black background, grey
// road network) of the user's surroundings as the background, with the time
// and date rendered on top in a clean, designed overlay.
//
// The map image (PNG) is fetched and rendered on the phone side (PebbleKit JS)
// and streamed to the watch in chunks over AppMessage. This file is
// responsible for:
//   * Receiving configuration (colors, toggles) from Clay.
//   * Receiving the streamed PNG, reassembling it and decoding it.
//   * Drawing the map + a designed time/date overlay.
//   * Asking the phone for a refresh on a configurable interval (and on launch).
// ---------------------------------------------------------------------------

// Persistent storage keys
#define PERSIST_TIME_COLOR      100
#define PERSIST_DATE_COLOR      101
#define PERSIST_SHOW_DATE       103
#define PERSIST_SHOW_CENTER_DOT 104
#define PERSIST_UPDATE_INTERVAL 105
#define PERSIST_LOCATION_MODE   106  // 0 = follow current, 1 = fixed location
#define PERSIST_SHOW_STATUS     107
#define PERSIST_TIME_FONT       108  // -1 = auto (platform default)
#define PERSIST_DATE_FONT       109  // -1 = auto (platform default)

// Defaults
#define DEFAULT_TIME_COLOR      0xFFFFFF // white
#define DEFAULT_DATE_COLOR      0xAAAAAA // light grey
#define DEFAULT_SHOW_DATE       true
#define DEFAULT_SHOW_CENTER_DOT false
#define DEFAULT_UPDATE_INTERVAL 60       // minutes between location checks
#define DEFAULT_SHOW_STATUS     true
#define DEFAULT_TIME_FONT       (-1)     // -1 = auto: pick by screen size
#define DEFAULT_DATE_FONT       (-1)     // -1 = auto: pick by screen size

static Window *s_window;
static Layer *s_canvas_layer;     // draws bg + map + center dot
static Layer *s_overlay_layer;    // draws the time/date overlay

static GBitmap *s_map_bitmap = NULL;

// Incoming image stream buffer. Pre-allocated with fixed capacity to avoid
// dynamic malloc/free churn on the heap, which causes heap fragmentation.
#define IMG_BUFFER_CAPACITY 8192
static uint8_t s_img_buffer[IMG_BUFFER_CAPACITY];
static uint32_t s_img_size = 0;
static uint32_t s_img_received = 0;

// Bounded retry when a received image is incomplete/corrupt.
#define MAX_IMG_RETRIES 2
static int s_img_retries = 0;

// Config (kept in memory, mirrored in persistent storage)
static GColor s_time_color;
static GColor s_date_color;
static GColor s_bg_color;
static bool s_show_date = DEFAULT_SHOW_DATE;
static bool s_show_center_dot = DEFAULT_SHOW_CENTER_DOT;
static int s_update_interval = DEFAULT_UPDATE_INTERVAL; // minutes
static int s_minutes_since_update = 0;
static bool s_fixed_location = false; // no periodic refresh when fixed
static bool s_show_status = DEFAULT_SHOW_STATUS;
static int  s_time_font = DEFAULT_TIME_FONT;
static int  s_date_font = DEFAULT_DATE_FONT;

// Custom font caches (NULL when a system font is selected).
// Set by reload_custom_fonts(); freed in window_unload.
static bool  s_large_screen = false;
static GFont s_custom_time_font = NULL;
static GFont s_custom_date_font = NULL;

// Cached time strings
static char s_time_buf[8];
static char s_date_buf[24];

// Transient status / debug line shown at the bottom of the face.
static char s_status[40] = "";
static AppTimer *s_status_timer = NULL;

static void clear_status_cb(void *ctx) {
  s_status_timer = NULL;
  s_status[0] = '\0';
  if (s_overlay_layer) {
    layer_mark_dirty(s_overlay_layer);
  }
}

// Only the benign terminal "up to date" message auto-hides; errors and
// in-progress messages stay on screen.
static bool is_transient_status(const char *t) {
  return strcmp(t, "Map up to date") == 0;
}

static void set_status(const char *text) {
  strncpy(s_status, text, sizeof(s_status) - 1);
  s_status[sizeof(s_status) - 1] = '\0';

  // Auto-hide benign/progress messages after a few seconds so they don't
  // linger (e.g. "Map up to date"). Errors stay until the next status.
  if (s_status_timer) {
    app_timer_cancel(s_status_timer);
    s_status_timer = NULL;
  }
  if (s_status[0] != '\0' && is_transient_status(s_status)) {
    s_status_timer = app_timer_register(6000, clear_status_cb, NULL);
  }

  if (s_overlay_layer) {
    layer_mark_dirty(s_overlay_layer);
  }
}

// ---------------------------------------------------------------------------
// Custom font management
// ---------------------------------------------------------------------------

static void reload_custom_fonts(void) {
  // Time font
  if (s_custom_time_font) {
    fonts_unload_custom_font(s_custom_time_font);
    s_custom_time_font = NULL;
  }
  switch (s_time_font) {
    // 42px variants — available on all platforms
    case 10:
      s_custom_time_font = fonts_load_custom_font(resource_get_handle(RESOURCE_ID_FONT_BITCOUNT_REG_42));
      break;
    case 11:
      s_custom_time_font = fonts_load_custom_font(resource_get_handle(RESOURCE_ID_FONT_BITCOUNT_BOLD_42));
      break;
    case 12:
      s_custom_time_font = fonts_load_custom_font(resource_get_handle(RESOURCE_ID_FONT_JERSEY_60));
      break;
    // 60px/78px variants — intended for Emery/Gabbro; fall back to 42px on smaller screens
    case 13:
      s_custom_time_font = fonts_load_custom_font(resource_get_handle(
        s_large_screen ? RESOURCE_ID_FONT_BITCOUNT_REG_60 : RESOURCE_ID_FONT_BITCOUNT_REG_42));
      break;
    case 14:
      s_custom_time_font = fonts_load_custom_font(resource_get_handle(
        s_large_screen ? RESOURCE_ID_FONT_BITCOUNT_BOLD_60 : RESOURCE_ID_FONT_BITCOUNT_BOLD_42));
      break;
    case 15:
      s_custom_time_font = fonts_load_custom_font(resource_get_handle(
        s_large_screen ? RESOURCE_ID_FONT_JERSEY_78 : RESOURCE_ID_FONT_JERSEY_60));
      break;
    case 16:
      s_custom_time_font = fonts_load_custom_font(resource_get_handle(RESOURCE_ID_FONT_NORICAN_40));
      break;
    case 17:
      s_custom_time_font = fonts_load_custom_font(resource_get_handle(
        s_large_screen ? RESOURCE_ID_FONT_NORICAN_58 : RESOURCE_ID_FONT_NORICAN_40));
      break;
    default: break;
  }

  // Date font
  if (s_custom_date_font) {
    fonts_unload_custom_font(s_custom_date_font);
    s_custom_date_font = NULL;
  }
  switch (s_date_font) {
    case 11: s_custom_date_font = fonts_load_custom_font(resource_get_handle(RESOURCE_ID_FONT_BITCOUNT_REG_21)); break;
    case 12: s_custom_date_font = fonts_load_custom_font(resource_get_handle(RESOURCE_ID_FONT_JERSEY_21));        break;
    case 13: s_custom_date_font = fonts_load_custom_font(resource_get_handle(RESOURCE_ID_FONT_BITCOUNT_REG_28)); break;
    case 14: s_custom_date_font = fonts_load_custom_font(resource_get_handle(RESOURCE_ID_FONT_JERSEY_28));        break;
    case 15: s_custom_date_font = fonts_load_custom_font(resource_get_handle(RESOURCE_ID_FONT_NORICAN_16));       break;
    case 16: s_custom_date_font = fonts_load_custom_font(resource_get_handle(RESOURCE_ID_FONT_NORICAN_22));       break;
    default: break;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

static void send_update_request(uint8_t mode) {
  // mode 1 = normal (respect refresh distance), 2 = forced re-download.
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) == APP_MSG_OK) {
    dict_write_uint8(iter, MESSAGE_KEY_REQUEST_UPDATE, mode);
    app_message_outbox_send();
  }
}

static void update_time_strings(void) {
  time_t now = time(NULL);
  struct tm *t = localtime(&now);

  if (clock_is_24h_style()) {
    strftime(s_time_buf, sizeof(s_time_buf), "%H:%M", t);
  } else {
    strftime(s_time_buf, sizeof(s_time_buf), "%I:%M", t);
    // Strip a leading zero for 12h style (e.g. "09:30" -> "9:30")
    if (s_time_buf[0] == '0') {
      memmove(s_time_buf, s_time_buf + 1, strlen(s_time_buf));
    }
  }

  strftime(s_date_buf, sizeof(s_date_buf), "%a %d %b", t);
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

static void canvas_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);

  // Background fill (also acts as a fallback when no map is loaded yet).
  graphics_context_set_fill_color(ctx, s_bg_color);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);

  // The image is requested larger than the screen with the location at its
  // centre; drawing it centred keeps the location at the screen centre on every
  // platform and crops the extra margin (incl. the Geoapify attribution band).
  GPoint loc_point = grect_center_point(&bounds);
  if (s_map_bitmap) {
    GRect img = gbitmap_get_bounds(s_map_bitmap);
    GRect dest = GRect(bounds.origin.x + (bounds.size.w - img.size.w) / 2,
                       bounds.origin.y + (bounds.size.h - img.size.h) / 2,
                       img.size.w, img.size.h);
    graphics_context_set_compositing_mode(ctx, GCompOpAssign);
    graphics_draw_bitmap_in_rect(ctx, s_map_bitmap, dest);
  }

  // Dot marking the user's location (the map is centred there).
  if (s_show_center_dot) {
    GPoint center = loc_point;
    graphics_context_set_fill_color(ctx, GColorWhite);
    graphics_fill_circle(ctx, center, 4);
    graphics_context_set_fill_color(ctx, GColorRed);
    graphics_fill_circle(ctx, center, 3);
  }
}

// Draw text with a 1px drop shadow for legibility over any map content.
static void draw_text_with_shadow(GContext *ctx, const char *text, GFont font,
                                  GRect box, GColor color, GColor shadow,
                                  GTextAlignment align) {
  GRect shadow_box = box;
  shadow_box.origin.x += 1;
  shadow_box.origin.y += 1;
  graphics_context_set_text_color(ctx, shadow);
  graphics_draw_text(ctx, text, font, shadow_box,
                     GTextOverflowModeTrailingEllipsis, align, NULL);
  graphics_context_set_text_color(ctx, color);
  graphics_draw_text(ctx, text, font, box,
                     GTextOverflowModeTrailingEllipsis, align, NULL);
}

static void overlay_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  GColor shadow = GColorBlack;

  GFont time_font;
  GFont date_font;
  int time_h;
  int date_h;
  bool large = bounds.size.w >= 200;

  // Time font — cases 5/6 (LECO 60) are only available on emery/gabbro
  // (guarded by #ifdef); on smaller platforms they fall back to LECO 42.
  switch (s_time_font) {
    case 0:
      time_font = fonts_get_system_font(FONT_KEY_LECO_42_NUMBERS);
      time_h = 44;
      break;
    case 1:
      time_font = fonts_get_system_font(FONT_KEY_BITHAM_42_LIGHT);
      time_h = 44;
      break;
    case 2:
      time_font = fonts_get_system_font(FONT_KEY_BITHAM_42_MEDIUM_NUMBERS);
      time_h = 44;
      break;
    case 3:
      time_font = fonts_get_system_font(FONT_KEY_BITHAM_42_BOLD);
      time_h = 44;
      break;
    case 4:
      time_font = fonts_get_system_font(FONT_KEY_ROBOTO_BOLD_SUBSET_49);
      time_h = 52;
      break;
    case 7:
      time_font = fonts_get_system_font(FONT_KEY_BITHAM_34_MEDIUM_NUMBERS);
      time_h = 38;
      break;
    case 8:
      time_font = fonts_get_system_font(FONT_KEY_LECO_36_BOLD_NUMBERS);
      time_h = 40;
      break;
    case 9:
      time_font = fonts_get_system_font(FONT_KEY_LECO_38_BOLD_NUMBERS);
      time_h = 42;
      break;
    case 5:
#ifdef FONT_KEY_LECO_60_NUMBERS_AM_PM
      if (large) {
        time_font = fonts_get_system_font(FONT_KEY_LECO_60_NUMBERS_AM_PM);
        time_h = 64;
        break;
      }
#endif
      time_font = fonts_get_system_font(FONT_KEY_LECO_42_NUMBERS);
      time_h = 44;
      break;
    case 6:
#ifdef FONT_KEY_LECO_60_BOLD_NUMBERS_AM_PM
      if (large) {
        time_font = fonts_get_system_font(FONT_KEY_LECO_60_BOLD_NUMBERS_AM_PM);
        time_h = 64;
        break;
      }
#endif
      time_font = fonts_get_system_font(FONT_KEY_LECO_42_NUMBERS);
      time_h = 44;
      break;
    case 10: // Bitcount Regular 42
    case 11: // Bitcount Bold 42
      time_font = s_custom_time_font
          ? s_custom_time_font
          : fonts_get_system_font(FONT_KEY_LECO_42_NUMBERS);
      time_h = 44;
      break;
    case 12: // Jersey 25 · 60
      time_font = s_custom_time_font
          ? s_custom_time_font
          : fonts_get_system_font(FONT_KEY_LECO_42_NUMBERS);
      time_h = 64;
      break;
    case 13: // Bitcount Regular 60
    case 14: // Bitcount Bold 60
      time_font = s_custom_time_font
          ? s_custom_time_font
          : fonts_get_system_font(FONT_KEY_LECO_42_NUMBERS);
      time_h = 64;
      break;
    case 15: // Jersey 25 · 78
      time_font = s_custom_time_font
          ? s_custom_time_font
          : fonts_get_system_font(FONT_KEY_LECO_42_NUMBERS);
      time_h = 82;
      break;
    case 16: // Norican Regular · 40
      time_font = s_custom_time_font
          ? s_custom_time_font
          : fonts_get_system_font(FONT_KEY_LECO_42_NUMBERS);
      time_h = 44;
      break;
    case 17: // Norican Regular · 58
      time_font = s_custom_time_font
          ? s_custom_time_font
          : fonts_get_system_font(FONT_KEY_LECO_42_NUMBERS);
      time_h = 62;
      break;
    default: // -1 = auto: pick by screen size
#ifdef FONT_KEY_LECO_60_NUMBERS_AM_PM
      if (large) {
        time_font = fonts_get_system_font(FONT_KEY_LECO_60_NUMBERS_AM_PM);
        time_h = 64;
      } else
#endif
      {
        time_font = fonts_get_system_font(FONT_KEY_LECO_42_NUMBERS);
        time_h = 44;
      }
      break;
  }

  // Date font — all fonts below are available on every platform
  switch (s_date_font) {
    case 0:  date_font = fonts_get_system_font(FONT_KEY_GOTHIC_14);           date_h = 18; break;
    case 1:  date_font = fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD);      date_h = 18; break;
    case 2:  date_font = fonts_get_system_font(FONT_KEY_GOTHIC_18);           date_h = 22; break;
    case 3:  date_font = fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);      date_h = 22; break;
    case 4:  date_font = fonts_get_system_font(FONT_KEY_ROBOTO_CONDENSED_21); date_h = 26; break;
    case 5:  date_font = fonts_get_system_font(FONT_KEY_GOTHIC_24);           date_h = 28; break;
    case 6:  date_font = fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD);      date_h = 28; break;
    case 7:  date_font = fonts_get_system_font(FONT_KEY_GOTHIC_28);           date_h = 32; break;
    case 8:  date_font = fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD);      date_h = 32; break;
    case 9:  date_font = fonts_get_system_font(FONT_KEY_DROID_SERIF_28_BOLD); date_h = 32; break;
    case 10: date_font = fonts_get_system_font(FONT_KEY_BITHAM_30_BLACK);     date_h = 34; break;
    case 11: // Bitcount Regular · 21
    case 12: // Jersey 25 · 21
      date_font = s_custom_date_font ? s_custom_date_font : fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);
      date_h = 24;
      break;
    case 13: // Bitcount Regular · 28
    case 14: // Jersey 25 · 28
      date_font = s_custom_date_font ? s_custom_date_font : fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD);
      date_h = 32;
      break;
    case 15: // Norican Regular · 16
      date_font = s_custom_date_font ? s_custom_date_font : fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD);
      date_h = 20;
      break;
    case 16: // Norican Regular · 22
      date_font = s_custom_date_font ? s_custom_date_font : fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);
      date_h = 26;
      break;
    default: // -1 = auto: pick by screen size
      if (large) {
        date_font = fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD);
        date_h = 32;
      } else {
        date_font = fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);
        date_h = 22;
      }
      break;
  }
  int block_h = s_show_date ? (time_h + 6 + date_h) : time_h;
  int top = bounds.origin.y + (bounds.size.h - block_h) / 2;

  // Time
  GRect time_box = GRect(bounds.origin.x, top, bounds.size.w, time_h);
  draw_text_with_shadow(ctx, s_time_buf, time_font, time_box,
                        s_time_color, shadow, GTextAlignmentCenter);

  if (s_show_date) {
    // A short accent divider between time and date for a designed look. Wider
    // and thicker on the large-font platforms (emery / gabbro) to match.
    int divider_w = large ? 64 : 40;
    int thick = large ? 2 : 1;
    int divider_y = top + time_h + 2;
    int dx = bounds.origin.x + (bounds.size.w - divider_w) / 2;

    graphics_context_set_stroke_color(ctx, shadow);
    graphics_draw_line(ctx, GPoint(dx, divider_y + thick),
                       GPoint(dx + divider_w, divider_y + thick));
    graphics_context_set_stroke_color(ctx, s_date_color);
    for (int i = 0; i < thick; i++) {
      graphics_draw_line(ctx, GPoint(dx, divider_y + i),
                         GPoint(dx + divider_w, divider_y + i));
    }

    // Date
    GRect date_box = GRect(bounds.origin.x, divider_y + 4, bounds.size.w, date_h);
    draw_text_with_shadow(ctx, s_date_buf, date_font, date_box,
                          s_date_color, shadow, GTextAlignmentCenter);
  }

  // Status / debug line at the bottom (only when enabled and non-empty).
  if (s_show_status && s_status[0] != '\0') {
    GFont status_font = fonts_get_system_font(FONT_KEY_GOTHIC_14);
    GRect status_box = GRect(bounds.origin.x + 4,
                             bounds.origin.y + bounds.size.h - 22,
                             bounds.size.w - 8, 18);
    draw_text_with_shadow(ctx, s_status, status_font, status_box,
                          GColorYellow, shadow, GTextAlignmentCenter);
  }
}

// ---------------------------------------------------------------------------
// Image stream handling
// ---------------------------------------------------------------------------

static void reset_image_stream(void) {
  s_img_size = 0;
  s_img_received = 0;
}

static void finalize_image(void) {
  if (s_img_size == 0) {
    set_status("No buffer");
    return;
  }

  // Capture the first bytes for an error message before the buffer is reset.
  uint8_t b0 = s_img_size > 0 ? s_img_buffer[0] : 0;
  uint8_t b1 = s_img_size > 1 ? s_img_buffer[1] : 0;
  uint8_t b2 = s_img_size > 2 ? s_img_buffer[2] : 0;
  uint8_t b3 = s_img_size > 3 ? s_img_buffer[3] : 0;
  uint32_t recv = s_img_received, total = s_img_size;
  static char dbg[40];

  // Valid only if every byte arrived and the PNG signature is intact.
  bool ok = (recv >= total) && total >= 8 &&
            b0 == 0x89 && b1 == 0x50 && b2 == 0x4E && b3 == 0x47;

  APP_LOG(APP_LOG_LEVEL_INFO, "Finalizing img: recv=%lu total=%lu free_heap=%lu",
          (unsigned long)recv, (unsigned long)total, (unsigned long)heap_bytes_free());

  GBitmap *new_bitmap = NULL;
  if (ok) {
    // Free the previous map before decoding so we never hold two full-screen
    // bitmaps (plus decode buffers) at once.
    if (s_map_bitmap) {
      gbitmap_destroy(s_map_bitmap);
      s_map_bitmap = NULL;
    }
    new_bitmap = gbitmap_create_from_png_data(s_img_buffer, s_img_size);
    if (!(new_bitmap && gbitmap_get_bounds(new_bitmap).size.w > 0)) {
      if (new_bitmap) {
        gbitmap_destroy(new_bitmap);
        new_bitmap = NULL;
      }
      ok = false;
    }
  }
  reset_image_stream();

  if (ok) {
    s_map_bitmap = new_bitmap; // previous bitmap already freed above
    layer_mark_dirty(s_canvas_layer);
    set_status(""); // success: clear status for a clean face
    s_img_retries = 0;
    APP_LOG(APP_LOG_LEVEL_INFO, "Map loaded successfully. Free heap: %lu",
            (unsigned long)heap_bytes_free());
  } else if (s_img_retries < MAX_IMG_RETRIES) {
    // Incomplete/corrupt: ask the phone to re-download (forced) and try again.
    s_img_retries++;
    snprintf(dbg, sizeof(dbg), "Retrying %d/%d", s_img_retries, MAX_IMG_RETRIES);
    set_status(dbg);
    send_update_request(2);
  } else {
    snprintf(dbg, sizeof(dbg), "Load failed %02x%02x%02x%02x", b0, b1, b2, b3);
    set_status(dbg);
    s_img_retries = 0; // allow future updates to try again
  }
}

// ---------------------------------------------------------------------------
// Config handling
// ---------------------------------------------------------------------------

static void apply_config(DictionaryIterator *iter) {
  bool changed = false;
  bool fonts_changed = false;

  Tuple *t;

  t = dict_find(iter, MESSAGE_KEY_TIME_COLOR);
  if (t) {
    s_time_color = GColorFromHEX(t->value->int32);
    persist_write_int(PERSIST_TIME_COLOR, t->value->int32);
    changed = true;
  }
  t = dict_find(iter, MESSAGE_KEY_DATE_COLOR);
  if (t) {
    s_date_color = GColorFromHEX(t->value->int32);
    persist_write_int(PERSIST_DATE_COLOR, t->value->int32);
    changed = true;
  }
  t = dict_find(iter, MESSAGE_KEY_SHOW_DATE);
  if (t) {
    s_show_date = t->value->int32 != 0;
    persist_write_bool(PERSIST_SHOW_DATE, s_show_date);
    changed = true;
  }
  t = dict_find(iter, MESSAGE_KEY_SHOW_CENTER_DOT);
  if (t) {
    s_show_center_dot = t->value->int32 != 0;
    persist_write_bool(PERSIST_SHOW_CENTER_DOT, s_show_center_dot);
    changed = true;
  }
  t = dict_find(iter, MESSAGE_KEY_UPDATE_INTERVAL);
  if (t) {
    int interval = t->value->int32;
    if (interval < 1) { interval = 1; }
    s_update_interval = interval;
    persist_write_int(PERSIST_UPDATE_INTERVAL, s_update_interval);
    s_minutes_since_update = 0; // restart the cycle with the new interval
  }
  t = dict_find(iter, MESSAGE_KEY_LOCATION_MODE);
  if (t) {
    // Clay sends the select value as a string ("0"/"1"); be tolerant of int.
    int mode = (t->type == TUPLE_CSTRING) ? atoi(t->value->cstring)
                                          : t->value->int32;
    s_fixed_location = (mode == 1);
    persist_write_bool(PERSIST_LOCATION_MODE, s_fixed_location);
  }
  t = dict_find(iter, MESSAGE_KEY_SHOW_STATUS);
  if (t) {
    s_show_status = t->value->int32 != 0;
    persist_write_bool(PERSIST_SHOW_STATUS, s_show_status);
    changed = true;
  }
  t = dict_find(iter, MESSAGE_KEY_TIME_FONT);
  if (t) {
    int v = (t->type == TUPLE_CSTRING) ? atoi(t->value->cstring) : t->value->int32;
    s_time_font = v;
    persist_write_int(PERSIST_TIME_FONT, v);
    changed = true;
    fonts_changed = true;
  }
  t = dict_find(iter, MESSAGE_KEY_DATE_FONT);
  if (t) {
    int v = (t->type == TUPLE_CSTRING) ? atoi(t->value->cstring) : t->value->int32;
    s_date_font = v;
    persist_write_int(PERSIST_DATE_FONT, v);
    changed = true;
    fonts_changed = true;
  }
  if (fonts_changed) {
    reload_custom_fonts();
  }

  if (changed) {
    layer_mark_dirty(s_canvas_layer);
    layer_mark_dirty(s_overlay_layer);
  }
}

static void load_persisted_config(void) {
  s_time_color = GColorFromHEX(persist_exists(PERSIST_TIME_COLOR)
      ? persist_read_int(PERSIST_TIME_COLOR) : DEFAULT_TIME_COLOR);
  s_date_color = GColorFromHEX(persist_exists(PERSIST_DATE_COLOR)
      ? persist_read_int(PERSIST_DATE_COLOR) : DEFAULT_DATE_COLOR);
  s_bg_color = GColorBlack; // map fills the screen; this only shows before load
  s_show_date = persist_exists(PERSIST_SHOW_DATE)
      ? persist_read_bool(PERSIST_SHOW_DATE) : DEFAULT_SHOW_DATE;
  s_show_center_dot = persist_exists(PERSIST_SHOW_CENTER_DOT)
      ? persist_read_bool(PERSIST_SHOW_CENTER_DOT) : DEFAULT_SHOW_CENTER_DOT;
  s_update_interval = persist_exists(PERSIST_UPDATE_INTERVAL)
      ? persist_read_int(PERSIST_UPDATE_INTERVAL) : DEFAULT_UPDATE_INTERVAL;
  if (s_update_interval < 1) { s_update_interval = 1; }
  s_fixed_location = persist_exists(PERSIST_LOCATION_MODE)
      ? persist_read_bool(PERSIST_LOCATION_MODE) : false;
  s_show_status = persist_exists(PERSIST_SHOW_STATUS)
      ? persist_read_bool(PERSIST_SHOW_STATUS) : DEFAULT_SHOW_STATUS;
  s_time_font = persist_exists(PERSIST_TIME_FONT)
      ? persist_read_int(PERSIST_TIME_FONT) : DEFAULT_TIME_FONT;
  s_date_font = persist_exists(PERSIST_DATE_FONT)
      ? persist_read_int(PERSIST_DATE_FONT) : DEFAULT_DATE_FONT;
}

// ---------------------------------------------------------------------------
// AppMessage
// ---------------------------------------------------------------------------

static void inbox_received_handler(DictionaryIterator *iter, void *context) {
  // Image stream control: start a new transfer.
  Tuple *size_t = dict_find(iter, MESSAGE_KEY_IMG_SIZE);
  if (size_t) {
    reset_image_stream();
    s_img_size = size_t->value->uint32;
    if (s_img_size == 0 || s_img_size > IMG_BUFFER_CAPACITY) {
      APP_LOG(APP_LOG_LEVEL_ERROR, "Image size %lu exceeds capacity %d",
              (unsigned long)s_img_size, IMG_BUFFER_CAPACITY);
      s_img_size = 0; // buffer capacity exceeded; reject stream
      set_status("Img too large");
    } else {
      set_status("Loading map...");
    }
    return;
  }

  // Image stream control: a data chunk.
  Tuple *data_t = dict_find(iter, MESSAGE_KEY_IMG_DATA);
  Tuple *offset_t = dict_find(iter, MESSAGE_KEY_IMG_OFFSET);
  if (data_t && offset_t && s_img_size > 0) {
    uint32_t offset = offset_t->value->uint32;
    uint16_t len = data_t->length;
    if (offset + len <= s_img_size && offset + len <= IMG_BUFFER_CAPACITY) {
      memcpy(s_img_buffer + offset, data_t->value->data, len);
      s_img_received += len;
    }
    return;
  }

  // Image stream control: transfer complete.
  if (dict_find(iter, MESSAGE_KEY_IMG_COMPLETE)) {
    finalize_image();
    return;
  }

  // Status / debug line pushed from the phone.
  Tuple *status_t = dict_find(iter, MESSAGE_KEY_STATUS);
  if (status_t && status_t->length > 0) {
    set_status(status_t->value->cstring);
    return;
  }

  // Otherwise treat the message as a config update from Clay.
  apply_config(iter);
}

static void inbox_dropped_handler(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_WARNING, "Inbox dropped: %d", (int)reason);
}

// ---------------------------------------------------------------------------
// Ticks
// ---------------------------------------------------------------------------

static void tick_handler(struct tm *tick_time, TimeUnits units_changed) {
  update_time_strings();
  layer_mark_dirty(s_overlay_layer);

  // In fixed-location mode there is nothing to re-check, so skip the periodic
  // refresh entirely. Otherwise ask the phone for a location/map check every
  // configured interval (the phone still only re-downloads when moved beyond
  // the refresh distance).
  if (!s_fixed_location) {
    s_minutes_since_update++;
    if (s_minutes_since_update >= s_update_interval) {
      s_minutes_since_update = 0;
      send_update_request(1);
    }
  }
}

// ---------------------------------------------------------------------------
// Window lifecycle
// ---------------------------------------------------------------------------

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  s_large_screen = (bounds.size.w >= 200);

  s_canvas_layer = layer_create(bounds);
  layer_set_update_proc(s_canvas_layer, canvas_update_proc);
  layer_add_child(root, s_canvas_layer);

  s_overlay_layer = layer_create(bounds);
  layer_set_update_proc(s_overlay_layer, overlay_update_proc);
  layer_add_child(root, s_overlay_layer);

  reload_custom_fonts(); // load any custom font saved in persist storage
  update_time_strings();
}

static void window_unload(Window *window) {
  if (s_custom_time_font) {
    fonts_unload_custom_font(s_custom_time_font);
    s_custom_time_font = NULL;
  }
  if (s_custom_date_font) {
    fonts_unload_custom_font(s_custom_date_font);
    s_custom_date_font = NULL;
  }
  layer_destroy(s_canvas_layer);
  layer_destroy(s_overlay_layer);
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

static void init(void) {
  load_persisted_config();

  s_window = window_create();
  window_set_background_color(s_window, GColorBlack);
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = window_load,
    .unload = window_unload,
  });
  window_stack_push(s_window, true);

  app_message_register_inbox_received(inbox_received_handler);
  app_message_register_inbox_dropped(inbox_dropped_handler);
  // Large inbox to fit ~1KB image chunks; small outbox for control messages.
  app_message_open(2048, 256);

  tick_timer_service_subscribe(MINUTE_UNIT, tick_handler);
}

static void deinit(void) {
  tick_timer_service_unsubscribe();
  if (s_map_bitmap) {
    gbitmap_destroy(s_map_bitmap);
  }
  reset_image_stream();
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
  return 0;
}
