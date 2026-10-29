"""OCR boundary and engine lifetime tests without downloading inference models."""

import sys
from types import SimpleNamespace
import numpy as np
import pytest
from veil_detector.ocr import OCR


def test_engine_is_lazy_reused_and_boxes_clipped(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []

    def factory(**options: int):
        calls.append(options)

        def engine(image: np.ndarray):
            assert image[0, 0].tolist() == [3, 2, 1]
            return [
                ([[-2, -2], [12, -2], [12, 6], [-2, 6]], "synthetic", 0.9),
                ([[20, 20]] * 4, "outside", 0.9),
            ], None

        return engine

    monkeypatch.setitem(sys.modules, "rapidocr_onnxruntime", SimpleNamespace(RapidOCR=factory))
    ocr = OCR()
    image = np.full((10, 10, 3), [1, 2, 3], dtype=np.uint8)
    for _ in range(2):
        lines = ocr.read(image)
        assert len(lines) == 1
        assert lines[0].rect == (0, 0, 1, 0.6)
    assert calls == [{"intra_op_num_threads": 2, "inter_op_num_threads": 1}]


def test_empty_ocr_result() -> None:
    ocr = OCR()
    ocr.engine = lambda image: (None, None)
    assert ocr.read(np.zeros((2, 2, 3), dtype=np.uint8)) == []
