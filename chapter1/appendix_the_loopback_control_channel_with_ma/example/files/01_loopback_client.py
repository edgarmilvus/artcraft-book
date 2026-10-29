#!/usr/bin/env python3
"""
loopback_client.py — direct control-channel client.

Use this only when the MCP stdio path is unavailable (the app is already
running). The first frame on the socket MUST be the auth frame; the engine
closes the connection otherwise. Everything after that is line-delimited
JSON, one object per line, one reply per request.
"""

from __future__ import annotations

import json
import socket
from typing import Any, Dict, Optional


class ArtCraftControl:
    """Authenticated loopback client for an ArtCraft control channel."""

    def __init__(self, port: int, token: str, host: str = "127.0.0.1") -> None:
        if len(token) != 64:
            raise ValueError("the control token must be exactly 64 hex characters")
        self._sock = socket.create_connection((host, port), timeout=30.0)
        self._reader = self._sock.makefile("r", encoding="utf-8")
        self._request_id = 0
        self._authenticate(token)

    def _authenticate(self, token: str) -> None:
        """Send the mandatory first frame and verify the engine's reply."""
        frame = json.dumps(
            {"id": "auth", "method": "auth", "params": {"token": token}}
        )
        self._sock.sendall((frame + "\n").encode("utf-8"))
        reply = json.loads(self._reader.readline())
        if not reply.get("ok"):
            self.close()
            raise ConnectionRefusedError(f"control auth failed: {reply.get('error')}")

    def call(self, method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Invoke one control method and return the decoded reply."""
        self._request_id += 1
        payload = json.dumps(
            {
                "id": self._request_id,
                "method": method,
                "params": params or {},
            }
        )
        self._sock.sendall((payload + "\n").encode("utf-8"))
        line = self._reader.readline()
        if not line:
            raise ConnectionResetError("the control channel closed unexpectedly")
        return json.loads(line)

    def execute(self, command: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Run one registry command by id, exactly as `command_run` would."""
        return self.call("engine.execute", {"command": command, "params": params or {}})

    def close(self) -> None:
        try:
            self._reader.close()
        finally:
            self._sock.close()


if __name__ == "__main__":
    import os

    client = ArtCraftControl(
        port=int(os.environ.get("CRAFT_CONTROL_PORT", "7979")),
        token=os.environ["CRAFT_CONTROL_TOKEN"],
    )
    try:
        # A live, non-destructive grade edit through the authenticated channel.
        print(client.execute("layer.newAdjustmentLayer.curves", {
            "points": [[0, 0], [64, 48], [192, 208], [255, 255]]
        }))
    finally:
        client.close()
