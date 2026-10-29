import io
import json
import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from veil_detector.models import Box, Detection
from veil_detector.ocr import Line
from veil_detector.pipeline import Pipeline
from veil_detector.recognizers import recognize, luhn
from veil_detector.server import create_app
from veil_detector.tracker import Tracker, iou


@pytest.mark.parametrize("i", range(50))
def test_recognizers(i: int) -> None:
    for text, kind in [
        (f"fake{i}@example.com", "email"),
        ("4111 1111 1111 1111", "card"),
        (f"api_key=synthetic_{i:08d}", "secret"),
        (f"{100 + i} Synthetic Main Street", "address"),
        ("+1 202 555 0100", "phone"),
        ("192.0.2.17", "ip"),
    ]:
        assert kind in dict(recognize(text, []))
    for text in [
        f"Score {i}: 9000",
        f"version 1.2.{i}",
        f"main function {i}",
        "127.0.0.1",
        "0000 0000 0000 0000",
        "password settings",
        "user at domain",
    ]:
        assert not recognize(text, [])


def test_luhn() -> None:
    assert luhn("4111111111111111")
    assert not luhn("4111111111111112")
    assert not luhn("0000000000000000")


def test_tracker() -> None:
    tracker = Tracker()
    d = Detection(
        kind="email",
        box=Box(x=0.2, y=0.2, w=0.2, h=0.1),
        confidence=0.99,
        text_hash="salted",
        first_seen_frame=1,
    )
    first = tracker.update([d], 0, 1500)[0]
    d2 = d.model_copy(deep=True)
    d2.first_seen_frame = 4
    assert tracker.update([d2], 100, 1500)[0].track_id == first.track_id
    assert tracker.update([], 1500, 1500)
    assert tracker.update([], 1700, 1500) == []
    assert iou(d.box, d.box) == pytest.approx(1)


def test_pipeline(monkeypatch: pytest.MonkeyPatch) -> None:
    pipeline = Pipeline()
    monkeypatch.setattr(
        pipeline.ocr, "read", lambda _: [Line("fake@example.com", (0.1, 0.1, 0.2, 0.05), 0.99)]
    )
    image = np.zeros((100, 100, 3), dtype=np.uint8)
    result = pipeline.process(image, 15, 0)
    assert result.detections[0].first_seen_frame == 0
    assert "fake@" not in result.model_dump_json()
    assert result.detections[0].box.x < 0.1
    pipeline.process(image, 30, 250)
    with pytest.raises(ValueError):
        pipeline.process(image, 30, 500)
    pipeline.policy.profile = "off"
    assert not pipeline.process(image, 45, 750).detections


def test_api(monkeypatch: pytest.MonkeyPatch) -> None:
    pipeline = Pipeline()
    monkeypatch.setattr(
        pipeline.ocr, "read", lambda _: [Line("fake@example.com", (0.1, 0.1, 0.2, 0.05), 0.99)]
    )
    token = "x" * 64
    client = TestClient(create_app(token, pipeline))
    headers = {"Authorization": "Bearer " + token}
    assert client.get("/v1/health").status_code == 401
    assert client.get("/v1/health", headers=headers).status_code == 200
    assert (
        client.put("/v1/vault", headers=headers, json={"terms": ["Synthetic Maple"]}).json()[
            "count"
        ]
        == 1
    )
    assert (
        client.put("/v1/policy", headers=headers, json={"profile": "paranoid"}).status_code == 200
    )
    blob = io.BytesIO()
    Image.new("RGB", (100, 100)).save(blob, format="PNG")
    headers["X-Veil-Frame"] = json.dumps({"frame_id": 1, "timestamp_ns": 0})
    with client.websocket_connect(
        "/v1/events", headers={"Authorization": "Bearer " + token}
    ) as socket:
        response = client.post("/v1/frames", headers=headers, content=blob.getvalue())
        assert response.status_code == 200
        assert socket.receive_json()["type"] == "detection"
        assert "fake@example.com" not in response.text
    assert client.post("/v1/frames", headers=headers, content=b"bad").status_code == 400
    with pytest.raises(ValueError):
        create_app("short")


def test_box_validation() -> None:
    with pytest.raises(ValueError):
        Box(x=0.9, y=0, w=0.2, h=0.1)


def test_adjacent_complete_lines_do_not_duplicate_masks(monkeypatch: pytest.MonkeyPatch) -> None:
    pipeline = Pipeline()
    monkeypatch.setattr(
        pipeline.ocr,
        "read",
        lambda _: [
            Line("first@example.com", (0.1, 0.1, 0.2, 0.02), 0.99),
            Line("second@example.com", (0.1, 0.14, 0.2, 0.02), 0.99),
        ],
    )
    result = pipeline.process(np.zeros((100, 100, 3), dtype=np.uint8), 0, 0)
    assert len(result.detections) == 2
    assert len({d.track_id for d in result.detections}) == 2
    assert all(d.box.h < 0.03 for d in result.detections)
