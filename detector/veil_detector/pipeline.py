"""Pixels to metadata-only masks. All text stays in process memory."""

import hashlib
import secrets
import time
import numpy as np
from numpy.typing import NDArray
from .change_detect import ChangeDetector, Rect
from .models import Box, Detection, DetectionResult, Kind, Policy
from .ocr import OCR, Line, OCRPool
from .recognizers import recognize
from .tracker import Tracker, iou

# Incremental OCR. Above this dirty fraction of the frame a full read is cheaper and safer.
FULL_AREA = 0.40
MAX_REGIONS = 4
# Padding around each dirty area, in pixels of the sampled frame, so the text detector
# sees whole glyphs plus context, and so RapidOCR never treats a crop as one text line.
PAD_PX = 16
MIN_SIDE_PX = 48


def _intersects(a: Rect, b: Rect) -> bool:
    return a[0] < b[0] + b[2] and b[0] < a[0] + a[2] and a[1] < b[1] + b[3] and b[1] < a[1] + a[3]


def _merge(a: Rect, b: Rect) -> Rect:
    x, y = min(a[0], b[0]), min(a[1], b[1])
    return (x, y, max(a[0] + a[2], b[0] + b[2]) - x, max(a[1] + a[3], b[1] + b[3]) - y)


def _pad(rect: Rect, px: float, py: float) -> Rect:
    x, y = max(0.0, rect[0] - px), max(0.0, rect[1] - py)
    return (x, y, min(1.0, rect[0] + rect[2] + px) - x, min(1.0, rect[1] + rect[3] + py) - y)


def plan_regions(
    dirty: list[Rect], cached: list[Line], width: int, height: int
) -> list[Rect] | None:
    """Padded, merged OCR rectangles that cover every dirty area, or ``None`` for a full read.

    Safety: each rectangle is grown until it wholly contains every cached line it touches,
    so a line that is only partly changed (typing into a field) is re-read in full and
    nothing new can be cut off at a crop edge. Rectangles are then merged until they are
    disjoint and at most ``MAX_REGIONS``; growth repeats until stable.
    """
    px, py = PAD_PX / width, PAD_PX / height
    rects = [
        _grow_to(_pad(rect, px, py), MIN_SIDE_PX / width, MIN_SIDE_PX / height) for rect in dirty
    ]
    while True:
        before = list(rects)
        grown = []
        for rect in rects:
            for line in cached:
                if _intersects(rect, line.rect):
                    rect = _merge(rect, _pad(line.rect, px, py))
            grown.append(rect)
        rects = grown
        merged = True
        while merged:
            merged = False
            for i in range(len(rects)):
                for j in range(i + 1, len(rects)):
                    if _intersects(rects[i], rects[j]):
                        rects[i] = _merge(rects[i], rects.pop(j))
                        merged = True
                        break
                if merged:
                    break
        while len(rects) > MAX_REGIONS:
            # Merge the pair whose union adds the least area.
            best = min(
                ((i, j) for i in range(len(rects)) for j in range(i + 1, len(rects))),
                key=lambda ij: _area([_merge(rects[ij[0]], rects[ij[1]])])
                - _area([rects[ij[0]], rects[ij[1]]]),
            )
            rects[best[0]] = _merge(rects[best[0]], rects.pop(best[1]))
        if rects == before:
            break
    if _area(rects) > FULL_AREA:
        return None
    return rects


def _grow_to(rect: Rect, min_w: float, min_h: float) -> Rect:
    """Grow ``rect`` symmetrically to at least ``min_w`` x ``min_h``, staying in the frame."""
    x, y, w, h = rect
    if w < min_w:
        x = min(max(0.0, x - (min_w - w) / 2), 1.0 - min_w)
        w = min_w
    if h < min_h:
        y = min(max(0.0, y - (min_h - h) / 2), 1.0 - min_h)
        h = min_h
    return (max(0.0, x), max(0.0, y), min(w, 1.0), min(h, 1.0))


def _area(rects: list[Rect]) -> float:
    return sum(rect[2] * rect[3] for rect in rects)


# Longest run of same-row fragments joined into one candidate (e.g. a card split over four
# input boxes, or "+44" "20 7946" "0958").
MAX_RUN = 6


def _union(lines: list[Line]) -> tuple[float, float, float, float]:
    x = min(line.rect[0] for line in lines)
    y = min(line.rect[1] for line in lines)
    right = max(line.rect[0] + line.rect[2] for line in lines)
    bottom = max(line.rect[1] + line.rect[3] for line in lines)
    return (x, y, right - x, bottom - y)


def same_row(a: Line, b: Line) -> bool:
    """Vertical centres within half the taller line's height."""
    height = max(a.rect[3], b.rect[3])
    return abs((a.rect[1] + a.rect[3] / 2) - (b.rect[1] + b.rect[3] / 2)) <= height * 0.5


def rows(lines: list[Line]) -> list[list[Line]]:
    """Cluster OCR fragments into left-to-right rows."""
    result: list[list[Line]] = []
    for line in sorted(lines, key=lambda item: (item.rect[1] + item.rect[3] / 2, item.rect[0])):
        for row in result:
            if same_row(row[-1], line):
                row.append(line)
                break
        else:
            result.append([line])
    return [sorted(row, key=lambda item: item.rect[0]) for row in result]


def groups(lines: list[Line]) -> list[list[Line]]:
    """Candidate multi-fragment spans: same-row runs and directly stacked line pairs."""
    candidates: list[list[Line]] = []
    for row in rows(lines):
        for start in range(len(row)):
            for end in range(start + 1, min(len(row), start + MAX_RUN)):
                a, b = row[end - 1], row[end]
                gap = b.rect[0] - (a.rect[0] + a.rect[2])
                if gap > 3 * max(a.rect[3], b.rect[3]):
                    break
                candidates.append(row[start : end + 1])
    for a, b in zip(lines, lines[1:]):
        if same_row(a, b):
            continue
        height = max(a.rect[3], b.rect[3])
        vertical_gap = max(a.rect[1], b.rect[1]) - min(a.rect[1] + a.rect[3], b.rect[1] + b.rect[3])
        aligned = abs(a.rect[0] - b.rect[0]) <= height * 2
        if vertical_gap <= height * 1.2 and aligned:
            candidates.append([a, b])
    return candidates


class Pipeline:
    """Isolate each capture stream; OCR engines may be shared through a pool."""

    def __init__(self, ocr: OCR | OCRPool | None = None) -> None:
        self.ocr: OCR | OCRPool = ocr if ocr is not None else OCR()
        self.vault: list[str] = []
        self.policy = Policy()
        self.tracker = Tracker()
        self.change = ChangeDetector()
        self.lines: list[Line] = []
        self.last_read = "none"
        self.salt = secrets.token_bytes(32)
        self.last_frame = -1
        self.latencies: list[float] = []
        # (kind, recognized text) for the latest frame. Only the explicit, opt-in
        # incident endpoint may return the text; it is never part of a detection result.
        self.incident_texts: list[tuple[Kind, str]] = []

    def refresh(self, image: NDArray[np.uint8], timestamp_ms: float) -> None:
        """Bring ``self.lines`` up to date with ``image``, reading only what changed.

        Invariant: every area that differs from the last read is OCR'd in this call. Cached
        lines outside the read rectangles are kept; those touching them are replaced.
        """
        dirty = self.change.regions(image, timestamp_ms)
        if dirty is not None and not dirty:
            return
        height, width = image.shape[:2]
        plan = None if dirty is None else plan_regions(dirty, self.lines, width, height)
        if plan is None:
            self.lines = self.ocr.read(image)
            self.change.commit(None, timestamp_ms)
            self.last_read = "full"
            return
        kept = [line for line in self.lines if not any(_intersects(line.rect, r) for r in plan)]
        fresh: list[Line] = []
        for x, y, w, h in plan:
            left, top = int(x * width), int(y * height)
            right, bottom = int(np.ceil((x + w) * width)), int(np.ceil((y + h) * height))
            crop = np.ascontiguousarray(image[top:bottom, left:right])
            cw, ch = right - left, bottom - top
            for line in self.ocr.read(crop, region=True):
                lx, ly, lw, lh = line.rect
                fresh.append(
                    Line(
                        line.text,
                        (
                            (left + lx * cw) / width,
                            (top + ly * ch) / height,
                            lw * cw / width,
                            lh * ch / height,
                        ),
                        line.confidence,
                    )
                )
        self.lines = kept + fresh
        self.change.commit(plan, timestamp_ms)
        self.last_read = "partial"

    def candidates(self) -> list[tuple[Line, list[tuple[Kind, float]]]]:
        """Single lines plus minimal fragment groups that reveal a new kind."""
        recognized = {id(line): recognize(line.text, self.vault) for line in self.lines}
        work: list[tuple[Line, list[tuple[Kind, float]]]] = [
            (line, recognized[id(line)]) for line in self.lines
        ]
        found_groups: list[tuple[list[Line], Kind, float]] = []
        seen: set[tuple[int, ...]] = set()
        for members in groups(self.lines):
            signature = tuple(sorted(id(line) for line in members))
            if signature in seen:
                continue
            seen.add(signature)
            existing = {kind for line in members for kind, _ in recognized[id(line)]}
            text = " ".join(line.text for line in members)
            for kind, score in recognize(text, self.vault):
                if kind not in existing:
                    found_groups.append((members, kind, score))
        # Keep only minimal groups: drop a group that contains a smaller group of the same kind.
        for members, kind, score in found_groups:
            ids = {id(line) for line in members}
            if any(
                other_kind == kind
                and len(other) < len(members)
                and {id(line) for line in other} <= ids
                for other, other_kind, _ in found_groups
            ):
                continue
            group = Line(
                " ".join(line.text for line in members),
                _union(members),
                min(line.confidence for line in members),
            )
            work.append((group, [(kind, score)]))
        return work

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
            self.refresh(image, timestamp_ms)
            for line, found in self.candidates():
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
                    entry = (kind, line.text)
                    if entry not in self.incident_texts and len(self.incident_texts) < 256:
                        self.incident_texts.append(entry)
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
