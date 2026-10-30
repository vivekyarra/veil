#include "guard-core.h"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <assert.h>
#include <stdio.h>
#include <string.h>
int main(void) {
  assert(veil_ring_capacity(750, 60) == 47);
  assert(veil_memory_bytes(1920, 1080, 750, 60) <= 450ULL * 1024 * 1024);
  for (uint64_t f = 0; f < 100000; f++)
    assert(veil_ring_index(f, 47) == f % 47);
  struct veil_core c = {0};
  struct veil_box box = {.1f, .2f, .3f, .1f}, out[8];
  assert(veil_sample(&c, 0, 0, 750000000) == 0);
  veil_result(&c, 0, 90, NULL, 0);
  assert(veil_sample(&c, 15, 16666667, 750000000) == 1);
  assert(veil_hold(&c, 1, 766666666, VEIL_PARANOID));
  assert(veil_hold(&c, 1, 766666667, VEIL_PARANOID));
  assert(c.late_results == 1);
  assert(!veil_hold(&c, 1, 800000000, VEIL_BALANCED));
  assert(!veil_hold(&c, 1, 800000000, VEIL_OFF));
  veil_result(&c, 15, 105, &box, 1);
  assert(!veil_hold(&c, 1, 900000000, VEIL_PARANOID));
  assert(veil_hold(&c, 16, 900000000, VEIL_PARANOID));
  assert(veil_hold(&c, 1000, 900000000, VEIL_PARANOID));
  assert(!veil_hold(&c, 1000, 900000000, VEIL_BALANCED));
  // Busy capture ticks do not create phantom requests. The next submitted
  // sample covers the gap, while output stays held until its result arrives.
  struct veil_core busy = {0};
  veil_sample(&busy, 0, 0, 750000000);
  veil_result(&busy, 0, 90, NULL, 0);
  assert(veil_hold(&busy, 30, 1000000000, VEIL_PARANOID));
  assert(veil_sample(&busy, 60, 16666667, 750000000) == 1);
  veil_result(&busy, 60, 150, &box, 1);
  assert(!veil_hold(&busy, 30, 2000000000, VEIL_PARANOID));
  assert(veil_lookup(&busy, 30, out, 8) == 1);
  assert(veil_hold(&busy, 61, 2000000000, VEIL_PARANOID));
  struct veil_core disconnected = {0};
  assert(veil_hold(&disconnected, 0, 900000000, VEIL_PARANOID));
  assert(veil_lookup(&c, 0, out, 8) == 0);
  for (uint64_t f = 1; f <= 105; f++)
    assert(veil_lookup(&c, f, out, 8) == 1);
  assert(veil_lookup(&c, 106, out, 8) == 0);
  for (unsigned i = 16; i < 10000; i++) {
    veil_sample(&c, i, i * 1000, 750000000);
    veil_result(&c, i, i + 90, &box, 1);
  }
  assert(c.pending_count == VEIL_MAX_PENDING);
  puts("guard core: ring wrap, mask sampling gap, hold, late profiles and "
       "capacity passed");
  return 0;
}
