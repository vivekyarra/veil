"""Pixels to metadata-only masks. All text stays in process memory."""

import hashlib
import secrets
import time
import numpy as np
from numpy.typing import NDArray
from .change_detect import ChangeDetector
from .models import Box, Detection, DetectionResult, Policy
from .ocr import OCR, Line
from .recognizers import recognize
from .tracker import Tracker, iou


class Pipeline:
    """Serialize access to one OCR engine; isolate each capture stream."""

    def __init__(self) -> None:
        self.ocr = OCR()
        self.vault: list[str] = []
        self.policy = Policy()
        self.tracker = Tracker()
        self.change = ChangeDetector()
        self.lines: list[Line] = []
        self.salt = secrets.token_bytes(32)
        self.last_frame = -1
        self.latencies: list[float] = []
        self.incident_texts: list[str] = []

    def process(
        self, image: NDArray[np.uint8], frame_id: int, timestamp_ms: float
    ) -> DetectionResult:
        """Cover the entire sampling gap, pad boxes and retain held tracks."""
        start = time.perf_counter()
        if frame_id <= self.last_frame:
            raise ValueError("frame IDs must increase per capture stream")
        first = self.last_frame + 1
        self.last_frame = frame_id
        detections: list[Detection] = []
        self.incident_texts = []
        if self.policy.profile != "off":
            if self.change.changed(image, timestamp_ms):
                self.lines = self.ocr.read(image)
            recognized = [recognize(line.text, self.vault) for line in self.lines]
            work = [(line, found) for line, found in zip(self.lines, recognized)]
            for index, (a, b) in enumerate(zip(self.lines, self.lines[1:])):
                if abs(a.rect[1] - b.rect[1]) < 0.08:
                    x, y = min(a.rect[0], b.rect[0]), min(a.rect[1], b.rect[1])
                    group = Line(
                        a.text + " " + b.text,
                        (
                            x,
                            y,
                            max(a.rect[0] + a.rect[2], b.rect[0] + b.rect[2]) - x,
                            max(a.rect[1] + a.rect[3], b.rect[1] + b.rect[3]) - y,
                        ),
                        min(a.confidence, b.confidence),
                    )
                    existing = {kind for kind, _ in recognized[index] + recognized[index + 1]}
                    work.append(
                        (
                            group,
                            [
                                (kind, score)
                                for kind, score in recognize(group.text, self.vault)
                                if kind not in existing
                            ],
                        )
                    )
            for line, found in work:
                for kind, confidence in found:
                    if kind not in self.policy.enabled or confidence < self.policy.thresholds.get(
                        kind, 0
                    ):
                        continue
                    x, y, w, h = line.rect
                    left, top = max(0.0, x - w * 0.08), max(0.0, y - h * 0.08)
                    box = Box(
                        x=left,
                        y=top,
                        w=min(1.0, x + w * 1.08) - left,
                        h=min(1.0, y + h * 1.08) - top,
                    )
                    if kind not in ("secret", "vault", "window") and any(
                        iou(box, zone) > 0.5 for zone in self.policy.ignore_zones
                    ):
                        continue
                    digest = hashlib.sha256(self.salt + line.text.encode()).hexdigest()
                    if line.text not in self.incident_texts and len(self.incident_texts) < 256:
                        self.incident_texts.append(line.text)
                    detections.append(
                        Detection(
                            kind=kind,
                            box=box,
                            confidence=confidence,
                            text_hash="sha256:" + digest,
                            first_seen_frame=first,
                        )
                    )
            detections = self.tracker.update(detections, timestamp_ms, self.policy.hold_ms)
        elapsed = (time.perf_counter() - start) * 1000
        self.latencies = (self.latencies + [elapsed])[-1000:]
        return DetectionResult(frame_id=frame_id, processed_ms=elapsed, detections=detections)
