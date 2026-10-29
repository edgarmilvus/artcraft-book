"""
Protocol stub for the exercise's control channel.

Speaks the NDJSON loopback protocol the chapter specifies: the first frame
must be `auth`, every later frame is `engine.execute`. It also implements
`session.list`, `document.inspect` and `document.activate`, keeps a command
history, and can drop a connection mid-command to simulate an engine crash.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any

TOKEN = "a" * 64


class ControlServer:
    def __init__(self, token: str = TOKEN) -> None:
        self.token = token
        self.history: list[dict[str, Any]] = []
        self.executions: list[str] = []
        self.drop_on: str | None = None
        self.documents: list[dict[str, Any]] = [{"index": 0, "name": "untitled"}]
        self._server: asyncio.AbstractServer | None = None
        self.port = 0

    async def start(self) -> None:
        self._server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]

    async def stop(self) -> None:
        if self._server:
            self._server.close()
            await self._server.wait_closed()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            first = await reader.readline()
            if not first:
                return
            frame = json.loads(first)
            if frame.get("method") != "auth":
                await self._reply(writer, frame.get("id"), ok=False,
                                  error={"code": "auth_required", "message": "first frame must be auth"})
                return
            if frame.get("params", {}).get("token") != self.token:
                await self._reply(writer, frame.get("id"), ok=False,
                                  error={"code": "unauthorized", "message": "bad token"})
                return
            await self._reply(writer, frame.get("id"), ok=True, result={"epoch": 1})

            while True:
                line = await reader.readline()
                if not line:
                    return
                msg = json.loads(line)
                command = msg["params"]["command"]
                params = msg["params"]["params"]

                if command == "session.list":
                    await self._reply(writer, msg["id"], ok=True, result={
                        "documents": self.documents,
                        "active_document": self.documents[0]["index"] if self.documents else -1,
                        "history_depth": len(self.history),
                    })
                    continue
                if command == "document.inspect":
                    await self._reply(writer, msg["id"], ok=True,
                                      result={"history": self.history[-32:]})
                    continue
                if command == "document.activate":
                    await self._reply(writer, msg["id"], ok=True,
                                      result={"active": params.get("document")})
                    continue

                self.executions.append(command)
                self.history.append({"command": command, "params": params})

                if self.drop_on and command == self.drop_on:
                    # Command applied, reply lost: the exact failure the
                    # ledger + reconcile path exists for.
                    self.drop_on = None
                    return

                await self._reply(writer, msg["id"], ok=True,
                                  result={"command": command, "applied": True})
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass

    @staticmethod
    async def _reply(writer: asyncio.StreamWriter, frame_id: Any, *, ok: bool,
                     result: Any = None, error: Any = None) -> None:
        frame: dict[str, Any] = {"id": frame_id, "ok": ok}
        if result is not None:
            frame["result"] = result
        if error is not None:
            frame["error"] = error
        writer.write((json.dumps(frame) + "\n").encode())
        await writer.drain()
