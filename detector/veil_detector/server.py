"""Authenticated loopback detector; no request bodies or OCR text are logged."""

import asyncio
import io
import json
import os
import secrets
import contextlib
import hashlib
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator
import numpy as np
from fastapi import FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from PIL import Image, UnidentifiedImageError
from .models import Policy, VaultUpdate, Detection
from .pipeline import Pipeline
from .window_guard.base import WindowState, enumerate_windows, map_window

MAX_BYTES = 16 * 1024 * 1024


def create_app(token: str, pipeline: Pipeline | None = None) -> FastAPI:
    """Construct an isolated app with a required high-entropy credential."""
    if len(token) < 32:
        raise ValueError("a random 256-bit install token is required")
    detector = pipeline or Pipeline()
    streams: dict[str, Pipeline] = {"default": detector}
    late_counts: dict[str, int] = {}
    lock = asyncio.Lock()
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
        if not secrets.compare_digest(authorization or "", "Bearer " + token):
            raise HTTPException(401, "authentication required")

    @app.get("/v1/health")
    async def health(authorization: str | None = Header(default=None)) -> dict[str, object]:
        authorize(authorization)
        values = detector.latencies
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
        async with lock:
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
        async with lock:
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
            frame_id = int(meta["frame_id"])
            timestamp = float(meta["timestamp_ns"]) / 1e6
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
            async with lock:
                key = str(meta.get("stream_id", "default"))[:128]
                if key not in streams:
                    if len(streams) >= 32:
                        oldest = next(name for name in streams if name != "default")
                        streams.pop(oldest)
                        late_counts.pop(oldest, None)
                    stream = Pipeline()
                    stream.ocr = detector.ocr
                    stream.vault = detector.vault.copy()
                    stream.policy = detector.policy
                    streams[key] = stream
                elif key != "default":
                    stream = streams.pop(key)
                    streams[key] = stream
                result = await asyncio.to_thread(streams[key].process, pixels, frame_id, timestamp)
                policy = detector.policy
                if policy.profile != "off" and "window" in policy.enabled:
                    capture = (
                        tuple(float(v) for v in meta["capture_rect"])
                        if "capture_rect" in meta
                        else None
                    )
                    if capture is not None and len(capture) != 4:
                        raise ValueError("capture rectangle requires four coordinates")
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
                                        + hashlib.sha256(
                                            detector.salt + window.title.encode()
                                        ).hexdigest(),
                                        first_seen_frame=frame_id,
                                    )
                                )
                if key != "default":
                    detector.latencies = (detector.latencies + [result.processed_ms])[-1000:]
        except (ValueError, KeyError, UnidentifiedImageError, Image.DecompressionBombError):
            raise HTTPException(400, "invalid frame or metadata") from None
        late_count = max(0, int(meta.get("late_results", 0)))
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
        body: dict[str, str], authorization: str | None = Header(default=None)
    ) -> dict[str, list[str]]:
        """Explicit incident-only loopback handoff; never included in normal events."""
        authorize(authorization)
        stream = streams.get(body.get("stream_id", ""))
        return {"texts": stream.incident_texts.copy() if stream is not None else []}

    @app.websocket("/v1/events")
    async def events(socket: WebSocket) -> None:
        if not secrets.compare_digest(socket.headers.get("authorization", ""), "Bearer " + token):
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
