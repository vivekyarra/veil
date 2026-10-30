# Architecture

VEIL connects three local components and one authorized service.

| Component | Role |
|---|---|
| Electron / React app | Onboarding, encrypted Never Show vault, Pre-flight, Rehearsal, and incident review |
| Native OBS filter | Frame delay, solid privacy masks, sample deadlines, and Paranoid hold policy |
| Python detector | RapidOCR / ONNX Runtime inference, recognizers, change detection, and region tracking |
| Twitch integration | Device OAuth, EventSub chat events, and approved Helix actions |

Pixels travel over authenticated IPv4 loopback. The detector uses a random per-install bearer token and disables access logs. OCR text and pixels stay in local process memory. The renderer uses context isolation, a sandbox, and narrow IPC.

The vault encrypts terms with AES-256-GCM; Electron safeStorage wraps the key. Default incident exports contain metadata rather than recognized private text. Optional Discord webhooks carry incident metadata. Explicit blocked-term sharing sends selected terms to Twitch, where channel moderators can see them.

## Licenses and acknowledgements

- Desktop and detector source: [MIT](../LICENSE).
- OBS-linked plugin: [GPL-2.0-or-later](../plugin/LICENSE.md).
- Plugin scaffolding: official [obs-plugintemplate](https://github.com/obsproject/obs-plugintemplate), revision `3e7d7ac3b5342cd7d9b88890b9c70b472d1520fc`; [upstream license](../plugin/UPSTREAM-LICENSE) and notices are retained.
- OCR: [RapidOCR](https://github.com/RapidAI/RapidOCR) and [ONNX Runtime](https://github.com/microsoft/onnxruntime). Package builds collect third-party license notices.
- Related work: [obs-pii-redactor](https://github.com/georgebreen/obs-pii-redactor), ScreenLeak, and browser redaction extensions. VEIL brings screen masking, private chat matching, and incident control into a connected streamer workflow.

The Screenpipe noncommercial image redactor is not included. See [security and privacy](../SECURITY.md) for deployment boundaries.
