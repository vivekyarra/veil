from veil_detector.window_guard.base import Window, WindowState, map_window
from veil_detector.models import Box
import pytest


def test_coordinates() -> None:
    window = Window("Synthetic Bitwarden", -50, 20, 100, 100)
    assert map_window(window, (0, 0, 100, 100), False) == Box(x=0, y=0.2, w=0.5, h=0.8)
    assert map_window(window, None, False) is None
    assert map_window(window, None, True) == Box(x=0, y=0, w=1, h=1)
    assert map_window(window, (100, 100, 100, 100), False) is None
    assert not WindowState([], False, "Permission required").available


def test_linux_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    from veil_detector.window_guard.linux import read_windows

    monkeypatch.setenv("XDG_SESSION_TYPE", "wayland")
    assert not read_windows().available


def test_mac_permission_missing() -> None:
    from veil_detector.window_guard.macos import read_windows

    assert isinstance(read_windows(), WindowState)
