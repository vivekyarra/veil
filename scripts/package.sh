#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
uv run --project detector pyinstaller --noconfirm --name veil-detector --onedir --collect-all rapidocr_onnxruntime --collect-all veil_detector --collect-all uvicorn --collect-all websockets --paths detector --distpath detector/dist --workpath detector/build detector/launcher.py
npm run package --prefix app
