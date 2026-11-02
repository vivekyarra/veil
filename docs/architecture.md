# Architecture

VEIL connects three local components and one authorized service.

| Component | Role |
|---|---|
| Electron / React app | Guided onboarding, encrypted Never Show vault, Pre-flight, Rehearsal, chat guard, incident engine, cover card and overlay badge server |
| Native OBS filter (`plugin/`) | 4:2:0 YUV delay ring (with an optional alpha plane for transparent sources), solid `#7c5cff` masks, union masks between samples, sample deadlines and fail-closed holds |
| Python detector (`detector/`) | Engine pool of RapidOCR / ONNX Runtime workers, change detection with incremental OCR on changed regions, recognizers for cards, emails, phones, addresses, IPs, IBANs, national IDs, secrets and vault terms |
| Twitch integration | Device OAuth, EventSub chat events and approved Helix actions, with moderator mode for running VEIL on someone else's channel |

## Data flow

1. The filter stores each delayed frame in the YUV ring and sends a sampled RGBA capture to the detector over authenticated loopback.
2. The detector returns regions. The filter draws masks over every frame the result covers. A frame with no finished check stays held (Paranoid).
3. Chat messages from EventSub are normalized (Unicode folding, homoglyphs, leetspeak, joining split messages) and matched against the vault. The same normalization cases run in Python and TypeScript.
4. A match or a Panic opens an incident. Panic always switches OBS to the cover card and can mute audio. Other Twitch actions go through approval controls.
5. The overlay server on loopback only sends counts and timestamps to the on-stream badge. It never sends text.

## Trust boundaries

Pixels and OCR text stay in local process memory. The detector requires a random per-install bearer token and disables access logs. The renderer runs sandboxed with context isolation and a narrow IPC surface (`app/electron/ipc/`). The vault encrypts terms with AES-256-GCM, and Electron safeStorage wraps the key. Default incident exports contain metadata, not recognized text. Optional Discord webhooks carry incident metadata. Sharing a blocked term sends it to Twitch, where channel moderators can see it.

## Licenses and acknowledgements

- Desktop and detector source: [MIT](../LICENSE).
- OBS-linked plugin: [GPL-2.0-or-later](../plugin/LICENSE.md).
- Plugin scaffolding: official [obs-plugintemplate](https://github.com/obsproject/obs-plugintemplate), revision `3e7d7ac3b5342cd7d9b88890b9c70b472d1520fc`; [upstream license](../plugin/UPSTREAM-LICENSE) and notices are retained.
- OCR: [RapidOCR](https://github.com/RapidAI/RapidOCR) and [ONNX Runtime](https://github.com/microsoft/onnxruntime). Package builds collect third-party license notices.
- Related work: [obs-pii-redactor](https://github.com/georgebreen/obs-pii-redactor), ScreenLeak and browser redaction extensions. VEIL combines screen masking, private chat matching and incident control in one streamer workflow.

The Screenpipe noncommercial image redactor is not included. See [security and privacy](../SECURITY.md).
