$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
uv run --project detector pyinstaller --noconfirm --name veil-detector --onedir --collect-all rapidocr_onnxruntime --collect-all veil_detector --collect-all uvicorn --collect-all websockets --paths detector --distpath detector/dist --workpath detector/build detector/launcher.py
if ($LASTEXITCODE) { throw 'Detector freeze failed' }
npm.cmd run package --prefix app
if ($LASTEXITCODE) { throw 'Desktop installer build failed' }
