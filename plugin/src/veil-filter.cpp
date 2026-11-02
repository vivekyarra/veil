#include "detector-client.h"
#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <graphics/graphics.h>
#include <memory>
#include <mutex>
#include <obs-module.h>
#include <thread>
#include <util/platform.h>
#include <utility>
#include <vector>

OBS_DECLARE_MODULE()
OBS_MODULE_USE_DEFAULT_LOCALE("veil-guard", "en-US")
MODULE_EXPORT const char *obs_module_description(void) {
  return "VEIL Guard local privacy lookahead filter";
}

// Measured CPU detector round trip is p50 1.35 s / p99 2.49 s. With two
// requests in flight and 4 samples/s, 2.5 s keeps Paranoid output viewable.
static constexpr int default_delay_ms = 2500, min_delay_ms = 300,
                     max_delay_ms = 6000;
static constexpr int default_inflight = 2, max_inflight = 4;
// 4:2:0 1080p60 at the default delay needs 451 MiB, so it stays at full
// resolution; 1440p60 (802 MiB) and 2160p30 (914 MiB) need a higher cap, as
// does 1080p60 with an alpha plane (751 MiB).
static constexpr int default_cap_mib = 640, min_cap_mib = 128,
                     max_cap_mib = 4096;
static constexpr uint32_t default_color = 0xffff5c7c; // #7c5cff, OBS ABGR
static constexpr uint64_t connected_window_ns = 3000000000ULL;
// No render for this long means the source was hidden: the ring is stale.
static constexpr uint64_t stale_gap_ns = 500000000ULL;

struct job {
  std::vector<uint8_t> pixels;
  uint32_t w, h;
  uint64_t frame, timestamp, generation, late;
};
struct done {
  uint64_t frame, generation;
  double roundtrip_ms;
  veil_reply reply;
};
// Persistent request threads fed by one queue. Threads exist for the
// maximum in-flight count; the configured limit gates submission. The
// graphics thread never allocates here: queue, results and pixel buffers are
// reserved up front and recycled, and the token is copied on the worker.
struct worker_pool {
  std::mutex mutex;
  std::condition_variable wake;
  std::vector<job> queue;
  std::vector<done> results;
  std::vector<std::vector<uint8_t>> spare; // recycled sample buffers
  std::vector<std::thread> threads;
  std::vector<std::unique_ptr<veil_cancel>> cancels;
  std::string stream, token;
  uint16_t port = 47321;
  size_t busy = 0;
  bool stopping = false;

  void configure(const std::string &new_stream, const std::string &new_token,
                 uint16_t new_port) {
    std::lock_guard<std::mutex> lock(mutex);
    stream = new_stream;
    token = new_token;
    port = new_port;
  }
  void start() {
    // in_flight() gates submission at max_inflight, so these never grow.
    queue.reserve(max_inflight);
    results.reserve(max_inflight * 2);
    spare.reserve(max_inflight + 2);
    for (int i = 0; i < max_inflight; i++) {
      cancels.push_back(std::make_unique<veil_cancel>());
      veil_cancel *cancel = cancels.back().get();
      threads.emplace_back([this, cancel] { run(*cancel); });
    }
  }
  void run(veil_cancel &cancel) {
    std::unique_lock<std::mutex> lock(mutex);
    for (;;) {
      wake.wait(lock, [this] { return stopping || !queue.empty(); });
      if (stopping)
        return;
      job j = std::move(queue.front());
      queue.erase(queue.begin());
      busy++;
      std::string s = stream, t = token;
      uint16_t p = port;
      lock.unlock();
      uint64_t start = os_gettime_ns();
      veil_reply reply = veil_request(j.pixels, j.w, j.h, j.frame, j.timestamp,
                                      s, t, p, j.late, cancel);
      double roundtrip = double(os_gettime_ns() - start) / 1e6;
      lock.lock();
      busy--;
      if (spare.size() < spare.capacity())
        spare.push_back(std::move(j.pixels));
      results.push_back(
          done{j.frame, j.generation, roundtrip, std::move(reply)});
    }
  }
  // A recycled buffer of the requested size; allocates only while the pool
  // warms up or after a resolution change.
  std::vector<uint8_t> buffer(size_t bytes) {
    std::vector<uint8_t> pixels;
    {
      std::lock_guard<std::mutex> lock(mutex);
      if (!spare.empty()) {
        pixels = std::move(spare.back());
        spare.pop_back();
      }
    }
    pixels.resize(bytes);
    return pixels;
  }
  void stop() {
    {
      std::lock_guard<std::mutex> lock(mutex);
      stopping = true;
      queue.clear();
    }
    for (auto &cancel : cancels)
      cancel->cancel();
    wake.notify_all();
    for (auto &thread : threads)
      thread.join();
    threads.clear();
  }
  size_t in_flight() {
    std::lock_guard<std::mutex> lock(mutex);
    return queue.size() + busy;
  }
  void submit(job &&j) {
    {
      std::lock_guard<std::mutex> lock(mutex);
      queue.push_back(std::move(j));
    }
    wake.notify_one();
  }
  // Swaps finished results into out (cleared, capacity kept both ways).
  void take(std::vector<done> &out) {
    out.clear();
    std::lock_guard<std::mutex> lock(mutex);
    if (!results.empty())
      results.swap(out);
  }
};

// A delayed frame: R8 luma + R8G8 chroma for 4:2:0, plus an R8 alpha plane
// when transparency is kept, or one RGBA texture in the fallback format
// (chroma and alpha stay null).
struct slot {
  gs_texrender_t *luma = nullptr, *chroma = nullptr, *alpha = nullptr;
  uint64_t id = 0, timestamp = 0;
  bool valid = false;
};
struct staged_sample {
  bool valid = false;
  uint64_t frame = 0, timestamp = 0;
  int index = 0;
};
struct guard {
  std::mutex mutex;
  obs_source_t *source = nullptr;
  std::vector<slot> ring;
  gs_effect_t *yuv = nullptr;        // null: effect missing, store RGBA instead
  gs_texrender_t *capture = nullptr; // RGBA working frame packed into slots
  enum veil_frame_format format = VEIL_FRAME_YUV420;
  gs_texrender_t *sample = nullptr;
  gs_stagesurf_t *stage[2] = {nullptr, nullptr};
  staged_sample staged;
  int next_stage = 0;
  uint32_t width = 0, height = 0, source_w = 0, source_h = 0, sample_w = 0,
           sample_h = 0, delay = default_delay_ms, fps = 60, sample_fps = 4,
           inflight = default_inflight, cap_mib = default_cap_mib;
  bool downscaled = false;
  enum veil_profile profile = VEIL_PARANOID;
  enum veil_alpha_mode alpha_mode = VEIL_ALPHA_AUTO;
  bool keep_alpha = true; // resolved from alpha_mode and the source in tick
  bool enabled = true, test = false, token_invalid = false;
  uint64_t frame = 0, last_time = 0, last_sample = 0, generation = 0;
  uint64_t last_result_ns = 0, failures = 0, overflows = 0;
  std::unique_ptr<veil_core> core = std::make_unique<veil_core>();
  std::string token, stream, last_error;
  uint16_t port = 47321;
  std::vector<double> latencies;
  uint32_t color = default_color;
  std::atomic<bool> flush{false};
  worker_pool workers;
  std::vector<done> finished; // graphics thread only, reused every frame
};
static const char *name(void *) { return "VEIL Guard"; }
static void clear_graphics(guard *g) {
  for (auto &s : g->ring) {
    gs_texrender_destroy(s.luma);
    gs_texrender_destroy(s.chroma);
    gs_texrender_destroy(s.alpha);
  }
  g->ring.clear();
  gs_texrender_destroy(g->capture);
  g->capture = nullptr;
  gs_texrender_destroy(g->sample);
  g->sample = nullptr;
  for (auto &stage : g->stage) {
    gs_stagesurface_destroy(stage);
    stage = nullptr;
  }
}
// Forget every buffered frame and pending result. Results still in flight
// carry the old generation and are dropped when they arrive.
static void reset_timeline(guard *g) {
  std::memset(g->core.get(), 0, sizeof(veil_core));
  for (auto &s : g->ring)
    s.valid = false;
  g->staged.valid = false;
  g->last_sample = 0;
  g->generation++;
}
static uint32_t output_fps() {
  obs_video_info info{};
  if (obs_get_video_info(&info))
    return veil_fps(info.fps_num, info.fps_den);
  return 60;
}
static void defaults(obs_data_t *s) {
  obs_data_set_default_bool(s, "enabled", true);
  obs_data_set_default_int(s, "profile", VEIL_PARANOID);
  obs_data_set_default_int(s, "delay_ms", default_delay_ms);
  obs_data_set_default_int(s, "sample_fps", 4);
  obs_data_set_default_int(s, "max_in_flight", default_inflight);
  obs_data_set_default_int(s, "buffer_cap_mib", default_cap_mib);
  obs_data_set_default_int(s, "mask_color", default_color);
  obs_data_set_default_int(s, "detector_port", 47321);
  obs_data_set_default_int(s, "preserve_alpha", VEIL_ALPHA_AUTO);
}
static void update(void *data, obs_data_t *s) {
  auto *g = static_cast<guard *>(data);
  // File and video-info reads happen before taking the render mutex.
  bool have_token = false;
  std::string token;
  const char *path = obs_data_get_string(s, "token_file");
  if (path && *path) {
    obs_data_t *config = obs_data_create_from_json_file(path);
    if (config) {
      token = obs_data_get_string(config, "token");
      have_token = true;
      obs_data_release(config);
    }
  }
  bool token_ok = veil_token_valid(token);
  if (have_token && !token_ok)
    blog(LOG_WARNING,
         "[veil-guard] token in %s is invalid (needs 32-512 "
         "printable characters, no CR/LF); detector disabled",
         path);
  uint32_t fps = output_fps();
  std::lock_guard<std::mutex> lock(g->mutex);
  g->enabled = obs_data_get_bool(s, "enabled");
  g->profile = static_cast<veil_profile>(
      std::clamp<int>(int(obs_data_get_int(s, "profile")), 0, 2));
  g->delay = std::clamp<int>(int(obs_data_get_int(s, "delay_ms")), min_delay_ms,
                             max_delay_ms);
  g->sample_fps =
      std::clamp<int>(int(obs_data_get_int(s, "sample_fps")), 1, 10);
  g->inflight = std::clamp<int>(int(obs_data_get_int(s, "max_in_flight")), 1,
                                max_inflight);
  g->cap_mib = std::clamp<int>(int(obs_data_get_int(s, "buffer_cap_mib")),
                               min_cap_mib, max_cap_mib);
  // Masks are always opaque, whatever alpha the color picker stored.
  g->color = uint32_t(obs_data_get_int(s, "mask_color")) | 0xff000000u;
  g->test = obs_data_get_bool(s, "test_pattern");
  g->alpha_mode = static_cast<veil_alpha_mode>(
      std::clamp<int>(int(obs_data_get_int(s, "preserve_alpha")), 0, 2));
  g->port = uint16_t(
      std::clamp<int>(int(obs_data_get_int(s, "detector_port")), 1024, 65535));
  g->fps = fps;
  if (have_token) {
    g->token = token_ok ? token : std::string();
    g->token_invalid = !token_ok;
  }
  g->workers.configure(g->stream, g->token, g->port);
}
static void *create(obs_data_t *s, obs_source_t *source) {
  auto *g = new guard;
  g->source = source;
  g->stream = std::to_string(os_gettime_ns());
  char *file = obs_module_file("veil-yuv.effect");
  char *error = nullptr;
  obs_enter_graphics();
  g->yuv = file ? gs_effect_create_from_file(file, &error) : nullptr;
  obs_leave_graphics();
  if (!g->yuv)
    blog(LOG_WARNING,
         "[veil-guard] cannot load %s (%s); storing RGBA frames, which need "
         "2.7x the memory",
         file ? file : "veil-yuv.effect", error ? error : "file not found");
  bfree(error);
  bfree(file);
  g->workers.start();
  g->finished.reserve(max_inflight * 2);
  g->latencies.reserve(1001);
  update(g, s);
  return g;
}
static void destroy(void *data) {
  auto *g = static_cast<guard *>(data);
  g->workers.stop(); // cancels in-flight requests; returns promptly
  obs_enter_graphics();
  clear_graphics(g);
  gs_effect_destroy(g->yuv);
  obs_leave_graphics();
  delete g;
}
static void request_flush(void *data) {
  static_cast<guard *>(data)->flush = true;
}
// Auto transparency looks at the filtered source itself; an earlier filter
// in the chain may add alpha (chroma key), so its output always keeps it.
static bool resolve_alpha(guard *g, veil_alpha_mode mode) {
  if (mode != VEIL_ALPHA_AUTO)
    return veil_keep_alpha(mode, nullptr, true, false);
  obs_source_t *parent = obs_filter_get_parent(g->source);
  obs_source_t *target = obs_filter_get_target(g->source);
  if (!parent || !target)
    return true;
  const char *id = obs_source_get_unversioned_id(parent);
  bool allow_transparency = false;
  if (id && std::strcmp(id, "game_capture") == 0) {
    obs_data_t *settings = obs_source_get_settings(parent);
    allow_transparency = obs_data_get_bool(settings, "allow_transparency");
    obs_data_release(settings);
  }
  return veil_keep_alpha(mode, id, target == parent, allow_transparency);
}
static void tick(void *data, float) {
  auto *g = static_cast<guard *>(data);
  uint32_t fps = output_fps();
  veil_alpha_mode mode;
  {
    std::lock_guard<std::mutex> lock(g->mutex);
    mode = g->alpha_mode;
  }
  bool keep_alpha = resolve_alpha(g, mode);
  std::lock_guard<std::mutex> lock(g->mutex);
  g->fps = fps;
  g->keep_alpha = keep_alpha;
}
// Solid output-resolution rectangle, drawn after unpacking. Follows the OBS
// color source: with linear sRGB the color is linearized and the framebuffer
// re-encodes it, so the mask lands on the configured color either way. It
// replaces what is below with alpha 1, so a mask or hold over a transparent
// area of the source never lets the scene underneath show through.
static void fill(float x, float y, float w, float h, uint32_t color) {
  gs_effect_t *effect = obs_get_base_effect(OBS_EFFECT_SOLID);
  const bool linear = gs_get_linear_srgb();
  const bool previous = gs_framebuffer_srgb_enabled();
  gs_enable_framebuffer_srgb(linear);
  vec4 value;
  if (linear)
    vec4_from_rgba_srgb(&value, color);
  else
    vec4_from_rgba(&value, color);
  gs_effect_set_vec4(gs_effect_get_param_by_name(effect, "color"), &value);
  gs_blend_state_push();
  gs_blend_function(GS_BLEND_ONE, GS_BLEND_ZERO);
  gs_matrix_push();
  gs_matrix_translate3f(x, y, 0);
  while (gs_effect_loop(effect, "Solid"))
    gs_draw_sprite(nullptr, 0, uint32_t(w), uint32_t(h));
  gs_matrix_pop();
  gs_blend_state_pop();
  gs_enable_framebuffer_srgb(previous);
}
// Runs one packing technique of the RGBA capture (nonlinear R'G'B', read
// without sRGB decode) over a cx x cy render target, with no blending.
static bool pack_into(guard *g, gs_texrender_t *target, uint32_t cx,
                      uint32_t cy, const char *technique) {
  gs_texture_t *rgba = gs_texrender_get_texture(g->capture);
  gs_texrender_reset(target);
  if (!gs_texrender_begin(target, cx, cy))
    return false;
  gs_ortho(0, float(cx), 0, float(cy), -100, 100);
  const bool previous = gs_framebuffer_srgb_enabled();
  gs_enable_framebuffer_srgb(false);
  gs_blend_state_push();
  gs_blend_function(GS_BLEND_ONE, GS_BLEND_ZERO);
  // gs_technique_end clears parameter values, so set them for every pass.
  gs_effect_set_texture(gs_effect_get_param_by_name(g->yuv, "image"), rgba);
  vec2 texel;
  vec2_set(&texel, 1.0f / float(g->width), 1.0f / float(g->height));
  gs_effect_set_vec2(gs_effect_get_param_by_name(g->yuv, "texel"), &texel);
  while (gs_effect_loop(g->yuv, technique))
    gs_draw_sprite(rgba, 0, cx, cy);
  gs_blend_state_pop();
  gs_enable_framebuffer_srgb(previous);
  gs_texrender_end(target);
  return true;
}
// RGBA capture -> 4:2:0 slot: full-resolution luma, half-resolution chroma
// and, when transparency is kept, full-resolution alpha.
static bool pack(guard *g, slot &s) {
  return pack_into(g, s.luma, g->width, g->height, "PackY") &&
         pack_into(g, s.chroma, (g->width + 1) / 2, (g->height + 1) / 2,
                   "PackUV") &&
         (!s.alpha || pack_into(g, s.alpha, g->width, g->height, "PackA"));
}
// Draws a stored frame at the full output size, before any mask. Stored
// color is premultiplied, so frames with alpha blend ONE / INVSRCALPHA like
// OBS's own filters; opaque frames replace what is below.
static void draw_frame(guard *g, slot &s, uint32_t cx, uint32_t cy) {
  const bool linear = gs_get_linear_srgb();
  const bool previous = gs_framebuffer_srgb_enabled();
  const bool alpha = g->format == VEIL_FRAME_YUVA420 ||
                     (g->format == VEIL_FRAME_RGBA && g->keep_alpha);
  gs_blend_state_push();
  gs_blend_function(GS_BLEND_ONE, alpha ? GS_BLEND_INVSRCALPHA : GS_BLEND_ZERO);
  gs_texture_t *luma = gs_texrender_get_texture(s.luma);
  if (g->format != VEIL_FRAME_RGBA) {
    gs_enable_framebuffer_srgb(linear);
    gs_effect_set_texture(gs_effect_get_param_by_name(g->yuv, "image"), luma);
    gs_effect_set_texture(gs_effect_get_param_by_name(g->yuv, "image_uv"),
                          gs_texrender_get_texture(s.chroma));
    const char *technique = linear ? "UnpackLinear" : "Unpack";
    if (alpha) {
      gs_effect_set_texture(gs_effect_get_param_by_name(g->yuv, "image_a"),
                            gs_texrender_get_texture(s.alpha));
      technique = linear ? "UnpackAlphaLinear" : "UnpackAlpha";
    }
    while (gs_effect_loop(g->yuv, technique))
      gs_draw_sprite(luma, 0, cx, cy);
  } else {
    // Opaque output of the RGBA fallback forces alpha to 1.
    gs_effect_t *effect =
        obs_get_base_effect(alpha ? OBS_EFFECT_DEFAULT : OBS_EFFECT_OPAQUE);
    gs_enable_framebuffer_srgb(true);
    gs_effect_set_texture_srgb(gs_effect_get_param_by_name(effect, "image"),
                               luma);
    while (gs_effect_loop(effect, "Draw"))
      gs_draw_sprite(luma, 0, cx, cy);
  }
  gs_blend_state_pop();
  gs_enable_framebuffer_srgb(previous);
}
static void apply_results(guard *g) {
  g->workers.take(g->finished);
  for (auto &d : g->finished) {
    if (d.generation != g->generation)
      continue; // stale: sampled before a reset or resolution change
    if (!d.reply.ok) {
      g->failures++;
      g->last_error = d.reply.error;
      continue; // the sample stays unconfirmed and covered
    }
    auto status = veil_result(g->core.get(), d.frame,
                              d.frame + uint64_t(g->fps) * 1500 / 1000,
                              d.reply.boxes.data(), d.reply.boxes.size());
    // Logging is file IO: only on the 1st, 2nd, 4th, 8th ... overflow.
    if (status == VEIL_RESULT_OVERFLOW) {
      const uint64_t count = ++g->overflows;
      if (!(count & (count - 1)))
        blog(LOG_WARNING,
             "[veil-guard] %llu boxes exceed the mask table; covering frames "
             "(%llu overflows)",
             (unsigned long long)d.reply.boxes.size(),
             (unsigned long long)count);
    }
    g->last_result_ns = os_gettime_ns();
    g->last_error.clear();
    g->latencies.push_back(d.roundtrip_ms);
    if (g->latencies.size() > 1000)
      g->latencies.erase(g->latencies.begin());
  }
}
// Maps the sample staged on the previous render, so the GPU copy has had a
// frame to finish, and hands it to the worker queue.
static void submit_staged(guard *g) {
  if (!g->staged.valid)
    return;
  g->staged.valid = false;
  gs_stagesurf_t *stage = g->stage[g->staged.index];
  uint8_t *mapped = nullptr;
  uint32_t stride = 0;
  if (!gs_stagesurface_map(stage, &mapped, &stride))
    return; // not registered; the next sample spans these frames
  std::vector<uint8_t> pixels =
      g->workers.buffer(size_t(g->sample_w) * g->sample_h * 4);
  for (uint32_t y = 0; y < g->sample_h; y++)
    std::memcpy(pixels.data() + size_t(y) * g->sample_w * 4,
                mapped + size_t(y) * stride, size_t(g->sample_w) * 4);
  gs_stagesurface_unmap(stage);
  // The deadline is when the first frame this sample covers is output. Use
  // the earliest buffered timestamp at or after it, never a later one.
  uint64_t first = g->core->has_sample ? g->core->previous_sample + 1 : 0;
  uint64_t first_time = g->staged.timestamp;
  for (auto &s : g->ring)
    if (s.valid && s.id >= first && s.timestamp < first_time)
      first_time = s.timestamp;
  veil_sample(g->core.get(), g->staged.frame, first_time,
              uint64_t(g->delay) * 1000000);
  g->workers.submit(
      job{std::move(pixels), g->sample_w, g->sample_h, g->staged.frame,
          g->staged.timestamp, g->generation,
          g->profile == VEIL_BALANCED ? g->core->late_results : 0});
}
// The detector reads the RGBA capture, not the 4:2:0 copy.
static void stage_sample(guard *g, const slot &current, gs_texture_t *texture,
                         uint32_t w, uint32_t h, uint64_t now) {
  if (g->token.empty() || now - g->last_sample < 1000000000ULL / g->sample_fps)
    return;
  if (g->workers.in_flight() >= g->inflight)
    return; // busy: no phantom request; the next sample spans the gap
  gs_texrender_reset(g->sample);
  if (!gs_texrender_begin(g->sample, g->sample_w, g->sample_h))
    return;
  gs_ortho(0, float(w), 0, float(h), -100, 100);
  // Premultiplied capture, copied as is: transparent areas read as black.
  gs_blend_state_push();
  gs_blend_function(GS_BLEND_ONE, GS_BLEND_ZERO);
  gs_effect_t *effect = obs_get_base_effect(OBS_EFFECT_DEFAULT);
  gs_effect_set_texture(gs_effect_get_param_by_name(effect, "image"), texture);
  while (gs_effect_loop(effect, "Draw"))
    gs_draw_sprite(texture, 0, w, h);
  gs_blend_state_pop();
  gs_texrender_end(g->sample);
  gs_stage_texture(g->stage[g->next_stage],
                   gs_texrender_get_texture(g->sample));
  g->staged = staged_sample{true, current.id, current.timestamp, g->next_stage};
  g->next_stage ^= 1;
  g->last_sample = now;
}
static const char *format_name(veil_frame_format format) {
  switch (format) {
  case VEIL_FRAME_YUVA420:
    return "4:2:0 + alpha";
  case VEIL_FRAME_RGBA:
    return "RGBA";
  default:
    return "4:2:0";
  }
}
static void render(void *data, gs_effect_t *) {
  auto *g = static_cast<guard *>(data);
  obs_source_t *target = obs_filter_get_target(g->source);
  std::lock_guard<std::mutex> lock(g->mutex);
  if (!target)
    return;
  if (!g->enabled || g->profile == VEIL_OFF) {
    g->flush = true; // the ring goes stale while bypassed
    obs_source_skip_video_filter(g->source);
    return;
  }
  uint32_t output_w = obs_source_get_base_width(target),
           output_h = obs_source_get_base_height(target);
  if (!output_w || !output_h)
    return;
  uint32_t w = 0, h = 0;
  const veil_frame_format format =
      veil_frame_format_for(g->yuv != nullptr, g->keep_alpha);
  const bool yuv = format != VEIL_FRAME_RGBA;
  bool downscaled =
      veil_fit_buffer(format, output_w, output_h, g->delay, g->fps,
                      uint64_t(g->cap_mib) * 1024 * 1024, &w, &h);
  size_t capacity = veil_ring_capacity(g->delay, g->fps);
  if (g->width != w || g->height != h || g->ring.size() != capacity ||
      g->format != format) {
    clear_graphics(g);
    reset_timeline(g);
    g->width = w;
    g->height = h;
    g->source_w = output_w;
    g->source_h = output_h;
    g->downscaled = downscaled;
    g->format = format;
    g->ring.resize(capacity);
    for (auto &s : g->ring) {
      s.luma = gs_texrender_create(yuv ? GS_R8 : GS_RGBA, GS_ZS_NONE);
      if (yuv)
        s.chroma = gs_texrender_create(GS_R8G8, GS_ZS_NONE);
      if (format == VEIL_FRAME_YUVA420)
        s.alpha = gs_texrender_create(GS_R8, GS_ZS_NONE);
    }
    if (yuv)
      g->capture = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
    g->sample_w = std::min(w, 1280u);
    g->sample_h = std::max(1u, uint32_t(uint64_t(h) * g->sample_w / w));
    g->sample = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
    for (auto &stage : g->stage)
      stage = gs_stagesurface_create(g->sample_w, g->sample_h, GS_RGBA);
    blog(downscaled ? LOG_WARNING : LOG_INFO,
         "[veil-guard] buffer %ux%u %s%s for %ux%u source, %u frames, %llu MiB",
         w, h, format_name(format),
         downscaled ? " (DOWNSCALED to fit memory cap)" : "", output_w,
         output_h, unsigned(capacity),
         (unsigned long long)(veil_memory_bytes(format, w, h, g->delay,
                                                g->fps) >>
                              20));
  }
  uint64_t now = obs_get_video_frame_time();
  if (g->flush.exchange(false) ||
      (g->last_time && now > g->last_time + stale_gap_ns))
    reset_timeline(g); // shown/activated again: never play stale frames
  if (now != g->last_time) {
    g->last_time = now;
    apply_results(g);
    auto &current = g->ring[veil_ring_index(g->frame, capacity)];
    current.valid = false;
    // 4:2:0 renders into the shared RGBA capture and packs it into the slot.
    gs_texrender_t *frame = yuv ? g->capture : current.luma;
    gs_texrender_reset(frame);
    if (gs_texrender_begin(frame, w, h)) {
      vec4 clear{};
      gs_clear(GS_CLEAR_COLOR, &clear, 0, 0);
      gs_ortho(0, float(output_w), 0, float(output_h), -100, 100);
      // The same blend as obs_source_process_filter_begin: color is stored
      // premultiplied by alpha whether or not the source draws premultiplied.
      gs_blend_state_push();
      gs_blend_function_separate(GS_BLEND_SRCALPHA, GS_BLEND_INVSRCALPHA,
                                 GS_BLEND_ONE, GS_BLEND_INVSRCALPHA);
      uint32_t flags = obs_source_get_output_flags(target);
      if (target == obs_filter_get_parent(g->source) &&
          !(flags & OBS_SOURCE_CUSTOM_DRAW) && !(flags & OBS_SOURCE_ASYNC))
        obs_source_default_render(target);
      else
        obs_source_video_render(target);
      gs_blend_state_pop();
      gs_texrender_end(frame);
      current.id = g->frame;
      current.timestamp = now;
      current.valid = !yuv || pack(g, current);
    }
    submit_staged(g);
    if (current.valid)
      stage_sample(g, current, gs_texrender_get_texture(frame), w, h, now);
    veil_prune(g->core.get(),
               g->frame + 1 > capacity ? g->frame + 1 - capacity : 0);
    g->frame++;
  }
  slot *output = nullptr;
  for (auto &s : g->ring)
    if (s.valid && s.timestamp + uint64_t(g->delay) * 1000000 <= now &&
        (!output || s.timestamp > output->timestamp))
      output = &s;
  if (!output || veil_hold(g->core.get(), output->id, now, g->profile)) {
    // The whole source rectangle, opaque even where the source is transparent.
    fill(0, 0, float(output_w), float(output_h), g->color);
    return;
  }
  draw_frame(g, *output, output_w, output_h);
  // Masks are drawn after unpacking, in output pixels and the exact color.
  static veil_box boxes[VEIL_MAX_MASKS]; // graphics thread only
  size_t n = veil_lookup(g->core.get(), output->id, boxes, VEIL_MAX_MASKS);
  for (size_t i = 0; i < n; i++)
    fill(boxes[i].x * output_w, boxes[i].y * output_h, boxes[i].w * output_w,
         boxes[i].h * output_h, g->color);
  if (g->test)
    fill(output_w * .2f, output_h * .2f, output_w * .4f, output_h * .2f,
         g->color);
}
static std::string textf(const char *pattern, ...) {
  char text[512];
  va_list args;
  va_start(args, pattern);
  vsnprintf(text, sizeof(text), pattern, args);
  va_end(args);
  return text;
}
static std::string detector_status(guard *g) {
  if (g->token_invalid)
    return "Token file invalid (needs 32-512 printable characters, no CR/LF)";
  if (g->token.empty())
    return "No token: connect the local detector in VEIL Onboarding";
  std::vector<double> sorted = g->latencies;
  std::sort(sorted.begin(), sorted.end());
  double p50 = sorted.empty() ? 0 : sorted[sorted.size() / 2],
         p99 = sorted.empty() ? 0
                              : sorted[std::min(sorted.size() - 1,
                                                size_t(sorted.size() * .99))];
  uint64_t now = os_gettime_ns();
  std::string state;
  if (!g->last_result_ns)
    state = "No result yet";
  else if (now - g->last_result_ns < connected_window_ns)
    state = "Connected";
  else
    state =
        textf("No result for %.0f s", double(now - g->last_result_ns) / 1e9);
  if (!g->last_error.empty())
    state += " (" + g->last_error + ")";
  state +=
      textf("; round trip p50 %.0f / p99 %.0f ms; late %llu; "
            "failed %llu; overflow %llu",
            p50, p99, (unsigned long long)g->core->late_results,
            (unsigned long long)g->failures, (unsigned long long)g->overflows);
  if (p99 > 0 && p99 + 1000.0 / g->sample_fps > g->delay)
    state += textf(". Delay %u ms is below p99 + sample interval; Paranoid "
                   "output will often be covered",
                   g->delay);
  return state;
}
static std::string buffer_status(guard *g) {
  unsigned frames = unsigned(veil_ring_capacity(g->delay, g->fps));
  if (!g->width)
    return textf("Not allocated yet; %u frames at %u fps, cap %u MiB", frames,
                 g->fps, g->cap_mib);
  std::string text = textf(
      "%ux%u %s (%u bpp), %u frames, %llu MiB", g->width, g->height,
      format_name(g->format),
      unsigned(veil_frame_bytes(g->format, 2, 2) * 8 / 4), frames,
      (unsigned long long)(veil_memory_bytes(g->format, g->width, g->height,
                                             g->delay, g->fps) >>
                           20));
  static const char *const modes[] = {"auto", "on", "off"};
  const bool alpha = g->format == VEIL_FRAME_YUVA420 ||
                     (g->format == VEIL_FRAME_RGBA && g->keep_alpha);
  text += textf("; transparency %s (%s)", alpha ? "kept" : "dropped",
                modes[g->alpha_mode]);
  if (g->format == VEIL_FRAME_RGBA)
    text += " (veil-yuv.effect failed to load; see the OBS log)";
  if (g->downscaled)
    text += textf(
        ". DOWNSCALED from %ux%u: full resolution needs %llu MiB, over the "
        "%u MiB cap. Lower the delay or raise the cap for full quality",
        g->source_w, g->source_h,
        (unsigned long long)(veil_memory_bytes(g->format, g->source_w,
                                               g->source_h, g->delay, g->fps) >>
                             20),
        g->cap_mib);
  return text;
}
static obs_properties_t *properties(void *data) {
  auto *g = static_cast<guard *>(data);
  auto *p = obs_properties_create();
  obs_properties_add_bool(p, "enabled", "Enabled");
  auto *profile = obs_properties_add_list(
      p, "profile", "Profile", OBS_COMBO_TYPE_LIST, OBS_COMBO_FORMAT_INT);
  obs_property_list_add_int(profile, "Off", VEIL_OFF);
  obs_property_list_add_int(profile, "Balanced (late results can escape)",
                            VEIL_BALANCED);
  obs_property_list_add_int(profile, "Paranoid (full-frame hold)",
                            VEIL_PARANOID);
  obs_properties_add_int(p, "delay_ms", "Video delay (ms)", min_delay_ms,
                         max_delay_ms, 50);
  obs_properties_add_int(p, "sample_fps", "Sample FPS", 1, 10, 1);
  obs_properties_add_int(p, "max_in_flight", "Concurrent detector requests", 1,
                         max_inflight, 1);
  auto *cap = obs_properties_add_int(p, "buffer_cap_mib",
                                     "Delay buffer memory cap (MiB)",
                                     min_cap_mib, max_cap_mib, 64);
  obs_property_set_long_description(
      cap, "Delayed frames are stored as 4:2:0 BT.709 (12 bits per pixel; "
           "1080p60 at 2.5 s needs 451 MiB), or 20 bits per pixel with an "
           "alpha plane (751 MiB). Only above the cap is the buffer stored at "
           "a reduced resolution; the status below shows it.");
  auto *alpha =
      obs_properties_add_list(p, "preserve_alpha", "Preserve transparency",
                              OBS_COMBO_TYPE_LIST, OBS_COMBO_FORMAT_INT);
  obs_property_list_add_int(alpha, "Auto", VEIL_ALPHA_AUTO);
  obs_property_list_add_int(alpha, "On", VEIL_ALPHA_ON);
  obs_property_list_add_int(alpha, "Off (opaque, over black)", VEIL_ALPHA_OFF);
  obs_property_set_long_description(
      alpha, "Auto keeps the alpha of browser, image, media and camera "
             "sources, and of anything behind an earlier filter such as a "
             "chroma key, at 8 more bits per pixel. Display, monitor and "
             "window captures, and game capture without Allow transparency, "
             "are stored opaque. Masks and holds are always opaque.");
  obs_properties_add_color(p, "mask_color", "Solid mask color");
  obs_properties_add_bool(p, "test_pattern", "Test pattern");
  obs_properties_add_path(p, "token_file", "Local token config", OBS_PATH_FILE,
                          "JSON (*.json)", nullptr);
  obs_properties_add_int(p, "detector_port", "127.0.0.1 detector port", 1024,
                         65535, 1);
  std::string detector = "Connect authenticated local detector", buffer;
  if (g) {
    std::lock_guard<std::mutex> lock(g->mutex);
    detector = detector_status(g);
    buffer = buffer_status(g);
  }
  obs_properties_add_text(p, "status", ("Detector: " + detector).c_str(),
                          OBS_TEXT_INFO);
  if (g)
    obs_properties_add_text(p, "buffer", ("Buffer: " + buffer).c_str(),
                            OBS_TEXT_INFO);
  return p;
}
bool obs_module_load(void) {
  obs_source_info info{};
  info.id = "veil_guard";
  info.type = OBS_SOURCE_TYPE_FILTER;
  info.output_flags = OBS_SOURCE_VIDEO;
  info.get_name = name;
  info.create = create;
  info.destroy = destroy;
  info.update = update;
  info.get_defaults = defaults;
  info.get_properties = properties;
  info.video_render = render;
  info.video_tick = tick;
  info.activate = request_flush;
  info.show = request_flush;
  info.deactivate = request_flush;
  info.hide = request_flush;
  obs_register_source(&info);
  return true;
}
