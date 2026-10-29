#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../plugin"
if [[ "$(uname -s)" == Darwin ]]; then
  cmake --preset macos -DVEIL_BUILD_OBS=ON
  cmake --build build_macos --config Release
  ctest --test-dir build_macos -C Release --no-tests=error --output-on-failure
  cmake --install build_macos --config Release --prefix dist
else
  cmake -S . -B build -DVEIL_BUILD_OBS=ON
  cmake --build build
  ctest --test-dir build --no-tests=error --output-on-failure
  cmake --install build --prefix dist
fi
