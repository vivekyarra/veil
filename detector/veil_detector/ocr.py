"""Lazy local CPU ONNX OCR with an explicit, measured provider."""

import inspect
import queue
from dataclasses import dataclass
from typing import Any
import numpy as np
from numpy.typing import NDArray
from .numeric_rescue import proposals, overlap, rescue_accepted
from .recognizers import luhn


@dataclass
class Line:
    text: str
    rect: tuple[float, float, float, float]
    confidence: float


def _accepts_use_cls(engine: Any) -> bool:
    """RapidOCR >= 1.3 takes ``use_cls`` per call; injected test engines may not."""
    try:
        parameters = inspect.signature(engine).parameters
    except (TypeError, ValueError):
        return False
    return "use_cls" in parameters or any(
        p.kind is inspect.Parameter.VAR_KEYWORD for p in parameters.values()
    )


class OCR:
    """Own one inference engine and return normalized line rectangles."""

    def __init__(self) -> None:
        self.engine: Any = None
        self.providers = ["CPUExecutionProvider"]
        self.provider_note = "CPU fallback; run pre-flight to measure latency"

    def read(self, image: NDArray[np.uint8], region: bool = False) -> list[Line]:
        """Recognize RGB pixels with a bounded thread budget.

        ``region`` marks a crop of a larger frame: detection then runs at native scale
        instead of RapidOCR's default of upscaling the short side to 736 px, which would
        make a small crop cost as much as a full frame. The angle classifier is skipped
        (``use_cls=False``): captured screens are upright, and it adds a pass per line.
        """
        if self.engine is None:
            from rapidocr_onnxruntime import RapidOCR

            self.engine = RapidOCR(intra_op_num_threads=2, inter_op_num_threads=1)
        detector: Any = getattr(self.engine, "text_det", None)
        saved = getattr(detector, "limit_type", None)
        if region and saved is not None:
            detector.limit_type = "max"
        try:
            options = {"use_cls": False} if _accepts_use_cls(self.engine) else {}
            result, _ = self.engine(image[:, :, ::-1].copy(), **options)
        finally:
            if region and saved is not None:
                detector.limit_type = saved
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
            originals: list[list[str]] = []
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
                originals.append([line.text for line in nearby])
            if pending:
                readings, _ = recognizer(
                    [image[y:bottom, x:right, ::-1].copy() for x, y, right, bottom in pending]
                )
                for (text, confidence), (x, y, right, bottom), seen in zip(
                    readings, pending, originals
                ):
                    digits = text.replace(" ", "").replace("-", "")
                    if (
                        confidence >= 0.5
                        and digits.isascii()
                        and digits.isdigit()
                        and rescue_accepted(seen, text)
                    ):
                        lines.append(
                            Line(
                                text,
                                (x / width, y / height, (right - x) / width, (bottom - y) / height),
                                float(confidence),
                            )
                        )
        return lines


class OCRPool:
    """Hand each read a free engine so up to ``size`` frames are recognized concurrently.

    RapidOCR sessions are not shared across threads; each engine is used by one read at a time.
    """

    def __init__(self, size: int = 2, engines: list[OCR] | None = None) -> None:
        self.engines = engines if engines is not None else [OCR() for _ in range(max(1, size))]
        self.size = len(self.engines)
        self.free: queue.Queue[OCR] = queue.Queue()
        for engine in self.engines:
            self.free.put(engine)

    @property
    def engine(self) -> Any:
        """The first loaded inference session, for health reporting."""
        return next((e.engine for e in self.engines if e.engine is not None), None)

    @property
    def providers(self) -> list[str]:
        return self.engines[0].providers

    @property
    def provider_note(self) -> str:
        return f"{self.engines[0].provider_note}; {self.size} pooled engines"

    def read(self, image: NDArray[np.uint8], region: bool = False) -> list[Line]:
        """Block until an engine is free, then recognize with it exclusively."""
        engine = self.free.get()
        try:
            return engine.read(image, region=True) if region else engine.read(image)
        finally:
            self.free.put(engine)
