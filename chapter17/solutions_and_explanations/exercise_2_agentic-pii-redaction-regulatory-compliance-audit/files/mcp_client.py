# =====================================================================
# mcp_client.py — a tiny MCP-over-stdio client for the harness.
#
# The engines speak JSON-RPC 2.0 over line-delimited stdio. This helper
# does the handshake, calls one tool and returns the parsed payload.
# =====================================================================
from __future__ import annotations
import json, subprocess
from typing import Any


class Mcp:
    def __init__(self, argv: list[str], cwd: str | None = None):
        self.p = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
            cwd=cwd,
        )
        self._id = 0

    def handshake(self) -> None:
        self._rpc("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "cap17-harness", "version": "1.0.0"},
        })
        self._notify("notifications/initialized", {})

    def _notify(self, method: str, params: dict) -> None:
        assert self.p.stdin is not None
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": method,
                                       "params": params}) + "\n")
        self.p.stdin.flush()

    def _rpc(self, method: str, params: dict | None = None) -> Any:
        assert self.p.stdin is not None and self.p.stdout is not None
        self._id += 1
        wanted = self._id
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": wanted,
                                       "method": method,
                                       "params": params or {}}) + "\n")
        self.p.stdin.flush()
        while True:
            line = self.p.stdout.readline()
            if not line:
                raise RuntimeError(f"MCP server closed while waiting for {method}")
            try:
                frame = json.loads(line)
            except json.JSONDecodeError:
                continue
            if frame.get("id") == wanted:
                return frame

    def call(self, tool: str, args: dict) -> Any:
        frame = self._rpc("tools/call", {"name": tool, "arguments": args})
        result = frame.get("result", {})
        content = result.get("content", [])
        first = next((c for c in content if c.get("type") == "text"), None)
        text = first["text"] if first else ""
        if result.get("isError"):
            raise RuntimeError(f"{tool} failed: {text}")
        if not text:
            return None
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text

    def execute(self, command: str, params: dict | None = None) -> Any:
        """Run one WordCraft engine command through the `execute` tool."""
        return self.call("execute", {"command": command, "params": params or {}})

    def close(self) -> None:
        try:
            if self.p.stdin:
                self.p.stdin.close()
        except Exception:
            pass
        try:
            self.p.wait(timeout=10)
        except Exception:
            self.p.kill()


def word_client(cwd: str | None = None) -> Mcp:
    """A WordCraft session. The working directory is its boundary."""
    client = Mcp(["wordcraft-cli", "mcp"], cwd=cwd)
    client.handshake()
    return client


def pdf_client(root: str) -> Mcp:
    """A PdfCraft session bounded to `root` — the server enforces it."""
    client = Mcp(["pdfcraft-cli", "mcp", "--root", root])
    client.handshake()
    return client
