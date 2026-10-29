"""Stub of the LightCraft desktop control channel, for running the audit loop.

The real counterpart is `lightcraft --control <port>`: an authenticated,
loopback-only JSON-lines server that lives in the desktop application. That
server needs a window, so it cannot run in a headless environment. This stub
speaks the same protocol and executes every command against the *real*
headless engine over its MCP server:

    {"id": 1, "ok": true, "result": {...}}
    {"id": 2, "ok": false, "error": "authentication required"}

The only extension is the `command_batch` pseudo-command: over the desktop
channel a batch is the `command.batch` engine command, which cannot thread the
ids of earlier steps. The stub maps `command_batch` onto the MCP tool of the
same name, which can, so the agent can build the blend in one atomic batch.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import threading
from typing import Any


class McpStdio:
    """The smallest MCP client that speaks JSON-RPC over a child's stdio."""

    def __init__(self, command: list[str]) -> None:
        self.proc = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
        self._id = 0
        # A re-entrant lock: `call` holds it while `_send` takes it again.
        self._lock = threading.RLock()
        self._send({"jsonrpc": "2.0", "id": 0, "method": "initialize",
                    "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                               "clientInfo": {"name": "stub-control-server", "version": "1.0.0"}}})
        self._read_until(0)
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})

    def _send(self, message: dict[str, Any]) -> None:
        with self._lock:
            assert self.proc.stdin is not None
            self.proc.stdin.write(json.dumps(message) + "\n")
            self.proc.stdin.flush()

    def _read_until(self, wanted: int) -> dict[str, Any]:
        assert self.proc.stdout is not None
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("the engine closed its output")
            line = line.strip()
            if not line:
                continue
            message = json.loads(line)
            if message.get("id") == wanted:
                return message

    def call(self, tool: str, arguments: dict[str, Any]) -> Any:
        with self._lock:
            self._id += 1
            wanted = self._id
            self._send({"jsonrpc": "2.0", "id": wanted, "method": "tools/call",
                        "params": {"name": tool, "arguments": arguments}})
            message = self._read_until(wanted)
        result = message.get("result") or {}
        if result.get("isError"):
            text = next((b.get("text", "") for b in result.get("content", []) if b.get("type") == "text"), "")
            raise RuntimeError(text or f"{tool} failed")
        for block in result.get("content", []):
            if block.get("type") == "text" and block.get("text"):
                text = block["text"]
                try:
                    return json.loads(text)
                except json.JSONDecodeError:
                    return text
        return None

    def close(self) -> None:
        try:
            self.proc.terminate()
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


class StubControlServer:
    """The loopback JSON-lines server the agent talks to."""

    def __init__(self, token: str, engine: list[str] | None = None) -> None:
        self.token = token
        self.engine = engine or ["lightcraft-cli", "mcp", "--headless"]
        self.calls: list[str] = []
        self.mcp: McpStdio | None = None

        self._server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._server.bind(("127.0.0.1", 0))
        self._server.listen(4)
        self.port: int = self._server.getsockname()[1]
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    # -- lifecycle ---------------------------------------------------------
    def start(self) -> None:
        self.mcp = McpStdio(self.engine)
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        try:
            self._server.close()
        except Exception:
            pass
        if self.mcp is not None:
            self.mcp.close()
            self.mcp = None

    # -- the protocol ------------------------------------------------------
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
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                self._reply(connection, {"id": None, "ok": False, "error": "malformed frame"})
                return
            method = message.get("method")
            if method == "auth":
                if message.get("params", {}).get("token") == self.token:
                    authenticated = True
                    self._reply(connection, {"id": message.get("id"), "ok": True, "result": {"authenticated": True}})
                else:
                    self._reply(connection, {"id": message.get("id"), "ok": False, "error": "bad token"})
                    return
                continue
            if not authenticated:
                self._reply(connection, {"id": message.get("id"), "ok": False, "error": "authentication required"})
                return
            if method != "engine.execute":
                self._reply(connection, {"id": message.get("id"), "ok": False, "error": f"unknown method `{method}`"})
                continue
            params = message.get("params", {})
            command = params.get("command")
            command_params = params.get("params") or {}
            self.calls.append(command)
            try:
                result = self._execute(command, command_params)
            except Exception as error:  # the engine refused the command
                self._reply(connection, {"id": message.get("id"), "ok": False, "error": str(error)})
                continue
            self._reply(connection, {"id": message.get("id"), "ok": True, "result": result})

    def _execute(self, command: str, params: dict[str, Any]) -> Any:
        assert self.mcp is not None
        if command in ("render_photo", "render_preview", "export"):
            # Rendering and export are MCP meta-tools, not engine commands;
            # the desktop control surface exposes them under the same names.
            return self.mcp.call(command, params)
        if command == "command_batch":
            # The MCP tool can thread ids between steps; the engine command
            # cannot, so the stub routes the batch here.
            steps = params.get("steps", [])
            return self.mcp.call("command_batch", {
                "steps": steps,
                "stop_on_error": bool(params.get("atomic", params.get("stop_on_error", True))),
            })
        return self.mcp.call("command_run", {"id": command, "params": params})

    @staticmethod
    def _reply(connection: socket.socket, message: dict[str, Any]) -> None:
        connection.sendall((json.dumps(message) + "\n").encode())


def main() -> None:
    """Run the stub on a fixed port, for a manual session."""
    port = int(os.environ.get("LIGHTCRAFT_STUB_PORT", "7980"))
    token = os.environ.get("LIGHTCRAFT_CONTROL_TOKEN", "0" * 64)
    server = StubControlServer(token)
    server.port = port
    server.start()
    print(f"stub control channel on 127.0.0.1:{server.port}")
    try:
        while True:
            threading.Event().wait(1)
    except KeyboardInterrupt:
        server.stop()


if __name__ == "__main__":
    main()
