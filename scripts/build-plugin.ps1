$ErrorActionPreference = 'Stop'
Set-Location (Join-Path (Split-Path -Parent $PSScriptRoot) 'plugin')
cmake --preset windows-x64 -DVEIL_BUILD_OBS=ON
if ($LASTEXITCODE) { throw 'OBS SDK configure failed; install Visual Studio C++ tools and Windows SDK' }
cmake --build build_x64 --config Release
if ($LASTEXITCODE) { throw 'Native plugin build failed' }
ctest --test-dir build_x64 -C Release --no-tests=error --output-on-failure
if ($LASTEXITCODE) { throw 'Native timing harness failed' }
cmake --install build_x64 --config Release --prefix dist
if ($LASTEXITCODE) { throw 'Plugin staging failed' }
