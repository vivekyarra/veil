"""Incremental OCR: only dirty regions are re-read, cached lines elsewhere are reused."""

import numpy as np
from numpy.typing import NDArray
from veil_detector.ocr import Line
from veil_detector.pipeline import Pipeline

W, H = 1280, 720


class FakeOCR:
    """Reads text blocks painted by ``paint``: each block's gray level indexes ``texts``.

    A block cut by the crop edge reads as truncated text, like real OCR would.
    """

    def __init__(self, texts: dict[int, str]) -> None:
        self.texts = texts
        self.calls: list[tuple[int, int, bool]] = []

    def read(self, image: NDArray[np.uint8], region: bool = False) -> list[Line]:
        h, w = image.shape[:2]
        self.calls.append((w, h, region))
        gray = image[:, :, 0]
        lines = []
        for level, text in self.texts.items():
            ys, xs = np.nonzero(gray == level)
            if not len(xs):
                continue
            x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
            cut = x0 == 0 or y0 == 0 or x1 == w or y1 == h
            shown = text[: len(text) // 2] if cut else text
            lines.append(Line(shown, (x0 / w, y0 / h, (x1 - x0) / w, (y1 - y0) / h), 0.99))
        return lines


def frame() -> NDArray[np.uint8]:
    return np.full((H, W, 3), 30, np.uint8)


def paint(image: NDArray[np.uint8], level: int, x: int, y: int, w: int, h: int) -> None:
    image[y : y + h, x : x + w] = level


def setup() -> tuple[Pipeline, FakeOCR, NDArray[np.uint8]]:
    fake = FakeOCR(
        {
            100: "Welcome back",
            110: "Settings",
            120: "alice@example.com",
            130: "sk_" + "live_4eC39HqLyjWDarjtT1zdp7dc",
            140: "x",
            150: "Inbox",
        }
    )
    pipeline = Pipeline(fake)  # type: ignore[arg-type]
    image = frame()
    paint(image, 100, 40, 40, 300, 24)
    paint(image, 110, 900, 40, 120, 24)
    pipeline.process(image, 1, 0)
    assert pipeline.last_read == "full"
    fake.calls.clear()
    return pipeline, fake, image


def texts(pipeline: Pipeline) -> set[str]:
    return {line.text for line in pipeline.lines}


def test_first_frame_is_full_and_static_frame_reads_nothing() -> None:
    pipeline, fake, image = setup()
    pipeline.process(image.copy(), 2, 100)
    assert fake.calls == []
    assert texts(pipeline) == {"Welcome back", "Settings"}


def test_toast_in_corner_is_read_in_same_call_and_cache_reused() -> None:
    pipeline, fake, image = setup()
    toast = image.copy()
    paint(toast, 130, 900, 640, 340, 30)
    result = pipeline.process(toast, 2, 100)
    assert pipeline.last_read == "partial"
    assert len(fake.calls) == 1 and fake.calls[0][2]
    assert fake.calls[0][0] * fake.calls[0][1] < W * H * 0.2
    assert texts(pipeline) == {"Welcome back", "Settings", "sk_" + "live_4eC39HqLyjWDarjtT1zdp7dc"}
    assert any(d.kind == "secret" for d in result.detections)
    toast_line = next(line for line in pipeline.lines if line.text.startswith("sk_"))
    assert abs(toast_line.rect[0] - 900 / W) < 1e-6 and abs(toast_line.rect[1] - 640 / H) < 1e-6


def test_typing_into_a_field_rereads_the_whole_field() -> None:
    pipeline, fake, image = setup()
    field = image.copy()
    paint(field, 120, 400, 300, 200, 24)
    pipeline.process(field, 2, 100)
    typed = field.copy()
    paint(typed, 120, 600, 300, 60, 24)  # the field grows by a few glyphs at its right end
    fake.calls.clear()
    pipeline.process(typed, 3, 200)
    assert pipeline.last_read == "partial" and len(fake.calls) == 1
    emails = [line for line in pipeline.lines if line.text.startswith("alice")]
    assert len(emails) == 1 and emails[0].text == "alice@example.com"
    assert abs(emails[0].rect[2] - 260 / W) < 1e-6


def test_tiny_one_line_change() -> None:
    pipeline, fake, image = setup()
    tiny = image.copy()
    paint(tiny, 140, 640, 400, 6, 10)
    pipeline.process(tiny, 2, 100)
    assert pipeline.last_read == "partial"
    assert "x" in texts(pipeline)
    width, height, _ = fake.calls[0]
    assert width * height < 100 * 100


def test_window_switch_is_full() -> None:
    pipeline, fake, image = setup()
    switched = np.full((H, W, 3), 200, np.uint8)
    paint(switched, 150, 40, 40, 100, 24)
    pipeline.process(switched, 2, 100)
    assert pipeline.last_read == "full"
    assert fake.calls == [(W, H, False)]
    assert texts(pipeline) == {"Inbox"}


def test_stale_lines_are_dropped() -> None:
    pipeline, _, image = setup()
    cleared = image.copy()
    paint(cleared, 30, 900, 40, 120, 24)  # "Settings" disappears
    pipeline.process(cleared, 2, 100)
    assert pipeline.last_read == "partial"
    assert texts(pipeline) == {"Welcome back"}


def test_periodic_refresh_forces_full() -> None:
    pipeline, fake, image = setup()
    pipeline.process(image.copy(), 2, 2500)
    assert pipeline.last_read == "full" and fake.calls == [(W, H, False)]


def test_slow_drift_accumulates_against_last_read() -> None:
    pipeline, fake, image = setup()
    drift = image.copy()
    for step, level in enumerate((32, 34, 36, 38), start=2):
        paint(drift, level, 400, 500, 200, 40)
        pipeline.process(drift.copy(), step, step * 10)
    assert fake.calls, "cumulative change past the threshold must be read"


def test_many_scattered_changes_merge_to_four_regions_or_full() -> None:
    pipeline, fake, image = setup()
    busy = image.copy()
    for i in range(8):
        paint(busy, 140, 60 + i * 150, 300 + (i % 2) * 200, 6, 10)
    pipeline.process(busy, 2, 100)
    assert pipeline.last_read == "full" or len(fake.calls) <= 4
