# Measured synthetic benchmark

3000 rendered 1920×1080 screenshots. CPU ONNX, 2 threads per OCR worker, 2 concurrent workers.

| Kind | Positive screens | Precision | Recall | Mean IoU |
|---|---:|---:|---:|---:|
| email | 429 | 1.0000 | 0.9977 | 0.6728 |
| card | 429 | 1.0000 | 0.9977 | 0.7213 |
| secret | 429 | 1.0000 | 0.9930 | 0.6462 |
| vault | 429 | 1.0000 | 1.0000 | 0.6398 |
| phone | 428 | 0.9510 | 0.9977 | 0.7146 |
| address | 428 | 1.0000 | 0.9977 | 0.6883 |

Negative-screen FPR: 0.4673%, 428 negative screens. Latency ms: {'p50': 1347.7617500001315, 'p95': 2132.4581949998665, 'p99': 2490.781044000032}. Gates passed: True.

One-to-one boxes at IoU >= 0.30, visible DOM intersection. Duplicate boxes and wrong-kind predictions count as false positives.

Synthetic screenshots only. Concurrent inference excludes queue wait; resumed samples retain measured timestamps. Not a real-stream or reference-GPU guarantee.

Evidence: [benchmark-ci.predictions-5f5872f1e8e0c88b.jsonl](benchmark-ci.predictions-5f5872f1e8e0c88b.jsonl), source archive [benchmark-ci.source-15d055b7f937.zip](benchmark-ci.source-15d055b7f937.zip).

Required delay is sample interval + measured p99 + margin. Sustained 1080p60, plugin CPU, reference GPU and clean-machine onboarding remain separate validation gates.
