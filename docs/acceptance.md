# Acceptance ledger

The full specification's Definition of Done is not yet met.

| Gate | State |
|---|---|
| Shared matcher | 208 shared Python/TypeScript golden cases pass |
| Detector | Actual OCR, authenticated HTTP and event WebSocket executed |
| Full benchmark | 3,000 images completed; card 428/429 (99.77%); all unchanged recall/FPR gates pass; benchmark-ci.json |
| Native filter | Windows DLL loaded in OBS; synthetic pixel checks and portable timing harness pass |
| Sustained rendering/reference GPU | Pending; short OBS smoke is insufficient |
| Native platform CI | Windows and macOS compilation, CTest and native packaging pass in run 41065360278 |
| Electron flows | Onboarding, vault, panic, export, actual OCR, masked source preview and clean quit pass |
| Twitch | Real yarravivek OAuth/EventSub, 720p broadcast, Panic cover and marker at 111 seconds verified; broadcaster match warns; live viewer deletion not claimed; live-twitch-smoke.json |
| Chat latency | 30 deduplicated messages below 1 second p95 on local contracts; chat-benchmark.json |
| Pre-flight/rehearsal | Four actual synthetic OCR scenarios; CPU Balanced is late |
| Packaging | Windows NSIS and macOS DMG built in green CI; Windows installed in 72.11 seconds on this existing machine; clean-machine setup pending |
| Accessibility | Seven page routes in both themes have zero automated WCAG A/AA violations; approval focus tested; manual review remains |
| Private-text exclusion | Planted-term unit/Electron checks pass for default events/exports |
| Audio rollback | Apply/crash recovery contracts and clean-exit Electron check pass |
| Demo/submission | Recorded edit, neural voice and captions prepared; opening 8 seconds reserved for participant clip; public YouTube URL and human entry still required |

Latest two-worker CI CPU p99 is 2.49 seconds, excluding queue wait. This exceeds the default 750 ms delay. Version 0.2 defaults to Paranoid and covers unverified frames; slow inference can keep output covered. Reference-GPU timing and sustained 1080p60 performance remain unverified. The earlier failing benchmark is retained as historical baseline, not current acceptance.
