"""Change grid plus mandatory periodic full refresh."""

import numpy as np
from numpy.typing import NDArray


class ChangeDetector:
    """Identify changed tiles; callers reuse unchanged line results."""

    def __init__(self) -> None:
        self.previous: NDArray[np.float64] | None = None
        self.refreshed = -1e9

    def changed(self, image: NDArray[np.uint8], now: float) -> bool:
        """Force OCR after two seconds even on apparently static content."""
        small = image[:: max(1, image.shape[0] // 90), :: max(1, image.shape[1] // 160)].mean(
            axis=2
        )
        different = self.previous is None or self.previous.shape != small.shape
        if not different and self.previous is not None:
            different = bool(np.max(np.abs(small - self.previous)) > 3)
        self.previous = small
        if different or now - self.refreshed >= 2000:
            self.refreshed = now
            return True
        return False
