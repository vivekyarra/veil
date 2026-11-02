"""Smoke test for bench/temporal.py with an exact fake OCR (no ONNX model needed)."""

import importlib.util
import sys
from pathlib import Path

import numpy as np
from veil_detector.ocr import Line
from veil_detector.pipeline import Pipeline

BENCH = Path(__file__).resolve().parents[2] / "bench" / "temporal.py"


def load():  # type: ignore[no-untyped-def]
    spec = importlib.util.spec_from_file_location("veil_temporal_bench", BENCH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class FakeOCR:
    """Return exactly the strings the generator drew in the current frame (or crop of it)."""

    def __init__(self, frames) -> None:  # type: ignore[no-untyped-def]
        self.texts = {np.asarray(f.image, dtype=np.uint8).tobytes(): f.texts for f in frames}
        self.current = np.zeros((1, 1, 3), dtype=np.uint8)

    def read(self, image: np.ndarray, region: bool = False) -> list[Line]:
        full, texts = self.current, self.texts[self.current.tobytes()]
        height, width = full.shape[:2]
        ch, cw = image.shape[:2]
        # Anchor on the most varied crop row so uniform backgrounds do not match everywhere.
        anchor = int(np.argmax(image.reshape(ch, -1).std(axis=1)))
        needle = image[anchor].tobytes()
        for top in range(height - ch + 1):
            row = full[top + anchor].tobytes()
            left = row.find(needle)
            while left >= 0:
                x = left // 3
                if left % 3 == 0 and np.array_equal(full[top : top + ch, x : x + cw], image):
                    x0, y0, sx, sy = x / width, top / height, cw / width, ch / height
                    return [
                        Line(t, ((tx - x0) / sx, (ty - y0) / sy, tw / sx, th / sy), 0.99)
                        for t, (tx, ty, tw, th) in texts
                        if tx >= x0 and ty >= y0 and tx + tw <= x0 + sx and ty + th <= y0 + sy
                    ]
                left = row.find(needle, left + 1)
        return []


class FramePipeline(Pipeline):
    """Tell the fake OCR which full frame any crop it receives came from."""

    def process(self, image, frame_id, timestamp_ms):  # type: ignore[no-untyped-def]
        self.ocr.current = image  # type: ignore[union-attr]
        return super().process(image, frame_id, timestamp_ms)


def test_temporal_bench_one_sequence() -> None:
    bench = load()
    summary = bench.run(1, 6, pipeline_factory=lambda seq: FramePipeline(ocr=FakeOCR(seq)))
    assert summary["synthetic"] is True
    assert summary["time_to_mask"]["targets"] == 1
    assert summary["time_to_mask"]["masked"] == 1
    assert summary["time_to_mask"]["frames"]["max"] == 0
    assert summary["recall"]["frame_recall"] == 1.0
    assert summary["false_positives"]["detections"] == 0
    assert summary["latency_ms"]["change"]["count"] >= 2
    assert not bench.check(summary, {"min_frame_recall": 0.9, "max_false_positives_per_frame": 0})
    assert bench.check(summary, {"max_change_latency_p95_ms": -1})
    md = bench.markdown(summary, [], {})
    assert "Generated test corpus" in md


def test_all_scenarios_render_targets() -> None:
    bench = load()
    for index in range(len(bench.SCENARIOS)):
        name, frames = bench.build(index, 8)
        assert len(frames) == 8
        assert frames[0].image.size == (1280, 720)
        assert any(f.targets for f in frames), name
        assert not frames[0].targets, name
