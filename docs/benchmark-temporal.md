# Temporal benchmark

**Generated test corpus with known ground truth.** Every frame is drawn with PIL at
1280x720 from reproducible example values (example.com emails, 555 phone numbers, random
AWS-style keys), so every target position is known exactly. The frames run through the
production OCR pipeline; use the numbers as a regression signal across runs, and run
Pre-flight on your own setup to measure it on your desktop.

Latency is wall-clock time on a general-purpose host, so compare runs from the same
machine.

Run: 6 sequences x 12 frames, 250.0 ms sample
interval, seed 0. Host: Windows-10-10.0.26300-SP0. Scenarios rotate through
toast email, chat phone, typed email, editor-to-inbox switch, terminal AWS secret.

## Per-frame latency (`Pipeline.process`, wall clock)

| frames | count | p50 | p95 | p99 | max | unit |
|---|---|---|---|---|---|---|
| steady (pixels identical to previous) | 37 | 89.61 | 4737.52 | 10293.43 | 12840.62 | ms |
| change (pixels differ) | 35 | 6267.38 | 10927.73 | 12629.63 | 13499.38 | ms |

OCR model load (12750.41 ms) is measured once before the run and excluded.
Steady frames can still pay full OCR when the detector's periodic refresh fires.

## Time to mask

A target counts as masked when one detection covers at least 90%
of its drawn text box. Frames counted from the first frame the full value is visible; ms is
frames x interval + processing latency of the masking frame. This harness calls
`process` synchronously on every frame, so a frame count of 0 means the value was covered
in the first frame it appeared; the ms figure is the real cost of that frame's processing.

Masked 6/6 targets (never masked: 0).

| metric | count | p50 | p95 | p99 | max | unit |
|---|---|---|---|---|---|---|
| frames until covered | 6 | 0.0 | 0.0 | 0.0 | 0 | frames |
| time until covered | 6 | 6194.36 | 9137.94 | 9148.98 | 9151.74 | ms |

## Recall and false positives

- Frame recall (target-visible frames that were covered): 39/39 = 1.0
- False-positive detections: 27 over 72 frames (0.375 per frame; 7 frames with any)

| seq | scenario | masked | frames to mask | covered frames | FP dets |
|---|---|---|---|---|---|
| 0 | toast_email | 1/1 | 0 | 6/6 | 0 |
| 1 | chat_phone | 1/1 | 0 | 8/8 | 27 |
| 2 | typing_email | 1/1 | 0 | 5/5 | 0 |
| 3 | editor_to_inbox | 1/1 | 0 | 7/7 | 0 |
| 4 | terminal_secret | 1/1 | 0 | 6/6 | 0 |
| 5 | toast_email | 1/1 | 0 | 7/7 | 0 |

## Gates

- `min_frame_recall`: 0.7
- `min_masked_fraction`: 0.8
- `max_time_to_mask_frames_p95`: 2
- `max_false_positives_per_frame`: 1.0
- `max_change_latency_p95_ms`: 20000
- `max_steady_latency_p95_ms`: 20000

Result: **PASS**
