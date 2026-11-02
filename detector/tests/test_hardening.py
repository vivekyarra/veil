"""Regression tests for the judge review: recognizer precision / recall, grouping,
change detection, the OCR pool and server robustness."""

import asyncio
import io
import json
import secrets
import threading
import time
import cv2
import httpx
import numpy as np
import pytest
from fastapi import WebSocketDisconnect
from fastapi.testclient import TestClient
from PIL import Image
from veil_detector import server
from veil_detector.change_detect import ChangeDetector
from veil_detector.models import Policy
from veil_detector.ocr import OCR, Line, OCRPool
from veil_detector.pipeline import Pipeline, groups, rows
from veil_detector.recognizers import iban_valid, recognize
from veil_detector.server import create_app, token_strong

TOKEN = secrets.token_hex(32)
AUTH = {"Authorization": "Bearer " + TOKEN}


def kinds(text: str, vault: list[str] | None = None) -> set[str]:
    return {kind for kind, _ in recognize(text, vault or [])}


@pytest.mark.parametrize(
    ("text", "kind"),
    [
        ("sk_" + "live_4eC39HqLyjWDarjtT1zdp7dc", "secret"),
        ("sk_" + "test_4eC39HqLyjWDarjtT1zdp7dc", "secret"),
        ("rk_" + "live_abcdEFGH12345678xyz", "secret"),
        ("AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY", "secret"),
        ("glpat-AbCdEfGhIjKlMnOpQrSt", "secret"),
        ("Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345", "secret"),
        ("ghs_" + "a1B2" * 9, "secret"),
        ("gho_" + "a1B2" * 9, "secret"),
        ("ghu_" + "a1B2" * 9, "secret"),
        ("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "secret"),
        ("password hunter22", "secret"),
        ("DB_PASSWORD=hunter22!", "secret"),
        ("xox" + "b-12345678901-123456789012-abcdefghijklmnopqrstuvwx", "secret"),
        ("123-45-6789", "national_id"),
        ("NI number QQ 12 34 56 C".replace("QQ", "AB"), "national_id"),
        ("DE89 3704 0044 0532 0130 00", "iban"),
        ("IBANGB82WEST12345698765432", "iban"),
        ("Hauptstraße 5", "address"),
        ("Lindenweg 12a, 10115 Berlin", "address"),
        ("Berliner Str. 7", "address"),
        ("12 rue de la Paix", "address"),
        ("221B Baker Street", "address"),
        ("14 Kingsley Close, Bristol BS8 1TH", "address"),
        ("+44 20 7946 0958", "phone"),
        ("01.23.45.67.89", "phone"),
        ("81.2.69.160", "ip"),
        ("2001:4860:4860::8888", "ip"),
        ("jane.doe @ mail.co.uk", "email"),
        ("3782 822463 10005", "card"),
    ],
)
def test_new_formats_detected(text: str, kind: str) -> None:
    assert kind in kinds(text)


@pytest.mark.parametrize(
    "text",
    [
        "lunch @ 12.30",
        "thanks @streamer. gg",
        "foo@1.2",
        "@streamer gg",
        "10.0.0.1",
        "192.168.1.20",
        "172.30.242.71",
        "fe80::1",
        "v1.2.3.4",
        "version 4.18.2.0",
        "build 10.0.19045.3803",
        "Chrome/125.0.5922.91",
        "Steuernummer 12/345/67890",
        "2024-05-12",
        "12.05.2024",
        "05/12/2024 14:30",
        "Order #4839201745",
        "Ticket 88213940",
        "4111 1111 1111 1112",
        "password settings",
        "Team 1 took first place",
        "https://example.org/docs/v2.1/index.html",
        "000-12-3456",
        "DE00 3704 0044 0532 0130 00",
    ],
)
def test_hard_negatives_not_flagged(text: str) -> None:
    assert kinds(text) == set()


def test_iban_checksum() -> None:
    assert iban_valid("GB82 WEST 1234 5698 7654 32")
    assert not iban_valid("GB83 WEST 1234 5698 7654 32")
    assert not iban_valid("1234")
    assert not iban_valid("GB82 WEST 1234 5698 7654 3!")


def test_policy_extends_card_family_for_older_clients() -> None:
    assert {"national_id", "iban"} <= set(Policy(enabled=["card", "email"]).enabled)
    assert "iban" not in Policy(enabled=["email"]).enabled
    assert Policy(enabled=["card", "iban"]).enabled == ["card", "iban"]


def fixed_lines(monkeypatch: pytest.MonkeyPatch, pipeline: Pipeline, lines: list[Line]) -> None:
    monkeypatch.setattr(pipeline.ocr, "read", lambda _: lines)


def test_card_split_across_input_boxes_is_grouped(monkeypatch: pytest.MonkeyPatch) -> None:
    pipeline = Pipeline()
    parts = ["4111", "1111", "1111", "1111"]
    lines = [Line(p, (0.30 + i * 0.05, 0.40, 0.03, 0.02), 0.9) for i, p in enumerate(parts)]
    lines.append(Line("Order #48213", (0.60, 0.40, 0.08, 0.02), 0.9))
    fixed_lines(monkeypatch, pipeline, lines)
    result = pipeline.process(np.zeros((40, 40, 3), dtype=np.uint8), 0, 0)
    cards = [d for d in result.detections if d.kind == "card"]
    assert len(cards) == 1
    box = cards[0].box
    assert box.x <= 0.30 and box.x + box.w >= 0.45 + 0.03
    assert box.x + box.w < 0.60  # the same-row distractor is not part of the mask


def test_rows_and_vertical_pairs() -> None:
    a = Line("221B Baker", (0.1, 0.1, 0.1, 0.02), 0.9)
    b = Line("Street", (0.1, 0.125, 0.05, 0.02), 0.9)
    far = Line("Street", (0.8, 0.5, 0.05, 0.02), 0.9)
    assert [len(row) for row in rows([a, b, far])] == [1, 1, 1]
    assert [a, b] in groups([a, b, far])
    assert not any(far in group for group in groups([a, b, far]))


def test_address_split_over_two_lines(monkeypatch: pytest.MonkeyPatch) -> None:
    pipeline = Pipeline()
    fixed_lines(
        monkeypatch,
        pipeline,
        [
            Line("1600 Pennsylvania", (0.1, 0.1, 0.1, 0.02), 0.9),
            Line("Avenue NW", (0.1, 0.125, 0.06, 0.02), 0.9),
        ],
    )
    result = pipeline.process(np.zeros((40, 40, 3), dtype=np.uint8), 0, 0)
    assert [d.kind for d in result.detections] == ["address"]


def test_small_text_triggers_reocr() -> None:
    detector = ChangeDetector()
    frame = np.full((1080, 1920, 3), 18, dtype=np.uint8)
    assert detector.changed(frame, 0)
    assert not detector.changed(frame.copy(), 100)
    # A short line of 9 px text between the old 12 px sampling stride positions.
    texted = frame.copy()
    cv2.putText(texted, "4111", (1405, 517), cv2.FONT_HERSHEY_PLAIN, 0.6, (230, 230, 230), 1)
    assert np.count_nonzero(texted != frame) > 0
    assert detector.changed(texted, 200)
    assert not detector.changed(texted.copy(), 300)
    assert detector.changed(texted, 2400)  # periodic refresh still applies


def test_single_pixel_stroke_missed_by_stride_is_seen() -> None:
    detector = ChangeDetector()
    frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
    detector.changed(frame, 0)
    stroke = frame.copy()
    stroke[13:21, 13] = 255  # no pixel on the old (12 px) sample lattice
    assert detector.changed(stroke, 100)


def test_ocr_pool_runs_reads_concurrently() -> None:
    active, peak, lock = [0], [0], threading.Lock()

    class Slow(OCR):
        def read(self, image: np.ndarray) -> list[Line]:  # type: ignore[override]
            with lock:
                active[0] += 1
                peak[0] = max(peak[0], active[0])
            time.sleep(0.15)
            with lock:
                active[0] -= 1
            return []

    pool = OCRPool(engines=[Slow(), Slow()])
    assert pool.size == 2 and pool.engine is None and "2 pooled" in pool.provider_note
    assert pool.providers == ["CPUExecutionProvider"]
    threads = [threading.Thread(target=pool.read, args=(None,)) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert peak[0] == 2
    assert OCRPool(size=3).size == 3


def frame_headers(meta: object) -> dict[str, str]:
    return {**AUTH, "X-Veil-Frame": meta if isinstance(meta, str) else json.dumps(meta)}


def png() -> bytes:
    blob = io.BytesIO()
    Image.new("RGB", (32, 32)).save(blob, format="PNG")
    return blob.getvalue()


def quiet_pipeline(monkeypatch: pytest.MonkeyPatch, text: str = "") -> Pipeline:
    pipeline = Pipeline()
    lines = [Line(text, (0.1, 0.1, 0.3, 0.05), 0.99)] if text else []
    monkeypatch.setattr(pipeline.ocr, "read", lambda _: lines)
    return pipeline


def test_tokens_require_format_and_entropy() -> None:
    assert token_strong(secrets.token_hex(32))
    assert token_strong(secrets.token_urlsafe(32))
    for weak in ["x" * 64, "ab" * 32, "0123456789abcdef" * 4, "short", "g" * 80, "!" * 64]:
        assert not token_strong(weak)
        with pytest.raises(ValueError):
            create_app(weak, Pipeline())


@pytest.mark.parametrize(
    "meta",
    [
        "[1, 2]",
        "42",
        "not json",
        {"frame_id": 1, "timestamp_ns": 0, "late_results": "many"},
        {"frame_id": 1, "timestamp_ns": 0, "late_results": None},
        {"frame_id": 1, "timestamp_ns": 0, "late_results": [1]},
        {"frame_id": None, "timestamp_ns": 0},
        {"frame_id": 1, "timestamp_ns": 0, "capture_rect": [0, 0, 1]},
        {"frame_id": 1, "timestamp_ns": 0, "capture_rect": 5},
        {"frame_id": 1, "timestamp_ns": 0, "format": "rgba", "width": 2, "height": 2},
        '{"frame_id": 1, "timestamp_ns": NaN}',
        '{"frame_id": 1, "timestamp_ns": Infinity}',
        '{"frame_id": 1, "timestamp_ns": 0, "capture_rect": [NaN, 0, 1, 1]}',
        {"frame_id": -1, "timestamp_ns": 0},
        {"frame_id": 2**64, "timestamp_ns": 0},
    ],
)
def test_malformed_metadata_is_rejected(monkeypatch: pytest.MonkeyPatch, meta: object) -> None:
    client = TestClient(create_app(TOKEN, quiet_pipeline(monkeypatch)))
    response = client.post("/v1/frames", headers=frame_headers(meta), content=png())
    assert response.status_code == 400


def test_out_of_order_frame_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    client = TestClient(create_app(TOKEN, quiet_pipeline(monkeypatch)))
    meta = {"frame_id": 5, "timestamp_ns": 0, "stream_id": "s"}
    assert client.post("/v1/frames", headers=frame_headers(meta), content=png()).status_code == 200
    assert client.post("/v1/frames", headers=frame_headers(meta), content=png()).status_code == 400


def test_incident_text_is_redacted_unless_requested(monkeypatch: pytest.MonkeyPatch) -> None:
    client = TestClient(create_app(TOKEN, quiet_pipeline(monkeypatch, "fake@example.com")))
    meta = {"frame_id": 1, "timestamp_ns": 0, "stream_id": "cap"}
    assert client.post("/v1/frames", headers=frame_headers(meta), content=png()).status_code == 200
    redacted = client.post("/v1/incident-text", headers=AUTH, json={"stream_id": "cap"}).json()
    assert redacted == {"redacted": True, "texts": ["[email redacted]"]}
    raw = client.post(
        "/v1/incident-text", headers=AUTH, json={"stream_id": "cap", "include_text": True}
    ).json()
    assert raw == {"redacted": False, "texts": ["fake@example.com"]}
    assert client.post("/v1/incident-text", json={"stream_id": "cap"}).status_code == 401
    missing = client.post("/v1/incident-text", headers=AUTH, json={"stream_id": "none"}).json()
    assert missing["texts"] == []


def test_active_streams_are_not_evicted(monkeypatch: pytest.MonkeyPatch) -> None:
    clock = [1000.0]
    monkeypatch.setattr(server.time, "monotonic", lambda: clock[0])
    client = TestClient(create_app(TOKEN, quiet_pipeline(monkeypatch)))

    def send(stream: str, frame: int) -> int:
        meta = {"frame_id": frame, "timestamp_ns": 0, "stream_id": stream}
        return client.post("/v1/frames", headers=frame_headers(meta), content=png()).status_code

    for index in range(server.MAX_STREAMS - 1):
        assert send(f"s{index}", 0) == 200
    assert send("overflow", 0) == 429  # every other stream is active
    clock[0] += server.ACTIVE_STREAM_S + 1
    assert send("s5", 1) == 200  # s5 stays active
    assert send("overflow", 0) == 200  # evicts the least recently seen idle stream (s0)
    assert send("s5", 2) == 200  # s5 kept its frame ordering state
    assert send("s0", 0) == 200  # s0 was evicted, so it restarts and frame 0 is accepted again
    assert send("s5", 3) == 200  # active s5 still survives further evictions


def test_streams_run_concurrently_with_engine_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    active, peak, lock = [0], [0], threading.Lock()

    class Slow(OCR):
        def read(self, image: np.ndarray) -> list[Line]:  # type: ignore[override]
            with lock:
                active[0] += 1
                peak[0] = max(peak[0], active[0])
            time.sleep(0.2)
            with lock:
                active[0] -= 1
            return []

    monkeypatch.setattr("veil_detector.ocr.OCR", Slow)
    monkeypatch.setenv("VEIL_OCR_ENGINES", "2")
    app = create_app(TOKEN)

    async def run() -> list[int]:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:

            async def post(stream: str, frame: int) -> int:
                meta = {"frame_id": frame, "timestamp_ns": frame * 10**8, "stream_id": stream}
                response = await client.post(
                    "/v1/frames", headers=frame_headers(meta), content=png()
                )
                return response.status_code

            return list(
                await asyncio.gather(
                    post("a", 0), post("b", 0), post("c", 0), post("a", 1), post("a", 2)
                )
            )

    assert asyncio.run(run()) == [200] * 5
    assert peak[0] == 2  # bounded by the pool, and more than one at a time


def test_health_reports_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    client = TestClient(create_app(TOKEN, engines=3))
    health = client.get("/v1/health", headers=AUTH).json()
    assert health["model_loaded"] is False
    assert "3 pooled engines" in health["provider_note"]


def test_non_ascii_credentials_are_rejected_not_crashed(monkeypatch: pytest.MonkeyPatch) -> None:
    client = TestClient(create_app(TOKEN, quiet_pipeline(monkeypatch)))
    bad = httpx.Headers([(b"authorization", b"Bearer " + bytes([0xE9, 0xFF]))])
    assert client.get("/v1/health", headers=bad).status_code == 401
    with (
        pytest.raises(WebSocketDisconnect),
        client.websocket_connect("/v1/events", headers=bad) as ws,
    ):
        ws.receive_text()


def test_stream_cap_under_concurrent_load(monkeypatch: pytest.MonkeyPatch) -> None:
    """50 concurrent requests over 40 streams: the cap holds, nothing errors, order is kept."""
    app = create_app(TOKEN, quiet_pipeline(monkeypatch))

    async def run() -> tuple[list[int], list[int]]:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:

            async def post(stream: str, frame: int) -> int:
                meta = {"frame_id": frame, "timestamp_ns": frame, "stream_id": stream}
                response = await client.post(
                    "/v1/frames", headers=frame_headers(meta), content=png()
                )
                return response.status_code

            ordered = await asyncio.gather(*[post("s0", frame) for frame in range(1, 11)])
            burst = [post(f"s{index}", 0) for index in range(1, 40)]
            burst += [post(f"s{index}", 1) for index in range(1, 11)]
            return list(ordered), list(await asyncio.gather(post("s0", 11), *burst))

    ordered, burst = asyncio.run(run())
    assert ordered == [200] * 10  # one stream's frames are processed in arrival order
    assert set(burst) == {200, 429}
    assert burst.count(200) == server.MAX_STREAMS - 1 + 10  # "default" holds one slot
