# Security and privacy

Report vulnerabilities through this repository's private security reporting. Use practice inputs in reports, and keep vault terms, account tokens, private screenshots and chat logs out of public issues.

## Local processing

OCR runs on your computer. The detector binds to IPv4 loopback, requires a random per-install bearer token and disables access logs. Keep it and OBS WebSocket local, and protect the OBS password.

The desktop user and operating system form the trust boundary. Use VEIL on an account and machine you control. The renderer is sandboxed with context isolation and narrow IPC, and source previews are masked before they reach it.

## On-stream overlay

The overlay badge is served read-only on loopback. Its feed carries only counts and timestamps, never recognized text or vault terms, because anything the overlay receives can end up on stream.

## Vault and account permissions

AES-256-GCM encrypts vault terms. Electron safeStorage protects the random key, and the vault fails closed when OS key protection is unavailable. A PIN gates temporary reveal in the app.

Twitch sign-in grants the scopes shown during authorization. In moderator mode, VEIL acts with the signed-in moderator's account, so only trusted moderators should run it. Private matching stays local. Sharing a blocked term sends that term to Twitch, where channel moderators can see it. Optional Discord webhooks send incident metadata; treat webhook URLs as credentials and rotate any that are exposed.

## Output and exports

Default exports omit private OCR text. Paranoid holds frames until checks complete; Balanced permits late output. Panic always covers OBS. Follow the [operating guide](docs/acceptance.md) to set the delay and check your OBS output. Recognition depends on the captured text and image quality, and the filter covers video only, not audio.

Installers are currently unsigned. Verify downloads with the release's checksums and source manifest.
