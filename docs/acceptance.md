# Acceptance ledger

The full specification's Definition of Done is not yet met.

| Gate | State |
|---|---|
| Shared matcher | 208 shared Python/TypeScript golden cases pass |
| Detector | Actual OCR, authenticated HTTP and event WebSocket executed |
| Full benchmark | 3,000 images completed; card 416/429 fails 97%; other recall/FPR gates pass |
| Native filter | Windows DLL loaded in OBS; synthetic pixel checks and portable timing harness pass |
| Sustained rendering/reference GPU | Pending; short OBS smoke is insufficient |
| Native platform CI | Configured; remote execution pending |
| Electron flows | Onboarding, vault, panic, export, actual OCR, masked source preview and clean quit pass |
| Twitch | Official CLI accepts four subscriptions, rejects chat; fallback local contracts pass; live pending |
| Chat latency | 30 deduplicated messages below 1 second p95 on local contracts; chat-benchmark.json |
| Pre-flight/rehearsal | Four actual synthetic OCR scenarios; CPU Balanced is late |
| Packaging | Final unsigned Windows NSIS built; packaged app passes complete Electron E2E with frozen detector; macOS/clean-machine pending |
| Accessibility | Seven page routes in both themes have zero automated WCAG A/AA violations; approval focus tested; manual review remains |
| Private-text exclusion | Planted-term unit/Electron checks pass for default events/exports |
| Audio rollback | Apply/crash recovery contracts and clean-exit Electron check pass |
| Public demo/submission | Human tasks; not performed |

CPU p99 26.5 seconds under concurrent load exceeds the maximum configured delay. Default 750 ms Balanced protection is not demonstrated. GPU timing and real-stream checks are release blockers.
