"""Capture coordinate mapping and permission-aware platform results."""

from dataclasses import dataclass
import sys
from ..models import Box


@dataclass
class Window:
    title: str
    x: float
    y: float
    w: float
    h: float


@dataclass
class WindowState:
    windows: list[Window]
    available: bool
    reason: str = ""


def enumerate_windows() -> WindowState:
    """Read window bounds only through the platform adapter."""
    if sys.platform == "win32":
        from .windows import read_windows
    elif sys.platform == "darwin":
        from .macos import read_windows
    else:
        from .linux import read_windows
    return read_windows()


def map_window(
    window: Window, capture: tuple[float, float, float, float] | None, paranoid: bool
) -> Box | None:
    """Intersect desktop coordinates; fail closed when mapping is unknown."""
    if capture is None:
        return Box(x=0, y=0, w=1, h=1) if paranoid else None
    x, y, w, h = capture
    if w <= 0 or h <= 0:
        return Box(x=0, y=0, w=1, h=1) if paranoid else None
    left, top = max(x, window.x), max(y, window.y)
    right, bottom = min(x + w, window.x + window.w), min(y + h, window.y + window.h)
    if right <= left or bottom <= top:
        return None
    return Box(x=(left - x) / w, y=(top - y) / h, w=(right - left) / w, h=(bottom - top) / h)
