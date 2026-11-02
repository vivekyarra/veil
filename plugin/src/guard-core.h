#ifndef VEIL_GUARD_CORE_H
#define VEIL_GUARD_CORE_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#define VEIL_MAX_MASKS 1024
#define VEIL_MAX_PENDING 128
#ifdef __cplusplus
extern "C" {
#endif
enum veil_profile { VEIL_OFF, VEIL_BALANCED, VEIL_PARANOID };
enum veil_result_status {
  VEIL_RESULT_IGNORED, // no matching pending sample, or already answered
  VEIL_RESULT_OK,
  VEIL_RESULT_OVERFLOW // boxes did not fit; the interval is held instead
};
struct veil_box {
  float x, y, w, h;
};
struct veil_mask {
  uint64_t sample, first, last;
  struct veil_box box;
};
struct veil_pending {
  uint64_t first, sampled, deadline, hold_last;
  bool answered, late_counted, overflow;
};
struct veil_core {
  struct veil_mask masks[VEIL_MAX_MASKS];
  size_t mask_count;
  struct veil_pending pending[VEIL_MAX_PENDING];
  size_t pending_count;
  uint64_t previous_sample, late_results, confirmed_until;
  uint64_t lost_first, lost_last;
  bool has_sample, has_result, has_lost;
};
size_t veil_ring_capacity(uint32_t delay_ms, uint32_t fps);
size_t veil_ring_index(uint64_t frame, size_t capacity);
// Output frame rate rounded up, so 59.94 (60000/1001) buffers 60 frames/s.
uint32_t veil_fps(uint32_t fps_num, uint32_t fps_den);
// Registers a submitted sample. Returns the first frame its result covers.
uint64_t veil_sample(struct veil_core *core, uint64_t frame,
                     uint64_t first_time_ns, uint64_t delay_ns);
// Applies a detector result. Results may arrive in any order; they are
// matched to their pending sample by frame and never move confirmation back.
enum veil_result_status veil_result(struct veil_core *core, uint64_t frame,
                                    uint64_t last, const struct veil_box *boxes,
                                    size_t count);
bool veil_hold(struct veil_core *core, uint64_t output_frame, uint64_t now_ns,
               enum veil_profile profile);
size_t veil_lookup(const struct veil_core *core, uint64_t frame,
                   struct veil_box *out, size_t capacity);
// Drops masks and samples that only cover frames older than oldest_frame.
void veil_prune(struct veil_core *core, uint64_t oldest_frame);
// How a delayed frame is stored on the GPU. RGBA is the fallback when the
// YUV effect cannot be loaded; it always keeps alpha.
enum veil_frame_format {
  VEIL_FRAME_YUV420, // R8 luma + half-resolution R8G8 chroma, 12 bpp
  VEIL_FRAME_RGBA,   // one RGBA8 texture, 32 bpp
  VEIL_FRAME_YUVA420 // 4:2:0 plus a full-resolution R8 alpha plane, 20 bpp
};
// "Preserve transparency" property values.
enum veil_alpha_mode { VEIL_ALPHA_AUTO, VEIL_ALPHA_ON, VEIL_ALPHA_OFF };
// Whether delayed frames keep the source's alpha. Auto drops alpha only for
// screen captures that are always opaque: display, monitor and window
// captures, and game capture unless its "Allow transparency" is set. Any
// other source, or a target behind an earlier filter (a chroma key, an image
// mask) keeps alpha, since an opaque copy would turn its transparent areas
// into black boxes over the scene.
bool veil_keep_alpha(enum veil_alpha_mode mode, const char *source_id,
                     bool target_is_parent, bool allow_transparency);
// The 4:2:0 format for a source, or RGBA when the YUV effect is missing.
enum veil_frame_format veil_frame_format_for(bool have_yuv, bool keep_alpha);
uint64_t veil_frame_bytes(enum veil_frame_format format, uint32_t width,
                          uint32_t height);
uint64_t veil_memory_bytes(enum veil_frame_format format, uint32_t width,
                           uint32_t height, uint32_t delay_ms, uint32_t fps);
// Largest buffer size with the source aspect ratio whose ring fits in
// cap_bytes. Returns true when the buffer had to be downscaled.
bool veil_fit_buffer(enum veil_frame_format format, uint32_t width,
                     uint32_t height, uint32_t delay_ms, uint32_t fps,
                     uint64_t cap_bytes, uint32_t *out_width,
                     uint32_t *out_height);
// Reference for the shader math: one 8-bit BT.709 full-range round trip.
void veil_rgb_to_yuv709(const uint8_t rgb[3], uint8_t yuv[3]);
void veil_yuv709_to_rgb(const uint8_t yuv[3], uint8_t rgb[3]);
#ifdef __cplusplus
}
#endif
#endif
