# Measured synthetic benchmark

3000 rendered 1920×1080 screenshots. CPU ONNX, 2 threads per OCR worker, 4 concurrent workers.

| Kind | Positive screens | Precision | Recall | Mean IoU |
|---|---:|---:|---:|---:|
| email | 429 | 1.0000 | 0.9977 | 0.6728 |
| card | 429 | 1.0000 | 0.9697 | 0.7249 |
| secret | 429 | 1.0000 | 0.9930 | 0.6459 |
| vault | 429 | 1.0000 | 1.0000 | 0.6399 |
| phone | 428 | 0.9510 | 0.9977 | 0.7145 |
| address | 428 | 1.0000 | 0.9977 | 0.6880 |

Negative-screen FPR: 0.4673%, 428 negative screens. Latency ms: {'p50': 8781.823749995965, 'p95': 17708.016774997668, 'p99': 26520.27111199044}. Gates passed: False.

One-to-one boxes at IoU >= 0.30, visible DOM intersection. Duplicate boxes and wrong-kind predictions count as false positives.

Synthetic screenshots only. Concurrent inference excludes queue wait; resumed samples retain measured timestamps. Not a real-stream or reference-GPU guarantee.

Evidence: [benchmark-full.predictions-19dfe2851ce9d22b.jsonl](benchmark-full.predictions-19dfe2851ce9d22b.jsonl), source archive [benchmark-full.source-dba8dbc6c66b.zip](benchmark-full.source-dba8dbc6c66b.zip).

Required delay is sample interval + measured p99 + margin. Sustained 1080p60, plugin CPU, reference GPU and clean-machine onboarding remain separate validation gates.
