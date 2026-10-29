# Security and privacy

Report vulnerabilities privately through the repository host's private security reporting when enabled. Do not put real vault terms, tokens, screenshots or chat logs in public issues; use synthetic reproductions.

The local desktop user is trusted. VEIL cannot protect a compromised operating system or prevent same-user processes from accessing memory. Keep OBS WebSocket credentials private and never forward the detector port. Detector requests require a per-install bearer token on loopback.

AES-256-GCM vault encryption uses a random key wrapped by Electron safeStorage, with no plaintext fallback. PIN reveal limits casual UI access; it is not a cryptographic boundary against someone controlling the user account. Optional blocked-term sharing deliberately discloses selected terms to Twitch/moderators. Discord webhooks are credentials and should be rotated if exposed.

Default exports omit private OCR text. Source previews are masked before renderer IPC. Committed evidence uses synthetic data. Installers are unsigned; macOS and independent security review remain pending. Balanced permits late frames; Paranoid covers missing/late results. Neither guarantees recognition of every secret. Inspect actual output and measured latency before streaming.
