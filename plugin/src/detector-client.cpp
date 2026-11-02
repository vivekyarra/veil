#include "detector-client.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <obs.h>
#include <sstream>
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <winhttp.h>
#else
#include <curl/curl.h>
#endif

// Long enough for the measured CPU p99 (2.49 s) plus queueing behind the
// other in-flight request, short enough that a wedged detector is noticed.
static constexpr int receive_timeout_ms = 10000;
static constexpr size_t max_response = 1024 * 1024;

void veil_cancel::cancel() {
  std::lock_guard<std::mutex> lock(mutex_);
  cancelled_ = true;
#ifdef _WIN32
  // Closing the request handle makes a blocking WinHTTP call on the worker
  // thread return ERROR_WINHTTP_OPERATION_CANCELLED immediately.
  if (handle_)
    WinHttpCloseHandle(static_cast<HINTERNET>(handle_));
#endif
  handle_ = nullptr;
}
void veil_cancel::reset() {
  std::lock_guard<std::mutex> lock(mutex_);
  cancelled_ = false;
}
bool veil_cancel::cancelled() {
  std::lock_guard<std::mutex> lock(mutex_);
  return cancelled_;
}
bool veil_cancel::attach(void *handle) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (cancelled_)
    return false;
  handle_ = handle;
  return true;
}
void veil_cancel::detach(void *handle) {
  std::lock_guard<std::mutex> lock(mutex_);
#ifdef _WIN32
  if (handle_ == handle && handle)
    WinHttpCloseHandle(static_cast<HINTERNET>(handle));
#else
  (void)handle;
#endif
  handle_ = nullptr;
}

bool veil_token_valid(const std::string &token) {
  if (token.size() < 32 || token.size() > 512)
    return false;
  for (unsigned char ch : token)
    if (ch < 0x21 || ch > 0x7e) // rejects CR, LF, other controls, non-ASCII
      return false;
  return true;
}

static bool get_number(obs_data_t *data, const char *name, double &out) {
  obs_data_item_t *item = data ? obs_data_item_byname(data, name) : nullptr;
  if (!item)
    return false;
  bool ok = obs_data_item_gettype(item) == OBS_DATA_NUMBER;
  if (ok)
    out = obs_data_item_get_double(item);
  obs_data_item_release(&item);
  return ok && std::isfinite(out);
}

veil_reply veil_parse_reply(const std::string &json, uint64_t frame) {
  veil_reply reply;
  obs_data_t *data =
      json.empty() ? nullptr : obs_data_create_from_json(json.c_str());
  if (!data) {
    reply.error = "detector response is not JSON";
    return reply;
  }
  obs_data_item_t *list = obs_data_item_byname(data, "detections");
  obs_data_array_t *detections = nullptr;
  if (list && obs_data_item_gettype(list) == OBS_DATA_ARRAY)
    detections = obs_data_item_get_array(list);
  obs_data_item_release(&list);
  double id = -1, processed = 0;
  bool valid = detections && get_number(data, "frame_id", id) &&
               get_number(data, "processed_ms", processed) &&
               id == double(frame);
  size_t count = detections ? obs_data_array_count(detections) : 0;
  for (size_t i = 0; valid && i < count; i++) {
    obs_data_t *item = obs_data_array_item(detections, i);
    obs_data_t *box = item ? obs_data_get_obj(item, "box") : nullptr;
    double x, y, bw, bh;
    valid = box && get_number(box, "x", x) && get_number(box, "y", y) &&
            get_number(box, "w", bw) && get_number(box, "h", bh);
    if (valid) {
      // Clip to the frame rather than dropping boxes that overhang an edge.
      double x0 = std::max(0.0, x), y0 = std::max(0.0, y),
             x1 = std::min(1.0, x + bw), y1 = std::min(1.0, y + bh);
      if (x1 > x0 && y1 > y0 && reply.boxes.size() <= VEIL_MAX_MASKS)
        reply.boxes.push_back(
            veil_box{float(x0), float(y0), float(x1 - x0), float(y1 - y0)});
    }
    obs_data_release(box);
    obs_data_release(item);
  }
  obs_data_array_release(detections);
  obs_data_release(data);
  if (!valid) {
    reply.boxes.clear();
    reply.error = "malformed detector response";
    return reply;
  }
  reply.latency_ms = processed;
  reply.ok = true;
  return reply;
}

#ifndef _WIN32
static size_t append_response(char *data, size_t size, size_t count,
                              void *target) {
  auto *text = static_cast<std::string *>(target);
  if (text->size() + size * count > max_response)
    return 0;
  text->append(data, size * count);
  return size * count;
}
static int check_cancel(void *cancel, curl_off_t, curl_off_t, curl_off_t,
                        curl_off_t) {
  return static_cast<veil_cancel *>(cancel)->cancelled() ? 1 : 0;
}
#endif
veil_reply veil_request(const std::vector<uint8_t> &pixels, uint32_t w,
                        uint32_t h, uint64_t frame, uint64_t timestamp,
                        const std::string &stream, const std::string &token,
                        uint16_t port, uint64_t late_results,
                        veil_cancel &cancel) {
  veil_reply reply;
  if (!veil_token_valid(token)) {
    reply.error = "invalid token";
    return reply;
  }
  if (pixels.size() != size_t(w) * h * 4) {
    reply.error = "invalid sample";
    return reply;
  }
  std::ostringstream metadata;
  metadata << "{\"frame_id\":" << frame << ",\"timestamp_ns\":" << timestamp
           << ",\"width\":" << w << ",\"height\":" << h
           << ",\"late_results\":" << late_results
           << ",\"format\":\"rgba\",\"stream_id\":\"" << stream << "\"}";
  std::string response;
  bool complete = false;
#ifdef _WIN32
  HINTERNET session =
      WinHttpOpen(L"VEIL/0.1", WINHTTP_ACCESS_TYPE_NO_PROXY,
                  WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!session) {
    reply.error = "WinHTTP unavailable";
    return reply;
  }
  WinHttpSetTimeouts(session, 1000, 1000, 5000, receive_timeout_ms);
  HINTERNET connection = WinHttpConnect(session, L"127.0.0.1", port, 0);
  HINTERNET request =
      connection ? WinHttpOpenRequest(connection, L"POST", L"/v1/frames",
                                      nullptr, WINHTTP_NO_REFERER,
                                      WINHTTP_DEFAULT_ACCEPT_TYPES, 0)
                 : nullptr;
  if (request && !cancel.attach(request)) {
    WinHttpCloseHandle(request);
    request = nullptr;
  }
  std::string header =
      "Authorization: Bearer " + token +
      "\r\nContent-Type: application/octet-stream\r\nX-Veil-Frame: " +
      metadata.str() + "\r\n";
  std::wstring wide(header.begin(), header.end());
  DWORD status = 0;
  if (request &&
      WinHttpSendRequest(request, wide.c_str(), DWORD(-1),
                         const_cast<uint8_t *>(pixels.data()),
                         DWORD(pixels.size()), DWORD(pixels.size()), 0) &&
      WinHttpReceiveResponse(request, nullptr)) {
    DWORD length = sizeof(status);
    WinHttpQueryHeaders(request,
                        WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                        nullptr, &status, &length, nullptr);
    if (status == 200) {
      char buffer[8192];
      DWORD read = 0;
      bool more = true;
      while ((more = WinHttpReadData(request, buffer, sizeof(buffer), &read) !=
                     FALSE) &&
             read && response.size() + read <= max_response)
        response.append(buffer, read);
      complete = more && read == 0;
    }
  }
  if (request)
    cancel.detach(request);
  if (connection)
    WinHttpCloseHandle(connection);
  WinHttpCloseHandle(session);
#else
  CURL *curl = curl_easy_init();
  if (!curl) {
    reply.error = "curl unavailable";
    return reply;
  }
  std::string url = "http://127.0.0.1:" + std::to_string(port) + "/v1/frames";
  struct curl_slist *headers = nullptr;
  headers =
      curl_slist_append(headers, ("Authorization: Bearer " + token).c_str());
  headers =
      curl_slist_append(headers, ("X-Veil-Frame: " + metadata.str()).c_str());
  headers =
      curl_slist_append(headers, "Content-Type: application/octet-stream");
  curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
  curl_easy_setopt(curl, CURLOPT_PROXY, "");
  curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_POSTFIELDS, pixels.data());
  curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE_LARGE,
                   curl_off_t(pixels.size()));
  curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT_MS, 1000L);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, long(receive_timeout_ms));
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, append_response);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
  curl_easy_setopt(curl, CURLOPT_NOPROGRESS, 0L);
  curl_easy_setopt(curl, CURLOPT_XFERINFOFUNCTION, check_cancel);
  curl_easy_setopt(curl, CURLOPT_XFERINFODATA, &cancel);
  CURLcode result =
      cancel.cancelled() ? CURLE_ABORTED_BY_CALLBACK : curl_easy_perform(curl);
  long status = 0;
  curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
  curl_slist_free_all(headers);
  curl_easy_cleanup(curl);
  complete = result == CURLE_OK && status == 200;
#endif
  if (cancel.cancelled()) {
    reply.error = "cancelled";
    return reply;
  }
  if (status != 200 || !complete) {
    reply.error = status ? "detector HTTP " + std::to_string(status)
                         : "detector unreachable";
    return reply;
  }
  return veil_parse_reply(response, frame);
}
