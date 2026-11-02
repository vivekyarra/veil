"""Reproducible pixel inference with resumable evidence and coverage-based one-to-one scoring."""

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

KINDS = [
    "email",
    "card",
    "secret",
    "vault",
    "phone",
    "address",
    "ip",
    "national_id",
    "iban",
]
NEGATIVE_CATEGORIES = [
    "code",
    "chat_mention",
    "time_at",
    "version",
    "private_ip",
    "date",
    "reference_number",
    "non_luhn_16",
    "scoreboard",
    "url",
]


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
    corpus = [
        json.loads(line)
        for line in (data / "manifest.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    records = corpus[:limit]
    for record in records:
        for item in record["targets"] + record["negatives"]:
            visible_box(item["box"])
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
            for p in sources + [
                Path(__file__),
                Path("bench/generate.py"),
                Path("bench/thresholds.json"),
            ]:
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
                    progress = {
                        "completed": len(predictions),
                        "total": len(records),
                        "run_key": key,
                    }
                    try:
                        output.with_suffix(".progress.json").write_text(
                            json.dumps(progress), encoding="utf-8"
                        )
                    except OSError:
                        pass  # progress is advisory; a transient file lock must not abort a run
    finally:
        pool.shutdown(wait=True, cancel_futures=True)
    summary = score(records, predictions)
    thresholds = json.loads(Path("bench/thresholds.json").read_text())
    metrics = summary["metrics"]
    failures = [
        f"{kind} recall {metrics.get(kind, {}).get('recall', 0):.4f} < {gate}"
        for kind, gate in thresholds["recall"].items()
        if kind not in metrics or metrics[kind]["recall"] < gate
    ]
    if summary["negative_screen_fpr"] > thresholds["negative_screen_fpr"]:
        failures.append(
            f"negative-screen FPR {summary['negative_screen_fpr']:.4f} > "
            f"{thresholds['negative_screen_fpr']}"
        )
    for category, gate in thresholds.get("hard_negative_fpr", {}).items():
        value = summary["hard_negatives"].get(category, {}).get("fpr", 0.0)
        if value > gate:
            failures.append(f"{category} hard-negative FPR {value:.4f} > {gate}")
    latency = {
        f"p{p}": float(np.percentile([r["latency_ms"] for r in predictions], p))
        for p in (50, 95, 99)
    }
    summary = {
        **run,
        "screens": len(records),
        "corpus_screens": len(corpus),
        "partial": len(records) < len(corpus),
        "completed_at_utc": datetime.now(timezone.utc).isoformat(),
        "provider": f"CPU ONNX, 2 threads per OCR worker, {workers} concurrent workers",
        **summary,
        "latency_ms": latency,
        "gates": thresholds,
        "gate_failures": failures,
        "gates_passed": not failures,
        "matching": MATCHING,
        "predictions_file": prediction_file.name,
        "predictions_sha256": hashlib.sha256(prediction_file.read_bytes()).hexdigest(),
        "source_archive": archive.name,
        "limits": LIMITS,
    }
    output.with_suffix(".json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8"
    )
    output.with_suffix(".md").write_text(markdown(summary), encoding="utf-8")
    return summary


MATCHING = (
    "Ground truth is the glyph ink box of each labelled span (pixel difference between the "
    "screen and the same screen with that text made transparent). A target is a hit when one "
    "unmatched detection of the same kind covers at least 90% of the ink box area and is no "
    "larger than 8x that area (so a full-screen mask cannot score). Matching is one-to-one; "
    "duplicate boxes and wrong-kind predictions count as false positives. Recall at IoU >= 0.5 "
    "against the ink box is reported alongside as a stricter localisation measure. A hard-"
    "negative span is a false positive when an unmatched detection covers at least 30% of it."
)
LIMITS = (
    "The corpus is a generated test corpus with DOM-derived ground truth (bench/generate.py, "
    "reproducible from a fixed seed). The detector was not tuned on this corpus's per-screen "
    "values; the same team wrote the generator, so results describe the value formats and "
    "layouts listed above rather than every possible desktop. Concurrent CPU inference "
    "excludes queue wait; resumed samples retain their original measured timestamps."
)


def coverage(detection: Box, truth: Box) -> float:
    """Fraction of the ground-truth area inside the detection."""
    overlap = max(
        0.0,
        min(detection.x + detection.w, truth.x + truth.w) - max(detection.x, truth.x),
    )
    overlap *= max(
        0.0,
        min(detection.y + detection.h, truth.y + truth.h) - max(detection.y, truth.y),
    )
    return overlap / (truth.w * truth.h)


def score(
    records: list[dict[str, Any]], predictions: list[dict[str, Any]]
) -> dict[str, Any]:
    """Coverage-based one-to-one scoring plus per-category hard-negative FPR."""
    counts = {
        kind: {"tp": 0, "fp": 0, "positive": 0, "iou": 0.0, "iou50": 0}
        for kind in KINDS
    }
    formats: dict[str, dict[str, int]] = {}
    hard: dict[str, dict[str, Any]] = {
        category: {"spans": 0, "flagged": 0, "kinds": {}}
        for category in NEGATIVE_CATEGORIES
    }
    negatives = negative_fp = 0
    for record, row in zip(records, predictions):
        result = DetectionResult.model_validate(row["result"])
        detections = [d for d in result.detections if d.kind in counts]
        used: set[int] = set()
        for target in sorted(
            record["targets"], key=lambda t: t["box"]["width"] * t["box"]["height"]
        ):
            truth = visible_box(target["box"])
            kind = target["kind"]
            count = counts[kind]
            count["positive"] += 1
            best, best_cov = -1, 0.0
            for index, detection in enumerate(detections):
                if index in used or detection.kind != kind:
                    continue
                cov = coverage(detection.box, truth)
                oversize = detection.box.w * detection.box.h > 8 * truth.w * truth.h
                if cov >= 0.9 and not oversize and cov > best_cov:
                    best, best_cov = index, cov
            same_kind = [d for d in detections if d.kind == kind]
            if max((iou(d.box, truth) for d in same_kind), default=0.0) >= 0.5:
                count["iou50"] += 1
            fmt = formats.setdefault(
                f"{kind}:{target['format']}", {"screens": 0, "hits": 0}
            )
            fmt["screens"] += 1
            if best >= 0:
                used.add(best)
                count["tp"] += 1
                count["iou"] += iou(detections[best].box, truth)
                fmt["hits"] += 1
        unmatched = [d for i, d in enumerate(detections) if i not in used]
        for detection in unmatched:
            counts[detection.kind]["fp"] += 1
        for negative in record["negatives"]:
            span = visible_box(negative["box"])
            entry = hard[negative["category"]]
            entry["spans"] += 1
            hits = [d for d in unmatched if coverage(d.box, span) >= 0.3]
            if hits:
                entry["flagged"] += 1
                for detection in hits:
                    entry["kinds"][detection.kind] = (
                        entry["kinds"].get(detection.kind, 0) + 1
                    )
        if not record["targets"]:
            negatives += 1
            negative_fp += bool(result.detections)
    metrics = {
        kind: {
            "screens": c["positive"],
            "true_positives": c["tp"],
            "false_positive_boxes": c["fp"],
            "precision": c["tp"] / max(1, c["tp"] + c["fp"]),
            "recall": c["tp"] / max(1, c["positive"]),
            "recall_iou50": c["iou50"] / max(1, c["positive"]),
            "mean_iou": c["iou"] / max(1, c["tp"]),
        }
        for kind, c in counts.items()
        if c["positive"] or c["fp"]
    }
    for entry in hard.values():
        entry["fpr"] = entry["flagged"] / max(1, entry["spans"])
    return {
        "metrics": metrics,
        "formats": {
            name: {**value, "recall": value["hits"] / max(1, value["screens"])}
            for name, value in sorted(formats.items())
        },
        "hard_negatives": hard,
        "negative_screens": negatives,
        "negative_screen_fpr": negative_fp / max(1, negatives),
    }


def partial_note(summary: dict[str, Any]) -> str:
    if not summary.get("partial"):
        return ""
    return (
        f"> **Partial run:** scored on the first {summary['screens']} screens of the "
        f"{summary['corpus_screens']}-screen corpus (`--limit {summary['screens']}`); the full "
        "corpus is evaluated in the CI benchmark job.\n\n"
    )


def highlights(summary: dict[str, Any]) -> str:
    """Headline numbers for the top of the page, derived from the scored run."""
    metrics = summary["metrics"]
    ranked = sorted(metrics.items(), key=lambda item: -item[1]["recall"])
    recall = ", ".join(f"{kind} {m['recall']:.1%}" for kind, m in ranked)
    worst_hard = max(h["fpr"] for h in summary["hard_negatives"].values())
    return (
        "## Highlights\n\n"
        f"- **Recall by kind (coverage >= 0.9):** {recall}.\n"
        f"- **Negative screens:** {summary['negative_screen_fpr']:.2%} of the "
        f"{summary['negative_screens']} screens with no private text produced any detection.\n"
        f"- **Hard negatives:** at most {worst_hard:.2%} of spans in any distractor category "
        "(code, dates, versions, private IPs, URLs and more) were masked.\n"
        "- **Scoring:** coverage-based and one-to-one, so a full-screen mask or duplicate "
        "boxes cannot inflate recall (details below)."
    )


def markdown(summary: dict[str, Any]) -> str:
    """Render the canonical benchmark page."""
    rows = "\n".join(
        f"| {kind} | {m['screens']} | {m['true_positives']} | {m['false_positive_boxes']} | "
        f"{m['precision']:.4f} | {m['recall']:.4f} | {m['recall_iou50']:.4f} | {m['mean_iou']:.4f} |"
        for kind, m in summary["metrics"].items()
    )
    hard = "\n".join(
        f"| {category} | {h['spans']} | {h['flagged']} | {h['fpr']:.4f} | "
        f"{', '.join(f'{k} {n}' for k, n in sorted(h['kinds'].items())) or '-'} |"
        for category, h in summary["hard_negatives"].items()
    )
    formats = "\n".join(
        f"| {name} | {f['screens']} | {f['recall']:.4f} |"
        for name, f in summary["formats"].items()
    )
    latency = ", ".join(f"{k} {v:.0f} ms" for k, v in summary["latency_ms"].items())
    failures = (
        "".join(f"\n- {failure}" for failure in summary["gate_failures"]) or " none."
    )
    return f"""# Controlled screenshot benchmark

{partial_note(summary)}{summary["screens"]}-screen run on a generated test corpus with DOM-derived ground truth: rendered 1920x1080 screenshots from `bench/generate.py`, scored against the pixel position of every labelled span. {summary["provider"]}.

{highlights(summary)}

## Scoring

{summary["matching"]}

## Recall and precision by kind

| Kind | Targets | Hits | FP boxes | Precision | Recall (coverage >= 0.9) | Recall (IoU >= 0.5) | Mean IoU of hits |
|---|---:|---:|---:|---:|---:|---:|---:|
{rows}

## Hard negatives

Spans that must not be masked, placed as distractors beside targets and on {summary["negative_screens"]} screens with no targets. Negative-screen FPR (any detection on a screen with no targets): **{summary["negative_screen_fpr"]:.4%}**.

| Category | Spans | Flagged | FPR | Kinds that fired |
|---|---:|---:|---:|---|
{hard}

## Recall by value format

| Kind:format | Targets | Recall |
|---|---:|---:|
{formats}

## Gates

CI gates (`bench/thresholds.json`) were derived from the committed 340-screen local run: each recall gate is the lower of (measured recall - 0.05) and the 95% Wilson lower bound, and each FPR gate is the higher of (measured FPR + 0.03) and the 95% Wilson upper bound, so sampling noise on a larger corpus does not trip them. They detect regressions and are not targets. Gates passed: **{summary["gates_passed"]}**. Failures:{failures}

## Latency

Per-frame processing: {latency}, measured with {summary["workers"]} concurrent OCR workers sharing one CPU, so per-frame time includes contention between workers and other host load. Choose the stream delay using sample interval + measured p99 + margin.

## Scope decisions

- Private, loopback, link-local, CGNAT and multicast IPs are not flagged (not identifying on the public internet); public IPv4 / IPv6 are.
- Version-context dotted numbers (`v1.2.3.4`, `version ...`, `build ...`) are never IPs.
- National IDs (US SSN, UK NINO) and IBANs (mod-97 validated) are their own kinds; clients that list `card` but neither new kind get both.

## Limits

{summary["limits"]}

Evidence: [{summary["predictions_file"]}]({summary["predictions_file"]}), source archive [{summary["source_archive"]}]({summary["source_archive"]}).
"""


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, default=Path("bench/data"))
    parser.add_argument("--limit", type=int)
    parser.add_argument("--output", type=Path, default=Path("docs/benchmark"))
    parser.add_argument("--workers", type=int, choices=range(1, 5), default=1)
    args = parser.parse_args()
    report = evaluate(args.data, args.limit, args.output, args.workers)
    raise SystemExit(0 if report["gates_passed"] else 1)
