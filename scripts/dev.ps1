$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
npm.cmd run build --prefix app
if ($LASTEXITCODE) { throw 'Desktop build failed' }
npm.cmd start --prefix app
