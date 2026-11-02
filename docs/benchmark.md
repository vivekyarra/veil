# Controlled screenshot benchmark

3000-screen run on a generated test corpus with DOM-derived ground truth: rendered 1920x1080 screenshots from `bench/generate.py`, scored against the pixel position of every labelled span. CPU ONNX, 2 threads per OCR worker, 2 concurrent workers.

## Highlights

- **Recall by kind (coverage >= 0.9):** card 99.7%, vault 99.7%, email 98.8%, iban 96.7%, national_id 95.2%, ip 90.0%, secret 89.3%, phone 86.8%, address 73.0%.
- **Negative screens:** 2.49% of the 883 screens with no private text produced any detection.
- **Hard negatives:** at most 2.96% of spans in any distractor category (code, dates, versions, private IPs, URLs and more) were masked.
- **Scoring:** coverage-based and one-to-one, so a full-screen mask or duplicate boxes cannot inflate recall (details below).

## Scoring

Ground truth is the glyph ink box of each labelled span (pixel difference between the screen and the same screen with that text made transparent). A target is a hit when one unmatched detection of the same kind covers at least 90% of the ink box area and is no larger than 8x that area (so a full-screen mask cannot score). Matching is one-to-one; duplicate boxes and wrong-kind predictions count as false positives. Recall at IoU >= 0.5 against the ink box is reported alongside as a stricter localisation measure. A hard-negative span is a false positive when an unmatched detection covers at least 30% of it.

## Recall and precision by kind

| Kind | Targets | Hits | FP boxes | Precision | Recall (coverage >= 0.9) | Recall (IoU >= 0.5) | Mean IoU of hits |
|---|---:|---:|---:|---:|---:|---:|---:|
| email | 320 | 316 | 7 | 0.9783 | 0.9875 | 0.4125 | 0.4891 |
| card | 328 | 327 | 48 | 0.8720 | 0.9970 | 0.1341 | 0.3753 |
| secret | 338 | 302 | 0 | 1.0000 | 0.8935 | 0.6982 | 0.5533 |
| vault | 296 | 295 | 0 | 1.0000 | 0.9966 | 0.3243 | 0.4423 |
| phone | 310 | 269 | 0 | 1.0000 | 0.8677 | 0.1710 | 0.4035 |
| address | 293 | 214 | 47 | 0.8199 | 0.7304 | 0.3481 | 0.4873 |
| ip | 309 | 278 | 3 | 0.9893 | 0.8997 | 0.2686 | 0.4257 |
| national_id | 311 | 296 | 0 | 1.0000 | 0.9518 | 0.0965 | 0.3699 |
| iban | 329 | 318 | 0 | 1.0000 | 0.9666 | 0.2523 | 0.4489 |

## Hard negatives

Spans that must not be masked, placed as distractors beside targets and on 883 screens with no targets. Negative-screen FPR (any detection on a screen with no targets): **2.4915%**.

| Category | Spans | Flagged | FPR | Kinds that fired |
|---|---:|---:|---:|---|
| code | 1597 | 0 | 0.0000 | - |
| chat_mention | 1567 | 2 | 0.0013 | email 2 |
| time_at | 1549 | 11 | 0.0071 | address 1, card 5, email 5 |
| version | 1545 | 9 | 0.0058 | card 6, ip 3 |
| private_ip | 1560 | 16 | 0.0103 | address 1, card 15 |
| date | 1587 | 47 | 0.0296 | address 41, card 6 |
| reference_number | 1473 | 3 | 0.0020 | address 1, card 2 |
| non_luhn_16 | 1616 | 43 | 0.0266 | address 2, card 41 |
| scoreboard | 1584 | 10 | 0.0063 | address 2, card 8 |
| url | 1560 | 2 | 0.0013 | card 2 |

## Recall by value format

| Kind:format | Targets | Recall |
|---|---:|---:|
| address:de | 55 | 0.4000 |
| address:fr | 59 | 0.8644 |
| address:uk | 58 | 0.5517 |
| address:us | 121 | 0.9008 |
| card:amex-dash | 14 | 1.0000 |
| card:amex-dash-split-inputs | 1 | 1.0000 |
| card:amex-plain | 19 | 1.0000 |
| card:amex-plain-split-inputs | 2 | 1.0000 |
| card:amex-space | 23 | 1.0000 |
| card:amex-space-split-inputs | 8 | 1.0000 |
| card:discover-dash | 15 | 1.0000 |
| card:discover-dash-split-inputs | 8 | 1.0000 |
| card:discover-plain | 8 | 1.0000 |
| card:discover-plain-split-inputs | 6 | 1.0000 |
| card:discover-space | 19 | 1.0000 |
| card:discover-space-split-inputs | 4 | 1.0000 |
| card:mastercard-dash | 24 | 1.0000 |
| card:mastercard-dash-split-inputs | 10 | 1.0000 |
| card:mastercard-plain | 33 | 1.0000 |
| card:mastercard-plain-split-inputs | 7 | 1.0000 |
| card:mastercard-space | 47 | 0.9787 |
| card:mastercard-space-split-inputs | 15 | 1.0000 |
| card:visa-dash | 11 | 1.0000 |
| card:visa-dash-split-inputs | 5 | 1.0000 |
| card:visa-plain | 13 | 1.0000 |
| card:visa-plain-split-inputs | 6 | 1.0000 |
| card:visa-space | 18 | 1.0000 |
| card:visa-space-split-inputs | 12 | 1.0000 |
| email:au | 8 | 1.0000 |
| email:biz | 6 | 1.0000 |
| email:com | 113 | 1.0000 |
| email:de | 35 | 0.9714 |
| email:dev | 16 | 1.0000 |
| email:fr | 39 | 0.9744 |
| email:info | 6 | 1.0000 |
| email:io | 9 | 0.8889 |
| email:net | 27 | 1.0000 |
| email:org | 41 | 0.9756 |
| email:uk | 20 | 1.0000 |
| iban:DE | 64 | 1.0000 |
| iban:ES | 70 | 0.9714 |
| iban:FR | 70 | 0.9857 |
| iban:GB | 74 | 0.9595 |
| iban:NL | 51 | 0.9020 |
| ip:ipv4 | 241 | 0.9004 |
| ip:ipv6 | 68 | 0.8971 |
| national_id:uk_nino | 100 | 0.8500 |
| national_id:us_ssn | 211 | 1.0000 |
| phone:AU-e164 | 8 | 1.0000 |
| phone:AU-international | 15 | 1.0000 |
| phone:AU-national | 5 | 0.4000 |
| phone:BR-e164 | 4 | 1.0000 |
| phone:BR-international | 10 | 1.0000 |
| phone:BR-national | 5 | 0.2000 |
| phone:CA-e164 | 7 | 1.0000 |
| phone:CA-international | 9 | 1.0000 |
| phone:CA-national | 3 | 1.0000 |
| phone:DE-e164 | 9 | 1.0000 |
| phone:DE-international | 11 | 0.9091 |
| phone:DE-national | 8 | 0.2500 |
| phone:ES-e164 | 8 | 1.0000 |
| phone:ES-international | 13 | 1.0000 |
| phone:ES-national | 5 | 0.0000 |
| phone:FR-e164 | 8 | 1.0000 |
| phone:FR-international | 5 | 1.0000 |
| phone:FR-national | 9 | 0.6667 |
| phone:GB-e164 | 5 | 1.0000 |
| phone:GB-international | 14 | 1.0000 |
| phone:GB-national | 4 | 0.5000 |
| phone:IN-e164 | 5 | 1.0000 |
| phone:IN-international | 4 | 1.0000 |
| phone:IN-national | 3 | 0.0000 |
| phone:IT-e164 | 11 | 1.0000 |
| phone:IT-international | 11 | 1.0000 |
| phone:IT-national | 6 | 0.5000 |
| phone:JP-e164 | 6 | 1.0000 |
| phone:JP-international | 13 | 1.0000 |
| phone:JP-national | 8 | 0.6250 |
| phone:MX-e164 | 7 | 1.0000 |
| phone:MX-international | 12 | 1.0000 |
| phone:MX-national | 6 | 0.1667 |
| phone:NL-e164 | 13 | 1.0000 |
| phone:NL-international | 17 | 1.0000 |
| phone:NL-national | 3 | 0.0000 |
| phone:US-e164 | 4 | 1.0000 |
| phone:US-international | 10 | 1.0000 |
| phone:US-national | 6 | 1.0000 |
| secret:api_key | 27 | 0.9630 |
| secret:aws_access_key | 18 | 1.0000 |
| secret:aws_secret | 18 | 0.9444 |
| secret:bearer | 25 | 0.8000 |
| secret:env_password | 19 | 1.0000 |
| secret:github_app | 23 | 1.0000 |
| secret:github_classic | 15 | 1.0000 |
| secret:github_fine | 16 | 0.9375 |
| secret:gitlab | 19 | 1.0000 |
| secret:google | 30 | 0.6333 |
| secret:jwt | 18 | 0.8333 |
| secret:openai | 24 | 1.0000 |
| secret:password_bare | 19 | 0.7895 |
| secret:password_colon | 17 | 1.0000 |
| secret:slack | 30 | 0.7667 |
| secret:stripe | 20 | 0.8500 |
| vault:vault | 296 | 0.9966 |

## Gates

CI gates (`bench/thresholds.json`) were derived from the committed 340-screen local run: each recall gate is the lower of (measured recall - 0.05) and the 95% Wilson lower bound, and each FPR gate is the higher of (measured FPR + 0.03) and the 95% Wilson upper bound, so sampling noise on a larger corpus does not trip them. They detect regressions and are not targets. Gates passed: **False**. Failures:
- address recall 0.7304 < 0.81

## Latency

Per-frame processing: p50 2048 ms, p95 3142 ms, p99 3865 ms, measured with 2 concurrent OCR workers sharing one CPU, so per-frame time includes contention between workers and other host load. Choose the stream delay using sample interval + measured p99 + margin.

## Scope decisions

- Private, loopback, link-local, CGNAT and multicast IPs are not flagged (not identifying on the public internet); public IPv4 / IPv6 are.
- Version-context dotted numbers (`v1.2.3.4`, `version ...`, `build ...`) are never IPs.
- National IDs (US SSN, UK NINO) and IBANs (mod-97 validated) are their own kinds; clients that list `card` but neither new kind get both.

## Limits

The corpus is a generated test corpus with DOM-derived ground truth (bench/generate.py, reproducible from a fixed seed). The detector was not tuned on this corpus's per-screen values; the same team wrote the generator, so results describe the value formats and layouts listed above rather than every possible desktop. Concurrent CPU inference excludes queue wait; resumed samples retain their original measured timestamps.

Evidence: [benchmark.predictions-720c4b01026d12a1.jsonl](benchmark.predictions-720c4b01026d12a1.jsonl), source archive [benchmark.source-c0d2e7c72f7e.zip](benchmark.source-c0d2e7c72f7e.zip).
