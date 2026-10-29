"""Stub of the desktop control channel, for running the art-director loop.

The real counterpart is `photocraft --control <port>`: an authenticated,
loopback-only JSON-lines server. That server lives in the desktop application
and needs a window, so it cannot run in a headless test environment. This stub
implements the frames the exercise uses — auth first, `engine.execute`,
`app.save`, `ui.screenshot` — with the same reply envelope:

    {"id": 1, "ok": true, "result": {...}}
    {"id": 2, "ok": false, "error": "authentication required"}

It keeps a tiny document model (a layer list and a history stack) so that the
loop's undo accounting is exercised for real rather than mocked.
"""

from __future__ import annotations

import io
import json
import socket
import threading
from pathlib import Path
from typing import Any

# The real desktop renderer writes the current document. The stub draws a
# 320x200 frame whose bands and counter follow the history depth, so every
# audit artefact is a real PNG and successive iterations are visibly distinct.
RENDER_WIDTH = 320
RENDER_HEIGHT = 200


class StubControlServer:
    def __init__(self, token: str, write_root: Path) -> None:
        self.token = token
        self.write_root = Path(write_root)
        self.write_root.mkdir(parents=True, exist_ok=True)

        self._server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._server.bind(("127.0.0.1", 0))
        self._server.listen(4)
        self.port: int = self._server.getsockname()[1]

        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._lock = threading.Lock()

        # Document model: enough state for the loop's decisions to be visible.
        self.layers: list[dict[str, Any]] = []
        self.history: list[str] = []
        self._next_layer = 1
        self.calls: list[str] = []

    # -- lifecycle ---------------------------------------------------------
    def start(self) -> None:
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        try:
            self._server.close()
        except OSError:
            pass
        if self._thread:
            self._thread.join(timeout=2)

    def __enter__(self) -> "StubControlServer":
        self.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.stop()

    # -- connection handling ----------------------------------------------
    def _serve(self) -> None:
        while not self._stop.is_set():
            try:
                conn, _ = self._server.accept()
            except OSError:
                return
            threading.Thread(target=self._session, args=(conn,), daemon=True).start()

    def _session(self, conn: socket.socket) -> None:
        authenticated = False
        with conn, conn.makefile("rw") as stream:
            for raw in stream:
                try:
                    frame = json.loads(raw)
                except json.JSONDecodeError:
                    stream.write(json.dumps({"id": None, "ok": False,
                                             "error": "malformed frame"}) + "\n")
                    stream.flush()
                    continue

                method = frame.get("method")
                if not authenticated:
                    if method != "auth":
                        stream.write(json.dumps({
                            "id": frame.get("id"), "ok": False,
                            "error": "authentication required",
                        }) + "\n")
                        stream.flush()
                        continue
                    if frame.get("params", {}).get("token") != self.token:
                        stream.write(json.dumps({
                            "id": frame.get("id"), "ok": False,
                            "error": "authentication required",
                        }) + "\n")
                        stream.flush()
                        conn.close()
                        return
                    authenticated = True
                    stream.write(json.dumps({
                        "id": frame.get("id"), "ok": True,
                        "result": {"authenticated": True},
                    }) + "\n")
                    stream.flush()
                    continue

                stream.write(json.dumps(self._dispatch(frame)) + "\n")
                stream.flush()

    # -- methods -----------------------------------------------------------
    def _dispatch(self, frame: dict) -> dict:
        request_id = frame.get("id")
        method = frame.get("method")
        params = frame.get("params") or {}
        try:
            if method == "engine.execute":
                return {"id": request_id, "ok": True,
                        "result": self._engine(params["command"], params.get("params") or {})}
            if method == "app.save":
                return {"id": request_id, "ok": True,
                        "result": self._save_png(params.get("path"))}
            if method == "ui.screenshot":
                return {"id": request_id, "ok": True,
                        "result": self._save_png(params.get("path"))}
            return {"id": request_id, "ok": False,
                    "error": f"unknown method `{method}`"}
        except Exception as exc:  # noqa: BLE001 — the real server reports errors this way
            return {"id": request_id, "ok": False, "error": str(exc)}

    def _engine(self, command: str, params: dict) -> Any:
        self.calls.append(command)

        if command == "file.new":
            self.layers = [{"id": 0, "name": "Background", "kind": "Pixel"}]
            self.history = ["New"]
            self._next_layer = 1
            return {"document": 0}

        if command == "document.inspect":
            return {
                "width": params.get("width", 1920),
                "height": 1080,
                "layers": list(reversed(self.layers)),
                "history": list(self.history),
                "canUndo": len(self.history) > 1,
                "canRedo": False,
                "hasSelection": False,
            }

        if command == "edit.undo":
            if len(self.history) <= 1:
                raise ValueError("nothing to undo")
            self.history.pop()
            if self.layers:
                self.layers.pop()
            return None

        if command == "select.rect" or command == "select.deselect":
            self.history.append(command)
            return None

        if command == "layer.newFillLayer.solidColor":
            layer = {"id": self._next_layer, "name": "Color Fill 1", "kind": "Fill"}
            self._next_layer += 1
            self.layers.append(layer)
            self.history.append(command)
            return {"layer": layer["id"]}

        if command.startswith("layer.new") or command == "layer.new.layer":
            layer = {"id": self._next_layer, "name": params.get("name", "Layer"),
                     "kind": "Pixel"}
            self._next_layer += 1
            self.layers.append(layer)
            self.history.append(command)
            return {"layer": layer["id"]}

        if command in ("layer.setProps", "layer.moveTo", "layer.translate",
                       "layer.setAdjustment", "layer.releaseClippingMask"):
            self.history.append(command)
            return None

        if command == "layer.createClippingMask":
            self.history.append(command)
            return {"layers": [params.get("layer")]}

        raise ValueError(f"unknown command `{command}`")

    def _render_png(self) -> bytes:
        """A deterministic 320x200 frame that changes with document history."""
        from PIL import Image, ImageDraw

        image = Image.new("RGB", (RENDER_WIDTH, RENDER_HEIGHT), "#202020")
        draw = ImageDraw.Draw(image)
        depth = len(self.history)

        # Vertical warm-to-cool gradient, the "photo" being corrected.
        for y in range(RENDER_HEIGHT):
            t = y / max(1, RENDER_HEIGHT - 1)
            draw.line(
                [(0, y), (RENDER_WIDTH, y)],
                fill=(int(26 + 190 * t), int(38 + 120 * t), int(70 + 100 * t)),
            )

        # One bar per layer, so a correction that creates or removes a layer is
        # visible in the frame the vision model receives.
        for index, layer in enumerate(self.layers[:8]):
            top = 24 + index * 18
            draw.rounded_rectangle(
                [20, top, 300, top + 10], radius=4,
                fill=("#e4572e", "#f4a261", "#2a9d8f", "#457b9d")[index % 4],
            )

        draw.rectangle([0, 0, 12, RENDER_HEIGHT], fill="#111111")
        draw.text((24, RENDER_HEIGHT - 28), f"history {depth} / layers {len(self.layers)}",
                  fill="#f8f5ef")
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        return buffer.getvalue()

    def _save_png(self, path: Any) -> dict:
        if not isinstance(path, str) or not path:
            raise ValueError("`path` must be a string")
        target = Path(path)
        if not target.is_absolute():
            target = self.write_root / target
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(self._render_png())
        # Both methods are reads: they add no history state.
        return {"path": str(target), "warnings": []}
