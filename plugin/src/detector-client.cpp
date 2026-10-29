#include "detector-client.h"
#include <chrono>
#include <obs.h>
#include <sstream>
#ifdef _WIN32
#include <windows.h>
#include <winhttp.h>
#else
#include <curl/curl.h>
#endif

#ifndef _WIN32
static size_t append_response(char *data, size_t size, size_t count,
                              void *target) {
  auto *text = static_cast<std::string *>(target);
  if (text->size() + size * count > 1024 * 1024)
    return 0;
  text->append(data, size * count);
  return size * count;
}
#endif
veil_reply veil_request(const std::vector<uint8_t> &pixels, uint32_t w,
                        uint32_t h, uint64_t frame, uint64_t timestamp,
                        const std::string &stream, const std::string &token,
                        uint16_t port, uint64_t late_results) {
  veil_reply reply;
  if (token.size() < 32 || pixels.size() != size_t(w) * h * 4)
    return reply;
  std::ostringstream metadata;
  metadata << "{\"frame_id\":" << frame << ",\"timestamp_ns\":" << timestamp
           << ",\"width\":" << w << ",\"height\":" << h
           << ",\"late_results\":" << late_results
           << ",\"format\":\"rgba\",\"stream_id\":\"" << stream << "\"}";
  std::string response;
#ifdef _WIN32
  HINTERNET session =
      WinHttpOpen(L"VEIL/0.1", WINHTTP_ACCESS_TYPE_NO_PROXY,
                  WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!session)
    return reply;
  WinHttpSetTimeouts(session, 1000, 1000, 5000, 30000);
  HINTERNET connection = WinHttpConnect(session, L"127.0.0.1", port, 0);
  HINTERNET request =
      connection ? WinHttpOpenRequest(connection, L"POST", L"/v1/frames",
                                      nullptr, WINHTTP_NO_REFERER,
                                      WINHTTP_DEFAULT_ACCEPT_TYPES, 0)
                 : nullptr;
  std::string header =
      "Authorization: Bearer " + token +
      "\r\nContent-Type: application/octet-stream\r\nX-Veil-Frame: " +
      metadata.str() + "\r\n";
  std::wstring wide(header.begin(), header.end());
  if (request &&
      WinHttpSendRequest(request, wide.c_str(), DWORD(-1),
                         const_cast<uint8_t *>(pixels.data()),
                         DWORD(pixels.size()), DWORD(pixels.size()), 0) &&
      WinHttpReceiveResponse(request, nullptr)) {
    DWORD status = 0, length = sizeof(status);
    WinHttpQueryHeaders(request,
                        WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                        nullptr, &status, &length, nullptr);
    if (status == 200) {
      char buffer[8192];
      DWORD read = 0;
      while (WinHttpReadData(request, buffer, sizeof(buffer), &read) && read &&
             response.size() + read <= 1024 * 1024)
        response.append(buffer, read);
    }
  }
  if (request)
    WinHttpCloseHandle(request);
  if (connection)
    WinHttpCloseHandle(connection);
  WinHttpCloseHandle(session);
#else
  CURL *curl = curl_easy_init();
  if (!curl)
    return reply;
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
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_POSTFIELDS, pixels.data());
  curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE_LARGE,
                   curl_off_t(pixels.size()));
  curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, 30000L);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, append_response);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
  CURLcode status = curl_easy_perform(curl);
  long http = 0;
  curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http);
  curl_slist_free_all(headers);
  curl_easy_cleanup(curl);
  if (status != CURLE_OK || http != 200)
    return reply;
#endif
  obs_data_t *data = obs_data_create_from_json(response.c_str());
  if (!data)
    return reply;
  obs_data_array_t *detections = obs_data_get_array(data, "detections");
  for (size_t i = 0; i < obs_data_array_count(detections) && i < VEIL_MAX_MASKS;
       i++) {
    obs_data_t *item = obs_data_array_item(detections, i),
               *box = obs_data_get_obj(item, "box");
    veil_box b{float(obs_data_get_double(box, "x")),
               float(obs_data_get_double(box, "y")),
               float(obs_data_get_double(box, "w")),
               float(obs_data_get_double(box, "h"))};
    if (b.x >= 0 && b.y >= 0 && b.w > 0 && b.h > 0 && b.x + b.w <= 1.001 &&
        b.y + b.h <= 1.001)
      reply.boxes.push_back(b);
    obs_data_release(box);
    obs_data_release(item);
  }
  reply.latency_ms = obs_data_get_double(data, "processed_ms");
  reply.ok = true;
  obs_data_array_release(detections);
  obs_data_release(data);
  return reply;
}
