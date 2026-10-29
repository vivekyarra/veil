"""Visible Win32 windows. Titles never leave this adapter's caller."""

import ctypes
from ctypes import wintypes
from .base import Window, WindowState


def read_windows() -> WindowState:
    """Enumerate visible windows with physical screen bounds."""
    user32 = ctypes.windll.user32
    result: list[Window] = []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]

    def visit(hwnd: int, _: int) -> bool:
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        text = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, text, length + 1)
        rect = wintypes.RECT()
        if (
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
            and length
            and rect.right > rect.left
            and rect.bottom > rect.top
        ):
            result.append(
                Window(
                    text.value,
                    float(rect.left),
                    float(rect.top),
                    float(rect.right - rect.left),
                    float(rect.bottom - rect.top),
                )
            )
        return True

    callback = callback_type(visit)
    user32.EnumWindows(callback, 0)
    return WindowState(result, True)
