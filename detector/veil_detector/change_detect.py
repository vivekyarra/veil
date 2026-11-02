"""Dirty-region grid against the last OCR'd frame, plus mandatory periodic full refresh."""

import cv2
import numpy as np
from numpy.typing import NDArray

# Block-mean grid. At 1080p each cell averages a 10x10 pixel block, so every pixel
# contributes; a strided sample could step over thin glyph strokes entirely.
GRID = (192, 108)
THRESHOLD = 3.0
REFRESH_MS = 2000

Rect = tuple[float, float, float, float]  # normalized x, y, w, h


class ChangeDetector:
    """Report which areas changed since they were last OCR'd.

    ``previous`` holds, per grid cell, the frame content at the time that cell was last
    read, so slow drift accumulates until it crosses the threshold instead of escaping.
    """

    def __init__(self) -> None:
        self.previous: NDArray[np.float32] | None = None
        self.pending: NDArray[np.float32] | None = None
        self.refreshed = -1e9

    @staticmethod
    def grid(image: NDArray[np.uint8]) -> NDArray[np.float32]:
        gray = image.mean(axis=2, dtype=np.float32) if image.ndim == 3 else image.astype(np.float32)
        width, height = min(GRID[0], gray.shape[1]), min(GRID[1], gray.shape[0])
        return np.asarray(
            cv2.resize(gray, (width, height), interpolation=cv2.INTER_AREA), dtype=np.float32
        )

    def regions(self, image: NDArray[np.uint8], now: float) -> list[Rect] | None:
        """``None`` demands a full OCR; otherwise the dirty rectangles (possibly empty).

        Each rectangle is one 8-connected component of dirty cells, grown by one cell so a
        glyph edge that only nudged its neighbour below the threshold is still covered.
        Call :meth:`commit` with what was actually read.
        """
        small = self.grid(image)
        self.pending = small
        if (
            self.previous is None
            or self.previous.shape != small.shape
            or now - self.refreshed >= REFRESH_MS
        ):
            return None
        mask = (np.abs(small - self.previous) > THRESHOLD).astype(np.uint8)
        if not mask.any():
            return []
        mask = cv2.dilate(mask, np.ones((3, 3), np.uint8))
        count, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        rows, cols = small.shape
        return [
            (
                float(stats[i, 0]) / cols,
                float(stats[i, 1]) / rows,
                float(stats[i, 2]) / cols,
                float(stats[i, 3]) / rows,
            )
            for i in range(1, count)
        ]

    def commit(self, rects: list[Rect] | None, now: float) -> None:
        """Record the pending frame as read: everywhere (``None``) or inside ``rects``."""
        if self.pending is None:
            return
        if rects is None or self.previous is None or self.previous.shape != self.pending.shape:
            self.previous = self.pending
            self.refreshed = now
            return
        rows, cols = self.pending.shape
        for x, y, w, h in rects:
            # Only cells wholly inside a read rectangle count as read.
            left, top = int(np.ceil(x * cols - 1e-6)), int(np.ceil(y * rows - 1e-6))
            right = int(np.floor((x + w) * cols + 1e-6))
            bottom = int(np.floor((y + h) * rows + 1e-6))
            self.previous[top:bottom, left:right] = self.pending[top:bottom, left:right]

    def changed(self, image: NDArray[np.uint8], now: float) -> bool:
        """Whole-frame decision: OCR on any change, and after two seconds regardless."""
        rects = self.regions(image, now)
        if rects is None or rects:
            self.commit(None, now)
            return True
        return False
