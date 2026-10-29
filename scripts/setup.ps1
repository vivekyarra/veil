$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
uv sync --project detector --python 3.11
if ($LASTEXITCODE) { throw 'Python dependency setup failed' }
npm.cmd ci --prefix app
if ($LASTEXITCODE) { throw 'Desktop dependency setup failed' }
uv run --project detector playwright install chromium
if ($LASTEXITCODE) { throw 'Benchmark browser setup failed' }
Write-Output 'Development environment ready. Copy .env.example to .env for live account setup.'
