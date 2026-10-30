#include "detector-client.h"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>
#include <fstream>
#include <future>
#include <graphics/graphics.h>
#include <mutex>
#include <obs-module.h>
#include <util/platform.h>
#include <vector>

OBS_DECLARE_MODULE()
OBS_MODULE_USE_DEFAULT_LOCALE("veil-guard", "en-US")
MODULE_EXPORT const char *obs_module_description(void) {
  return "VEIL Guard local privacy lookahead filter";
}

struct slot {
  gs_texrender_t *texture = nullptr;
  uint64_t id = 0, timestamp = 0;
  bool valid = false;
};
struct guard {
  std::mutex mutex;
  obs_source_t *source = nullptr;
  std::vector<slot> ring;
  gs_texrender_t *sample = nullptr;
  gs_stagesurf_t *stage = nullptr;
  uint32_t width = 0, height = 0, sample_w = 0, sample_h = 0, delay = 750,
           fps = 60, sample_fps = 4;
  enum veil_profile profile = VEIL_PARANOID;
  bool enabled = true, test = false;
  uint64_t frame = 0, last_time = 0, last_sample = 0;
  veil_core core{};
  std::future<veil_reply> worker;
  uint64_t working_frame = 0;
  std::string token, stream;
  uint16_t port = 47321;
  double last_latency = 0;
  std::vector<double> latencies;
  uint32_t color = 0xff141019;
};
static const char *name(void *) { return "VEIL Guard"; }
static void clear_graphics(guard *g) {
  for (auto &s : g->ring)
    gs_texrender_destroy(s.texture);
  g->ring.clear();
  gs_texrender_destroy(g->sample);
  g->sample = nullptr;
  gs_stagesurface_destroy(g->stage);
  g->stage = nullptr;
}
static void defaults(obs_data_t *s) {
  obs_data_set_default_bool(s, "enabled", true);
  obs_data_set_default_int(s, "profile", VEIL_PARANOID);
  obs_data_set_default_int(s, "delay_ms", 750);
  obs_data_set_default_int(s, "sample_fps", 4);
  obs_data_set_default_int(s, "mask_color", 0xff141019);
  obs_data_set_default_int(s, "detector_port", 47321);
}
static void update(void *data, obs_data_t *s) {
  auto *g = static_cast<guard *>(data);
  std::lock_guard<std::mutex> lock(g->mutex);
  g->enabled = obs_data_get_bool(s, "enabled");
  g->profile = static_cast<veil_profile>(
      std::clamp<int>(int(obs_data_get_int(s, "profile")), 0, 2));
  g->delay = std::clamp<int>(int(obs_data_get_int(s, "delay_ms")), 300, 3000);
  g->sample_fps =
      std::clamp<int>(int(obs_data_get_int(s, "sample_fps")), 1, 10);
  g->color = uint32_t(obs_data_get_int(s, "mask_color"));
  g->test = obs_data_get_bool(s, "test_pattern");
  g->port = uint16_t(
      std::clamp<int>(int(obs_data_get_int(s, "detector_port")), 1024, 65535));
  const char *path = obs_data_get_string(s, "token_file");
  if (path && *path) {
    obs_data_t *config = obs_data_create_from_json_file(path);
    if (config) {
      g->token = obs_data_get_string(config, "token");
      obs_data_release(config);
    }
  }
}
static void *create(obs_data_t *s, obs_source_t *source) {
  auto *g = new guard;
  g->source = source;
  g->stream = std::to_string(os_gettime_ns());
  obs_video_info info{};
  if (obs_get_video_info(&info) && info.fps_den)
    g->fps = std::max(1u, info.fps_num / info.fps_den);
  update(g, s);
  return g;
}
static void destroy(void *data) {
  auto *g = static_cast<guard *>(data);
  if (g->worker.valid())
    g->worker.wait();
  obs_enter_graphics();
  clear_graphics(g);
  obs_leave_graphics();
  delete g;
}
static void fill(float x, float y, float w, float h, uint32_t color) {
  gs_effect_t *effect = obs_get_base_effect(OBS_EFFECT_SOLID);
  vec4 value;
  vec4_from_rgba(&value, color);
  gs_effect_set_vec4(gs_effect_get_param_by_name(effect, "color"), &value);
  gs_matrix_push();
  gs_matrix_translate3f(x, y, 0);
  while (gs_effect_loop(effect, "Solid"))
    gs_draw_sprite(nullptr, 0, uint32_t(w), uint32_t(h));
  gs_matrix_pop();
}
static void render(void *data, gs_effect_t *) {
  auto *g = static_cast<guard *>(data);
  obs_source_t *target = obs_filter_get_target(g->source);
  std::lock_guard<std::mutex> lock(g->mutex);
  if (!target)
    return;
  if (!g->enabled || g->profile == VEIL_OFF) {
    obs_source_skip_video_filter(g->source);
    return;
  }
  uint32_t output_w = obs_source_get_base_width(target),
           output_h = obs_source_get_base_height(target);
  if (!output_w || !output_h)
    return;
  uint32_t w = output_w, h = output_h;
  if (veil_memory_bytes(w, h, g->delay, g->fps) > 450ULL * 1024 * 1024) {
    double ratio = std::min(
        {1280.0 / w, 720.0 / h,
         std::sqrt(double(449ULL * 1024 * 1024) /
                   double(veil_memory_bytes(w, h, g->delay, g->fps)))});
    w = std::max(1u, uint32_t(w * ratio));
    h = std::max(1u, uint32_t(h * ratio));
  }
  size_t capacity = veil_ring_capacity(g->delay, g->fps);
  if (g->width != w || g->height != h || g->ring.size() != capacity) {
    clear_graphics(g);
    g->width = w;
    g->height = h;
    g->core = {};
    g->frame = 0;
    g->last_sample = 0;
    g->ring.resize(capacity);
    for (auto &s : g->ring)
      s.texture = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
    g->sample_w = std::min(w, 1280u);
    g->sample_h = std::max(1u, uint32_t(uint64_t(h) * g->sample_w / w));
    g->sample = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
    g->stage = gs_stagesurface_create(g->sample_w, g->sample_h, GS_RGBA);
  }
  uint64_t now = obs_get_video_frame_time();
  if (now != g->last_time) {
    g->last_time = now;
    auto &current = g->ring[veil_ring_index(g->frame, capacity)];
    gs_texrender_reset(current.texture);
    if (gs_texrender_begin(current.texture, w, h)) {
      vec4 clear{};
      gs_clear(GS_CLEAR_COLOR, &clear, 0, 0);
      gs_ortho(0, float(output_w), 0, float(output_h), -100, 100);
      gs_blend_state_push();
      gs_blend_function(GS_BLEND_ONE, GS_BLEND_ZERO);
      uint32_t flags = obs_source_get_output_flags(target);
      if (target == obs_filter_get_parent(g->source) &&
          !(flags & OBS_SOURCE_CUSTOM_DRAW) && !(flags & OBS_SOURCE_ASYNC))
        obs_source_default_render(target);
      else
        obs_source_video_render(target);
      gs_blend_state_pop();
      gs_texrender_end(current.texture);
      current.id = g->frame;
      current.timestamp = now;
      current.valid = true;
    }
    if (g->worker.valid() && g->worker.wait_for(std::chrono::milliseconds(0)) ==
                                 std::future_status::ready) {
      auto reply = g->worker.get();
      if (reply.ok) {
        veil_result(&g->core, g->working_frame,
                    g->working_frame + uint64_t(g->fps) * 1500 / 1000,
                    reply.boxes.data(), reply.boxes.size());
        g->last_latency = reply.latency_ms;
        g->latencies.push_back(reply.latency_ms);
        if (g->latencies.size() > 1000)
          g->latencies.erase(g->latencies.begin());
      }
    }
    if (now - g->last_sample >= 1000000000ULL / g->sample_fps) {
      uint64_t first_time = now;
      if (g->core.has_sample)
        for (auto &s : g->ring)
          if (s.valid && s.id == g->core.previous_sample + 1)
            first_time = s.timestamp;
      g->last_sample = now;
      if (!g->worker.valid() && !g->token.empty()) {
        gs_texrender_reset(g->sample);
        if (gs_texrender_begin(g->sample, g->sample_w, g->sample_h)) {
          gs_ortho(0, float(w), 0, float(h), -100, 100);
          gs_effect_t *effect = obs_get_base_effect(OBS_EFFECT_DEFAULT);
          gs_effect_set_texture(gs_effect_get_param_by_name(effect, "image"),
                                gs_texrender_get_texture(current.texture));
          while (gs_effect_loop(effect, "Draw"))
            gs_draw_sprite(gs_texrender_get_texture(current.texture), 0, w, h);
          gs_texrender_end(g->sample);
          gs_stage_texture(g->stage, gs_texrender_get_texture(g->sample));
          uint8_t *mapped = nullptr;
          uint32_t stride = 0;
          if (gs_stagesurface_map(g->stage, &mapped, &stride)) {
            std::vector<uint8_t> pixels(size_t(g->sample_w) * g->sample_h * 4);
            for (uint32_t y = 0; y < g->sample_h; y++)
              std::memcpy(pixels.data() + size_t(y) * g->sample_w * 4,
                          mapped + size_t(y) * stride, size_t(g->sample_w) * 4);
            gs_stagesurface_unmap(g->stage);
            // Register only captures actually submitted to the worker. Busy
            // ticks have no request to answer; the next capture spans them.
            veil_sample(&g->core, g->frame, first_time,
                        uint64_t(g->delay) * 1000000);
            g->working_frame = g->frame;
            g->worker = std::async(
                std::launch::async, veil_request, std::move(pixels),
                g->sample_w, g->sample_h, g->frame, now, g->stream, g->token,
                g->port,
                g->profile == VEIL_BALANCED ? g->core.late_results : 0);
          }
        }
      }
    }
    g->frame++;
  }
  slot *output = nullptr;
  for (auto &s : g->ring)
    if (s.valid && s.timestamp + uint64_t(g->delay) * 1000000 <= now &&
        (!output || s.timestamp > output->timestamp))
      output = &s;
  if (!output || veil_hold(&g->core, output->id, now, g->profile)) {
    fill(0, 0, float(output_w), float(output_h), 0xff141019);
    return;
  }
  gs_effect_t *effect = obs_get_base_effect(OBS_EFFECT_DEFAULT);
  gs_effect_set_texture(gs_effect_get_param_by_name(effect, "image"),
                        gs_texrender_get_texture(output->texture));
  while (gs_effect_loop(effect, "Draw"))
    gs_draw_sprite(gs_texrender_get_texture(output->texture), 0, output_w,
                   output_h);
  veil_box boxes[VEIL_MAX_MASKS];
  size_t n = veil_lookup(&g->core, output->id, boxes, VEIL_MAX_MASKS);
  for (size_t i = 0; i < n; i++)
    fill(boxes[i].x * output_w, boxes[i].y * output_h, boxes[i].w * output_w,
         boxes[i].h * output_h, g->color);
  if (g->test)
    fill(output_w * .2f, output_h * .2f, output_w * .4f, output_h * .2f,
         g->color);
}
static obs_properties_t *properties(void *data) {
  auto *g = static_cast<guard *>(data);
  auto *p = obs_properties_create();
  std::unique_lock<std::mutex> lock;
  if (g)
    lock = std::unique_lock<std::mutex>(g->mutex);
  obs_properties_add_bool(p, "enabled", "Enabled");
  auto *profile = obs_properties_add_list(
      p, "profile", "Profile", OBS_COMBO_TYPE_LIST, OBS_COMBO_FORMAT_INT);
  obs_property_list_add_int(profile, "Off", VEIL_OFF);
  obs_property_list_add_int(profile, "Balanced (late results can escape)",
                            VEIL_BALANCED);
  obs_property_list_add_int(profile, "Paranoid (full-frame hold)",
                            VEIL_PARANOID);
  obs_properties_add_int(p, "delay_ms", "Video delay (ms)", 300, 3000, 50);
  obs_properties_add_int(p, "sample_fps", "Sample FPS", 1, 10, 1);
  obs_properties_add_color(p, "mask_color", "Solid mask color");
  obs_properties_add_bool(p, "test_pattern", "Test pattern");
  obs_properties_add_path(p, "token_file", "Local token config", OBS_PATH_FILE,
                          "JSON (*.json)", nullptr);
  obs_properties_add_int(p, "detector_port", "127.0.0.1 detector port", 1024,
                         65535, 1);
  std::vector<double> sorted = g ? g->latencies : std::vector<double>{};
  std::sort(sorted.begin(), sorted.end());
  double p50 = sorted.empty() ? 0 : sorted[sorted.size() / 2],
         p99 = sorted.empty() ? 0
                              : sorted[std::min(sorted.size() - 1,
                                                size_t(sorted.size() * .99))];
  std::string status =
      g ? (g->last_latency > 0 ? "Connected; " : "No result; ") +
              std::string("p50 ") + std::to_string(p50) + " / p99 " +
              std::to_string(p99) + " ms; late " +
              std::to_string(g->core.late_results) + "; buffer MiB " +
              std::to_string(
                  veil_memory_bytes(g->width, g->height, g->delay, g->fps) /
                  1048576)
        : "Connect authenticated local detector";
  obs_properties_add_text(p, "status", status.c_str(), OBS_TEXT_INFO);
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
  obs_register_source(&info);
  return true;
}
