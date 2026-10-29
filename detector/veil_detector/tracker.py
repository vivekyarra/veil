"""Conservative union tracking avoids smoothing away newly exposed edges."""

from .models import Box, Detection


def iou(a: Box, b: Box) -> float:
    """Intersection over union for normalized rectangles."""
    overlap = max(0.0, min(a.x + a.w, b.x + b.w) - max(a.x, b.x)) * max(
        0.0, min(a.y + a.h, b.y + b.h) - max(a.y, b.y)
    )
    return overlap / (a.w * a.h + b.w * b.h - overlap)


class Tracker:
    """Retain tracks for the policy hold time with monotonic frame times."""

    def __init__(self) -> None:
        self.tracks: dict[str, tuple[Detection, float]] = {}
        self.counter = 0

    def update(self, detections: list[Detection], now: float, hold_ms: int) -> list[Detection]:
        """Assign stable identities and return active masks."""
        self.tracks = {
            key: value for key, value in self.tracks.items() if now - value[1] <= hold_ms
        }
        previous = self.tracks.copy()
        assigned: set[str] = set()
        for detection in detections:
            candidates = [
                (key, d)
                for key, (d, _) in previous.items()
                if key not in assigned
                and d.kind == detection.kind
                and iou(d.box, detection.box) >= 0.3
            ]
            if candidates:
                key, old = max(candidates, key=lambda pair: iou(pair[1].box, detection.box))
                detection.track_id = key
                assigned.add(key)
                detection.first_seen_frame = old.first_seen_frame
                a, b = old.box, detection.box
                x, y = min(a.x, b.x), min(a.y, b.y)
                detection.box = Box(
                    x=x, y=y, w=max(a.x + a.w, b.x + b.w) - x, h=max(a.y + a.h, b.y + b.h) - y
                )
            else:
                self.counter += 1
                detection.track_id = f"t-{self.counter}"
            self.tracks[detection.track_id] = (detection, now)
        return [item[0] for item in self.tracks.values()]
