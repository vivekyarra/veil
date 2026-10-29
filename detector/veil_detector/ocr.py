"""Lazy local CPU ONNX OCR with an explicit, measured provider."""

from dataclasses import dataclass
from typing import Any
import numpy as np
from numpy.typing import NDArray
from .numeric_rescue import proposals, overlap
from .recognizers import luhn


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
        recognizer = getattr(self.engine, "text_rec", None)
        if recognizer is not None:
            pending = []
            for proposal in proposals(image):
                nearby = [
                    line
                    for line in lines
                    if overlap(
                        proposal,
                        (
                            line.rect[0] * width,
                            line.rect[1] * height,
                            (line.rect[0] + line.rect[2]) * width,
                            (line.rect[1] + line.rect[3]) * height,
                        ),
                    )
                    >= 0.35
                ]
                if nearby and not any(
                    13 <= sum(c.isascii() and c.isdigit() for c in line.text) <= 19
                    and not luhn(line.text)
                    for line in nearby
                ):
                    continue
                pending.append(proposal)
            if pending:
                readings, _ = recognizer(
                    [image[y:bottom, x:right, ::-1].copy() for x, y, right, bottom in pending]
                )
                for (text, confidence), (x, y, right, bottom) in zip(readings, pending):
                    digits = text.replace(" ", "").replace("-", "")
                    if confidence >= 0.5 and digits.isascii() and digits.isdigit() and luhn(digits):
                        lines.append(
                            Line(
                                text,
                                (x / width, y / height, (right - x) / width, (bottom - y) / height),
                                float(confidence),
                            )
                        )
        return lines
