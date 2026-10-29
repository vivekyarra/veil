"""Supplemental card readings must retain Luhn and avoid duplicate masks."""

import numpy as np
import pytest
from veil_detector.ocr import OCR
from veil_detector.numeric_rescue import overlap, proposals


def test_proposals_ignore_blank_pixels_and_clip_bounds() -> None:
    blank = np.zeros((80, 200, 3), dtype=np.uint8)
    assert proposals(blank) == []
    for x in range(0, 100, 9):
        blank[5:15, x : x + 4] = 255
    boxes = proposals(blank)
    assert boxes and all(0 <= x < r <= 200 and 0 <= y < b <= 80 for x, y, r, b in boxes)
    assert overlap((0, 0, 10, 10), (0, 0, 5, 10)) == 0.5


@pytest.mark.parametrize(
    "recognized,confidence,expected",
    [
        ("4111 1111 1111 1111", 0.99, 1),
        ("4111 1111 1111 1112", 0.99, 0),
        ("4111 1111 1111 1111", 0.4, 0),
        ("SCORE 4111111111111111", 0.99, 0),
    ],
)
def test_missing_card_retry_keeps_checksum(
    monkeypatch: pytest.MonkeyPatch, recognized: str, confidence: float, expected: int
) -> None:
    class Engine:
        def __call__(self, image):
            return [], None

        def text_rec(self, crops):
            assert len(crops) == 1
            return [(recognized, confidence)], 0

    monkeypatch.setattr("veil_detector.ocr.proposals", lambda _: [(10, 10, 80, 30)])
    ocr = OCR()
    ocr.engine = Engine()
    result = ocr.read(np.zeros((100, 100, 3), dtype=np.uint8))
    assert len(result) == expected
    if result:
        assert result[0].rect == (0.1, 0.1, 0.7, 0.2)


def test_existing_card_is_not_recognized_twice(monkeypatch: pytest.MonkeyPatch) -> None:
    class Engine:
        def __call__(self, image):
            return [([[10, 10], [80, 10], [80, 30], [10, 30]], "4111111111111111", 0.99)], None

        def text_rec(self, crops):
            raise AssertionError("Redundant recognition")

    monkeypatch.setattr("veil_detector.ocr.proposals", lambda _: [(10, 10, 80, 30)])
    ocr = OCR()
    ocr.engine = Engine()
    assert len(ocr.read(np.zeros((100, 100, 3), dtype=np.uint8))) == 1
