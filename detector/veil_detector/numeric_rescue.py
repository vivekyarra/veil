"""Find small horizontal text spans missed by the neural text detector.

This is a supplemental proposal pass, never a substitute for full-frame OCR.
Only checksum-valid card readings are accepted by the caller, and only through
``rescue_accepted``: a re-read may correct a couple of misread digits on a line that
already looks like a card, but it may never turn an arbitrary number into one.
"""

import re
from collections.abc import Sequence
import cv2
import numpy as np
from numpy.typing import NDArray
from .recognizers import luhn

# 4-4-4-4 (Visa/Mastercard/Discover, optionally 4-4-4-4-3 for 19-digit PANs) or 4-6-5 (Amex),
# separated by single spaces or dashes. Contiguous digit runs are not card-like on their own:
# order numbers, tracking ids and random 16-digit strings look exactly like that.
CARD_LAYOUT = re.compile(
    r"(?<![\d])(?:\d{4}(?:[ -]\d{4}){3}(?:[ -]\d{1,3})?|\d{4}[ -]\d{6}[ -]\d{5})(?![\d])"
)
MAX_RESCUE_EDITS = 2


def card_layout(text: str) -> bool:
    """True when the text contains a 13-19 digit run grouped the way cards are printed."""
    return any(13 <= sum(c.isdigit() for c in m.group()) <= 19 for m in CARD_LAYOUT.finditer(text))


def _digits(text: str) -> str:
    return "".join(c for c in text if c.isascii() and c.isdigit())


def _edits(a: str, b: str) -> int:
    """Levenshtein distance between two short digit strings."""
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb)))
        previous = current
    return previous[-1]


def rescue_accepted(originals: Sequence[str], rescued: str) -> bool:
    """Decide whether a supplemental re-read of a proposal may be reported as a card.

    ``originals`` are the full-frame OCR readings overlapping the proposal (empty when the
    detector missed the span entirely). The caller still requires the rescued digits to pass
    Luhn; this only bounds *how* a reading may get there:

    - With no original reading, the re-read itself must have a card layout.
    - Otherwise some original must have a card layout and the rescued digits must be within
      ``MAX_RESCUE_EDITS`` edits of it without being longer (no invented digits).
    """
    digits = _digits(rescued)
    if not luhn(digits):
        return False
    if not originals:
        return card_layout(rescued)
    for original in originals:
        if not card_layout(original):
            continue
        source = _digits(original)
        if len(digits) <= len(source) and _edits(source, digits) <= MAX_RESCUE_EDITS:
            return True
    return False


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
