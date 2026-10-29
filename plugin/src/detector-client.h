#pragma once
#include "guard-core.h"
#include <cstdint>
#include <string>
#include <vector>
struct veil_reply {
  bool ok = false;
  double latency_ms = 0;
  std::vector<veil_box> boxes;
};
veil_reply veil_request(const std::vector<uint8_t> &pixels, uint32_t w,
                        uint32_t h, uint64_t frame, uint64_t timestamp,
                        const std::string &stream, const std::string &token,
                        uint16_t port, uint64_t late_results);
