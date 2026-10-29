"""X11 best effort; Wayland window titles are not assumed accessible."""

import os
import subprocess
from .base import Window, WindowState


def read_windows() -> WindowState:
    """Use wmctrl only when X11 enumeration is available."""
    if os.environ.get("XDG_SESSION_TYPE") == "wayland":
        return WindowState([], False, "Wayland window enumeration unavailable; OCR continues")
    try:
        output = subprocess.run(
            ["wmctrl", "-lG"], capture_output=True, text=True, timeout=1, check=True
        ).stdout
        windows = []
        for line in output.splitlines():
            parts = line.split(maxsplit=7)
            if len(parts) == 8:
                windows.append(
                    Window(
                        parts[7], float(parts[2]), float(parts[3]), float(parts[4]), float(parts[5])
                    )
                )
        return WindowState(windows, True)
    except (OSError, subprocess.SubprocessError, ValueError):
        return WindowState([], False, "X11 window enumeration unavailable; OCR continues")
