import json
from pathlib import Path
import pytest
from veil_detector.normalize import matches

CASES = json.loads(
    (Path(__file__).resolve().parents[2] / "shared/normalization-cases.json").read_text(
        encoding="utf-8"
    )
)


@pytest.mark.parametrize("case", CASES)
def test_golden(case: dict[str, object]) -> None:
    assert matches(str(case["term"]), str(case["message"])) == case["match"]
