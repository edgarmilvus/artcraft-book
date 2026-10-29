"""Loopback stand-in for the PhotoCraft placeholder window.

The real channel is the desktop application's authenticated JSON-lines
control socket. This stub implements the three methods the resolver uses —
`auth`, `ui.pointer` and `ui.screenshot` — and writes a real PNG for the
screenshot so the placeholder strategy can be exercised headlessly.
"""
from __future__ import annotations

import json
import socket
import threading
from pathlib import Path

from PIL import Image, ImageDraw


class StubControlServer:
    def __init__(self, token: str) -> None:
        self.token = token
        self._server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._server.bind(("127.0.0.1", 0))
        self._server.listen(4)
        self.port = self._server.getsockname()[1]
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self.calls: list[str] = []

    def start(self) -> None:
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        try:
            self._server.close()
        except OSError:
            pass

    def _serve(self) -> None:
        while not self._stop.is_set():
            try:
                connection, _ = self._server.accept()
            except OSError:
                return
            with connection:
                self._handle(connection)

    def _handle(self, connection: socket.socket) -> None:
        stream = connection.makefile("r")
        authenticated = False
        for line in stream:
            if not line.strip():
                continue
            message = json.loads(line)
            method = message.get("method")
            if method == "auth":
                if message.get("params", {}).get("token") == self.token:
                    authenticated = True
                    self._reply(connection, {"id": message.get("id"), "ok": True})
                else:
                    self._reply(connection, {"id": message.get("id"), "ok": False, "error": "bad token"})
                    return
                continue
            if not authenticated:
                self._reply(connection, {"id": message.get("id"), "ok": False, "error": "auth required"})
                return
            self.calls.append(str(method))
            if method == "ui.screenshot":
                path = Path(message.get("params", {}).get("path", "placeholder.png"))
                path.parent.mkdir(parents=True, exist_ok=True)
                image = Image.new("RGB", (1200, 1500), "#f4f1ea")
                draw = ImageDraw.Draw(image)
                draw.rectangle([120, 120, 1080, 900], fill="#1d4ed8")
                draw.text((160, 980), "PLACEHOLDER — replace with approved asset", fill="#111827")
                image.save(path)
                self._reply(connection, {"id": message.get("id"), "ok": True, "result": {"path": str(path)}})
            else:
                self._reply(connection, {"id": message.get("id"), "ok": True, "result": {}})

    @staticmethod
    def _reply(connection: socket.socket, message: dict) -> None:
        connection.sendall((json.dumps(message) + "\n").encode())
