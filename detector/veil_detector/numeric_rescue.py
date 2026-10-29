"""Find small horizontal text spans missed by the neural text detector.

This is a supplemental proposal pass, never a substitute for full-frame OCR.
Only checksum-valid card readings are accepted by the caller.
"""

from collections.abc import Sequence
import cv2
import numpy as np
from numpy.typing import NDArray


def proposals(image: NDArray[np.uint8]) -> list[tuple[int, int, int, int]]:
    """Bound work on dense scenes; propose high-contrast horizontal text spans."""
    height, width = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    edges = cv2.morphologyEx(gray, cv2.MORPH_GRADIENT, np.ones((3, 3), dtype=np.uint8))
    _, binary = cv2.threshold(edges, 32, 255, cv2.THRESH_BINARY)
    binary = cv2.dilate(binary, np.ones((1, 9), dtype=np.uint8))
    _, _, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    result = []
    for x, y, w, h, area in stats[1:]:
        if 5 <= h <= 90 and w >= 14 and w / h >= 1.5 and area / (w * h) > 0.12:
            result.append(
                (
                    max(0, int(x) - 3),
                    max(0, int(y) - 3),
                    min(width, int(x + w) + 3),
                    min(height, int(y + h) + 3),
                )
            )
    return sorted(result, key=lambda b: (b[1], b[0]))[:128]


def overlap(a: Sequence[float], b: Sequence[float]) -> float:
    """Return proposal coverage by an existing OCR line, using pixel xyxy boxes."""
    area = max(1.0, (a[2] - a[0]) * (a[3] - a[1]))
    return (
        max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
        * max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
        / area
    )
