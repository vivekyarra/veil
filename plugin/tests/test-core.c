#include "guard-core.h"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <assert.h>
#include <stdio.h>
#include <string.h>
int main(void) {
  assert(veil_ring_capacity(750, 60) == 47);
  assert(veil_memory_bytes(VEIL_FRAME_RGBA, 1920, 1080, 750, 60) <=
         450ULL * 1024 * 1024);
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
    assert(veil_result(&c, i, i + 90, &box, 1) == VEIL_RESULT_OK);
    veil_prune(&c, i > 400 ? i - 400 : 0);
  }
  assert(c.pending_count <= VEIL_MAX_PENDING && !c.has_lost);
  assert(c.mask_count < VEIL_MAX_MASKS);

  // Frame rate rounds up: 59.94 buffers 60 frames per second.
  assert(veil_fps(60000, 1001) == 60 && veil_fps(30000, 1001) == 30);
  assert(veil_fps(60, 1) == 60 && veil_fps(0, 0) == 60);
  // Frame sizes: 4:2:0 is 12 bits per pixel; odd sizes round chroma up.
  assert(veil_frame_bytes(VEIL_FRAME_RGBA, 1920, 1080) == 1920 * 1080 * 4);
  assert(veil_frame_bytes(VEIL_FRAME_YUV420, 1920, 1080) ==
         1920 * 1080 * 3 / 2);
  assert(veil_frame_bytes(VEIL_FRAME_YUV420, 3, 3) == 9 + 2 * 2 * 2);
  assert(veil_frame_bytes(VEIL_FRAME_YUV420, 1, 1) == 1 + 2);
  const uint64_t mib = 1024 * 1024;
  // 152 frames at 2.5 s and 60 fps.
  assert(veil_memory_bytes(VEIL_FRAME_YUV420, 1920, 1080, 2500, 60) ==
         3110400ULL * 152);
  // Buffer fitting at the 640 MiB default cap: 1080p60 at 2.5 s stays at full
  // resolution in 4:2:0, while the same ring in RGBA would be downscaled.
  uint32_t bw = 0, bh = 0;
  const uint64_t cap = 640 * mib;
  assert(
      !veil_fit_buffer(VEIL_FRAME_YUV420, 1920, 1080, 2500, 60, cap, &bw, &bh));
  assert(bw == 1920 && bh == 1080);
  assert(
      !veil_fit_buffer(VEIL_FRAME_YUV420, 1920, 1080, 6000, 30, cap, &bw, &bh));
  assert(!veil_fit_buffer(VEIL_FRAME_RGBA, 1280, 720, 750, 60, cap, &bw, &bh));
  assert(bw == 1280 && bh == 720);
  assert(veil_fit_buffer(VEIL_FRAME_RGBA, 1920, 1080, 2500, 60, cap, &bw, &bh));
  assert(bw < 1920 && bw > 1000 && bh * 16 / 9 <= bw + 2);
  assert(veil_memory_bytes(VEIL_FRAME_RGBA, bw, bh, 2500, 60) <= cap);
  assert(veil_memory_bytes(VEIL_FRAME_RGBA, bw + 2, bh + 2, 2500, 60) > cap);
  // Larger sources downscale only as a last resort, to even sizes that fit.
  const uint32_t big[][3] = {{2560, 1440, 60}, {3840, 2160, 30}};
  for (size_t i = 0; i < 2; i++) {
    assert(veil_fit_buffer(VEIL_FRAME_YUV420, big[i][0], big[i][1], 2500,
                           big[i][2], cap, &bw, &bh));
    assert(bw % 2 == 0 && bh % 2 == 0 && bw > big[i][0] * 3 / 4);
    assert(veil_memory_bytes(VEIL_FRAME_YUV420, bw, bh, 2500, big[i][2]) <=
           cap);
    assert(veil_memory_bytes(VEIL_FRAME_YUV420, bw + 2, bh + 2, 2500,
                             big[i][2]) > cap);
    assert(!veil_fit_buffer(VEIL_FRAME_YUV420, big[i][0], big[i][1], 2500,
                            big[i][2], 1024 * mib, &bw, &bh));
  }
  // Keeping transparency adds a full-resolution R8 alpha plane: 20 bpp.
  assert(veil_frame_bytes(VEIL_FRAME_YUVA420, 1920, 1080) ==
         1920 * 1080 * 5 / 2);
  assert(veil_frame_bytes(VEIL_FRAME_YUVA420, 3, 3) == 9 + 2 * 2 * 2 + 9);
  assert(veil_frame_bytes(VEIL_FRAME_YUVA420, 2, 2) * 8 / 4 == 20);
  assert(veil_frame_bytes(VEIL_FRAME_YUV420, 2, 2) * 8 / 4 == 12);
  assert(veil_memory_bytes(VEIL_FRAME_YUVA420, 1920, 1080, 2500, 60) ==
         5184000ULL * 152);
  // 1080p60 with alpha (751 MiB) no longer fits the 640 MiB default cap: it
  // is downscaled to the largest even size that fits, and fits at 768 MiB.
  assert(
      veil_fit_buffer(VEIL_FRAME_YUVA420, 1920, 1080, 2500, 60, cap, &bw, &bh));
  assert(bw % 2 == 0 && bh % 2 == 0 && bw > 1700 && bw < 1920);
  assert(veil_memory_bytes(VEIL_FRAME_YUVA420, bw, bh, 2500, 60) <= cap);
  assert(veil_memory_bytes(VEIL_FRAME_YUVA420, bw + 2, bh + 2, 2500, 60) > cap);
  assert(!veil_fit_buffer(VEIL_FRAME_YUVA420, 1920, 1080, 2500, 60, 768 * mib,
                          &bw, &bh));
  assert(bw == 1920 && bh == 1080);
  // 1080p30 with alpha at the default delay fits the default cap.
  assert(!veil_fit_buffer(VEIL_FRAME_YUVA420, 1920, 1080, 2500, 30, cap, &bw,
                          &bh));
  // Transparency: explicit modes win; Auto drops alpha only for screen
  // captures filtered directly, and keeps it behind an earlier filter.
  assert(veil_keep_alpha(VEIL_ALPHA_ON, "monitor_capture", true, false));
  assert(!veil_keep_alpha(VEIL_ALPHA_OFF, "browser_source", true, false));
  const char *keep[] = {"browser_source", "image_source", "ffmpeg_source",
                        "dshow_input",    "scene",        "color_source_v3"};
  for (size_t i = 0; i < sizeof(keep) / sizeof(keep[0]); i++)
    assert(veil_keep_alpha(VEIL_ALPHA_AUTO, keep[i], true, false));
  const char *opaque[] = {"monitor_capture", "window_capture",
                          "display_capture", "screen_capture", "xshm_input"};
  for (size_t i = 0; i < sizeof(opaque) / sizeof(opaque[0]); i++) {
    assert(!veil_keep_alpha(VEIL_ALPHA_AUTO, opaque[i], true, false));
    assert(veil_keep_alpha(VEIL_ALPHA_AUTO, opaque[i], false, false));
  }
  assert(!veil_keep_alpha(VEIL_ALPHA_AUTO, "game_capture", true, false));
  assert(veil_keep_alpha(VEIL_ALPHA_AUTO, "game_capture", true, true));
  assert(veil_keep_alpha(VEIL_ALPHA_AUTO, NULL, true, false));
  assert(veil_frame_format_for(true, true) == VEIL_FRAME_YUVA420);
  assert(veil_frame_format_for(true, false) == VEIL_FRAME_YUV420);
  assert(veil_frame_format_for(false, true) == VEIL_FRAME_RGBA);
  assert(veil_frame_format_for(false, false) == VEIL_FRAME_RGBA);
  // An 8-bit BT.709 full-range round trip stays within 2 levels, including
  // the default mask color #7c5cff and the extremes.
  int worst = 0;
  for (int r = 0; r < 256; r += 3)
    for (int g = 0; g < 256; g += 5)
      for (int b = 0; b < 256; b += 7) {
        uint8_t rgb[3] = {(uint8_t)r, (uint8_t)g, (uint8_t)b}, yuv[3], back[3];
        veil_rgb_to_yuv709(rgb, yuv);
        veil_yuv709_to_rgb(yuv, back);
        for (int k = 0; k < 3; k++) {
          int d = back[k] > rgb[k] ? back[k] - rgb[k] : rgb[k] - back[k];
          worst = d > worst ? d : worst;
        }
      }
  assert(worst <= 2);
  uint8_t purple[3] = {0x7c, 0x5c, 0xff}, yuv[3], back[3];
  veil_rgb_to_yuv709(purple, yuv);
  veil_yuv709_to_rgb(yuv, back);
  for (int k = 0; k < 3; k++)
    assert(back[k] + 2 >= purple[k] && back[k] <= purple[k] + 2);
  printf("4:2:0 1080p60 %llu MiB, 1440p60 %llu MiB, 2160p30 %llu MiB at "
         "2.5 s; worst round-trip error %d levels\n",
         (unsigned long long)(veil_memory_bytes(VEIL_FRAME_YUV420, 1920, 1080,
                                                2500, 60) /
                              mib),
         (unsigned long long)(veil_memory_bytes(VEIL_FRAME_YUV420, 2560, 1440,
                                                2500, 60) /
                              mib),
         (unsigned long long)(veil_memory_bytes(VEIL_FRAME_YUV420, 3840, 2160,
                                                2500, 30) /
                              mib),
         worst);

  // Frames between two samples get the union of both samples' boxes, even
  // when the gap is longer than a mask's own lifetime.
  struct veil_box a = {.1f, .1f, .1f, .1f}, b = {.5f, .5f, .1f, .1f};
  struct veil_core u = {0};
  veil_sample(&u, 0, 0, 2500000000);
  veil_result(&u, 0, 90, &a, 1);
  assert(veil_sample(&u, 200, 0, 2500000000) == 1);
  veil_result(&u, 200, 290, &b, 1);
  assert(veil_lookup(&u, 150, out, 8) == 2);
  assert(veil_lookup(&u, 200, out, 8) == 2);
  assert(veil_lookup(&u, 250, out, 8) == 1);
  assert(veil_lookup(&u, 0, out, 8) == 1);

  // Out-of-order results with two requests in flight.
  struct veil_core o = {0};
  veil_sample(&o, 0, 0, 1000);
  veil_result(&o, 0, 0, NULL, 0);
  assert(veil_sample(&o, 15, 10, 1000) == 1);
  assert(veil_sample(&o, 30, 20, 1000) == 16);
  assert(veil_hold(&o, 20, 5000, VEIL_PARANOID));
  assert(veil_result(&o, 30, 120, &b, 1) == VEIL_RESULT_OK);
  assert(o.confirmed_until == 30);
  assert(!veil_hold(&o, 20, 5000, VEIL_PARANOID)); // answered by sample 30
  assert(veil_hold(&o, 10, 5000, VEIL_PARANOID));  // sample 15 still pending
  assert(veil_lookup(&o, 20, out, 8) == 1);
  assert(veil_result(&o, 15, 105, &a, 1) == VEIL_RESULT_OK);
  assert(o.confirmed_until ==
         30); // monotonic: the older result cannot lower it
  assert(!veil_hold(&o, 10, 5000, VEIL_PARANOID));
  assert(veil_lookup(&o, 10, out, 8) == 1);
  assert(veil_lookup(&o, 20, out, 8) == 2); // union, though 15 arrived late
  assert(veil_hold(&o, 31, 5000, VEIL_PARANOID));
  // Duplicate and unknown results are ignored and add no masks.
  size_t masks = o.mask_count;
  assert(veil_result(&o, 15, 105, &a, 1) == VEIL_RESULT_IGNORED);
  assert(veil_result(&o, 99, 200, &a, 1) == VEIL_RESULT_IGNORED);
  assert(o.mask_count == masks && o.confirmed_until == 30);

  // Mask overflow holds the interval in every profile instead of dropping
  // boxes from a confirmed frame.
  static struct veil_box many[VEIL_MAX_MASKS];
  for (size_t i = 0; i < VEIL_MAX_MASKS; i++)
    many[i] = a;
  struct veil_core f = {0};
  veil_sample(&f, 0, 0, 1000);
  assert(veil_result(&f, 0, 10, many, VEIL_MAX_MASKS - 1) == VEIL_RESULT_OK);
  assert(veil_sample(&f, 15, 0, 1000) == 1);
  assert(veil_result(&f, 15, 30, many, 2) == VEIL_RESULT_OVERFLOW);
  assert(f.confirmed_until == 15);
  for (uint64_t fr = 1; fr <= 30; fr++) {
    assert(veil_hold(&f, fr, 5000, VEIL_BALANCED));
    assert(veil_hold(&f, fr, 5000, VEIL_PARANOID));
  }
  assert(!veil_hold(&f, 0, 5000, VEIL_BALANCED));
  assert(!veil_hold(&f, 5, 5000, VEIL_OFF));
  // A later sample extends the overflow hold through its own interval.
  assert(veil_sample(&f, 60, 0, 1000) == 16);
  veil_result(&f, 60, 70, NULL, 0);
  assert(veil_hold(&f, 50, 5000, VEIL_BALANCED));
  assert(!veil_hold(&f, 65, 5000, VEIL_BALANCED));
  // Once those frames leave the ring, the hold and masks are released.
  veil_prune(&f, 61);
  assert(f.mask_count == 0 && !veil_hold(&f, 65, 5000, VEIL_BALANCED));

  // Pruning an unanswered sample whose frames are still buffered stays
  // fail-closed, even when eviction is forced by a full pending table.
  struct veil_core l = {0};
  veil_sample(&l, 0, 0, 1000); // never answered
  for (unsigned i = 1; i <= VEIL_MAX_PENDING; i++)
    veil_sample(&l, i * 10, 0, 1000); // all in flight, none answered
  assert(l.has_lost && l.lost_first == 0 && l.lost_last == 0);
  assert(veil_hold(&l, 0, 5000, VEIL_PARANOID));
  veil_prune(&l, 1);
  assert(!l.has_lost);
  // Memory math never wraps: the largest sizes saturate instead of reading as
  // a tiny buffer, odd chroma rounding survives UINT32_MAX, and the fit search
  // still terminates with an even size of at least 2x2.
  assert(veil_frame_bytes(VEIL_FRAME_YUV420, UINT32_MAX, 1) ==
         (uint64_t)UINT32_MAX + (((uint64_t)UINT32_MAX + 1) / 2) * 2);
  assert(veil_frame_bytes(VEIL_FRAME_RGBA, UINT32_MAX, UINT32_MAX) ==
         UINT64_MAX);
  assert(veil_frame_bytes(VEIL_FRAME_YUVA420, UINT32_MAX, UINT32_MAX) ==
         UINT64_MAX);
  assert(veil_memory_bytes(VEIL_FRAME_YUV420, UINT32_MAX, UINT32_MAX / 2, 6000,
                           240) == UINT64_MAX);
  uint32_t ow = 0, oh = 0;
  assert(veil_fit_buffer(VEIL_FRAME_YUVA420, UINT32_MAX, UINT32_MAX, 6000,
                         UINT32_MAX, 128ULL << 20, &ow, &oh));
  assert(ow >= 2 && oh >= 2 && ow % 2 == 0 && oh % 2 == 0);
  assert(veil_fit_buffer(VEIL_FRAME_RGBA, UINT32_MAX, 1, 2500, 60, 640ULL << 20,
                         &ow, &oh));
  assert(ow % 2 == 0 && oh == 2 &&
         veil_memory_bytes(VEIL_FRAME_RGBA, ow, oh, 2500, 60) <= 640ULL << 20);
  // Zero-size sources are never resized and need no memory.
  assert(!veil_fit_buffer(VEIL_FRAME_YUV420, 0, 1080, 2500, 60, 1, &ow, &oh));
  assert(ow == 0 && oh == 1080);
  assert(veil_memory_bytes(VEIL_FRAME_YUV420, 0, 0, 2500, 60) == 0);
  assert(veil_ring_capacity(UINT32_MAX, UINT32_MAX) > 2);
  assert(veil_fps(UINT32_MAX, 1) == UINT32_MAX && veil_fps(1, UINT32_MAX) == 1);
  puts("guard core: ring wrap, mask sampling gap, hold, late profiles, alpha "
       "and "
       "capacity, union, out-of-order, overflow and fit passed");
  return 0;
}
