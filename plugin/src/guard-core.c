#include "guard-core.h"
#include <string.h>

size_t veil_ring_capacity(uint32_t delay_ms, uint32_t fps) {
  return ((uint64_t)delay_ms * fps + 999) / 1000 + 2;
}
size_t veil_ring_index(uint64_t frame, size_t capacity) {
  return capacity ? (size_t)(frame % capacity) : 0;
}
uint32_t veil_fps(uint32_t num, uint32_t den) {
  if (!num || !den)
    return 60;
  uint32_t fps = (uint32_t)(((uint64_t)num + den - 1) / den);
  return fps ? fps : 1;
}
// Sizes are 32-bit, so w * h fits in 64 bits but a further multiply may not:
// saturate instead of wrapping, so an absurd size can never fit a cap.
static uint64_t mul_sat(uint64_t a, uint64_t b) {
  return a && b > UINT64_MAX / a ? UINT64_MAX : a * b;
}
static uint64_t add_sat(uint64_t a, uint64_t b) {
  return b > UINT64_MAX - a ? UINT64_MAX : a + b;
}
uint64_t veil_frame_bytes(enum veil_frame_format format, uint32_t w,
                          uint32_t h) {
  uint64_t pixels = (uint64_t)w * h;
  if (format == VEIL_FRAME_RGBA)
    return mul_sat(pixels, 4);
  // Full-resolution R8 luma plus an R8G8 chroma plane rounded up to cover
  // odd sizes: 12 bits per pixel, plus 8 for a full-resolution R8 alpha plane.
  uint64_t chroma = mul_sat(((uint64_t)w + 1) / 2 * (((uint64_t)h + 1) / 2), 2);
  uint64_t yuv = add_sat(pixels, chroma);
  return format == VEIL_FRAME_YUVA420 ? add_sat(yuv, pixels) : yuv;
}
bool veil_keep_alpha(enum veil_alpha_mode mode, const char *id,
                     bool target_is_parent, bool allow_transparency) {
  if (mode != VEIL_ALPHA_AUTO)
    return mode == VEIL_ALPHA_ON;
  if (!target_is_parent || !id)
    return true;
  if (strcmp(id, "game_capture") == 0)
    return allow_transparency;
  static const char *const opaque[] = {
      "monitor_capture",
      "window_capture",
      "display_capture",
      "screen_capture",
      "xshm_input",
      "xcomposite_input",
      "pipewire-desktop-capture-source",
      "pipewire-window-capture-source",
      "pipewire-screen-capture-source",
  };
  for (size_t i = 0; i < sizeof(opaque) / sizeof(opaque[0]); i++)
    if (strcmp(id, opaque[i]) == 0)
      return false;
  return true;
}
enum veil_frame_format veil_frame_format_for(bool have_yuv, bool keep_alpha) {
  if (!have_yuv)
    return VEIL_FRAME_RGBA;
  return keep_alpha ? VEIL_FRAME_YUVA420 : VEIL_FRAME_YUV420;
}
uint64_t veil_memory_bytes(enum veil_frame_format format, uint32_t w,
                           uint32_t h, uint32_t delay, uint32_t fps) {
  return mul_sat(veil_frame_bytes(format, w, h),
                 veil_ring_capacity(delay, fps));
}
static uint32_t scaled_height(uint32_t w, uint32_t h, uint32_t bw) {
  uint32_t bh = (uint32_t)((uint64_t)h * bw / w) & ~1u;
  return bh < 2 ? 2 : bh;
}
bool veil_fit_buffer(enum veil_frame_format format, uint32_t w, uint32_t h,
                     uint32_t delay, uint32_t fps, uint64_t cap, uint32_t *ow,
                     uint32_t *oh) {
  *ow = w;
  *oh = h;
  if (!w || !h || veil_memory_bytes(format, w, h, delay, fps) <= cap)
    return false;
  // Last resort: binary search for the widest even width that fits.
  uint32_t lo = 2, hi = w;
  while (lo < hi) {
    uint32_t mid = (uint32_t)(((uint64_t)lo + hi + 1) / 2);
    if (veil_memory_bytes(format, mid, scaled_height(w, h, mid), delay, fps) <=
        cap)
      lo = mid;
    else
      hi = mid - 1;
  }
  *ow = lo & ~1u ? lo & ~1u : 2;
  *oh = scaled_height(w, h, *ow);
  return true;
}
// BT.709 full range, the same constants as data/veil-yuv.effect.
static uint8_t quantize(float v) {
  return v <= 0 ? 0 : v >= 1 ? 255 : (uint8_t)(v * 255.0f + 0.5f);
}
void veil_rgb_to_yuv709(const uint8_t rgb[3], uint8_t yuv[3]) {
  float r = rgb[0] / 255.0f, g = rgb[1] / 255.0f, b = rgb[2] / 255.0f;
  float y = 0.2126f * r + 0.7152f * g + 0.0722f * b;
  yuv[0] = quantize(y);
  yuv[1] = quantize((b - y) / 1.8556f + 0.5f);
  yuv[2] = quantize((r - y) / 1.5748f + 0.5f);
}
void veil_yuv709_to_rgb(const uint8_t yuv[3], uint8_t rgb[3]) {
  float y = yuv[0] / 255.0f, cb = yuv[1] / 255.0f - 0.5f,
        cr = yuv[2] / 255.0f - 0.5f;
  rgb[0] = quantize(y + 1.5748f * cr);
  rgb[1] = quantize(y - 0.187324f * cb - 0.468124f * cr);
  rgb[2] = quantize(y + 1.8556f * cb);
}
static struct veil_pending *find_sampled(struct veil_core *c, uint64_t frame) {
  for (size_t i = 0; i < c->pending_count; i++)
    if (c->pending[i].sampled == frame)
      return &c->pending[i];
  return NULL;
}
static struct veil_pending *find_first(struct veil_core *c, uint64_t frame) {
  for (size_t i = 0; i < c->pending_count; i++)
    if (c->pending[i].first == frame)
      return &c->pending[i];
  return NULL;
}
static void remove_pending(struct veil_core *c, size_t i) {
  struct veil_pending *p = &c->pending[i];
  if (!p->answered || p->overflow) {
    // A sample that still protects frames stays fail-closed when forgotten.
    uint64_t end = p->hold_last > p->sampled ? p->hold_last : p->sampled;
    if (!c->has_lost || p->first < c->lost_first)
      c->lost_first = p->first;
    if (!c->has_lost || end > c->lost_last)
      c->lost_last = end;
    c->has_lost = true;
  }
  memmove(c->pending + i, c->pending + i + 1,
          (c->pending_count - i - 1) * sizeof(c->pending[0]));
  c->pending_count--;
}
uint64_t veil_sample(struct veil_core *c, uint64_t frame, uint64_t first_time,
                     uint64_t delay) {
  uint64_t first = c->has_sample ? c->previous_sample + 1 : 0;
  c->has_sample = true;
  c->previous_sample = frame;
  if (c->pending_count == VEIL_MAX_PENDING) {
    size_t evict = 0;
    for (size_t i = 0; i < c->pending_count; i++)
      if (c->pending[i].answered && !c->pending[i].overflow) {
        evict = i;
        break;
      }
    remove_pending(c, evict);
  }
  c->pending[c->pending_count++] = (struct veil_pending){
      first, frame, first_time + delay, frame, false, false, false};
  return first;
}
enum veil_result_status veil_result(struct veil_core *c, uint64_t frame,
                                    uint64_t last, const struct veil_box *boxes,
                                    size_t count) {
  struct veil_pending *p = find_sampled(c, frame);
  if (!p || p->answered)
    return VEIL_RESULT_IGNORED;
  p->answered = true;
  if (!c->has_result || frame > c->confirmed_until)
    c->confirmed_until = frame;
  c->has_result = true;
  if (last < frame)
    last = frame;
  // Frames between two samples get the union of both samples' boxes. Extend
  // this sample through the next submitted one (it may already be answered
  // when results arrive out of order) ...
  struct veil_pending *next = find_first(c, frame + 1);
  if (next && next->sampled > last)
    last = next->sampled;
  // ... and extend the previous sample's masks and holds through this one.
  if (p->first > 0) {
    uint64_t previous = p->first - 1;
    for (size_t i = 0; i < c->mask_count; i++)
      if (c->masks[i].sample == previous && c->masks[i].last < frame)
        c->masks[i].last = frame;
    struct veil_pending *before = find_sampled(c, previous);
    if (before && before->overflow && before->hold_last < frame)
      before->hold_last = frame;
  }
  if (count > VEIL_MAX_MASKS - c->mask_count) {
    // Never confirm boxes we cannot draw: cover the whole interval instead.
    p->overflow = true;
    p->hold_last = last;
    return VEIL_RESULT_OVERFLOW;
  }
  for (size_t i = 0; i < count; i++)
    c->masks[c->mask_count++] =
        (struct veil_mask){frame, p->first, last, boxes[i]};
  return VEIL_RESULT_OK;
}
void veil_prune(struct veil_core *c, uint64_t oldest) {
  size_t kept = 0;
  for (size_t i = 0; i < c->mask_count; i++)
    if (c->masks[i].last >= oldest)
      c->masks[kept++] = c->masks[i];
  c->mask_count = kept;
  for (size_t i = c->pending_count; i-- > 0;) {
    struct veil_pending *p = &c->pending[i];
    uint64_t end = p->hold_last > p->sampled ? p->hold_last : p->sampled;
    if (end < oldest) {
      p->answered = true; // its frames have left the ring; nothing to protect
      p->overflow = false;
      remove_pending(c, i);
    }
  }
  if (c->has_lost && c->lost_last < oldest)
    c->has_lost = false;
}
bool veil_hold(struct veil_core *c, uint64_t frame, uint64_t now,
               enum veil_profile profile) {
  if (profile == VEIL_OFF)
    return false;
  bool pending = false, overflow = false;
  for (size_t i = 0; i < c->pending_count; i++) {
    struct veil_pending *p = &c->pending[i];
    if (p->overflow && frame >= p->first && frame <= p->hold_last)
      overflow = true;
    if (!p->answered && frame >= p->first && frame <= p->sampled) {
      // Unanswered frames are unknown even if a newer result (out of order)
      // already confirmed later frames. The deadline only decides lateness.
      pending = true;
      if (now >= p->deadline && !p->late_counted) {
        c->late_results++;
        p->late_counted = true;
      }
    }
  }
  if (c->has_lost && frame >= c->lost_first && frame <= c->lost_last)
    pending = true;
  // Detected boxes that could not be stored are covered in every profile.
  if (overflow)
    return true;
  // Busy workers cannot register every sample. Unknown output must remain
  // covered even after the last pending sample's bounded frame interval.
  return profile == VEIL_PARANOID &&
         (pending || !c->has_result || frame > c->confirmed_until);
}
size_t veil_lookup(const struct veil_core *c, uint64_t frame,
                   struct veil_box *out, size_t capacity) {
  size_t n = 0;
  for (size_t i = 0; i < c->mask_count && n < capacity; i++)
    if (frame >= c->masks[i].first && frame <= c->masks[i].last)
      out[n++] = c->masks[i].box;
  return n;
}
