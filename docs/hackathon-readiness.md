# Codex x TwitchCon readiness

Checked 30 October 2026 IST. This is a project checklist, not confirmation of registration or entry.

## Official event

Use the complete [Official Rules](https://twitchcon-codex.devpost.com/rules), [overview](https://twitchcon-codex.devpost.com/) and [FAQ](https://twitchcon-codex.devpost.com/resources). The rules control any inconsistency.

The rules cover eligibility and exclusions, registration, new work during 23 October–2 November, Twitch/Codex functionality, submission/access requirements, ownership and licensed integrations, modifications, judging, publicity, prize verification/taxes, releases, conduct, disputes and privacy. Read them directly before entering. Adults/eligible teams may participate; organizations and excluded residents/conflicted participants may not. Provide functioning software, accessible source/instructions, an English description, session ID, and a short publicly accessible YouTube demo showing Twitch and Codex. Keep judging access available. Do not use unlicensed assets or commit credentials. Entrants retain their work but grant specified judging/publicity rights. Prize acceptance has separate verification obligations.

The rules specify 2 November, 2 PM Pacific: **3 November, 3:30 AM IST**. The FAQ's UTC conversion differs; submit early and use the site's countdown.

## Judge-facing proof

The four criteria are equally weighted: innovation, impact, implementation and design. Five finalists share $25,000: $10,000/$6,000/$4,000 and two $2,500 awards. [Overview](https://twitchcon-codex.devpost.com/).

| Criterion | VEIL evidence to show |
|---|---|
| Innovation | Private local matching plus OBS lookahead and incident containment; explain the difference from existing redactors without claiming the first redactor |
| Impact | A streamer adds a synthetic boundary, contains an incident and reviews what happened |
| Implementation | Actual Twitch connection, native OBS output, reproducible benchmark, authentic Codex chat and remote CI |
| Design | Working desktop interactions, accessible themes, clear failure states and a concise demonstration |

## Project checklist

- Repository: https://github.com/vivekyarra/veil
- Build chat: `01a187d8-7c89-7993-bb7c-340d3f64dc8f`; captured provenance is in build-provenance.json.
- Public history starts with a source snapshot; original 14-commit build history is preserved locally as archive/original-build. Do not represent this publication cleanup as a different build process.
- Eight named work branches and at most 15 public commits are the requested publication constraints.
- Actual tests, packaging and model results are linked in acceptance.md. CI must pass on the published main commit.
- Card recovery retains Luhn validation; its full-corpus rerun must pass unchanged gates before claiming that blocker closed.
- Default Paranoid covers unverified frames, including worker stalls. It can keep output covered on slow hardware; this is not proof of fast GPU inference or perfect OCR.
- Twitch account sign-in alone is not VEIL authorization: a Public Client ID and device grant are required.
- Live test-channel interactions and the final video URL must be real, not substituted by local mocks.
- Video recording follows the user's forthcoming instructions. The user will upload to YouTube and provide the URL.
- Devpost connection currently requires reauthentication. No registration, submission or personal eligibility is asserted here.

## Final handoff

Use docs/devpost-submission.md and docs/demo-script.md. Record real app/Twitch interactions, label simulations, use synthetic data, retain the timing limitations, and include Codex footage. Do not publish captured credentials or real private text. Review the exported media before upload. A saved draft is not an entered project; verify entry on Devpost after the human submits.
