# Development

Run setup before development, and keep OBS WebSocket bound to your local machine.

```powershell
./scripts/setup.ps1
./scripts/dev.ps1
./scripts/build-plugin.ps1
./scripts/package.ps1
```

The matching `.sh` scripts support macOS. Native dependency builds require Visual Studio 2022 C++ tools and the Windows SDK, or Xcode tools on macOS. The OBS template downloads pinned SDK dependencies.

## Verify a change

```powershell
uv run --project detector ruff check detector
uv run --project detector mypy --config-file detector/pyproject.toml detector/veil_detector
uv run --project detector pytest detector/tests --cov=veil_detector --cov-fail-under=85
npm.cmd run lint --prefix app
npm.cmd run format:check --prefix app
npm.cmd run test:coverage --prefix app
npm.cmd run build --prefix app
npm.cmd run test:e2e --prefix app
```

CI also builds the native plugin and packages on Windows and macOS, runs packaged app interactions on each OS, and audits the bundled source and binaries.

## Reproduce the benchmark

```powershell
uv run --project detector playwright install chromium
uv run --project detector python bench/generate.py --count 3000 --output bench/data-ci
uv run --project detector python bench/evaluate.py --data bench/data-ci --output docs/benchmark-ci --workers 2
```

The corpus consists of generated practice screens with DOM-derived ground truth. Prediction caching requires matching detector source, models, corpus, runtime, hardware environment, and worker settings; each reused image also requires a matching pixel hash. Existing prediction records retain their measured timing. A new environment performs fresh inference. [Current scoring](benchmark.md).
