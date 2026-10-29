"""Lazy local CPU ONNX OCR with an explicit, measured provider."""

from dataclasses import dataclass
from typing import Any
import numpy as np
from numpy.typing import NDArray


@dataclass
class Line:
    text: str
    rect: tuple[float, float, float, float]
    confidence: float


class OCR:
    """Own one inference engine and return normalized line rectangles."""

    def __init__(self) -> None:
        self.engine: Any = None
        self.providers = ["CPUExecutionProvider"]
        self.provider_note = "CPU fallback; run pre-flight to measure latency"

    def read(self, image: NDArray[np.uint8]) -> list[Line]:
        """Recognize RGB pixels with a bounded thread budget."""
        if self.engine is None:
            from rapidocr_onnxruntime import RapidOCR

            self.engine = RapidOCR(intra_op_num_threads=2, inter_op_num_threads=1)
        result, _ = self.engine(image[:, :, ::-1].copy())
        height, width = image.shape[:2]
        lines = []
        for points, text, confidence in result or []:
            xs, ys = [p[0] for p in points], [p[1] for p in points]
            x, y = max(0, min(xs) / width), max(0, min(ys) / height)
            right, bottom = min(1, max(xs) / width), min(1, max(ys) / height)
            if right > x and bottom > y:
                lines.append(Line(text, (x, y, right - x, bottom - y), float(confidence)))
        return lines
