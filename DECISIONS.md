# Decisions and evidence limits

- Build specification read in full on 2026-10-29. No applicable ancestor or repository AGENTS.md exists.
- One main chat, no delegated build agents. Session identifier is taken from CODEX_THREAD_ID and CODEX_SESSION_ID, not guessed.
- No .env existed at initialization. Live Twitch actions require a registered public client and explicit sign-in.
- Devpost connection was reported unauthorized by the parent chat. Official event eligibility, deadline and submission fields are unverified. Dates in the supplied specification are user-provided claims.
- Synthetic fixtures use reserved example domains, documentation IP ranges and fake credentials. No captured user desktop data is committed.
- Official Twitch contracts: https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/ and https://dev.twitch.tv/docs/eventsub/handling-websocket-events/ checked during build. Public-client refresh tokens rotate once; reconnect handoff retains subscriptions and keeps the original socket until the new welcome.

- OCR uses bundled RapidOCR ONNX CPU models initially. GPU provider performance is not established. Change detection currently conservatively reruns full OCR on detected change rather than unsafe cropped tile boundaries; unchanged frames reuse results with a two-second forced refresh. Tracker unions old/new boxes to avoid smoothing inward over exposed edges.
- Node 24 lacks a prebuilt binary for the initially selected SQLite version. Upgrade to current better-sqlite3 13.0.3 and Electron 45.1.0 verified via npm registry. Native dependency builds require matching ABI; packaging proof will be recorded separately.


- OBS upstream template revision 3e7d7ac3b5342cd7d9b88890b9c70b472d1520fc retained as build scaffolding reference. Portable core builds separately from libobs. Native filter runtime and Windows/macOS SDK builds are separate gates, not implied by headless tests. Upstream helper licensing must remain intact.
- Address smoke misses traced to OCR collapsing CamelCase street text (e.g. synthetic house number joined directly to SyntheticMapleStreet); canonicalize those OCR boundaries before address recognition.


- Restarted the full-corpus inference pass after 225/3000 screens to use four independent OCR workers (two ORT threads each). Accuracy still uses real pixels and independent state per screen. Concurrent-worker latency is reported as such and is not live-stream performance. The separate completed 300-screen single-worker result remains preserved.

- The completed full run uses one-to-one IoU >= 0.30 after clipping DOM truth to visible pixels. Earlier weak image-hit scoring and an aborted out-of-bounds run are superseded, not acceptance evidence. Exact full-run source is archived with predictions; subsequent formatting/provider cleanup does not rewrite that provenance.
- Card misses inspected on actual pixels include entirely missing tiny OCR lines and a dropped digit. Do not relax Luhn, lower gates, or invent card digits to pass the benchmark. The 96.97% failure remains open.
- Isolated Intel Iris Xe / onnxruntime-directml 1.23.0 initialization did not complete in 338.6 seconds. Removed the experimental session replacement from shipping code. CPU remains explicit; GPU validation is a release blocker.
- Official Twitch CLI v1.1.24 executed locally, bound explicitly to 127.0.0.1. It accepts stream/shield subscriptions but rejects channel.chat.message. Production EventSub reports incomplete setup. Local Fastify chat/device-code contracts cover missing CLI features. CLI mock-api binds all interfaces without a host option, so it is not used for the local-only test contract. No live Twitch proof is claimed.
- Playwright Electron clean shutdown must detach the Node inspector through desktop.close(); app.quit alone can leave debugger attachment blocking process exit. Clean audio rollback is asserted after real process termination.
- Screenpipe's pii-image-redactor is CC BY-NC 4.0 and is not bundled. The OBS-linked plugin follows GPL-2.0-or-later; retain official template notices separately from the MIT app/detector.

