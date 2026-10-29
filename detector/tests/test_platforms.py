"""OS adapters tested with synthetic native API responses, not user windows."""

import ctypes
import subprocess
import sys
from types import SimpleNamespace
from ctypes import wintypes
import pytest
from veil_detector.window_guard.base import WindowState


def test_win32_adapter(monkeypatch: pytest.MonkeyPatch) -> None:
    from veil_detector.window_guard.windows import read_windows

    class Function:
        def __init__(self, function: object) -> None:
            self.function = function

        def __call__(self, *args: object) -> object:
            return self.function(*args)  # type: ignore[operator]

    def text(_hwnd: object, buffer: object, _length: object) -> int:
        buffer.value = "Synthetic Bitwarden"  # type: ignore[attr-defined]
        return 19

    def rect(_hwnd: object, pointer: object) -> bool:
        target = ctypes.cast(pointer, ctypes.POINTER(wintypes.RECT)).contents
        target.left, target.top, target.right, target.bottom = 10, 20, 310, 220
        return True

    fake = SimpleNamespace(
        IsWindowVisible=Function(lambda _: True),
        GetWindowTextLengthW=Function(lambda _: 19),
        GetWindowTextW=Function(text),
        GetWindowRect=Function(rect),
        EnumWindows=Function(lambda callback, _: callback(1, 0)),
    )
    monkeypatch.setattr(ctypes, "windll", SimpleNamespace(user32=fake), raising=False)
    monkeypatch.setattr(ctypes, "WINFUNCTYPE", ctypes.CFUNCTYPE, raising=False)
    state = read_windows()
    assert (
        state.available
        and state.windows[0].w == 300
        and state.windows[0].title == "Synthetic Bitwarden"
    )


def test_quartz_adapter(monkeypatch: pytest.MonkeyPatch) -> None:
    from veil_detector.window_guard.macos import read_windows

    quartz = SimpleNamespace(CGPreflightScreenCaptureAccess=lambda: False)
    monkeypatch.setitem(sys.modules, "Quartz", quartz)
    assert not read_windows().available
    quartz.CGPreflightScreenCaptureAccess = lambda: True
    quartz.CGWindowListCopyWindowInfo = lambda *_: [
        {
            "kCGWindowBounds": {"X": 10, "Y": 20, "Width": 300, "Height": 200},
            "kCGWindowOwnerName": "Synthetic Mail",
            "kCGWindowLayer": 0,
        }
    ]
    quartz.kCGWindowListOptionOnScreenOnly = 1
    quartz.kCGWindowListExcludeDesktopElements = 2
    quartz.kCGNullWindowID = 0
    assert read_windows().windows[0].h == 200


def test_x11_adapter(monkeypatch: pytest.MonkeyPatch) -> None:
    from veil_detector.window_guard.linux import read_windows

    monkeypatch.setenv("XDG_SESSION_TYPE", "x11")
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *_args, **_kwargs: SimpleNamespace(
            stdout="0x01 0 10 20 300 200 synthetic-host Synthetic Mail\n"
        ),
    )
    assert read_windows().windows[0].x == 10

    def unavailable(*_args: object, **_kwargs: object) -> None:
        raise FileNotFoundError

    monkeypatch.setattr(subprocess, "run", unavailable)
    assert not read_windows().available


def test_dispatch(monkeypatch: pytest.MonkeyPatch) -> None:
    from veil_detector.window_guard import base, linux, windows, macos

    for platform, module in [("win32", windows), ("darwin", macos), ("linux", linux)]:
        monkeypatch.setattr(sys, "platform", platform)
        monkeypatch.setattr(module, "read_windows", lambda: WindowState([], True))
        assert base.enumerate_windows().available
