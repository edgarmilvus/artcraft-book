#!/usr/bin/env python3
"""run_python_loop.py — harness for the Python aperture loop.

Starts an in-process stub of the PhotoCraft control channel on an
ephemeral port, then drives `aperture_loop.run` against it. No engine,
no provider key, no network beyond loopback.

Run: python3 run_python_loop.py
"""

from __future__ import annotations

import importlib.util
import json
import socket
import threading
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("aperture_loop", HERE / "11_aperture_loop.py")
assert spec and spec.loader
loop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(loop)

TOKEN = "test-token"
PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQ"
    "DwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)

assertions = 0


def check(label: str, condition: bool) -> None:
    global assertions
    if not condition:
        raise AssertionError(label)
    assertions += 1
    print(f"PASS {label}")


def equal(label: str, actual: Any, expected: Any) -> None:
    check(f"{label} (expected {expected!r}, got {actual!r})" if actual != expected else label,
          actual == expected)


class StubChannel:
    """The control channel as the Python client expects it."""

    def __init__(self) -> None:
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(8)
        self.port = self.sock.getsockname()[1]
        self.stats = {"batches": 0, "undone": 0, "saves": [], "previews": 0}
        self._lock = threading.Lock()
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self) -> None:
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    @staticmethod
    def _send(conn: socket.socket, payload: dict[str, Any]) -> None:
        conn.sendall((json.dumps(payload) + "\n").encode())

    def _handle(self, conn: socket.socket) -> None:
        reader = conn.makefile("r")
        authed = False
        try:
            for line in reader:
                request = json.loads(line)
                method = request.get("method")
                params = request.get("params") or {}

                if not authed:
                    if method != "auth":
                        self._send(conn, {"ok": False, "error": "auth required first"})
                        return
                    if params.get("token") != TOKEN:
                        self._send(conn, {"ok": False, "error": "bad token"})
                        return
                    authed = True
                    self._send(conn, {"ok": True, "result": {"ok": True}})
                    continue

                if method == "doc.render_preview":
                    with self._lock:
                        self.stats["previews"] += 1
                    self._send(conn, {"ok": True, "result": {"image": PNG_B64}})
                elif method == "engine.batch":
                    steps = params.get("steps") or []
                    completed = 0
                    failed = 0
                    results: list[dict[str, Any]] = []
                    for step in steps:
                        if step.get("id") == "layer.newAdjustmentLayer.levels":
                            failed = 1
                            results.append({"ok": False, "error": "synthetic levels failure"})
                            break
                        completed += 1
                        results.append({"ok": True})
                    with self._lock:
                        self.stats["batches"] += 1
                    self._send(conn, {"ok": True, "result": {
                        "completed": completed, "failed": failed, "results": results,
                    }})
                elif method == "history.undo":
                    with self._lock:
                        self.stats["undone"] += int(params.get("steps", 0))
                    self._send(conn, {"ok": True, "result": {}})
                elif method == "doc.save":
                    with self._lock:
                        self.stats["saves"].append(params.get("path"))
                    self._send(conn, {"ok": True, "result": {
                        "path": params.get("path"), "warnings": [],
                    }})
                else:
                    self._send(conn, {"ok": False, "error": f"unknown method {method}"})
        finally:
            reader.close()
            conn.close()

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass


class ScriptedVision:
    def __init__(self, verdicts: list[dict[str, Any]]) -> None:
        self.pending = list(verdicts)
        self.calls = 0

    def audit(self, png_b64: str, prompt: str) -> dict[str, Any]:
        assert png_b64.startswith("iVBORw0KGgo"), "expected a base64 PNG"
        assert "JSON" in prompt
        self.calls += 1
        if not self.pending:
            raise AssertionError("scripted vision ran out of verdicts")
        return self.pending.pop(0)


def critique(verdict: str = "revise", confidence: float = 0.8,
             findings: list[dict[str, Any]] | None = None,
             corrections: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {
        "verdict": verdict,
        "confidence": confidence,
        "findings": findings or [],
        "corrections": corrections or [],
    }


def brief(target: str, *, max_cycles: int = 3, floor: float = 0.62) -> dict[str, Any]:
    return {
        "jobId": "00000000-0000-4000-8000-000000000000",
        "sourcePath": "input/hero.png",
        "targetPath": target,
        "channelProfile": "shopify_hero",
        "brandKit": {"primaryHex": "#3366cc", "forbiddenHex": [], "tone": "editorial_clean"},
        "maxCycles": max_cycles,
        "confidenceFloor": floor,
    }


def test_units() -> None:
    steps = loop.compile_from_critique(
        critique(corrections=[{"command": "cool_down", "params": {}}],
                 findings=[{"axis": "color", "severity": "warn", "message": "warm cast"}]),
        brief("output/x.jpg"),
        (2048, 1024),
    )
    equal("compiler: one step for one suggestion", len(steps), 1)
    equal("compiler: cool_down maps to photoFilter", steps[0]["id"], "layer.newAdjustmentLayer.photoFilter")
    equal("compiler: cooling filter selected", steps[0]["params"]["filter"], "cooling80")

    composition = loop.compile_from_critique(
        critique(findings=[{"axis": "composition", "severity": "warn",
                            "message": "loose framing"}]),
        brief("output/x.jpg"),
        (1000, 500),
    )
    equal("compiler: composition crops to 96 %", composition[0]["params"]["width"], 960)

    advisory = loop.compile_from_critique(
        critique(findings=[{"axis": "color", "severity": "info", "message": "polish"}]),
        brief("output/x.jpg"),
        (1000, 500),
    )
    equal("compiler: info findings compile nothing", advisory, [])


def test_auth_failure(server: StubChannel) -> None:
    try:
        loop.ApertureSocket(port=server.port, token="wrong")
    except ConnectionRefusedError as err:
        check("auth: wrong token is refused", "bad token" in str(err))
    else:
        raise AssertionError("auth: wrong token was accepted")


def test_accept(server: StubChannel) -> None:
    vision = ScriptedVision([critique(verdict="pass", confidence=0.9)])
    result = loop.run(brief("output/py-accept.jpg"), vision,
                      port=server.port, token=TOKEN)
    equal("accept: outcome", result["outcome"], "accepted")
    equal("accept: one cycle", len(result["history"]), 1)
    equal("accept: nothing applied", result["history"][0]["completed"], 0)
    equal("accept: base edit applied", server.stats["batches"] >= 1, True)
    check("accept: artifact was saved", "output/py-accept.jpg" in server.stats["saves"])


def test_revise_then_pass(server: StubChannel) -> None:
    vision = ScriptedVision([
        critique(findings=[{"axis": "exposure", "severity": "warn",
                            "message": "muddy midtones"}]),
        critique(verdict="pass", confidence=0.88),
    ])
    result = loop.run(brief("output/py-revise.jpg"), vision,
                      port=server.port, token=TOKEN)
    equal("revise: outcome", result["outcome"], "accepted")
    equal("revise: two cycles", len(result["history"]), 2)
    equal("revise: first cycle applied one step", result["history"][0]["completed"], 1)
    equal("revise: second cycle applied nothing", result["history"][1]["completed"], 0)
    equal("revise: vision saw two frames", vision.calls, 2)


def test_batch_failure(server: StubChannel) -> None:
    before = server.stats["undone"]
    vision = ScriptedVision([
        critique(findings=[
            {"axis": "color", "severity": "warn", "message": "flat colour"},
            {"axis": "exposure", "severity": "warn", "message": "highlight clipping"},
        ]),
    ])
    result = loop.run(brief("output/py-failed.jpg"), vision,
                      port=server.port, token=TOKEN)
    equal("batch: outcome", result["outcome"], "rolled-back-then-escalated")
    equal("batch: nothing reported as applied", result["history"][0]["completed"], 0)
    equal("batch: the failing step is reported", result["history"][0]["failed"], 1)
    equal("batch: the applied prefix was undone", result["history"][0]["undone"], 1)
    equal("batch: server saw the undo", server.stats["undone"] - before, 1)
    check("batch: the document is still saved", "output/py-failed.jpg" in server.stats["saves"])


def test_max_cycles(server: StubChannel) -> None:
    vision = ScriptedVision([
        critique(findings=[{"axis": "exposure", "severity": "warn", "message": "muddy"}]),
        critique(findings=[{"axis": "exposure", "severity": "warn", "message": "still muddy"}]),
    ])
    result = loop.run(brief("output/py-cap.jpg", max_cycles=2), vision,
                      port=server.port, token=TOKEN)
    equal("cap: outcome", result["outcome"], "max-cycles")
    equal("cap: both cycles ran", len(result["history"]), 2)


def test_confidence_floor(server: StubChannel) -> None:
    vision = ScriptedVision([critique(verdict="pass", confidence=0.2)])
    result = loop.run(brief("output/py-floor.jpg"), vision,
                      port=server.port, token=TOKEN)
    equal("floor: outcome", result["outcome"], "escalated")


def test_model_escalation(server: StubChannel) -> None:
    vision = ScriptedVision([critique(verdict="escalate", confidence=0.9)])
    result = loop.run(brief("output/py-escalate.jpg"), vision,
                      port=server.port, token=TOKEN)
    equal("escalate: outcome", result["outcome"], "escalated")
    equal("escalate: no correction was applied", result["history"][0]["completed"], 0)


def main() -> None:
    server = StubChannel()
    try:
        test_units()
        test_auth_failure(server)
        test_accept(server)
        test_revise_then_pass(server)
        test_batch_failure(server)
        test_max_cycles(server)
        test_confidence_floor(server)
        test_model_escalation(server)
    finally:
        server.close()
    print(f"\n{assertions} assertions passed")


if __name__ == "__main__":
    main()
