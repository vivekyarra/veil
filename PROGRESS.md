# VEIL build evidence

Acceptance is recorded only after execution. Remote CI, hardware performance and live account checks remain unverified until actually run.

## M1 — tooling
Created repository structure, pinned development tooling, privacy configuration and provenance. Local tooling checks are recorded in subsequent entries; remote CI cannot be claimed without a remote repository.

## M2 — shared matcher
80 golden cases pass in Python and TypeScript (Vitest 80/80). Tests cover numeric preservation, spaced obfuscation, confusables, zero-width text, leetspeak and transposition. Cases are shared and independently specified.


## M3 — detector core
135 tests pass; measured Python coverage 90%; ruff and strict mypy pass. Actual RapidOCR on a generated JPEG returns email boxes and salted hashes without raw text. Cold model initialization plus OCR measured 17013.66 ms on this busy CPU host; this is not a warm latency claim. Auth, malformed image handling, vault update, policies, frame ordering, tracking and metadata-only events tested.


## M4 — synthetic benchmark
Generated 3000 actual 1920x1080 Playwright screenshots and DOM truth (seed 7319). A measured 42-screen smoke after OCR-boundary correction passes recall/FPR gates (6 positives per kind, 6 negatives); small-set evidence only. Warm CPU p50 5102.29 ms, p99 11921.69 ms on busy host; 750 ms delay is not validated. Required 300-screen gate run is in progress. Full corpus inference is not yet measured. M4 acceptance pending that larger run.


## M5 — native filter
GCC -Wall -Wextra -Werror compiled portable filter core and the executable harness passed 100000 ring wraps, sampling-gap masks, deadline boundary, late-result profiles, hold and bounded stores. Native OBS render/staging/HTTP filter implemented; libobs SDK compilation and real OBS/GPU performance remain unverified. Upstream template scaffolding pinned in DECISIONS.md. M5 full acceptance pending platform builds/runtime.


## M6 — window guard
Win32 visible-window enumeration, Quartz permission fallback and X11 best effort implemented. Coordinate mapping and permission fallback tests pass in the 138-test Python suite. Server polls at 5 Hz; Paranoid maps unknown capture coordinates to full-frame masks. Native macOS permission behavior and real capture-coordinate calibration remain unverified.


## M7 — desktop foundation
Electron 45.1.0 + React/Vite strict TypeScript build passes. SQLite settings, secure local token ACLs, detector supervisor, OBS JSON v5 client and durable audio rollback implemented. Actual Electron E2E traversed onboarding against a real loopback OBS v5 contract server, applied offsets and verified restoration at clean exit; crash restoration separately tested. The run is recorded in docs/e2e-evidence.json.


## M8 — Twitch layer
Device-code polling, serialized rotating refresh, startup/hourly validation, priority/rate-aware Helix, EventSub dedupe/reconnect and six-hour bounded chat ring implemented. Loopback HTTP/WebSocket contract integration passes. Official Twitch CLI execution and real credentials are not yet verified; local contract mocks do not count as CLI or live proof.


## M9 — private chat guard
AES-256-GCM vault key protected by Electron safeStorage, PIN reveal with lockout, per-entry blocked-term opt-in and private fuzzy chat moderation implemented. Real Electron E2E adds, unlocks, reveals and deletes a planted synthetic entry. HTTP/WebSocket mock benchmark deletes 30 deduplicated obfuscated messages within 1 s p95; latest measurement in docs/chat-benchmark.json. Private terms absent from emitted guard events and encrypted database bytes.


## M10 — incident engine
Auto/Ask/Off actions, default-No approval, panic, repeat-offender handling, lifecycle, delayed clips, metadata-only Discord payload and Markdown/PDF reports implemented. Actual Electron E2E produced Markdown and real PDF exports; panic and incident timeline pass against isolated rehearsal actions. Loopback action tests verify cover/marker/guard success, declined Shield Mode, and no planted term in default reports. Native hotkey under a game and live Twitch actions remain unverified.

## M11 — pre-flight and rehearsal

Implemented measured detector latency/configuration checks, permission availability, manual VOD/notification acknowledgements, source-by-source OCR with pixel-redacted previews before IPC, four actual synthetic OCR scenarios, and isolated simulated moderation. Real Electron E2E verifies the flows and scans planted terms from process output. Balanced CPU results are late and intentionally shown unmasked; native reference-GPU before-output acceptance remains pending. Source preview masks are verified from bitmap pixels, not only DOM state.

## M12 — packaging (partial acceptance)

PyInstaller bundled models and the local detector. An unsigned Windows NSIS installer was produced locally. Real Windows OBS 31.1.1 loaded the DLL; synthetic pixel checks passed for test masking, preserved outside pixels and Paranoid unavailable-detector cover (3510 short-smoke frames, zero skipped). Native timing CTest passes. Final-source frozen/installer rebuild is underway. macOS packaging, remote CI artifacts and clean-machine five-minute onboarding are pending.

## M13 — polish and documentation (partial acceptance)

Seven desktop pages, dark/light themes, keyboard focus styles and reduced-motion handling implemented. README, privacy/security guidance, architecture, honest demo script, submission draft and acceptance ledger now describe measured limitations. Automated accessibility audit is underway; no certification is claimed. Human public recording, publication and submission are not performed.

## Verification update — 2026-10-30 IST

273 Python tests pass with 89.64% whole-package coverage; ruff format/check and strict mypy pass using detector/pyproject.toml. 231 TypeScript tests pass with 81.55% line coverage over service modules (Electron main/preload excluded; main is exercised by E2E). ESLint and strict TypeScript build pass. Shared golden set expanded to 208 Unicode/obfuscation cases in both languages. Regression checks cover adjacent-line duplicate masks, distinct same-frame tracks, active-incident Panic, guard Off and rescheduled incident closure.

Full 3000-image one-to-one geometric benchmark completed: card 416/429 (96.97%) fails required 97%; other recall gates and 0.47% negative FPR pass. Concurrent CPU p50/p99 8.78/26.52 seconds excludes queue wait and cannot justify default750ms protection. Exact frozen source and per-image predictions are retained. Earlier weaker scoring is superseded. M4 acceptance remains open.

Official Twitch CLI 1.1.24 actually executed on loopback: four production subscriptions accepted, channel.chat.message rejected; incomplete state surfaced correctly. Local Fastify fallback covers unsupported chat/device-code contracts. Live-account acceptance remains open. Intel Iris Xe DirectML initialization did not complete in 338.6seconds; experimental provider swapping removed from production rather than shipped unverified.

Real Electron clean quit now passes after Playwright detaches the Node inspector; audio offsets restore to original values. Cold Windows detector startup has a bounded two-minute allowance and immediate child-exit detection. The complete Definition of Done remains open; see docs/acceptance.md.

Final polish checks: all seven pages in both themes have zero automated axe WCAG A/AA violations. Corrected light-mode contrast; approval focus cycles within the modal and Escape declines. Metadata diagnostics export excludes tokens, vault contents and chat. Electron E2E asserts that export and focus behavior. Latest service coverage is 81.56%. deptry 0.25.1 passes production dependency analysis with explicit PIL/Quartz mappings and the documented dynamic WebSocket backend exception. ts-prune found ten module-internal exports, now made private. clang-format 23.1.3 applied to native source; CTest still passes. These audits supplement rather than replace manual accessibility/platform review.

Packaged Windows VEIL.exe passes the complete real Electron E2E using its bundled frozen detector: actual OCR, all14 page/theme accessibility scans, source mask pixels, vault, panic, approval focus, metadata diagnostics, Markdown/PDF and clean audio rollback. app.asar main/index hashes match the compiled tested build. Frozen detector independently passes authenticated HTTP, event WebSocket and synthetic-email OCR; measured15.31s cold frame is not a latency guarantee. Final NSIS compression is finishing; clean-machine installer execution remains unverified.

Final Windows NSIS build completed successfully. Installer is unsigned (Authenticode NotSigned). Release audit compares packaged main/index and detector/plugin binaries against the tested outputs and records SHA-256 hashes in docs/release-manifest.json. No real streaming sources were opened, no live Twitch actions were performed, and nothing was publicly pushed or submitted. M12/M13 remain partially accepted because remote/platform/human and performance gates are outstanding.

