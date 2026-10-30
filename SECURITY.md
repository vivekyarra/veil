# Security and privacy

Report vulnerabilities through this repository's private security reporting when available. Use practice inputs in reports, and keep vault terms, account tokens, private screenshots, and chat logs out of public issues.

## Local processing

OCR runs on your computer. The detector binds to IPv4 loopback, requires a random per-install bearer token, and disables access logs. Keep this endpoint and OBS WebSocket local, and protect the OBS password.

The desktop user and operating system form the trust boundary. Use VEIL on an account and machine you control. The renderer is sandboxed with context isolation and narrow IPC; source previews are masked before renderer transfer.

## Vault and account permissions

AES-256-GCM encrypts vault terms. Electron safeStorage protects the random encryption key; unavailable OS key protection causes the vault to fail closed. The PIN gates temporary reveal in the app. Keep operating-system access controls enabled.

Twitch sign-in grants the scopes displayed during authorization. Private matching stays local. Explicit blocked-term sharing sends selected terms to Twitch and channel moderators. Optional Discord webhooks send incident metadata; treat webhook URLs as credentials and rotate an exposed URL.

## Output and exports

Default exports omit private OCR text. Paranoid holds frames until checks complete; Balanced permits late output. Follow the [operating guide](docs/acceptance.md) to set the delay and inspect your OBS output. Recognition depends on the captured text and image quality.

Current installers are unsigned. Use the release's checksums and source manifest to verify downloads. Windows and macOS packaged app flows are checked in CI.
