"""Public CoreGraphics window list with an explicit permission fallback."""

from typing import Any
from .base import Window, WindowState


def read_windows() -> WindowState:
    """Return an unavailable state when Quartz or Screen Recording is absent."""
    try:
        import Quartz

        if not Quartz.CGPreflightScreenCaptureAccess():
            return WindowState([], False, "Enable Screen Recording for VEIL; OCR remains available")
        records: Any = Quartz.CGWindowListCopyWindowInfo(
            Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements,
            Quartz.kCGNullWindowID,
        )
        windows = []
        for record in records:
            bounds = record.get("kCGWindowBounds", {})
            title = (
                str(record.get("kCGWindowOwnerName", ""))
                + " "
                + str(record.get("kCGWindowName", ""))
            )
            if record.get("kCGWindowLayer", 0) == 0:
                windows.append(
                    Window(
                        title,
                        float(bounds.get("X", 0)),
                        float(bounds.get("Y", 0)),
                        float(bounds.get("Width", 0)),
                        float(bounds.get("Height", 0)),
                    )
                )
        return WindowState(windows, True)
    except ImportError:
        return WindowState(
            [], False, "Quartz unavailable; install the macOS detector build. OCR remains available"
        )
