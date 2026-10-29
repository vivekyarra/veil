#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
uv sync --project detector --python 3.11
npm ci --prefix app
uv run --project detector playwright install chromium
