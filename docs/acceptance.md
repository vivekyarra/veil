# Verification and operating guide

## What is checked

| Area | Evidence |
|---|---|
| Screen recognition | Generated test corpus with known ground truth: varied values, hard negatives and multi-element screens. A hit needs ≥ 90% coverage of the glyph ink box. Per-kind recall and false-positive rates are in [benchmark.md](benchmark.md). CI scores the full corpus against gates. |
| Temporal behavior | Masks scored across frame sequences on the same generated test corpus: [benchmark-temporal.md](benchmark-temporal.md). |
| Shared matching | Python and TypeScript share one set of normalization cases ([normalization-cases.json](../shared/normalization-cases.json)): homoglyphs, leetspeak, split messages and whole-word matching for short terms. |
| Native OBS | Windows filter in OBS 31.1.1 passed 38/38 pixel checks covering mask color, surrounding pixels, transparent sources and fail-closed holds with the detector unavailable. [Record](evidence/native-obs-smoke.json). |
| Delay memory | The 4:2:0 YUV ring keeps 1080p60 at full resolution with a 2.5 s delay in about 451 MiB. [Plugin notes](../plugin/README.md). |
| Desktop app | Onboarding, vault, Panic, incident detail, OCR practice, source review, Markdown / PDF export and clean shutdown. [App checks](evidence/e2e-evidence.json). |
| Twitch | Authorized OAuth and EventSub, a 720p broadcast, a Panic cover switch and a VOD marker at 111 seconds. [Live checks](evidence/live-twitch-smoke.json). |
| Chat response | Loopback contract run against local stand-ins for the Twitch services. [Timing](evidence/chat-benchmark.json). |
| Packaged apps | Windows and macOS CI builds run packaged-app interactions. [CI](https://github.com/vivekyarra/veil/actions/workflows/ci.yml) · [Windows install](evidence/windows-installer-smoke.json). |
| Accessibility | Automated WCAG A/AA checks on every route in both themes; keyboard focus stays inside approval dialogs. [Checks](evidence/accessibility.json). |
| Private text | Planted-term checks confirm that vault terms stay out of default logs and exports. Source previews are masked before they reach the renderer. |

## Choosing your stream settings

**Paranoid** is the default. Frames newer than the last finished check stay covered, including when the detector is busy or unavailable. Masks from consecutive samples are unioned, so a region that moves between samples stays covered. **Balanced** is an explicit opt-in that allows late output.

Set the delay to the sample interval plus your measured p99 processing time plus a margin. The committed run measured per-frame timing on a laptop CPU, in [benchmark.md](benchmark.md) and [benchmark-temporal.md](benchmark-temporal.md). On CPU-only hardware, Paranoid holds the cover during busy scenes; incremental OCR keeps steady scenes fast. Pre-flight measures your machine and offers **Apply measured delay**, which updates the filter and audio offsets together.


## Account actions and privacy

- **Panic** always switches OBS to the cover card. When enabled, mute-on-panic also mutes audio.
- **Moderator mode** lets a trusted moderator run VEIL for a streamer.
- **Twitch outages** do not sign you out.
- Protected accounts, including the broadcaster, get warnings instead of deletions. Chat response starts once Twitch delivers the event, so a message can't be stopped before that.
- Vault terms are matched locally. Sharing a term to Twitch's blocked-term list is a separate, explicit action, and moderators can see shared terms. Shield Mode and other extra actions need approval.
- **Rehearsal** uses practice captures and isolated account actions. Its state is saved, and a protection banner stays visible while it is on.

[Security and privacy](../SECURITY.md)
