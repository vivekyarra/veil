"""Authenticated loopback detector; no request bodies or OCR text are logged."""

import asyncio
import io
import json
import math
import os
import re
import secrets
import contextlib
import hashlib
import time
from collections import Counter
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator
import numpy as np
from fastapi import FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel
from .models import Policy, VaultUpdate, Detection
from .ocr import OCRPool
from .pipeline import Pipeline
from .window_guard.base import WindowState, enumerate_windows, map_window

MAX_BYTES = 16 * 1024 * 1024
MAX_STREAMS = 32
# A stream that sent a frame within this window keeps its tracker state; the maximum policy
# hold is 10 s, so evicting sooner could drop a held mask.
ACTIVE_STREAM_S = 15.0
TOKEN_FORMAT = re.compile(r"[0-9a-fA-F]{64,}|[A-Za-z0-9_-]{43,}")


def token_strong(token: str) -> bool:
    """Hex (>= 64 chars) or URL-safe base64 (>= 43 chars) with >= 160 bits of estimated entropy."""
    if not TOKEN_FORMAT.fullmatch(token):
        return False
    counts = Counter(token)
    if len(counts) < 12:
        return False
    if any(token == (token[:k] * len(token))[: len(token)] for k in range(1, 17)):
        return False
    entropy = -sum(n * math.log2(n / len(token)) for n in counts.values())
    return entropy >= 160


MAX_FRAME_ID = 2**63 - 1


def credential_matches(supplied: str | None, token: str) -> bool:
    """Constant-time bearer check; non-ASCII header bytes are a mismatch, not a server error."""
    expected = ("Bearer " + token).encode()
    return secrets.compare_digest((supplied or "").encode("latin-1", "replace"), expected)


def finite(value: object) -> float:
    """Parse a float that must be finite; NaN or infinity would break hold timing."""
    number = float(value)  # type: ignore[arg-type]
    if not math.isfinite(number):
        raise ValueError("non-finite number")
    return number


class IncidentRequest(BaseModel):
    stream_id: str = ""
    include_text: bool = False


def create_app(token: str, pipeline: Pipeline | None = None, engines: int | None = None) -> FastAPI:
    """Construct an isolated app with a required high-entropy credential."""
    if not token_strong(token):
        raise ValueError("a random 256-bit install token (hex or URL-safe base64) is required")
    if pipeline is None:
        size = engines if engines is not None else int(os.environ.get("VEIL_OCR_ENGINES", "2"))
        detector = Pipeline(OCRPool(max(1, min(8, size))))
    else:
        detector = pipeline
    concurrency = asyncio.Semaphore(getattr(detector.ocr, "size", 1))
    streams: dict[str, Pipeline] = {"default": detector}
    stream_locks: dict[str, asyncio.Lock] = {"default": asyncio.Lock()}
    last_seen: dict[str, float] = {"default": time.monotonic()}
    late_counts: dict[str, int] = {}
    # Health percentiles over every stream, kept once per frame and across stream eviction.
    recent_latencies: list[float] = []
    subscribers: set[WebSocket] = set()
    window_state = WindowState([], False, "Window enumeration not yet sampled")

    async def poll_windows() -> None:
        nonlocal window_state
        while True:
            window_state = await asyncio.to_thread(enumerate_windows)
            await asyncio.sleep(0.2)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        task = asyncio.create_task(poll_windows())
        try:
            yield
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
            for stream in streams.values():
                stream.vault.clear()

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

    def authorize(authorization: str | None) -> None:
        if not credential_matches(authorization, token):
            raise HTTPException(401, "authentication required")

    def stream_for(key: str) -> Pipeline:
        """Create streams on demand; evict only idle streams when the cap is reached."""
        if key in streams:
            return streams[key]
        if len(streams) >= MAX_STREAMS:
            now = time.monotonic()
            idle = [
                name
                for name in streams
                if name != "default"
                and not stream_locks[name].locked()
                and now - last_seen[name] > ACTIVE_STREAM_S
            ]
            if not idle:
                raise HTTPException(429, "too many active capture streams")
            oldest = min(idle, key=lambda name: last_seen[name])
            streams.pop(oldest)
            stream_locks.pop(oldest)
            last_seen.pop(oldest)
            late_counts.pop(oldest, None)
        stream = Pipeline(detector.ocr)
        stream.vault = detector.vault.copy()
        stream.policy = detector.policy
        streams[key] = stream
        stream_locks[key] = asyncio.Lock()
        last_seen[key] = time.monotonic()
        return stream

    @app.get("/v1/health")
    async def health(authorization: str | None = Header(default=None)) -> dict[str, object]:
        authorize(authorization)
        # Native, pre-flight and rehearsal captures use isolated stream IDs.
        # Health must measure those streams, not only the rarely-used default.
        values = recent_latencies
        return {
            "status": "ok",
            "model_loaded": detector.ocr.engine is not None,
            "providers": detector.ocr.providers,
            "provider_note": detector.ocr.provider_note,
            "p50_ms": float(np.percentile(values, 50)) if values else None,
            "p99_ms": float(np.percentile(values, 99)) if values else None,
            "window_guard_available": window_state.available,
            "window_guard_reason": window_state.reason,
            "denylisted_windows": sum(
                any(term.lower() in window.title.lower() for term in detector.policy.denylist)
                for window in window_state.windows
            ),
        }

    @app.put("/v1/vault")
    async def vault(
        body: VaultUpdate, authorization: str | None = Header(default=None)
    ) -> dict[str, int]:
        authorize(authorization)
        detector.vault = body.terms.copy()
        for stream in streams.values():
            stream.vault = body.terms.copy()
            stream.change.refreshed = -1e9
        return {"count": len(body.terms)}

    @app.put("/v1/policy")
    async def policy(
        body: Policy, authorization: str | None = Header(default=None)
    ) -> dict[str, str]:
        authorize(authorization)
        detector.policy = body
        for stream in streams.values():
            stream.policy = body
        return {"status": "updated"}

    @app.post("/v1/frames")
    async def frames(
        request: Request,
        authorization: str | None = Header(default=None),
        x_veil_frame: str = Header(),
    ) -> dict[str, object]:
        authorize(authorization)
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > MAX_BYTES:
                raise HTTPException(413, "frame too large")
        try:
            meta = json.loads(x_veil_frame)
            if not isinstance(meta, dict):
                raise ValueError("frame metadata must be a JSON object")
            frame_id = int(meta["frame_id"])
            if not 0 <= frame_id <= MAX_FRAME_ID:
                raise ValueError("frame id out of range")
            timestamp = finite(meta["timestamp_ns"]) / 1e6
            late_count = max(0, int(meta.get("late_results", 0)))
            key = str(meta.get("stream_id", "default"))[:128]
            capture = (
                tuple(finite(v) for v in meta["capture_rect"]) if "capture_rect" in meta else None
            )
            if capture is not None and len(capture) != 4:
                raise ValueError("capture rectangle requires four coordinates")
            if meta.get("format") == "rgba":
                width, height = int(meta["width"]), int(meta["height"])
                if (
                    not 0 < width <= 4096
                    or not 0 < height <= 2160
                    or len(body) != width * height * 4
                ):
                    raise ValueError("invalid raw frame")
                pixels = (
                    np.frombuffer(body, dtype=np.uint8).reshape(height, width, 4)[:, :, :3].copy()
                )
            else:
                image = Image.open(io.BytesIO(body))
                if image.width * image.height > 4096 * 2160:
                    raise ValueError("image dimensions exceed limit")
                pixels = np.asarray(image.convert("RGB"), dtype=np.uint8)
        except (
            ValueError,
            KeyError,
            TypeError,
            OverflowError,
            OSError,
            UnidentifiedImageError,
            Image.DecompressionBombError,
        ):
            raise HTTPException(400, "invalid frame or metadata") from None
        stream = stream_for(key)
        # One frame at a time per stream keeps frame order and tracker state consistent;
        # different streams run concurrently up to the OCR pool size.
        async with stream_locks[key]:
            last_seen[key] = time.monotonic()
            try:
                async with concurrency:
                    result = await asyncio.to_thread(stream.process, pixels, frame_id, timestamp)
            except ValueError:
                raise HTTPException(400, "invalid frame or metadata") from None
            finally:
                last_seen[key] = time.monotonic()
        policy = detector.policy
        if policy.profile != "off" and "window" in policy.enabled:
            for window in window_state.windows:
                if any(term.lower() in window.title.lower() for term in policy.denylist):
                    rectangle = map_window(window, capture, policy.profile == "paranoid")
                    if rectangle is not None:
                        result.detections.append(
                            Detection(
                                track_id="window",
                                kind="window",
                                box=rectangle,
                                confidence=1,
                                text_hash="sha256:"
                                + hashlib.sha256(detector.salt + window.title.encode()).hexdigest(),
                                first_seen_frame=frame_id,
                            )
                        )
        recent_latencies[:] = (recent_latencies + [result.processed_ms])[-1000:]
        late = late_count > late_counts.get(key, 0)
        late_counts[key] = late_count
        event = {
            "type": "late_result" if late else "detection",
            "stream_id": key,
            "result": result.model_dump(),
        }
        for socket in subscribers.copy():
            try:
                await asyncio.wait_for(socket.send_json(event), timeout=0.1)
            except (RuntimeError, TimeoutError, WebSocketDisconnect):
                subscribers.discard(socket)
        return result.model_dump()

    @app.post("/v1/incident-text")
    async def incident_text(
        body: IncidentRequest, authorization: str | None = Header(default=None)
    ) -> dict[str, object]:
        """Late-result incident evidence for the latest frame of one stream.

        Redacted by default: each entry carries only the recognized kind. Raw OCR text is
        returned only when the caller sets ``include_text`` on that request; it never appears
        in detection responses or events.
        """
        authorize(authorization)
        stream = streams.get(body.stream_id)
        entries = stream.incident_texts.copy() if stream is not None else []
        if body.include_text:
            return {"redacted": False, "texts": [text for _, text in entries]}
        return {"redacted": True, "texts": [f"[{kind} redacted]" for kind, _ in entries]}

    @app.websocket("/v1/events")
    async def events(socket: WebSocket) -> None:
        if not credential_matches(socket.headers.get("authorization"), token):
            await socket.close(code=1008)
            return
        await socket.accept()
        subscribers.add(socket)
        try:
            while True:
                await socket.receive_text()
        except WebSocketDisconnect:
            subscribers.discard(socket)

    return app


def main() -> None:
    """Start without access logging and with loopback binding only."""
    import uvicorn

    token = os.environ.get("VEIL_LOCAL_TOKEN", "")
    uvicorn.run(
        create_app(token),
        host="127.0.0.1",
        port=int(os.environ.get("VEIL_PORT", "47321")),
        access_log=False,
    )


if __name__ == "__main__":
    main()
