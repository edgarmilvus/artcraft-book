# python/14_live_bridge.py
"""An authenticated client for an ArtCraft desktop control channel.

The control channel belongs to the *desktop application* — ``photocraft
--control 7979`` — not to the CLI, which answers "unknown subcommand" for
``--control``. It is a loopback-only, JSON-lines socket on which the very
first frame must carry the auth token the application minted.

The protocol is deliberately small::

    -> {"id": "auth", "method": "auth", "params": {"token": "..."}}
    <- {"id": "auth", "ok": true, "result": {"authenticated": true}}

    -> {"id": 1, "method": "engine.execute",
        "params": {"command": "session.inspect", "params": {}}}
    <- {"id": 1, "ok": true, "result": {...}}

    -> {"id": 2, "method": "ui.screenshot", "params": {"path": "shot.png"}}
    <- {"id": 2, "ok": true, "result": {"path": "shot.png"}}

A frame that is not the auth frame is answered with
``{"ok": false, "error": "authentication required"}``, and a wrong token
closes the socket. That is the behaviour a shared CI runner wants: a
bridge that forgets to authenticate is disconnected, not obeyed.
"""

from __future__ import annotations

import json
import os
import socket
import sys
from typing import Any


class ControlChannelError(RuntimeError):
    """Raised when the control channel refuses a frame."""


class CraftLiveClient:
    """Authenticated JSON-lines client for an ArtCraft control port."""

    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 7979,
        token: str | None = None,
        timeout: float = 15.0,
    ) -> None:
        if not token:
            raise ControlChannelError(
                "the control channel requires a token; "
                "pass one or set PHOTOCRAFT_TOKEN"
            )
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.settimeout(timeout)
        self.reader = self.sock.makefile("r", encoding="utf-8")
        self._rid = 0

        # MANDATORY first frame: the token. The application closes the
        # socket if it does not see it.
        ack = self._roundtrip(
            {
                "id": "auth",
                "method": "auth",
                "params": {"token": token},
            }
        )
        if not ack.get("ok"):
            raise ControlChannelError(f"TCP auth failed: {ack.get('error')}")

    # -- framing ----------------------------------------------------------
    def _roundtrip(self, frame: dict[str, Any]) -> dict[str, Any]:
        self.sock.sendall((json.dumps(frame) + "\n").encode("utf-8"))
        line = self.reader.readline()
        if not line:
            raise ControlChannelError("the control channel closed the socket")
        reply = json.loads(line)
        if not isinstance(reply, dict):
            raise ControlChannelError("the control channel sent a malformed frame")
        return reply

    def _call(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self._rid += 1
        reply = self._roundtrip(
            {
                "id": self._rid,
                "method": method,
                "params": params,
            }
        )
        if not reply.get("ok"):
            raise ControlChannelError(str(reply.get("error", "unknown error")))
        return reply

    # -- methods ----------------------------------------------------------
    def execute(self, command_id: str, params: dict[str, Any] | None = None) -> Any:
        """Run one registry command in the running application."""
        reply = self._call(
            "engine.execute",
            {"command": command_id, "params": params or {}},
        )
        return reply.get("result")

    def screenshot(self, path: str) -> Any:
        """Capture the application window to ``path``."""
        reply = self._call("ui.screenshot", {"path": path})
        return reply.get("result")

    def close(self) -> None:
        try:
            self.reader.close()
        finally:
            self.sock.close()


def main() -> int:
    token = os.environ["PHOTOCRAFT_TOKEN"]
    client = CraftLiveClient(
        port=int(os.environ.get("CONTROL_PORT", "7979")),
        token=token,
    )
    try:
        # Ask the running application where the campaign currently is.
        state = client.execute("session.inspect")
        print(json.dumps(state, indent=2, sort_keys=True))
        # Capture the current window so an operator can eyeball the
        # composite.
        shot = client.screenshot(
            os.environ.get("APPROVAL_SNAPSHOT", "approval-snapshot.png")
        )
        print(f"approval snapshot at {shot}", file=sys.stderr)
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
