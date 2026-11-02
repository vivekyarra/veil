# AGENTS.md

Instructions for Codex and other coding agents working in this repository.

## What VEIL is

A local privacy control room for OBS and Twitch. Three local components plus Twitch:

| Path | Component | Language |
|---|---|---|
| `app/` | Electron main process (`app/electron/`) and React renderer (`app/src/`): onboarding, Never Show vault, Pre-flight, Rehearsal, chat guard, incident engine, overlay badge server | TypeScript |
| `plugin/` | Native OBS filter: YUV delay ring, masks, frame policy (`plugin/src/guard-core.c` is the pure, testable core) | C / C++ |
| `detector/` | Local OCR service: RapidOCR engine pool, change detection, recognizers, numeric rescue | Python 3.11 |
| `bench/` | Generated test corpus (`generate.py`), scoring (`evaluate.py`), temporal benchmark (`temporal.py`), gates | Python |
| `shared/` | `normalization-cases.json`, run by both the TypeScript and Python test suites | JSON |
| `scripts/` | Setup, dev, plugin build, packaging, release audit and smoke scripts | PowerShell / sh / Node |
| `docs/` | Architecture, development, verification guide, benchmark reports; recorded run output lives in `docs/evidence/` | Markdown / JSON |

## Setup

Node.js 24, uv with Python 3.11, CMake, and Visual Studio 2022 C++ tools (Windows) or Xcode tools (macOS).

```powershell
./scripts/setup.ps1   # or ./scripts/setup.sh
./scripts/dev.ps1     # run the app against a local detector
```

## Build and test (mirrors `.github/workflows/ci.yml`)

Detector, from the repo root:

```powershell
uv sync --project detector --python 3.11
uv run --project detector ruff check detector
uv run --project detector ruff format --check detector
uv run --project detector mypy --config-file detector/pyproject.toml detector/veil_detector
uv run --project detector pytest detector/tests --cov=veil_detector --cov-fail-under=85
uv run --project detector python scripts/check-crumbs.py
uvx deptry==0.25.1 detector/veil_detector --config detector/pyproject.toml
```

App, from `app/`:

```powershell
npm ci
npm run lint            # eslint + tsc --noEmit
npm run format:check    # prettier
npx --yes ts-prune@0.10.3 -p tsconfig.json -e
npm run test:coverage -- --coverage.thresholds.lines=80
npm run build
npm run test:e2e        # Electron end-to-end run; needs the detector synced
```

Plugin, from the repo root:

```powershell
uvx clang-format==23.1.3 --dry-run --Werror plugin/src/guard-core.c plugin/src/guard-core.h plugin/src/detector-client.cpp plugin/src/detector-client.h plugin/src/veil-filter.cpp plugin/tests/test-core.c
cmake -S plugin -B plugin/build
cmake --build plugin/build --config Release
ctest --test-dir plugin/build -C Release --no-tests=error --output-on-failure
```

Full OBS build and packaging: `./scripts/build-plugin.ps1` and `./scripts/package.ps1` (or the `.sh` versions). Benchmark commands are in [docs/development.md](docs/development.md).

## Conventions

- **Keep CI green.** Run the checks for every component you touch before you finish.
- **No crumbs.** `scripts/check-crumbs.py` rejects committed `.env` files, task-marker comments, `console.log(`, `.skip(` / `.only(` in tests, and `print(` in `detector/veil_detector/`.
- **Formatting is enforced:** Prettier for `app/`, Ruff for Python, clang-format for `plugin/`.
- **Normalization changes go in both languages.** Update `app/electron/guard/normalize.ts`, `detector/veil_detector/normalize.py` and add a case to `shared/normalization-cases.json`.
- **Fail closed.** In Paranoid mode a frame without a finished check stays covered. Never weaken a hold or a mask to make a test pass.
- **Private text stays local.** Vault terms and OCR text must not reach logs, exports, the overlay server or the renderer unmasked. The overlay sends counts and timestamps only.
- **Twitch actions go through the incident engine**, respecting each action's mode (`auto`, `ask`, `off`). Rehearsal actions stay isolated from the real account.
- **Renderer IPC** is narrow and defined in `app/electron/ipc/`; add new channels there.
- **Evidence output** is written to `docs/evidence/`. Do not hand-edit those JSON files.
- **Pinned versions:** keep exact versions for tools invoked with `uvx` / `npx` in CI.
