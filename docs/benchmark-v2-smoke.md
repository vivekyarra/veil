# Measured synthetic benchmark

42 rendered 1920×1080 screenshots. CPU ONNX, 2 threads per OCR worker, 2 concurrent workers.

| Kind | Positive screens | Precision | Recall | Mean IoU |
|---|---:|---:|---:|---:|
| email | 6 | 1.0000 | 1.0000 | 0.6488 |
| card | 6 | 1.0000 | 1.0000 | 0.7613 |
| secret | 6 | 1.0000 | 1.0000 | 0.6576 |
| vault | 6 | 1.0000 | 1.0000 | 0.6503 |
| phone | 6 | 1.0000 | 1.0000 | 0.6973 |
| address | 6 | 1.0000 | 1.0000 | 0.6535 |

Negative-screen FPR: 0.0000%, 6 negative screens. Latency ms: {'p50': 6947.909649999929, 'p95': 10073.20681000783, 'p99': 10678.376410996862}. Gates passed: True.

One-to-one boxes at IoU >= 0.30, visible DOM intersection. Duplicate boxes and wrong-kind predictions count as false positives.

Synthetic screenshots only. Concurrent inference excludes queue wait; resumed samples retain measured timestamps. Not a real-stream or reference-GPU guarantee.

Evidence: [benchmark-v2-smoke.predictions-8dc147f2501d1c89.jsonl](benchmark-v2-smoke.predictions-8dc147f2501d1c89.jsonl), source archive [benchmark-v2-smoke.source-926b01ef3f30.zip](benchmark-v2-smoke.source-926b01ef3f30.zip).

Required delay is sample interval + measured p99 + margin. Sustained 1080p60, plugin CPU, reference GPU and clean-machine onboarding remain separate validation gates.
