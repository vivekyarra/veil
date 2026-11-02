# Controlled screenshot benchmark

> **Partial run:** scored on the first 340 screens of the 3000-screen corpus (`--limit 340`); the full corpus is evaluated in the CI benchmark job.

340-screen run on a generated test corpus with DOM-derived ground truth: rendered 1920x1080 screenshots from `bench/generate.py`, scored against the pixel position of every labelled span. CPU ONNX, 2 threads per OCR worker, 4 concurrent workers.

## Highlights

- **Recall by kind (coverage >= 0.9):** email 100.0%, vault 100.0%, national_id 97.5%, card 97.4%, address 96.3%, iban 95.5%, secret 95.1%, ip 89.7%, phone 84.2%.
- **Negative screens:** 1.05% of the 95 screens with no private text produced any detection.
- **Hard negatives:** at most 3.14% of spans in any distractor category (code, dates, versions, private IPs, URLs and more) were masked.
- **Scoring:** coverage-based and one-to-one, so a full-screen mask or duplicate boxes cannot inflate recall (details below).

## Scoring

Ground truth is the glyph ink box of each labelled span (pixel difference between the screen and the same screen with that text made transparent). A target is a hit when one unmatched detection of the same kind covers at least 90% of the ink box area and is no larger than 8x that area (so a full-screen mask cannot score). Matching is one-to-one; duplicate boxes and wrong-kind predictions count as false positives. Recall at IoU >= 0.5 against the ink box is reported alongside as a stricter localisation measure. A hard-negative span is a false positive when an unmatched detection covers at least 30% of it.

## Recall and precision by kind

| Kind | Targets | Hits | FP boxes | Precision | Recall (coverage >= 0.9) | Recall (IoU >= 0.5) | Mean IoU of hits |
|---|---:|---:|---:|---:|---:|---:|---:|
| email | 40 | 40 | 1 | 0.9756 | 1.0000 | 0.3750 | 0.4737 |
| card | 39 | 38 | 7 | 0.8444 | 0.9744 | 0.1026 | 0.3900 |
| secret | 41 | 39 | 0 | 1.0000 | 0.9512 | 0.8293 | 0.5610 |
| vault | 34 | 34 | 0 | 1.0000 | 1.0000 | 0.4118 | 0.4551 |
| phone | 38 | 32 | 0 | 1.0000 | 0.8421 | 0.2368 | 0.4178 |
| address | 27 | 26 | 4 | 0.8667 | 0.9630 | 0.5185 | 0.4990 |
| ip | 39 | 35 | 0 | 1.0000 | 0.8974 | 0.3333 | 0.4320 |
| national_id | 40 | 39 | 0 | 1.0000 | 0.9750 | 0.0750 | 0.3696 |
| iban | 44 | 42 | 0 | 1.0000 | 0.9545 | 0.2500 | 0.4458 |

## Hard negatives

Spans that must not be masked, placed as distractors beside targets and on 95 screens with no targets. Negative-screen FPR (any detection on a screen with no targets): **1.0526%**.

| Category | Spans | Flagged | FPR | Kinds that fired |
|---|---:|---:|---:|---|
| code | 198 | 0 | 0.0000 | - |
| chat_mention | 183 | 0 | 0.0000 | - |
| time_at | 167 | 1 | 0.0060 | email 1 |
| version | 172 | 0 | 0.0000 | - |
| private_ip | 165 | 4 | 0.0242 | card 4 |
| date | 181 | 3 | 0.0166 | address 3 |
| reference_number | 161 | 0 | 0.0000 | - |
| non_luhn_16 | 191 | 6 | 0.0314 | card 6 |
| scoreboard | 145 | 2 | 0.0138 | address 1, card 1 |
| url | 191 | 0 | 0.0000 | - |

## Recall by value format

| Kind:format | Targets | Recall |
|---|---:|---:|
| address:de | 3 | 1.0000 |
| address:fr | 6 | 1.0000 |
| address:uk | 1 | 0.0000 |
| address:us | 17 | 1.0000 |
| card:amex-dash | 2 | 1.0000 |
| card:amex-plain | 2 | 1.0000 |
| card:amex-space | 3 | 1.0000 |
| card:discover-dash | 1 | 1.0000 |
| card:discover-plain | 2 | 1.0000 |
| card:discover-plain-split-inputs | 2 | 1.0000 |
| card:discover-space | 6 | 1.0000 |
| card:mastercard-dash | 2 | 1.0000 |
| card:mastercard-plain | 2 | 1.0000 |
| card:mastercard-plain-split-inputs | 1 | 1.0000 |
| card:mastercard-space | 5 | 0.8000 |
| card:mastercard-space-split-inputs | 3 | 1.0000 |
| card:visa-dash-split-inputs | 2 | 1.0000 |
| card:visa-plain | 1 | 1.0000 |
| card:visa-plain-split-inputs | 2 | 1.0000 |
| card:visa-space | 1 | 1.0000 |
| card:visa-space-split-inputs | 2 | 1.0000 |
| email:au | 1 | 1.0000 |
| email:biz | 1 | 1.0000 |
| email:com | 12 | 1.0000 |
| email:de | 7 | 1.0000 |
| email:dev | 1 | 1.0000 |
| email:fr | 7 | 1.0000 |
| email:io | 1 | 1.0000 |
| email:net | 1 | 1.0000 |
| email:org | 7 | 1.0000 |
| email:uk | 2 | 1.0000 |
| iban:DE | 7 | 1.0000 |
| iban:ES | 17 | 0.9412 |
| iban:FR | 9 | 1.0000 |
| iban:GB | 7 | 1.0000 |
| iban:NL | 4 | 0.7500 |
| ip:ipv4 | 29 | 0.8966 |
| ip:ipv6 | 10 | 0.9000 |
| national_id:uk_nino | 15 | 0.9333 |
| national_id:us_ssn | 25 | 1.0000 |
| phone:AU-international | 1 | 1.0000 |
| phone:BR-international | 3 | 1.0000 |
| phone:BR-national | 1 | 0.0000 |
| phone:CA-e164 | 1 | 1.0000 |
| phone:CA-international | 1 | 1.0000 |
| phone:DE-e164 | 2 | 1.0000 |
| phone:DE-international | 1 | 0.0000 |
| phone:DE-national | 1 | 0.0000 |
| phone:ES-e164 | 1 | 1.0000 |
| phone:ES-international | 4 | 1.0000 |
| phone:ES-national | 1 | 0.0000 |
| phone:FR-e164 | 2 | 1.0000 |
| phone:FR-international | 1 | 1.0000 |
| phone:FR-national | 1 | 0.0000 |
| phone:GB-e164 | 1 | 1.0000 |
| phone:IT-e164 | 2 | 1.0000 |
| phone:IT-international | 3 | 1.0000 |
| phone:IT-national | 1 | 1.0000 |
| phone:JP-international | 1 | 1.0000 |
| phone:JP-national | 1 | 1.0000 |
| phone:MX-national | 1 | 0.0000 |
| phone:NL-e164 | 1 | 1.0000 |
| phone:NL-international | 4 | 1.0000 |
| phone:US-international | 1 | 1.0000 |
| phone:US-national | 1 | 1.0000 |
| secret:api_key | 1 | 1.0000 |
| secret:aws_access_key | 4 | 1.0000 |
| secret:aws_secret | 1 | 1.0000 |
| secret:bearer | 5 | 0.8000 |
| secret:env_password | 4 | 1.0000 |
| secret:github_app | 3 | 1.0000 |
| secret:github_fine | 4 | 1.0000 |
| secret:gitlab | 3 | 1.0000 |
| secret:google | 3 | 1.0000 |
| secret:jwt | 4 | 0.7500 |
| secret:openai | 2 | 1.0000 |
| secret:password_bare | 3 | 1.0000 |
| secret:password_colon | 2 | 1.0000 |
| secret:stripe | 2 | 1.0000 |
| vault:vault | 34 | 1.0000 |

## Gates

CI gates (`bench/thresholds.json`) were derived from the committed 340-screen local run: each recall gate is the lower of (measured recall - 0.05) and the 95% Wilson lower bound, and each FPR gate is the higher of (measured FPR + 0.03) and the 95% Wilson upper bound, so sampling noise on a larger corpus does not trip them. They detect regressions and are not targets. Gates passed: **True**. Failures: none.

## Latency

Per-frame processing: p50 9950 ms, p95 24576 ms, p99 34515 ms, measured with 4 concurrent OCR workers sharing one CPU, so per-frame time includes contention between workers and other host load. Choose the stream delay using sample interval + measured p99 + margin.

## Scope decisions

- Private, loopback, link-local, CGNAT and multicast IPs are not flagged (not identifying on the public internet); public IPv4 / IPv6 are.
- Version-context dotted numbers (`v1.2.3.4`, `version ...`, `build ...`) are never IPs.
- National IDs (US SSN, UK NINO) and IBANs (mod-97 validated) are their own kinds; clients that list `card` but neither new kind get both.

## Limits

The corpus is a generated test corpus with DOM-derived ground truth (bench/generate.py, reproducible from a fixed seed). The detector was not tuned on this corpus's per-screen values; the same team wrote the generator, so results describe the value formats and layouts listed above rather than every possible desktop. Concurrent CPU inference excludes queue wait; resumed samples retain their original measured timestamps.

Evidence: [benchmark.predictions-bbcda382ad8f2a4c.jsonl](benchmark.predictions-bbcda382ad8f2a4c.jsonl), source archive [benchmark.source-85957310e854.zip](benchmark.source-85957310e854.zip).
