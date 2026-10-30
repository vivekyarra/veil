# Verification and operating guide

## Verified workflow

| Area | Evidence |
|---|---|
| Local recognition | Authenticated OCR service and event WebSocket; 3,000-screen controlled benchmark; all configured recall and false-positive gates pass. [Results](benchmark.md). |
| Shared matching | 208 shared Python / TypeScript normalization cases. |
| Native OBS | Windows DLL loaded in OBS 31.1.1; pixel checks verify masks, surrounding pixels, and Paranoid holds. [Record](native-obs-smoke.json). |
| Desktop app | Onboarding, vault, Panic, incident detail, OCR practice, source review, Markdown / PDF export, and clean shutdown. [App checks](e2e-evidence.json). |
| Twitch connection | Authorized OAuth and EventSub, 720p broadcast, Panic cover switch, and VOD marker at 111 seconds. Broadcaster matches produce the expected protected-user warning. [Live checks](live-twitch-smoke.json). |
| Chat response | 30 deduplicated messages processed below one second p95 against isolated HTTP / WebSocket service contracts. [Timing](chat-benchmark.json). |
| Packaged apps | Windows and macOS CI builds include actual packaged app interactions and a bundled-source audit. [CI](https://github.com/vivekyarra/veil/actions/workflows/ci.yml). |
| Published Windows install | Version 0.2.0 installed in 106.01 seconds on the existing Windows host; installed payload hashes matched CI. Bundled OCR executed and clean shutdown completed. [Install](windows-installer-smoke.json) · [Runtime](windows-installed-runtime.json). |
| Accessibility | Seven routes in both themes pass automated WCAG A/AA checks; keyboard focus stays inside approval dialogs. [Checks](accessibility.json). |
| Private text | Planted-term checks verify exclusion from default logs and exports; source previews are masked before renderer IPC. |
| Audio recovery | Apply and crash-recovery service contracts, plus clean-exit packaged app checks. |

Release assets identify their exact source commit and checksums in the attached `RELEASE-MANIFEST.json`. The [published checkpoint](published-release.json) records version 0.2.0; the CI artifacts for each later build carry their own generated manifests.

## Choose your stream settings

Paranoid is the default. It holds output until recognition checks complete, including when the worker is busy. Balanced is an explicit choice that allows late output. Inspect actual OBS output after applying settings.

The two-worker CPU benchmark measured p50 **1.35 seconds** and p99 **2.49 seconds**, excluding queue wait. Set a delay using the sample interval, measured p99, and a margin. The default 750 ms setting can result in a continuing cover on this CPU configuration. Benchmark screens use generated layouts with known ground truth; use Pre-flight and Rehearsal to check your setup.

The verification above covers the stated environments and workflows. Reference-GPU timing, sustained 1080p60, native OBS output on macOS, clean consumer-machine onboarding, and deletion of an ordinary viewer's message on live Twitch have not been qualified by these checks.

## Account actions and privacy

Live Twitch actions require account authorization and the appropriate channel permissions. Protected accounts, including the broadcaster, receive warnings rather than deletion. Chat response follows receipt of an event; it cannot retract a message before Twitch delivers it.

Adding a vault term keeps matching local. Explicit blocked-term sharing sends a selected term to Twitch, where moderators can see it. Shield Mode and additional incident actions use approval controls. Clip links support human review.

Rehearsal uses practice captures and isolated account actions; its result is displayed separately from OBS broadcast output. Reports leave out private OCR text by default. [Security and privacy](../SECURITY.md).
