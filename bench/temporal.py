"""Temporal benchmark: generated frame sequences through the production pipeline.

Every sequence is a generated test corpus with known ground truth, drawn with PIL at
1280x720 from reproducible example values. The
benchmark measures what a stream sees over time: per-frame latency (steady vs change
frames), how many frames and milliseconds pass before a newly visible secret is covered,
per-frame recall and false-positive detections.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import random
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from veil_detector.models import Box
from veil_detector.ocr import OCR
from veil_detector.pipeline import Pipeline

WIDTH, HEIGHT = 1280, 720
SCENARIOS = [
    "toast_email",
    "chat_phone",
    "typing_email",
    "editor_to_inbox",
    "terminal_secret",
]
COVERAGE = 0.9

_FONT_CACHE: dict[tuple[bool, int], Any] = {}


def font(size: int, mono: bool = False) -> Any:
    key = (mono, size)
    if key not in _FONT_CACHE:
        names = (
            ["consola.ttf", "DejaVuSansMono.ttf", "Menlo.ttc"]
            if mono
            else ["segoeui.ttf", "arial.ttf", "DejaVuSans.ttf", "Helvetica.ttc"]
        )
        loaded: Any = None
        for name in names:
            try:
                loaded = ImageFont.truetype(name, size)
                break
            except OSError:
                continue
        _FONT_CACHE[key] = loaded or ImageFont.load_default(size=size)
    return _FONT_CACHE[key]


@dataclass
class Frame:
    image: Image.Image
    # Every drawn string with its normalized (x, y, w, h); lets tests replay OCR exactly.
    texts: list[tuple[str, tuple[float, float, float, float]]] = field(
        default_factory=list
    )
    # Sensitive values that are fully visible and must be covered in this frame.
    targets: list[dict[str, Any]] = field(default_factory=list)
    # Partially visible sensitive text; detections here are neither credit nor FP.
    tolerated: list[tuple[float, float, float, float]] = field(default_factory=list)


class Canvas:
    def __init__(self, background: str) -> None:
        self.frame = Frame(Image.new("RGB", (WIDTH, HEIGHT), background))
        self.draw = ImageDraw.Draw(self.frame.image)

    def rect(self, xy: tuple[int, int, int, int], fill: str) -> None:
        self.draw.rectangle(xy, fill=fill)

    def text(
        self,
        x: int,
        y: int,
        value: str,
        size: int = 20,
        fill: str = "#202020",
        mono: bool = False,
    ) -> tuple[float, float, float, float]:
        f = font(size, mono)
        self.draw.text((x, y), value, font=f, fill=fill)
        left, top, right, bottom = self.draw.textbbox((x, y), value, font=f)
        norm = (
            left / WIDTH,
            top / HEIGHT,
            (right - left) / WIDTH,
            (bottom - top) / HEIGHT,
        )
        self.frame.texts.append((value, norm))
        return norm

    def target(
        self, kind: str, value: str, norm: tuple[float, float, float, float]
    ) -> None:
        self.frame.targets.append({"kind": kind, "id": f"{kind}:{value}", "box": norm})


def fake_email(rng: random.Random) -> str:
    first = rng.choice(["alice", "jordan", "priya", "mateo", "lena", "sam"])
    last = rng.choice(["smith", "okafor", "nguyen", "kowalski", "reyes"])
    return f"{first}.{last}{rng.randint(10, 99)}@example.com"


def desktop(c: Canvas, rng: random.Random) -> None:
    c.rect((0, 0, WIDTH, HEIGHT), "#2b5d8a")
    for i, name in enumerate(["Recycle Bin", "Projects", "Notes.txt", "OBS Studio"]):
        c.rect((40, 40 + i * 110, 104, 104 + i * 110), "#d9e4ef")
        c.text(30, 108 + i * 110, name, 16, "#ffffff")
    c.rect((0, HEIGHT - 48, WIDTH, HEIGHT), "#1b1f24")
    c.text(
        WIDTH - 110,
        HEIGHT - 36,
        f"{rng.randint(1, 12)}:{rng.randint(10, 59)} PM",
        18,
        "#fff",
    )


def toast_email(rng: random.Random, frames: int, onset: int) -> list[Frame]:
    email = fake_email(rng)
    seed = rng.random()
    out = []
    for i in range(frames):
        c = Canvas("#2b5d8a")
        desktop(c, random.Random(seed))
        if i >= onset:
            c.rect((800, 520, 1260, 660), "#f4f4f4")
            c.text(820, 535, "New message", 22, "#111")
            c.text(820, 572, "From:", 20, "#333")
            c.target("email", email, c.text(882, 572, email, 20, "#333"))
            c.text(820, 610, "Re: stream schedule for Friday", 18, "#555")
        out.append(c.frame)
    return out


def chat_phone(rng: random.Random, frames: int, onset: int) -> list[Frame]:
    users = ["pixelfox", "nightowl", "gg_ezra", "modbot", "tara_plays"]
    chatter = [
        "that boss fight was insane",
        "LUL",
        "what keyboard is that?",
        "patch 2.4.1 nerfed it",
        "see you at 9 tonight",
        "first time here, hi!",
        "clip it clip it",
        "rank 42 on the board",
    ]
    phone = f"+1 202 555 {rng.randint(1000, 9999)}"
    lines = [(rng.choice(users), rng.choice(chatter), False) for _ in range(onset + 1)]
    lines.append(("tara_plays", f"text me at {phone}", True))
    lines += [(rng.choice(users), rng.choice(chatter), False) for _ in range(frames)]
    out, visible, row = [], 12, 44
    for i in range(frames):
        c = Canvas("#18181b")
        c.rect((880, 0, WIDTH, HEIGHT), "#0e0e10")
        c.rect((0, 0, 870, HEIGHT), "#3a3a44")
        c.text(40, 40, "Live gameplay", 28, "#e0e0e0")
        shown = lines[max(0, i + 2 - visible) : i + 2]
        for j, (user, message, private) in enumerate(shown):
            y = 120 + (visible - len(shown) + j) * row
            c.text(900, y, f"{user}:", 18, "#bf94ff")
            if private:
                prefix = c.text(900 + 120, y, "text me at", 18, "#efeff1")
                start = int((prefix[0] + prefix[2]) * WIDTH) + 8
                c.target("phone", phone, c.text(start, y, phone, 18, "#efeff1"))
            else:
                c.text(900 + 120, y, message, 18, "#efeff1")
        out.append(c.frame)
    return out


def typing_email(rng: random.Random, frames: int, onset: int) -> list[Frame]:
    email = fake_email(rng)
    start = 1
    per = max(1, -(-len(email) // max(1, onset - start)))
    out = []
    for i in range(frames):
        c = Canvas("#f3f4f6")
        c.rect((340, 120, 940, 600), "#ffffff")
        c.text(380, 150, "Create your account", 30, "#111827")
        c.text(380, 230, "Display name", 18, "#374151")
        c.rect((380, 258, 900, 300), "#f9fafb")
        c.text(392, 266, "StreamerOne", 20, "#111827")
        c.text(380, 330, "Email", 18, "#374151")
        c.rect((380, 358, 900, 400), "#f9fafb")
        typed = email[: max(0, (i - start + 1) * per)] if i >= start else ""
        if typed:
            norm = c.text(392, 366, typed, 20, "#111827")
            if typed == email:
                c.target("email", email, norm)
            else:
                c.frame.tolerated.append(norm)
        c.rect((380, 460, 560, 504), "#2563eb")
        c.text(420, 470, "Continue", 20, "#ffffff")
        out.append(c.frame)
    return out


def editor_to_inbox(rng: random.Random, frames: int, onset: int) -> list[Frame]:
    sender = fake_email(rng)
    code = [
        "def handle(event):",
        "    if event.kind == 'follow':",
        "        queue.put(event.user)",
        "    return render(version='1.4.2')",
        "",
        "for i in range(10):",
        "    print(f'tick {i}')",
    ]
    out = []
    for i in range(frames):
        if i < onset:
            c = Canvas("#1e1e1e")
            c.rect((0, 0, 220, HEIGHT), "#252526")
            for j, name in enumerate(["main.py", "overlay.py", "README.md"]):
                c.text(20, 30 + j * 32, name, 16, "#cccccc")
            for j, line in enumerate(code):
                if line:
                    c.text(250, 40 + j * 30, line, 18, "#d4d4d4", mono=True)
        else:
            c = Canvas("#ffffff")
            c.rect((0, 0, 240, HEIGHT), "#f1f3f4")
            c.text(30, 40, "Inbox", 22, "#202124")
            c.text(30, 80, "Starred", 18, "#5f6368")
            subjects = [
                "Your invoice is ready",
                "Sponsorship question",
                "Weekly digest",
            ]
            for j, subject in enumerate(subjects):
                y = 60 + j * 70
                if j == 1:
                    c.target("email", sender, c.text(270, y, sender, 18, "#202124"))
                else:
                    c.text(270, y, "Team Updates", 18, "#202124")
                c.text(640, y, subject, 18, "#5f6368")
        out.append(c.frame)
    return out


def terminal_secret(rng: random.Random, frames: int, onset: int) -> list[Frame]:
    key = "".join(
        rng.choice("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/+")
        for _ in range(40)
    )
    secret = f"AWS_SECRET_ACCESS_KEY={key}"
    log = [
        "$ npm run build",
        "> veil-app@0.4.0 build",
        "compiled 214 modules in 3.2s",
        "$ cat .env",
        "NODE_ENV=production",
        "PORT=3000",
    ]
    before = log[: max(0, onset)]
    lines = (
        before + [secret] + ["AWS_REGION=us-east-1", "$ "] + ["" for _ in range(frames)]
    )
    out = []
    for i in range(frames):
        c = Canvas("#0c0c0c")
        shown = lines[: max(1, i + 1 - (onset - len(before)))]
        for j, line in enumerate(shown):
            if not line:
                continue
            norm = c.text(24, 24 + j * 28, line, 18, "#cccccc", mono=True)
            if line == secret:
                c.target("secret", secret, norm)
        out.append(c.frame)
    return out


GENERATORS: dict[str, Callable[[random.Random, int, int], list[Frame]]] = {
    "toast_email": toast_email,
    "chat_phone": chat_phone,
    "typing_email": typing_email,
    "editor_to_inbox": editor_to_inbox,
    "terminal_secret": terminal_secret,
}


def build(index: int, frames: int, seed: int = 0) -> tuple[str, list[Frame]]:
    name = SCENARIOS[index % len(SCENARIOS)]
    rng = random.Random(f"{seed}:{index}")
    onset = max(1, frames // 3 + rng.randint(0, max(0, frames // 6)))
    if name == "typing_email":
        onset = max(2, (frames * 2) // 3)
    return name, GENERATORS[name](rng, frames, min(onset, frames - 1))


def coverage(det: Box, truth: tuple[float, float, float, float]) -> float:
    x, y, w, h = truth
    ox = max(0.0, min(det.x + det.w, x + w) - max(det.x, x))
    oy = max(0.0, min(det.y + det.h, y + h) - max(det.y, y))
    return ox * oy / (w * h)


def overlaps(det: Box, region: tuple[float, float, float, float]) -> bool:
    return (
        coverage(det, region) > 0
        or coverage(
            Box(x=region[0], y=region[1], w=region[2], h=region[3]),
            (det.x, det.y, det.w, det.h),
        )
        > 0
    )


def pct(values: list[float], q: float) -> float | None:
    return round(float(np.percentile(values, q)), 2) if values else None


def stats(values: list[float]) -> dict[str, Any]:
    return {
        "count": len(values),
        "p50": pct(values, 50),
        "p95": pct(values, 95),
        "p99": pct(values, 99),
        "max": round(max(values), 2) if values else None,
    }


def run(
    sequences: int,
    frames: int,
    interval_ms: float = 250.0,
    seed: int = 0,
    pipeline_factory: Callable[[list[Frame]], Pipeline] | None = None,
) -> dict[str, Any]:
    """Run every sequence through a fresh pipeline (one capture stream per sequence)."""
    steady: list[float] = []
    change: list[float] = []
    ttm_frames: list[float] = []
    ttm_ms: list[float] = []
    target_frames = covered_frames = fp_dets = total_frames = fp_frames = 0
    per_sequence = []
    warmup_ms = None
    shared: OCR | None = None
    if pipeline_factory is None:
        # One engine shared by every stream; model load is measured once and excluded.
        shared = OCR()
        start = time.perf_counter()
        shared.read(np.full((HEIGHT, WIDTH, 3), 255, dtype=np.uint8))
        warmup_ms = round((time.perf_counter() - start) * 1000, 2)
    for index in range(sequences):
        name, seq = build(index, frames, seed)
        pipeline = pipeline_factory(seq) if pipeline_factory else Pipeline(ocr=shared)
        previous: np.ndarray | None = None
        onsets: dict[str, int] = {}
        masked: dict[str, dict[str, float]] = {}
        seq_targets = seq_covered = seq_fp = 0
        for frame_id, frame in enumerate(seq):
            pixels = np.asarray(frame.image, dtype=np.uint8)
            is_change = previous is None or not np.array_equal(pixels, previous)
            previous = pixels
            timestamp = frame_id * interval_ms
            start = time.perf_counter()
            result = pipeline.process(pixels, frame_id, timestamp)
            latency = (time.perf_counter() - start) * 1000
            (change if is_change else steady).append(latency)
            total_frames += 1
            for target in frame.targets:
                onsets.setdefault(target["id"], frame_id)
                target_frames += 1
                seq_targets += 1
                if any(
                    coverage(d.box, target["box"]) >= COVERAGE
                    for d in result.detections
                ):
                    covered_frames += 1
                    seq_covered += 1
                    if target["id"] not in masked:
                        delay = frame_id - onsets[target["id"]]
                        masked[target["id"]] = {
                            "frames": delay,
                            "ms": round(delay * interval_ms + latency, 2),
                        }
            allowed = [t["box"] for t in frame.targets] + frame.tolerated
            false = [
                d
                for d in result.detections
                if not any(overlaps(d.box, a) for a in allowed)
            ]
            fp_dets += len(false)
            seq_fp += len(false)
            fp_frames += bool(false)
        for target_id in onsets:
            if target_id in masked:
                ttm_frames.append(masked[target_id]["frames"])
                ttm_ms.append(masked[target_id]["ms"])
        per_sequence.append(
            {
                "index": index,
                "scenario": name,
                "targets": len(onsets),
                "masked": len(masked),
                "time_to_mask": [masked.get(t) for t in onsets],
                "target_frames": seq_targets,
                "covered_frames": seq_covered,
                "false_positive_detections": seq_fp,
            }
        )
    targets = sum(s["targets"] for s in per_sequence)
    return {
        "synthetic": True,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "config": {
            "sequences": sequences,
            "frames": frames,
            "interval_ms": interval_ms,
            "seed": seed,
            "resolution": [WIDTH, HEIGHT],
            "coverage_required": COVERAGE,
        },
        "host": {"platform": platform.platform(), "processor": platform.processor()},
        "ocr_warmup_ms": warmup_ms,
        "latency_ms": {"steady": stats(steady), "change": stats(change)},
        "time_to_mask": {
            "targets": targets,
            "masked": len(ttm_frames),
            "never_masked": targets - len(ttm_frames),
            "frames": stats(ttm_frames),
            "ms": stats(ttm_ms),
        },
        "recall": {
            "target_frames": target_frames,
            "covered_frames": covered_frames,
            "frame_recall": round(covered_frames / target_frames, 4)
            if target_frames
            else None,
        },
        "false_positives": {
            "frames": total_frames,
            "detections": fp_dets,
            "frames_with_fp": fp_frames,
            "per_frame": round(fp_dets / total_frames, 4) if total_frames else None,
        },
        "sequences": per_sequence,
    }


def check(summary: dict[str, Any], gates: dict[str, float]) -> list[str]:
    """Return human-readable failures; a missing metric fails its gate."""
    values = {
        "min_frame_recall": summary["recall"]["frame_recall"],
        "min_masked_fraction": (
            summary["time_to_mask"]["masked"] / summary["time_to_mask"]["targets"]
            if summary["time_to_mask"]["targets"]
            else None
        ),
        "max_time_to_mask_frames_p95": summary["time_to_mask"]["frames"]["p95"],
        "max_time_to_mask_ms_p95": summary["time_to_mask"]["ms"]["p95"],
        "max_false_positives_per_frame": summary["false_positives"]["per_frame"],
        "max_change_latency_p95_ms": summary["latency_ms"]["change"]["p95"],
        "max_steady_latency_p95_ms": summary["latency_ms"]["steady"]["p95"],
    }
    failures = []
    for gate, limit in gates.items():
        if gate not in values:
            failures.append(f"unknown gate {gate}")
            continue
        value = values[gate]
        if value is None:
            if gate != "max_steady_latency_p95_ms":
                failures.append(f"{gate}: no measurement")
            continue
        ok = value >= limit if gate.startswith("min_") else value <= limit
        if not ok:
            failures.append(f"{gate}: measured {value} vs limit {limit}")
    return failures


def markdown(
    summary: dict[str, Any], failures: list[str], gates: dict[str, float]
) -> str:
    cfg, lat, ttm = summary["config"], summary["latency_ms"], summary["time_to_mask"]

    def row(label: str, s: dict[str, Any], unit: str = "ms") -> str:
        return f"| {label} | {s['count']} | {s['p50']} | {s['p95']} | {s['p99']} | {s['max']} | {unit} |"

    scenario_rows = "\n".join(
        f"| {s['index']} | {s['scenario']} | {s['masked']}/{s['targets']} | "
        f"{', '.join(str(t['frames']) if t else 'never' for t in s['time_to_mask'])} | "
        f"{s['covered_frames']}/{s['target_frames']} | {s['false_positive_detections']} |"
        for s in summary["sequences"]
    )
    gate_lines = "\n".join(f"- `{k}`: {v}" for k, v in gates.items()) or "- none"
    verdict = "PASS" if not failures else "FAIL: " + "; ".join(failures)
    return f"""# Temporal benchmark

**Generated test corpus with known ground truth.** Every frame is drawn with PIL at
{WIDTH}x{HEIGHT} from reproducible example values (example.com emails, 555 phone numbers, random
AWS-style keys), so every target position is known exactly. The frames run through the
production OCR pipeline; use the numbers as a regression signal across runs, and run
Pre-flight on your own setup to measure it on your desktop.

Latency is wall-clock time on a general-purpose host, so compare runs from the same
machine.

Run: {cfg["sequences"]} sequences x {cfg["frames"]} frames, {cfg["interval_ms"]} ms sample
interval, seed {cfg["seed"]}. Host: {summary["host"]["platform"]}. Scenarios rotate through
toast email, chat phone, typed email, editor-to-inbox switch, terminal AWS secret.

## Per-frame latency (`Pipeline.process`, wall clock)

| frames | count | p50 | p95 | p99 | max | unit |
|---|---|---|---|---|---|---|
{row("steady (pixels identical to previous)", lat["steady"])}
{row("change (pixels differ)", lat["change"])}

OCR model load ({summary["ocr_warmup_ms"]} ms) is measured once before the run and excluded.
Steady frames can still pay full OCR when the detector's periodic refresh fires.

## Time to mask

A target counts as masked when one detection covers at least {int(cfg["coverage_required"] * 100)}%
of its drawn text box. Frames counted from the first frame the full value is visible; ms is
frames x interval + processing latency of the masking frame. This harness calls
`process` synchronously on every frame, so a frame count of 0 means the value was covered
in the first frame it appeared; the ms figure is the real cost of that frame's processing.

Masked {ttm["masked"]}/{ttm["targets"]} targets (never masked: {ttm["never_masked"]}).

| metric | count | p50 | p95 | p99 | max | unit |
|---|---|---|---|---|---|---|
{row("frames until covered", ttm["frames"], "frames")}
{row("time until covered", ttm["ms"])}

## Recall and false positives

- Frame recall (target-visible frames that were covered): {summary["recall"]["covered_frames"]}/{summary["recall"]["target_frames"]} = {summary["recall"]["frame_recall"]}
- False-positive detections: {summary["false_positives"]["detections"]} over {summary["false_positives"]["frames"]} frames ({summary["false_positives"]["per_frame"]} per frame; {summary["false_positives"]["frames_with_fp"]} frames with any)

| seq | scenario | masked | frames to mask | covered frames | FP dets |
|---|---|---|---|---|---|
{scenario_rows}

## Gates

{gate_lines}

Result: **{verdict}**
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sequences", type=int, default=6)
    parser.add_argument("--frames", type=int, default=12)
    parser.add_argument("--interval-ms", type=float, default=250.0)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--output", type=Path, default=Path("docs/benchmark-temporal"))
    parser.add_argument("--gates", type=Path, default=None)
    args = parser.parse_args()
    if args.frames < 3 or args.sequences < 1:
        parser.error("need at least 1 sequence of 3 frames")
    gates = json.loads(args.gates.read_text(encoding="utf-8")) if args.gates else {}
    summary = run(args.sequences, args.frames, args.interval_ms, args.seed)
    sources = sorted(Path("detector/veil_detector").rglob("*.py"))
    if sources:
        summary["detector_source_sha256"] = hashlib.sha256(
            b"".join(p.read_bytes() for p in sources)
        ).hexdigest()
    failures = check(summary, gates)
    summary["gates"] = gates
    summary["gate_failures"] = failures
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.with_suffix(".json").write_text(
        json.dumps(summary, indent=2) + "\n", "utf-8"
    )
    args.output.with_suffix(".md").write_text(
        markdown(summary, failures, gates), "utf-8"
    )
    print(
        json.dumps(
            {
                k: summary[k]
                for k in ("latency_ms", "time_to_mask", "recall", "false_positives")
            }
        )
    )
    for failure in failures:
        print("GATE FAILED:", failure, file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
