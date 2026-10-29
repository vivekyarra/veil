"""Reproducible pixel inference with resumable evidence and one-to-one box scoring."""

from __future__ import annotations
import argparse
import hashlib
import io
import json
import platform
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path
from threading import local
from typing import Any
import numpy as np
from PIL import Image
import rapidocr_onnxruntime
from veil_detector.models import Box, DetectionResult
from veil_detector.pipeline import Pipeline
from veil_detector.tracker import iou


def visible_box(rect: dict[str, float], width: int = 1920, height: int = 1080) -> Box:
    """Clip DOM geometry to pixels that actually appear in the screenshot."""
    x = max(0.0, min(float(width), rect["x"]))
    y = max(0.0, min(float(height), rect["y"]))
    right = min(float(width), rect["x"] + rect["width"])
    bottom = min(float(height), rect["y"] + rect["height"])
    if right <= x or bottom <= y:
        raise ValueError("Ground truth is entirely outside the screenshot")
    return Box(
        x=x / width, y=y / height, w=(right - x) / width, h=(bottom - y) / height
    )


def evaluate(
    data: Path, limit: int | None, output: Path, workers: int
) -> dict[str, Any]:
    """Cache actual predictions by source, weights, corpus and worker configuration."""
    output.parent.mkdir(parents=True, exist_ok=True)
    records = [
        json.loads(line)
        for line in (data / "manifest.jsonl").read_text(encoding="utf-8").splitlines()
    ][:limit]
    for record in records:
        if record["kind"] != "negative":
            visible_box(record["box"])
    sources = sorted(Path("detector/veil_detector").rglob("*.py"))
    source_hash = hashlib.sha256(b"".join(p.read_bytes() for p in sources)).hexdigest()
    manifest_hash = hashlib.sha256((data / "manifest.jsonl").read_bytes()).hexdigest()
    model_dir = Path(rapidocr_onnxruntime.__file__).parent / "models"
    weights = {
        p.name: hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(model_dir.glob("*.onnx"))
    }
    run = {
        "source_sha256": source_hash,
        "manifest_sha256": manifest_hash,
        "model_sha256": weights,
        "workers": workers,
        "onnxruntime": version("onnxruntime"),
        "rapidocr": version("rapidocr-onnxruntime"),
        "processor": platform.processor(),
        "platform": platform.platform(),
    }
    key = hashlib.sha256(json.dumps(run, sort_keys=True).encode()).hexdigest()[:16]
    prediction_file = output.parent / (output.name + ".predictions-" + key + ".jsonl")
    archive = output.parent / (output.name + ".source-" + source_hash[:12] + ".zip")
    if not archive.exists():
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
            for p in sources + [Path(__file__), Path("bench/thresholds.json")]:
                bundle.write(p, p.as_posix())
    cache: dict[str, dict[str, Any]] = {}
    if prediction_file.exists():
        for line in prediction_file.read_text(encoding="utf-8").splitlines():
            try:
                row = json.loads(line)
                DetectionResult.model_validate(row["result"])
                cache[row["file"]] = row
            except (ValueError, KeyError):
                continue
    state = local()

    def infer(pair: tuple[int, dict[str, Any]]) -> dict[str, Any]:
        index, record = pair
        blob = (data / record["file"]).read_bytes()
        image_hash = hashlib.sha256(blob).hexdigest()
        if (
            record["file"] in cache
            and cache[record["file"]]["image_sha256"] == image_hash
        ):
            return cache[record["file"]]
        if not hasattr(state, "pipeline"):
            state.pipeline = Pipeline()
        pipeline = state.pipeline
        pipeline.tracker.tracks.clear()
        pipeline.change.previous = None
        pipeline.vault = record["vault"]
        pixels = np.asarray(Image.open(io.BytesIO(blob)).convert("RGB"), dtype=np.uint8)
        start = time.perf_counter()
        result = pipeline.process(pixels, index, index * 250.0)
        return {
            "file": record["file"],
            "image_sha256": image_hash,
            "latency_ms": (time.perf_counter() - start) * 1000,
            "result": result.model_dump(),
            "measured_at": datetime.now(timezone.utc).isoformat(),
        }

    predictions = []
    pool = ThreadPoolExecutor(max_workers=workers)
    try:
        with prediction_file.open("a", encoding="utf-8") as log:
            for start in range(0, len(records), workers * 4):
                batch = list(enumerate(records))[start : start + workers * 4]
                for row in pool.map(infer, batch):
                    predictions.append(row)
                    if row["file"] not in cache:
                        log.write(json.dumps(row) + "\n")
                        log.flush()
                        cache[row["file"]] = row
                    output.with_suffix(".progress.json").write_text(
                        json.dumps(
                            {
                                "completed": len(predictions),
                                "total": len(records),
                                "run_key": key,
                            }
                        ),
                        encoding="utf-8",
                    )
    finally:
        pool.shutdown(wait=True, cancel_futures=True)
    kinds = ["email", "card", "secret", "vault", "phone", "address", "ip"]
    counts = {kind: {"tp": 0, "fp": 0, "positive": 0, "iou": 0.0} for kind in kinds}
    negatives = negative_fp = 0
    for record, row in zip(records, predictions):
        result = DetectionResult.model_validate(row["result"])
        expected = record["kind"]
        truth = visible_box(record["box"]) if expected != "negative" else None
        if expected == "negative":
            negatives += 1
            negative_fp += bool(result.detections)
        for kind in kinds:
            detections = [d for d in result.detections if d.kind == kind]
            count = counts[kind]
            if kind == expected and truth is not None:
                count["positive"] += 1
                best = max((iou(d.box, truth) for d in detections), default=0.0)
                matched = int(best >= 0.3)
                count["tp"] += matched
                count["iou"] += best if matched else 0
                count["fp"] += len(detections) - matched
            else:
                count["fp"] += len(detections)
    metrics = {
        kind: {
            "screens": c["positive"],
            "true_positives": c["tp"],
            "false_positive_boxes": c["fp"],
            "precision": c["tp"] / max(1, c["tp"] + c["fp"]),
            "recall": c["tp"] / max(1, c["positive"]),
            "mean_iou": c["iou"] / max(1, c["tp"]),
        }
        for kind, c in counts.items()
        if c["positive"] or c["fp"]
    }
    thresholds = json.loads(Path("bench/thresholds.json").read_text())
    fpr = negative_fp / max(1, negatives)
    passed = (
        all(
            kind in metrics and metrics[kind]["recall"] >= gate
            for kind, gate in thresholds["recall"].items()
        )
        and fpr <= thresholds["negative_screen_fpr"]
    )
    latency = {
        f"p{p}": float(np.percentile([r["latency_ms"] for r in predictions], p))
        for p in (50, 95, 99)
    }
    summary = {
        **run,
        "screens": len(records),
        "completed_at_utc": datetime.now(timezone.utc).isoformat(),
        "provider": f"CPU ONNX, 2 threads per OCR worker, {workers} concurrent workers",
        "metrics": metrics,
        "negative_screens": negatives,
        "negative_screen_fpr": fpr,
        "latency_ms": latency,
        "gates_passed": passed,
        "matching": "One-to-one boxes at IoU >= 0.30, visible DOM intersection. Duplicate boxes and wrong-kind predictions count as false positives.",
        "predictions_file": prediction_file.name,
        "predictions_sha256": hashlib.sha256(prediction_file.read_bytes()).hexdigest(),
        "source_archive": archive.name,
        "limits": "Synthetic screenshots only. Concurrent inference excludes queue wait; resumed samples retain measured timestamps. Not a real-stream or reference-GPU guarantee.",
    }
    output.with_suffix(".json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8"
    )
    rows = "\n".join(
        f"| {kind} | {m['screens']} | {m['precision']:.4f} | {m['recall']:.4f} | {m['mean_iou']:.4f} |"
        for kind, m in metrics.items()
    )
    output.with_suffix(".md").write_text(
        f"# Measured synthetic benchmark\n\n{len(records)} rendered 1920×1080 screenshots. {summary['provider']}.\n\n| Kind | Positive screens | Precision | Recall | Mean IoU |\n|---|---:|---:|---:|---:|\n{rows}\n\nNegative-screen FPR: {fpr:.4%}, {negatives} negative screens. Latency ms: {latency}. Gates passed: {passed}.\n\n{summary['matching']}\n\n{summary['limits']}\n\nEvidence: [{prediction_file.name}]({prediction_file.name}), source archive [{archive.name}]({archive.name}).\n\nRequired delay is sample interval + measured p99 + margin. Sustained 1080p60, plugin CPU, reference GPU and clean-machine onboarding remain separate validation gates.\n",
        encoding="utf-8",
    )
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, default=Path("bench/data"))
    parser.add_argument("--limit", type=int)
    parser.add_argument("--output", type=Path, default=Path("docs/benchmark"))
    parser.add_argument("--workers", type=int, choices=range(1, 5), default=1)
    args = parser.parse_args()
    report = evaluate(args.data, args.limit, args.output, args.workers)
    raise SystemExit(0 if report["gates_passed"] else 1)
