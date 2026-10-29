#include "guard-core.h"
#include <string.h>

size_t veil_ring_capacity(uint32_t delay_ms, uint32_t fps) {
  return ((uint64_t)delay_ms * fps + 999) / 1000 + 2;
}
size_t veil_ring_index(uint64_t frame, size_t capacity) {
  return capacity ? (size_t)(frame % capacity) : 0;
}
uint64_t veil_memory_bytes(uint32_t w, uint32_t h, uint32_t delay,
                           uint32_t fps) {
  return (uint64_t)w * h * 4 * veil_ring_capacity(delay, fps);
}
uint64_t veil_sample(struct veil_core *c, uint64_t frame, uint64_t first_time,
                     uint64_t delay) {
  uint64_t first = c->has_sample ? c->previous_sample + 1 : 0;
  c->has_sample = true;
  c->previous_sample = frame;
  if (c->pending_count == VEIL_MAX_PENDING) {
    memmove(c->pending, c->pending + 1,
            (--c->pending_count) * sizeof(c->pending[0]));
  }
  c->pending[c->pending_count++] =
      (struct veil_pending){first, frame, first_time + delay, false, false};
  return first;
}
void veil_result(struct veil_core *c, uint64_t frame, uint64_t last,
                 const struct veil_box *boxes, size_t count) {
  uint64_t first = 0;
  for (size_t i = 0; i < c->pending_count; i++) {
    if (c->pending[i].sampled == frame) {
      c->pending[i].answered = true;
      first = c->pending[i].first;
      if (!c->has_result || frame > c->confirmed_until)
        c->confirmed_until = frame;
      c->has_result = true;
    }
  }
  size_t kept = 0;
  for (size_t i = 0; i < c->mask_count; i++)
    if (c->masks[i].last >= first)
      c->masks[kept++] = c->masks[i];
  c->mask_count = kept;
  for (size_t i = 0; i < count && c->mask_count < VEIL_MAX_MASKS; i++)
    c->masks[c->mask_count++] = (struct veil_mask){first, last, boxes[i]};
}
bool veil_hold(struct veil_core *c, uint64_t frame, uint64_t now,
               enum veil_profile profile) {
  if (profile == VEIL_OFF)
    return false;
  bool pending = false;
  for (size_t i = 0; i < c->pending_count; i++) {
    struct veil_pending *p = &c->pending[i];
    if (!p->answered && frame >= p->first && frame <= p->sampled &&
        now >= p->deadline) {
      pending = true;
      if (!p->late_counted) {
        c->late_results++;
        p->late_counted = true;
      }
    }
  }
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
