#pragma once
#include "guard-core.h"
#include <cstdint>
#include <mutex>
#include <string>
#include <vector>
struct veil_reply {
  bool ok = false;
  double latency_ms = 0;
  std::string error;
  // At most VEIL_MAX_MASKS + 1 boxes: one more than the core can hold, so an
  // oversized response reaches the core and is held instead of truncated.
  std::vector<veil_box> boxes;
};
// Shared by a worker and its owner. cancel() aborts an in-flight request from
// another thread so shutdown never waits for the receive timeout.
class veil_cancel {
public:
  void cancel();
  void reset();
  bool cancelled();
  bool attach(void *handle);
  void detach(void *handle);

private:
  std::mutex mutex_;
  bool cancelled_ = false;
  void *handle_ = nullptr;
};
// Header-safe bearer token: 32..512 printable ASCII characters, no CR/LF.
bool veil_token_valid(const std::string &token);
// Parses and validates a detector response. Anything malformed is an error.
veil_reply veil_parse_reply(const std::string &json, uint64_t frame);
veil_reply veil_request(const std::vector<uint8_t> &pixels, uint32_t w,
                        uint32_t h, uint64_t frame, uint64_t timestamp,
                        const std::string &stream, const std::string &token,
                        uint16_t port, uint64_t late_results,
                        veil_cancel &cancel);
