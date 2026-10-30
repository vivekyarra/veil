# VEIL — submission draft

Not submitted. Official event requirements were checked on 30 October 2026 IST; see [readiness checklist](hackathon-readiness.md). Live account authorization is complete; the final public YouTube URL is still required. Repository: https://github.com/vivekyarra/veil.

## Inspiration

A screen leak can spread through chat and remain in clips. Shared moderation terms can also disclose information the streamer wanted private. VEIL explores local prevention alongside private moderation and incident response.

## What it does

An Electron app coordinates a native OBS filter and local OCR detector. Delayed source frames receive solid masks; Balanced permits late frames and Paranoid covers them. An encrypted Never Show vault feeds local matching. Twitch integrations support deletion, repeat-offender handling, markers, optional Shield Mode and clip review. Panic creates a metadata incident journal. Pre-flight and offline Rehearsal expose configuration and failure modes.

Version 0.2 defaults to Paranoid. It also covers output newer than the last confirmed sample during worker stalls. This closes a fail-closed correctness gap, but slow CPU inference can keep output covered; it does not establish the original 750 ms GPU latency target. Public Client ID setup is available directly in onboarding.

## How we built it with Codex

One main Codex chat followed a milestone specification, shared normalization cases, deterministic screenshot generation and local HTTP/WebSocket contracts. Real Electron interactions and native OBS pixel tests exercise distinct parts of the system. Benchmark evidence preserves source archives, model hashes and per-image results. Chat ID: `01a187d8-7c89-7993-bb7c-340d3f64dc8f`; see build-provenance.json.

## Challenges and accomplishments

Frame alignment, skipped samples, late results, audio rollback, Unicode obfuscation and excluding private text from diagnostics required explicit tests. The latest full 3,000-image synthetic run measured recall: email 99.77%, cards 99.77%, secrets 99.30%, vault 100%, phones 99.77%, addresses 99.77%; negative FPR 0.47%. All unchanged recall/FPR gates pass. Two concurrent CPU workers measured p50/p99 of 1.35/2.09 seconds excluding queue wait. These controlled layouts do not prove real-world recall or safe default-delay streaming. The earlier failing run remains available for comparison.

The Windows filter loaded in OBS and passed synthetic mask/Paranoid checks. Thirty deduplicated synthetic chat messages were deleted below one second p95 against local contracts. Actual Electron onboarding, vault, panic, OCR rehearsal, masked source previews, PDF export and clean rollback pass. Real Twitch OAuth and EventSub connected on yarravivek; a 720p broadcast, Panic scene switch and VOD marker at 111 seconds were verified. An obfuscated broadcaster message produced the expected protected-user warning. Windows and macOS packages passed CI, including packaged Windows E2E. Reference GPU, sustained rendering, clean-machine acceptance and live viewer deletion remain separate validation limits.

## Privacy, prior art and next steps

OCR is local; vault AES-GCM keys use OS-protected storage. Default reports omit private text. Explicit blocked-term sharing sends selected terms to Twitch; optional Discord sends incident metadata. Reactive moderation can permit brief visibility.

Related work includes obs-pii-redactor, ScreenLeak and browser redaction extensions. VEIL combines their prevention problem with private chat matching and incident response. It uses RapidOCR, ONNX Runtime, libobs and official plugin scaffolding. Screenpipe's noncommercial redactor is not bundled.

Next: validate reference-GPU execution/output timing and sustained streams, and review accessibility/privacy independently. IRL and audio leak detection are outside this prototype.

## Submission tasks

The source and eight work branches are published. Add the public YouTube demo URL after upload, confirm claims against current evidence and event requirements, then submit manually. No Devpost submission has been performed by the agent.
