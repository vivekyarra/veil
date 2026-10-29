# VEIL — Complete Build Specification

**Project:** VEIL — real-time leak protection and incident response for Twitch streamers
**Hackathon:** Codex x TwitchCon Hackathon (Devpost)
**Audience of this document:** OpenAI Codex, working autonomously, plus the human team for the few tasks only a human can do (listed in section 17)

---

## 0. Instructions to Codex (read first)

You are building a complete, working, demo-ready product from this spec. Work autonomously until the Definition of Done (section 16) is fully satisfied.

1. **Work in this one Codex thread** for the whole build. The hackathon requires the session ID of the thread where most of the build happened, and judges score how well the project uses Codex.
2. **Follow the milestones in section 15 in order.** After each milestone: run all tests, fix failures, commit with a message `M<n>: <summary>`, and append an entry to `PROGRESS.md` (what was built, what was tested, known issues).
3. **Never stop to ask questions.** When something needs a real credential (Twitch Client ID, OBS password), read it from `.env`, ship a `.env.example`, and make everything testable without it using the mocks in section 13. Record any assumption in `DECISIONS.md`.
4. **Never use real personal data** anywhere: tests, fixtures, screenshots, docs, demo assets. Use the `Faker` library and obviously fake values (e.g., `555-0100` phone numbers, `example.com` emails).
5. **Do not claim features that are not built.** README, Devpost text and UI copy must match what the code actually does.
6. **Do not invent Twitch API behavior.** Use only the endpoints, scopes and events listed in section 9. If one behaves differently from this spec when tested against the Twitch CLI mock or docs, follow reality and log it in `DECISIONS.md`.
7. **No crumbs:** no `TODO`, `FIXME`, placeholder functions, dead code, commented-out code, unused dependencies, or failing/skipped tests in the final repo. A CI check (section 14) enforces this.
8. Keep code quality high: typed code (TypeScript strict, Python type hints with `mypy --strict` on core modules), small modules, clear names, docstrings on public functions.

---

## 1. Product summary

**One-line pitch:** VEIL stops streamers from leaking private information on stream, and if something slips out, contains it on Twitch within seconds.

**The pain (verified):**
- Streamers accidentally show emails, DMs, addresses, phone numbers, API keys and password managers on stream. Leaks lead to doxxing and swatting.
- Once leaked, chat repeats it, viewers clip it, and the VOD keeps it.
- Twitch offers only manual tools after the fact (AutoMod blocked terms, Shield Mode, manual broadcast delay). Streamers today manually put parts of their address and phone number into blocked-terms lists, which exposes that data to every moderator.

**What VEIL does, in three layers:**

1. **Prevent (local, before frames leave the PC).** An OBS filter holds the stream back by a short, configurable delay (default 750 ms). During that window a local detector scans frames for private data. Detected regions are covered with solid masks before the frames are encoded and sent to Twitch.
2. **Contain (Twitch-side incident response).** If a leak escapes, or the streamer hits the panic hotkey, VEIL opens an incident: it guards chat against the leaked text, deletes chat messages that already contain it, can enable Shield Mode, drops a stream marker for VOD cleanup, lists clips created during the leak window, and gives moderators an incident card.
3. **Guard (always on).** A private "Never Show" vault (real name, street, city, phone, family names, school, etc.) is matched against chat with fuzzy matching. Messages that contain vault terms are deleted automatically. The vault never leaves the PC and is never written to Twitch's blocked-terms list unless the streamer explicitly opts in, so moderators cannot read it.

Plus a **Pre-flight Check** before going live that scans every capture source and the OS notification settings and flags risks.

**Privacy promise (must be true in code):** no video frame, OCR text or vault entry is ever sent off the machine. The only network traffic is to Twitch's official APIs and, optionally, a Discord webhook the streamer configures (which receives incident metadata only, never the leaked text).

### Prior art and differentiation (must appear in README)

- `georgebreen/obs-pii-redactor` (GitHub): proof-of-concept OBS filter that boxes PII via a local detection model; Windows-only, text detection experimental, no Twitch integration.
- screenpipe's open `pii-image-redactor` model and ScreenLeak benchmark: PII detection in screenshots for AI agents.
- Entropy (Chrome extension): hides secrets inside the browser only.
- VEIL's differentiation: (a) frame-accurate prevention with a lookahead buffer and fail-closed option, (b) Twitch-side incident response, (c) a private chat guard that keeps sensitive terms hidden from moderators, (d) pre-flight risk checks, (e) measured precision/recall on a published synthetic benchmark.

---

## 2. Users and core user stories

**Streamer (primary)**
- S1: As a streamer, I install VEIL, log in with Twitch, connect OBS, and am protected in under 5 minutes.
- S2: I add my private terms to the Never Show vault once; VEIL guards chat and screen against them in every stream.
- S3: If my email client or a DM pops up on stream, viewers see a solid mask, not the content.
- S4: If something leaks anyway, I press one hotkey and VEIL covers the stream and contains the leak on Twitch.
- S5: Before going live, I run Pre-flight and fix the flagged risks.
- S6: After the stream, I see an incident report with exact timestamps, affected clips, and VOD marker positions.

**Moderator (secondary)**
- M1: As a mod, I get notified that an incident is open, without seeing the private data itself.
- M2: I see which users repeatedly tried to post leaked info, so I can act.

**Viewer (indirect)**
- V1: Viewers see nothing broken: a brief, clean mask instead of private data.

---

## 3. Scope

### In scope (must ship)
- OBS native plugin: `VEIL Guard` video filter (delay buffer, frame sampling, mask rendering, fail-closed mode).
- Local detector service (Python): OCR, PII recognizers, vault matching, window/app guard, box tracking.
- Desktop control app (Electron + React + TypeScript): onboarding, Twitch login, OBS connection, vault, live dashboard, incidents, pre-flight, settings, panic hotkey, rehearsal mode.
- Twitch integration: Device Code OAuth, EventSub WebSocket chat listener, chat guard, incident response actions.
- Synthetic benchmark generator and evaluator with published results.
- Full test suite, CI, docs, demo assets, Devpost submission text draft.

### Out of scope (do not build; mention as roadmap only)
- IRL camera scene understanding (house numbers, street signs at angles, reflections). Roadmap only.
- Audio leaks (spoken addresses). Roadmap only.
- Mobile streaming apps.
- Any cloud backend or cloud inference.
- Deleting clips via API (Twitch's API does not offer it; VEIL lists clips and deep-links to the Creator Dashboard instead).

### Platforms
- **Windows 10/11 x64: primary, must fully work.**
- macOS 13+ (Apple Silicon): must build and run; GPU acceleration optional.
- Linux: best effort; do not block the DoD on Linux.
- OBS Studio **30 or later** (obs-websocket v5 is built in).

---

## 4. Architecture

```
┌──────────────────────────── Streamer PC ───────────────────────────────┐
│                                                                        │
│  OBS Studio                                                            │
│  ┌──────────────────────────────────────────────┐                      │
│  │ Scene ──► [VEIL Guard filter]                │                      │
│  │            • ring buffer (delay D)           │  frames (downscaled) │
│  │            • samples every Nth frame ────────┼──────────┐           │
│  │            • applies masks to delayed frames◄┼──masks───┤           │
│  └──────────────────────────────────────────────┘          │           │
│         ▲  obs-websocket v5 (scene switch, audio offsets,  │           │
│         │  screenshots for pre-flight)                     ▼           │
│  ┌──────┴─────────────────────┐   WebSocket     ┌───────────────────┐  │
│  │ VEIL Desktop (Electron)    │◄──────────────► │ VEIL Detector     │  │
│  │ • UI (React)               │   (events)      │ (Python, FastAPI) │  │
│  │ • Twitch client + EventSub │                 │ • OCR             │  │
│  │ • Incident engine          │                 │ • PII recognizers │  │
│  │ • Chat guard               │                 │ • Vault matcher   │  │
│  │ • Vault (encrypted)        │── vault terms ─►│ • Window guard    │  │
│  │ • Panic hotkey             │   (in memory)   │ • Box tracker     │  │
│  └──────┬─────────────────────┘                 └───────────────────┘  │
└─────────┼──────────────────────────────────────────────────────────────┘
          │ HTTPS (Helix API) + WSS (EventSub)
          ▼
       Twitch
```

**Process model**
- The Electron app is the supervisor. It starts and health-checks the detector process, connects to OBS via obs-websocket, and connects to Twitch.
- The OBS plugin talks directly to the detector over localhost (lowest latency path). It does not depend on Electron being up, except for config.
- All localhost traffic is authenticated with a random 256-bit token generated per install, stored in the app config directory, and shared with the plugin via a config file readable only by the current user.
- All local servers bind to `127.0.0.1` only. Never `0.0.0.0`.

---

## 5. Repository layout

```
veil/
├─ README.md
├─ LICENSE                     (MIT)
├─ PROGRESS.md                 (milestone log, Codex-maintained)
├─ DECISIONS.md                (assumptions and deviations)
├─ SECURITY.md                 (threat model summary, how to report)
├─ .env.example
├─ .github/workflows/ci.yml
├─ docs/
│  ├─ architecture.md
│  ├─ benchmark.md             (generated results)
│  ├─ demo-script.md
│  ├─ devpost-submission.md
│  └─ screenshots/             (fake data only)
├─ plugin/                     (OBS native plugin, C/C++, CMake)
│  ├─ CMakeLists.txt
│  ├─ src/
│  │  ├─ plugin-main.c
│  │  ├─ veil-filter.c
│  │  ├─ ring-buffer.c / .h
│  │  ├─ sampler.c / .h        (GPU→CPU staging, downscale, send)
│  │  ├─ mask-store.c / .h     (time-indexed masks)
│  │  ├─ detector-client.c / .h
│  │  └─ config.c / .h
│  ├─ data/effects/mask.effect
│  └─ tests/
├─ detector/                   (Python 3.11, uv-managed)
│  ├─ pyproject.toml
│  ├─ veil_detector/
│  │  ├─ server.py             (FastAPI app + WebSocket)
│  │  ├─ pipeline.py           (frame → detections)
│  │  ├─ ocr.py                (RapidOCR wrapper)
│  │  ├─ change_detect.py      (tile diffing)
│  │  ├─ recognizers/
│  │  │  ├─ email.py  phone.py  card.py  ip.py
│  │  │  ├─ address.py  secrets.py  vault.py
│  │  ├─ normalize.py          (shared with chat guard semantics)
│  │  ├─ window_guard/
│  │  │  ├─ base.py  windows.py  macos.py  linux.py
│  │  ├─ tracker.py            (IoU tracking, hold time)
│  │  ├─ policy.py             (profiles, thresholds)
│  │  └─ models.py             (pydantic schemas)
│  └─ tests/
├─ app/                        (Electron + React + TypeScript)
│  ├─ package.json
│  ├─ electron/
│  │  ├─ main.ts  preload.ts
│  │  ├─ supervisor.ts         (spawns/monitors detector)
│  │  ├─ obs/                  (obs-websocket-js client)
│  │  ├─ twitch/
│  │  │  ├─ auth.ts            (Device Code Flow, token refresh)
│  │  │  ├─ helix.ts           (typed API client, rate-limit aware)
│  │  │  └─ eventsub.ts        (WebSocket transport, reconnect)
│  │  ├─ guard/
│  │  │  ├─ normalize.ts       (must match detector/normalize.py)
│  │  │  ├─ matcher.ts
│  │  │  └─ chat-guard.ts
│  │  ├─ incidents/
│  │  │  ├─ engine.ts  actions.ts  report.ts
│  │  ├─ vault/vault.ts        (encryption at rest)
│  │  ├─ preflight/preflight.ts
│  │  ├─ hotkeys.ts
│  │  ├─ rehearsal/            (simulated chat + fake leaks)
│  │  └─ store/                (settings, SQLite via better-sqlite3)
│  ├─ src/                     (React renderer)
│  │  ├─ pages/  Onboarding, Dashboard, Vault, Incidents,
│  │  │          IncidentDetail, Preflight, Settings, Rehearsal
│  │  ├─ components/
│  │  └─ styles/
│  └─ tests/
├─ bench/                      (synthetic benchmark)
│  ├─ generate.py              (Playwright-rendered screens)
│  ├─ templates/               (HTML: email client, DM app, browser,
│  │                            terminal, form, game HUD negatives)
│  ├─ evaluate.py
│  └─ thresholds.json          (CI gates)
├─ shared/
│  └─ normalization-cases.json (golden cases used by BOTH TS and Python tests)
└─ scripts/
   ├─ setup.ps1  setup.sh      (one-command dev setup)
   ├─ dev.ps1    dev.sh        (run everything)
   ├─ build-plugin.ps1  build-plugin.sh
   ├─ package.ps1  package.sh  (installers)
   └─ check-crumbs.py          (fails on TODO/FIXME/etc.)
```

---

## 6. Component 1 — OBS plugin: `VEIL Guard` filter

### 6.1 Build basis
- Start from the official `obsproject/obs-plugintemplate` (CMake presets, GitHub Actions for Windows/macOS). Keep its CI structure.
- Language: C (C++ allowed for the HTTP client if simpler). HTTP client: WinHTTP on Windows, libcurl elsewhere, behind one interface in `detector-client.c`.

### 6.2 Where it attaches
- **Default ("Scene mode"):** the filter is added to each scene that goes live. Everything in the scene (webcam, game, overlays) is delayed by the same amount, so video stays internally consistent.
- **Audio sync is mandatory:** because video is delayed by `D` ms, the Electron app must set every audio input's sync offset to `+D` ms through obs-websocket `SetInputAudioSyncOffset`, store the original offsets, and restore them when VEIL is disabled or the app exits cleanly. On startup, if offsets from a previous crash are detected (stored in config), restore them first.

### 6.3 Frame pipeline
1. Each rendered frame of the filtered scene is copied into a GPU ring buffer of textures (`gs_texrender`). Buffer length = `ceil(D / frame_interval) + 2`.
2. Every Nth frame (default: sample at 4 fps) is staged to CPU (`gs_stagesurface`), downscaled to max 1280 px wide, and sent to the detector as raw RGBA or JPEG (quality 90) with `{frame_id, timestamp_ns, width, height}`.
3. The filter outputs the frame from `D` ms ago, with all masks whose time range covers that frame drawn on top.
4. Masks are **solid fills** (color configurable, default near-black with a subtle VEIL pattern). **Never pixelate or blur**: those can be partially reversed.

### 6.4 Mask timing (the core correctness rule)
- The detector returns detections for sampled frame `f`. A detection's mask must apply from the **first frame after the previous sampled frame** (`f_prev + 1`) onward, because the content may have appeared anywhere in that gap.
- Masks persist for a **hold time** after the last frame where the region was detected (default 1500 ms) to prevent flicker.
- Required delay: `D ≥ sample_interval + p99_detector_latency + margin`. Defaults: 250 + 400 + 100 = **750 ms**. Allowed range 300–3000 ms.
- The plugin computes, per sampled frame, a **deadline**: the time when `f_prev + 1` will be output. If the result for `f` has not arrived by the deadline:
  - **Paranoid profile (fail-closed):** cover the full frame with the "Hold on — VEIL is checking" card until results arrive.
  - **Balanced profile (default, fail-open):** output unmasked, increment a `late_results` counter, and emit a warning event to the app.
  - **Off:** plugin passes frames through with no delay.

### 6.5 Plugin settings (filter properties UI)
- Enabled (bool), Profile (Off/Balanced/Paranoid), Delay ms, Sample fps (1–10), Mask color, Detector URL (default `http://127.0.0.1:47321`), Test pattern (draws a fixed mask to verify rendering without the detector).
- Status line in the properties: connected / latency p50 & p99 / late results count.

### 6.6 Performance budgets
- Added GPU memory at 1080p60 with D = 750 ms: ≤ 450 MB. Expose the estimate in the properties UI.
- Plugin CPU overhead (excluding detector): ≤ 3% of one core.
- No frame drops introduced at 1080p60 on a mid-range GPU (GTX 1660 / RX 6600 class). Measure with OBS stats and document in `docs/benchmark.md`.

### 6.7 Plugin tests
- Unit tests (CTest) for ring buffer indexing, mask time-range lookup, deadline computation, and wrap-around.
- An integration harness that runs the filter logic headless with synthetic frames and a mock detector returning scripted results, asserting which output frames are masked (including late-result behavior for each profile).

---

## 7. Component 2 — Detector service (Python)

### 7.1 Stack
- Python 3.11, `uv` for env management, FastAPI + uvicorn, pydantic v2.
- OCR: **RapidOCR** (ONNX Runtime; DirectML on Windows, CoreML on macOS when available, CPU fallback). Pin versions.
- PII: custom recognizers (below) plus `phonenumbers` for phone validation. Microsoft Presidio is optional; do not add it unless it measurably improves the benchmark.
- Optional image model: screenpipe's `pii-image-redactor`. **Only add it if its license permits redistribution; check and record in `DECISIONS.md`.** It must be optional (off by default) and the product must meet its benchmark gates without it.

### 7.2 API (localhost only, token required in `Authorization: Bearer <token>`)
- `POST /v1/frames` — body: frame bytes + JSON header. Returns `DetectionResult`.
- `PUT /v1/vault` — receives the current vault terms from the Electron app (in memory only; never written to disk by the detector).
- `PUT /v1/policy` — profile, thresholds, enabled recognizers, window-guard denylist.
- `GET /v1/health` — status, model loaded, latency stats.
- `WS /v1/events` — pushes detection events to the Electron app (`detection`, `late_result`, `window_guard_trigger`, `health`).

```jsonc
// DetectionResult
{
  "frame_id": 18342,
  "processed_ms": 212,
  "detections": [
    {
      "track_id": "t-91",
      "kind": "email | phone | card | ip | address | secret | vault | window",
      "box": { "x": 0.412, "y": 0.103, "w": 0.188, "h": 0.031 },   // normalized 0..1
      "confidence": 0.97,
      "text_hash": "sha256:…",       // salted hash, never raw text
      "first_seen_frame": 18339
    }
  ]
}
```
**Raw detected text never leaves the detector process** except to the Electron app over the local WebSocket when an incident is opened (needed to guard chat), and then only in memory.

### 7.3 Pipeline per frame
1. **Change detection:** split the frame into a 16×9 tile grid; compare each tile against the previous sampled frame (mean absolute difference on a downscaled grayscale). Only changed tiles (plus a 1-tile border) go to OCR. Unchanged tiles reuse previous results. Force a full-frame OCR every 2 s.
2. **OCR** on changed regions → text lines with boxes.
3. **Recognizers** run on each line and on line groups (to catch addresses split over lines):
   - `email`: RFC-pragmatic regex; ignore obvious UI placeholders (`name@example.com` in input placeholders is still masked — safety first).
   - `phone`: `phonenumbers` parsing with region list from settings (default: US, GB, IN, CA, AU, DE, FR); require a valid number.
   - `card`: 13–19 digits with separators, Luhn-valid.
   - `ip`: IPv4 (exclude 0.0.0.0, 127.x, version-like strings such as `1.2.3` with only 3 parts) and IPv6.
   - `address`: heuristic — house number + street word (street, st, ave, road, rd, lane, blvd, drive, …, plus localized lists) or postal-code patterns adjacent to a city-like token. Tune on the benchmark.
   - `secrets`: high-signal patterns (AWS access key IDs, GitHub tokens `ghp_`/`github_pat_`, OpenAI-style `sk-` keys, Slack `xox*` tokens, private-key headers, JWTs, generic `password: …` / `api_key=` assignments).
   - `vault`: fuzzy match against vault terms using the shared normalization (section 10.2); edit distance ≤ 1 for terms ≥ 6 chars, exact normalized match for shorter terms; multi-token terms matched across adjacent words.
4. **Window guard (OS level, independent of OCR):** poll the window list at 5 Hz. If a denylisted app/window title (defaults below) is visible and on screen, emit a `window` detection covering that window's bounds mapped into the captured frame coordinates when mappable, or the whole frame in Paranoid profile when not. Default denylist: 1Password, Bitwarden, KeePass/KeePassXC, LastPass, Dashlane, Windows Credential Manager, Keychain Access, Outlook, Thunderbird, Mail.app, browser windows whose titles match Gmail/Outlook.com/Proton Mail/bank patterns, Discord windows whose title indicates a DM (configurable regex). Platform modules: Win32 `EnumWindows`/`GetWindowRect`/`GetWindowText`; macOS `CGWindowListCopyWindowInfo` (requires Screen Recording permission — onboarding must explain it); Linux X11 best effort.
5. **Tracker:** IoU ≥ 0.3 matches a detection to an existing track; exponential smoothing on box coordinates; boxes padded by 8% on each side; track survives the hold time without detections.
6. **Policy:** per-kind confidence thresholds; a per-game "ignore zones" list (normalized rectangles the streamer draws over HUD regions that cause false positives) — ignore zones never apply to `vault`, `secret` or `window` kinds.

### 7.4 Latency targets (measured, published)
- p50 ≤ 150 ms, p99 ≤ 400 ms per sampled 1280-px frame on: Windows + DirectML-capable GPU. CPU-only numbers must also be measured and documented honestly, with a recommended delay for CPU-only machines.

### 7.5 Detector tests
- Unit tests per recognizer with positive and negative cases (≥ 30 each for email, phone, card, secrets; ≥ 50 for address).
- Golden normalization tests from `shared/normalization-cases.json`.
- Tracker tests (matching, smoothing, hold time).
- API tests with FastAPI TestClient, including auth failures.

---

## 8. Component 3 — Desktop app (Electron + React + TypeScript)

### 8.1 Stack
- Electron (latest stable at build time), Vite, React 18, TypeScript strict, Zustand for state, Tailwind for styling, `better-sqlite3` for local storage, `obs-websocket-js` v5, `uiohook-napi` or Electron `globalShortcut` for hotkeys (globalShortcut preferred; fall back only if it can't capture while OBS/game is focused, and document).
- Packaging: `electron-builder` → Windows NSIS installer and macOS DMG. The detector is bundled as a frozen executable (PyInstaller) per platform, plus model files.

### 8.2 Screens
1. **Onboarding (wizard):**
   1. Welcome + privacy promise.
   2. Log in with Twitch (Device Code Flow: show code + "Open Twitch" button; poll until done).
   3. Connect OBS (host/port/password; test connection; explain where to find the obs-websocket password in OBS → Tools → WebSocket Server Settings).
   4. Install plugin check (detect the `VEIL Guard` filter type via obs-websocket `GetSourceFilterKindList`; if missing, show installer path and steps).
   5. Add VEIL Guard to scenes (one click: add filter to selected scenes via `CreateSourceFilter`).
   6. Fill the Never Show vault (guided categories: full name, nicknames, street address parts, city/neighborhood, phone, personal emails, family/pet names, school/workplace, license plate; free-form entries).
   7. macOS only: Screen Recording permission for window guard.
   8. Run first Pre-flight.
2. **Dashboard (live):** status pills (OBS, Detector, Twitch, EventSub, Plugin latency), protection profile switch, delay value, today's counters (masks applied, chat messages removed, incidents), live event feed (kind + time, never raw text), big red **PANIC** button with hotkey label.
3. **Vault:** list of entries (masked by default, reveal on click with OS re-auth on macOS / Windows Hello where available, otherwise app PIN), add/edit/delete, import from text, "Also add to Twitch blocked terms" per-entry toggle with a clear warning that moderators can read Twitch blocked terms.
4. **Incidents:** list; **Incident detail** shows timeline (start, actions taken with results, end), leak window timestamps, VOD marker info, clips created in the window (thumbnail, creator, link), chat messages removed (count + usernames, not content), repeat offenders, and buttons: "Open clips manager", "Open video producer", "Export report (PDF/Markdown)".
5. **Pre-flight:** checklist with pass/warn/fail and one-click fixes where possible.
6. **Settings:** profile, delay, sample fps, recognizers on/off, thresholds (advanced), ignore zones editor (draw on a frozen screenshot), window-guard denylist editor, hotkeys, incident automation rules, Discord webhook, data retention, logs export.
7. **Rehearsal mode:** see section 12.

UI quality bar: clean, dark theme by default with light theme support, keyboard accessible, WCAG AA contrast, every action shows result feedback, no raw stack traces in UI.

### 8.3 Vault security
- Stored in SQLite, encrypted with AES-256-GCM. Key protected by Electron `safeStorage` (DPAPI on Windows, Keychain on macOS). Never logged, never sent to Twitch unless the per-entry opt-in is on, never sent anywhere else.
- Sent to the detector only over the authenticated localhost connection, held in memory there.
- "Wipe vault" action with confirmation.

---

## 9. Twitch integration

### 9.1 App registration (human task, see section 17)
- Register an app at the Twitch Developer Console as a **Public** client type (needed for Device Code Flow without a client secret). Client ID goes into `.env` as `TWITCH_CLIENT_ID`.

### 9.2 Authentication — Device Code Grant Flow
- `POST https://id.twitch.tv/oauth2/device` with `client_id` and `scopes` → `device_code`, `user_code`, `verification_uri`, `interval`.
- Poll `POST https://id.twitch.tv/oauth2/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code` at the given interval until success, handling `authorization_pending` and `slow_down`.
- Store access + refresh tokens encrypted via `safeStorage`. Refresh before expiry; refresh tokens for public clients are single-use, so always persist the newly returned refresh token atomically. On refresh failure, show a re-login banner, keep local protection (layers 1 and 3 that don't need Twitch) running.
- Validate token on startup (`GET https://id.twitch.tv/oauth2/validate`) and hourly, as Twitch requires.

### 9.3 Scopes (request exactly these)
| Scope | Used for |
|---|---|
| `user:read:chat` | EventSub `channel.chat.message` |
| `user:write:chat` | Optional neutral notices in chat ("Mods: incident opened") |
| `moderator:manage:chat_messages` | Delete chat messages |
| `moderator:read:blocked_terms`, `moderator:manage:blocked_terms` | Opt-in blocked terms |
| `moderator:read:shield_mode`, `moderator:manage:shield_mode` | Shield Mode |
| `moderator:manage:banned_users` | Timeouts for repeat offenders (only if the rule is enabled) |
| `channel:manage:broadcast` | Create stream markers |

The broadcaster's own token is used for everything; `broadcaster_id` and `moderator_id` are both the broadcaster's user ID.

### 9.4 Helix endpoints used
- `GET /helix/users` — resolve own user ID/login.
- `GET /helix/streams?user_id=` — live status (also from EventSub).
- `DELETE /helix/moderation/chat?broadcaster_id=&moderator_id=&message_id=` — delete a message (Twitch only allows deleting messages less than 6 hours old; broadcaster/mod messages cannot be deleted — handle the error gracefully).
- `POST /helix/moderation/blocked_terms` / `DELETE …?id=` / `GET …` — opt-in blocked terms (2–500 chars).
- `PUT /helix/moderation/shield_mode` with `{"is_active": true|false}`.
- `POST /helix/moderation/bans` with `{"data": {"user_id": "...", "duration": 600, "reason": "..."}}` — timeout.
- `POST /helix/streams/markers` with `{"user_id": "...", "description": "VEIL incident #12"}` (≤ 140 chars; fails when not live or VODs are disabled — record the failure reason in the incident).
- `GET /helix/clips?broadcaster_id=&started_at=&ended_at=` — clips created in the leak window (paginate).
- `GET /helix/videos?user_id=&type=archive` — find the current VOD to compute offsets for the report.
- `POST /helix/chat/messages` — optional neutral notice.

Helix client requirements: typed request/response models, automatic retry with backoff for 429/5xx, respect `Ratelimit-Remaining`/`Ratelimit-Reset` headers, a request queue so incident actions run in priority order (delete messages first), structured logging without tokens or message content.

### 9.5 EventSub over WebSocket
- Connect to `wss://eventsub.wss.twitch.tv/ws`; on `session_welcome`, create subscriptions via `POST /helix/eventsub/subscriptions` with `transport.method = "websocket"` and the session ID, within the required window after welcome.
- Subscriptions: `channel.chat.message` (v1, condition `broadcaster_user_id` and `user_id` = broadcaster), `stream.online`, `stream.offline`, `channel.shield_mode.begin`, `channel.shield_mode.end`.
- Handle `session_keepalive` (reconnect if no message within keepalive timeout + margin), `session_reconnect` (connect to the new URL before closing the old), `revocation`, and duplicate message IDs (dedupe by `message_id`, keep last 1,000).
- Keep an in-memory ring of recent chat messages (`message_id`, `user_id`, `user_login`, normalized text, timestamp) for the last 6 hours, capped at 50,000 messages. **Never persisted to disk.** Used for retroactive deletion when an incident opens.

---

## 10. Chat guard

### 10.1 Behavior
- Every incoming chat message is normalized and matched against: (a) vault terms, and (b) the active incident's leaked strings.
- On match: delete the message immediately (priority queue), increment that user's attempt counter for the incident/session, and emit an event (username + matched category, **not** the text).
- Repeat-offender rule (configurable, default on): 2 matches in 10 minutes → 10-minute timeout with reason "Posting private information"; 3+ → flag in the incident for mod review (no automatic permanent ban).
- Broadcaster and moderators are exempt from timeouts but their matching messages still raise a warning toast in the app (messages from mods cannot be deleted via API).
- Accepted limitation (document it): a message is briefly visible before deletion (target: deleted within 1 s p95 from EventSub receipt). Streamers who want zero exposure can opt each vault entry into Twitch blocked terms.

### 10.2 Normalization (identical in TypeScript and Python)
Applied to both terms and messages:
1. Unicode NFKC, lowercase.
2. Map confusables/homoglyphs to ASCII (Cyrillic/Greek look-alikes, full-width chars).
3. Leetspeak map: `0→o, 1→i, 3→e, 4→a, 5→s, 7→t, @→a, $→s`, applied as an **additional** variant (keep the original too, so real digits in phone numbers still match).
4. Strip zero-width characters, emotes markup, and repeated punctuation.
5. Produce two forms: tokenized words, and a "squashed" form with all non-alphanumerics removed (catches `1 2 3 M a i n  S t`).
6. Digits-only form for phone/house numbers/postal codes (catches `five five five` is out of scope; note it).
Matching: exact on squashed form for terms < 6 chars; Damerau-Levenshtein ≤ 1 on tokens and on squashed substrings for terms ≥ 6 chars; digits-only match for numeric vault entries ≥ 5 digits.
`shared/normalization-cases.json` holds ≥ 80 golden cases; both language test suites must pass all of them.

---

## 11. Incident engine

### 11.1 Triggers
- **Escaped leak:** the detector reports a detection whose `first_seen_frame` was already output before the mask could apply (late result in Balanced mode).
- **Panic hotkey / button** (default `Ctrl+Shift+F12` on Windows, `Cmd+Shift+F12` on macOS; configurable).
- **Manual incident** from the dashboard ("Something leaked") with optional text entry of what leaked.
- **Chat spike:** ≥ 3 different users post messages matching a vault term within 60 s (signals something leaked that VEIL didn't see).

### 11.2 Actions (each individually configurable as Auto / Ask / Off; defaults shown)
| # | Action | Default |
|---|---|---|
| 1 | Panic only: switch OBS program scene to the "VEIL Cover" scene (created during onboarding: a branded "Be right back" card + mic stays live) via `SetCurrentProgramScene` | Auto |
| 2 | Add leaked strings to the chat guard (session-scoped) | Auto |
| 3 | Retroactively delete matching messages from the in-memory chat ring | Auto |
| 4 | Create stream marker "VEIL incident #n" | Auto |
| 5 | Enable Shield Mode | Ask |
| 6 | Add leaked strings to Twitch blocked terms (mods can read them) | Off |
| 7 | Post neutral chat notice (no details) | Off |
| 8 | Discord webhook to mods (incident number, time, actions; no leaked text) | Off (Auto once configured) |
| 9 | After incident closes + 2 min: fetch clips created in the window, attach to incident | Auto |

"Ask" shows a native notification + in-app modal with a 10-second countdown defaulting to **No**.

### 11.3 Lifecycle and report
- States: `open → contained → closed`. Closing is manual (or automatic 10 min after the last related event).
- Every action records: timestamp, request, result (success / error code / reason), duration.
- Report export (Markdown and PDF) includes: summary, timeline, leak window in stream time and VOD offset, actions and results, clips list with links, users with attempt counts, and recommended manual follow-ups (e.g., "Trim VOD between 01:12:04 and 01:12:31 in Video Producer"; "Review 3 clips"). **No leaked text in the report unless the user explicitly checks "include leaked text".**

---

## 12. Pre-flight check and Rehearsal mode

### 12.1 Pre-flight (runs on demand, offline or live; optionally auto-runs when OBS starts streaming)
Checks:
1. VEIL Guard filter present and enabled on every scene used for streaming.
2. Audio sync offsets applied and consistent with the delay.
3. Detector healthy; measured p99 latency fits within the configured delay (else recommend a delay).
4. Screenshot every visible capture source via `GetSourceScreenshot`, run full detection, report findings with thumbnails (masked).
5. Window guard: list denylisted apps currently open.
6. OS notifications: Windows Focus Assist / Do Not Disturb, macOS Focus — warn if off (notifications are a common leak source). Where detection isn't possible via public APIs, show a manual checklist item instead of guessing.
7. Twitch: token valid, required scopes granted, EventSub connected, VODs enabled (markers need them).
8. Vault: warn if empty or if fewer than 3 categories filled.

### 12.2 Rehearsal mode (also powers the demo)
- Simulated chat: an internal fake chat feed (and optionally the Twitch CLI mock EventSub server) with scripted viewers, including ones who try to post vault terms with obfuscation (`1 2 3 m4in st`).
- Fake leak scenarios: opens a local window (bundled HTML pages) showing a fake email inbox, a fake DM, a terminal with a fake API key, a fake address form — all with Faker-generated data. Run each scenario and show: detection time, mask applied (yes/no), late (yes/no).
- Split-view in the app: "Your screen" (live, unmasked, small) vs "What Twitch sees" (VEIL Guard output via an OBS projector or screenshot polling).
- Rehearsal never calls real moderation endpoints; it uses the mock layer.

---

## 13. Mocks and test infrastructure

- **Twitch:** use the official Twitch CLI (`twitch mock-api start` for Helix mock, `twitch event websocket start-server` for EventSub WebSocket mock). Wrap in `scripts/` so `npm run test:integration` starts and stops them. If a needed endpoint is not supported by the mock, implement a small local Fastify mock with the same contract and note it in `DECISIONS.md`.
- **OBS:** a fake obs-websocket v5 server for app tests (implements the request types VEIL uses: `GetSceneList`, `GetSourceFilterKindList`, `CreateSourceFilter`, `GetSourceFilterList`, `SetSourceFilterEnabled`, `GetInputList`, `GetInputAudioSyncOffset`, `SetInputAudioSyncOffset`, `GetSourceScreenshot`, `SetCurrentProgramScene`, `CreateScene`, `CreateInput`).
- **Detector:** a mock detector for plugin and app tests that returns scripted detections with scripted latencies.

---

## 14. Quality gates, benchmark and CI

### 14.1 Synthetic benchmark (`bench/`)
- `generate.py` renders ≥ 3,000 screenshots at 1920×1080 using Playwright from HTML templates: email clients, chat/DM apps, browser with address bar and tabs, terminals/code editors, forms, settings pages, plus **negatives**: game HUDs, scoreboards, chat overlays, stream alerts, code without secrets. Vary fonts (≥ 8), sizes (11–28 px), themes (light/dark), scaling (100–200%), JPEG artifacts, partial occlusion and slight motion blur. Ground-truth boxes come from the DOM.
- `evaluate.py` runs the detector pipeline and reports per-kind precision, recall, box IoU, and latency percentiles; writes `docs/benchmark.md` and a JSON summary.
- **CI gates (`thresholds.json`):** recall ≥ 0.97 for email, card, secret, vault; ≥ 0.93 for phone; ≥ 0.85 for address; false-positive rate on negative screens ≤ 2% of screens; p99 latency recorded (not gated in CI since CI has no GPU).
- Publish the generator so judges can reproduce results.

### 14.2 Test coverage
- Python core modules ≥ 85% line coverage; TypeScript `electron/` ≥ 80%; plugin logic modules covered by CTest.
- E2E (Playwright for Electron): onboarding with mocks; vault add/reveal/delete; rehearsal scenario run; panic flow creating an incident with the expected action results; report export.

### 14.3 CI (`.github/workflows/ci.yml`)
- Jobs: lint (ESLint, Prettier, ruff, mypy, clang-format check), unit tests (Python, TS, CTest), integration tests (Twitch CLI mocks + fake OBS), benchmark on a reduced set (300 images) with gates, plugin build for Windows and macOS, app build, `scripts/check-crumbs.py`.
- `check-crumbs.py` fails on: `TODO`, `FIXME`, `XXX`, `HACK`, `console.log` in production code, `print(` in detector production code (use logging), skipped tests, `.only` in tests, unused exports (ts-prune), unused Python deps (deptry), and any committed `.env`.

---

## 15. Milestones (execute in order)

**M1 — Skeleton & tooling.** Repo layout, package managers, lint/format configs, CI with all jobs (passing on empty tests), `.env.example`, README skeleton, LICENSE. *Accept:* CI green.

**M2 — Normalization & matcher (shared).** `shared/normalization-cases.json` (≥ 80 cases), TS and Python implementations, tests passing in both. *Accept:* identical results on all golden cases.

**M3 — Detector core.** OCR wrapper, recognizers, vault matching, tracker, policy, FastAPI API with auth, unit/API tests. *Accept:* tests pass; manual run on sample images returns correct boxes.

**M4 — Benchmark.** Generator + evaluator + gates; tune recognizers until gates pass. *Accept:* `docs/benchmark.md` generated, gates pass.

**M5 — OBS plugin.** Filter with ring buffer, sampling, detector client, mask store, mask effect, profiles, properties UI, CTest + headless harness. *Accept:* harness proves correct masking incl. late results per profile; builds on Windows and macOS in CI.

**M6 — Window guard.** Windows and macOS implementations, denylist, coordinate mapping, tests with mocked OS APIs. *Accept:* tests pass; manual check documented.

**M7 — Desktop app foundation.** Electron shell, supervisor for the detector, settings store, OBS client (+ fake OBS server), onboarding steps 1, 3–5, audio offset management with crash-safe restore. *Accept:* E2E onboarding with mocks.

**M8 — Twitch layer.** Device Code auth, token storage/refresh/validate, Helix client, EventSub WebSocket with reconnect/keepalive/dedupe, chat ring buffer. *Accept:* integration tests against Twitch CLI mocks.

**M9 — Vault & chat guard.** Encrypted vault, UI, detector sync, chat guard with deletion queue, repeat-offender rule, opt-in blocked terms. *Accept:* integration tests: obfuscated vault terms deleted within 1 s p95 in mock.

**M10 — Incident engine.** Triggers, actions with Auto/Ask/Off, VEIL Cover scene, panic hotkey, lifecycle, report export, Discord webhook. *Accept:* E2E panic flow passes; report contains no leaked text by default.

**M11 — Pre-flight & Rehearsal.** All checks, fake leak scenarios, simulated chat, split view. *Accept:* rehearsal runs end to end offline.

**M12 — Packaging.** PyInstaller detector, electron-builder installers, plugin installers/instructions per OS, first-run experience on a clean machine documented. *Accept:* installers built in CI as artifacts.

**M13 — Polish & docs.** UI polish pass, accessibility pass, README (features, install, quickstart, privacy, prior art, limitations, benchmark summary, architecture diagram), `docs/demo-script.md`, `docs/devpost-submission.md`, screenshots with fake data, `SECURITY.md`. *Accept:* DoD checklist complete.

---

## 16. Definition of Done (all must be true)

- [ ] All milestones M1–M13 accepted and logged in `PROGRESS.md`.
- [ ] CI fully green on the default branch, including benchmark gates and crumb check.
- [ ] Fresh Windows machine: installer → onboarding → protected stream in ≤ 5 minutes, following README only.
- [ ] Rehearsal mode demonstrates every fake leak scenario being masked before output in Balanced profile with default delay on the reference GPU.
- [ ] Panic hotkey switches to the cover scene in ≤ 300 ms and opens an incident with all Auto actions executed (verified against mocks; verified live by the human team per section 17).
- [ ] Chat guard deletes obfuscated vault terms within 1 s p95 (mock measurement published).
- [ ] No raw private text in logs, reports (default), Discord payloads, or anything leaving the machine except Twitch API calls the user explicitly enabled (blocked terms opt-in). Add a test that scans log output during E2E runs for planted fake vault terms.
- [ ] Audio offsets restored on clean exit and after a simulated crash.
- [ ] README includes prior art & differentiation, limitations (IRL, audio, brief chat visibility before deletion, CPU-only latency), and privacy statement.
- [ ] `docs/devpost-submission.md` and `docs/demo-script.md` complete.
- [ ] No TODO/FIXME/placeholder/dead code; no skipped tests.

---

## 17. Human-only tasks (Codex cannot do these; list them in README "Maintainers" section)

1. Register the Twitch application (Public client) and put the Client ID in `.env`.
2. Install the built plugin and app on a real Windows streaming PC; run a real test stream to a private/test channel; verify markers, Shield Mode, deletions, clips listing live.
3. Record the demo video (≤ 3 minutes) following `docs/demo-script.md`, upload to YouTube as **public**.
4. Run `/status` in Codex to get the session ID for the main build thread.
5. Push the repo to GitHub (public, or private shared with `testing@devpost.com`).
6. Submit on Devpost using `docs/devpost-submission.md` before **Nov 3, 2026, 3:30 AM IST** (Nov 2, 2:00 PM PT).

---

## 18. Demo script (Codex writes the final version to `docs/demo-script.md`)

Target 2:50 total.
1. **0:00–0:15 Hook.** Split screen: streamer's real screen vs Twitch view. A fake email with a fake home address pops up. On Twitch: solid mask. Caption: "Viewers never saw it."
2. **0:15–0:35 The problem.** Quick text cards: leaks → chat repeats → clips → VOD. "Twitch's tools only work after it's too late."
3. **0:35–1:20 Prevent.** Rehearsal run through fake DM, terminal API key, password manager window: each masked; show the latency readout and benchmark numbers.
4. **1:20–2:05 Contain.** Panic hotkey: cover scene, incident opens, simulated chat users try `1 2 3 m4in st` — deleted instantly, repeat offender timed out, marker dropped, clips listed. Incident report export.
5. **2:05–2:30 Guard + privacy.** Vault: terms never leave the PC, mods can't see them. Pre-flight catching an open password manager.
6. **2:30–2:50 Built with Codex.** Show the Codex thread, the benchmark generator, CI gates. Close: "VEIL — what Twitch should already have."

---

## 19. Devpost description outline (Codex writes final text to `docs/devpost-submission.md`)

Sections: Inspiration (the leak pain, the blocked-terms workaround), What it does (three layers + pre-flight), How we built it (architecture; **how Codex was used**: milestone-driven build in one thread, shared normalization golden tests, synthetic benchmark generation, mocks, CI gates), Challenges (frame-accurate masking with lookahead, audio sync, fail-closed design, keeping private terms hidden from mods), Accomplishments (benchmark numbers — real values from `docs/benchmark.md` only), What we learned, Prior art & how VEIL differs, What's next (IRL camera detection, audio leak detection, Twitch Extension for mod incident panel).

---

## 20. Risks and required fallbacks

| Risk | Fallback (must be implemented, not just noted) |
|---|---|
| GPU ring buffer too heavy on low-end PCs | Auto-reduce: lower internal buffer resolution to 720p for delayed frames when VRAM estimate exceeds 450 MB, with a warning |
| Detector too slow on CPU-only | Pre-flight measures latency and recommends a larger delay; Paranoid users get fail-closed |
| OCR false positives on game HUDs | Ignore-zone editor + per-game profiles keyed by Twitch category |
| macOS permission denied for window list | Window guard disabled with a clear banner; OCR protection continues |
| EventSub disconnects mid-stream | Auto-reconnect; while disconnected, show red status and keep local protection running |
| Marker creation fails (offline/VODs off) | Record reason in incident; report uses wall-clock times instead |
| Twitch CLI mock lacks an endpoint | Local Fastify mock with identical contract (logged in `DECISIONS.md`) |
