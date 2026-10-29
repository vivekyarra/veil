#ifndef VEIL_GUARD_CORE_H
#define VEIL_GUARD_CORE_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#define VEIL_MAX_MASKS 256
#define VEIL_MAX_PENDING 128
#ifdef __cplusplus
extern "C" {
#endif
enum veil_profile { VEIL_OFF, VEIL_BALANCED, VEIL_PARANOID };
struct veil_box {
  float x, y, w, h;
};
struct veil_mask {
  uint64_t first, last;
  struct veil_box box;
};
struct veil_pending {
  uint64_t first, sampled, deadline;
  bool answered, late_counted;
};
struct veil_core {
  struct veil_mask masks[VEIL_MAX_MASKS];
  size_t mask_count;
  struct veil_pending pending[VEIL_MAX_PENDING];
  size_t pending_count;
  uint64_t previous_sample, late_results;
  bool has_sample;
};
size_t veil_ring_capacity(uint32_t delay_ms, uint32_t fps);
size_t veil_ring_index(uint64_t frame, size_t capacity);
uint64_t veil_sample(struct veil_core *core, uint64_t frame,
                     uint64_t first_time_ns, uint64_t delay_ns);
void veil_result(struct veil_core *core, uint64_t frame, uint64_t last,
                 const struct veil_box *boxes, size_t count);
bool veil_hold(struct veil_core *core, uint64_t output_frame, uint64_t now_ns,
               enum veil_profile profile);
size_t veil_lookup(const struct veil_core *core, uint64_t frame,
                   struct veil_box *out, size_t capacity);
uint64_t veil_memory_bytes(uint32_t width, uint32_t height, uint32_t delay_ms,
                           uint32_t fps);
#ifdef __cplusplus
}
#endif
#endif
