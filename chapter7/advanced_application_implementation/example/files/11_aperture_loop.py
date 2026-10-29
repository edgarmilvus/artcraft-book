# ─── aperture_loop.py ────────────────────────────────────────────────────────
"""Aperture QA — the same closed loop, driven from Python.

Talks to the PhotoCraft control channel: newline-delimited JSON over a
loopback TCP socket, authenticated by the first frame. Every reply is
{"ok": bool, "result": ...} or {"ok": false, "error": "..."}.
"""

from __future__ import annotations

import json
import os
import socket
from typing import Any, Protocol

CHANNELS = {
    "shopify_hero": (2048, 1024),
    "instagram_story": (1080, 1920),
    "amazon_a_plus": (1464, 600),
    "print_a4": (2480, 3508),
}

AUDIT_PROMPT = """You are a senior art director auditing an e-commerce render.
Reply ONLY with JSON:
{"verdict": "pass" | "revise" | "escalate",
 "confidence": 0.0..1.0,
 "findings": [{"axis": "exposure|color|composition|typography|artifacts|brand|geometry",
               "severity": "info|warn|block", "message": "..."}],
 "corrections": [{"command": "warm_up|cool_down|add_contrast|lift_shadows|recover_highlights",
                  "params": {}}]}"""


class Vision(Protocol):
    """Anything that can audit a base64 PNG: OpenAI, a local VLM, a fake."""

    def audit(self, png_b64: str, prompt: str) -> dict[str, Any]: ...


class OpenAIVision:
    """Adapter over the official SDK, imported lazily so this module
    stays importable on a machine without the `openai` package."""

    def __init__(self, model: str = "gpt-4o") -> None:
        from openai import OpenAI  # local import: optional dependency

        self._client = OpenAI()
        self._model = model

    def audit(self, png_b64: str, prompt: str) -> dict[str, Any]:
        reply = self._client.chat.completions.create(
            model=self._model,
            temperature=0.15,
            response_format={"type": "json_object"},
            messages=[{
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url",
                     "image_url": {"url": f"data:image/png;base64,{png_b64}",
                                   "detail": "high"}},
                ],
            }],
        )
        return json.loads(reply.choices[0].message.content)


class ApertureSocket:
    """Authenticated loopback client for the PhotoCraft control channel."""

    def __init__(self, host: str = "127.0.0.1", port: int = 7979,
                 token: str | None = None) -> None:
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.connect((host, port))
        self.reader = self.sock.makefile("r")
        self._id = 0
        # MANDATORY: first frame must be the auth handshake.
        if token is None:
            token = os.environ.get("PHOTOCRAFT_TOKEN", "")
        auth = json.dumps({"id": "auth", "method": "auth",
                           "params": {"token": token}})
        self.sock.sendall((auth + "\n").encode())
        reply = json.loads(self.reader.readline())
        if not reply.get("ok"):
            raise ConnectionRefusedError(f"TCP auth failed: {reply.get('error')}")

    def call(self, method: str, params: dict[str, Any]) -> Any:
        self._id += 1
        payload = json.dumps({"id": self._id, "method": method, "params": params})
        self.sock.sendall((payload + "\n").encode())
        line = self.reader.readline()
        if not line:
            raise ConnectionError("control channel closed the connection")
        reply = json.loads(line)
        if not reply.get("ok"):
            raise RuntimeError(f"{method}: {reply.get('error')}")
        return reply.get("result")

    def close(self) -> None:
        try:
            self.reader.close()
            self.sock.close()
        except OSError:
            pass


def apply_batch(client: ApertureSocket, steps: list[dict[str, Any]]) -> dict[str, int]:
    """Run a batch and compensate a partial failure.

    The engine stops at the first rejected step but keeps the steps that
    already landed. Undoing that prefix restores all-or-nothing behaviour.
    """
    if not steps:
        return {"completed": 0, "failed": 0, "undone": 0}
    result = client.call("engine.batch",
                         {"steps": steps, "stop_on_error": True})
    completed = int(result.get("completed", 0))
    failed = int(result.get("failed", 0))
    if failed:
        client.call("history.undo", {"steps": completed})
        return {"completed": 0, "failed": failed, "undone": completed}
    return {"completed": completed, "failed": 0, "undone": 0}


def apply_base_edit(client: ApertureSocket, brief: dict[str, Any]) -> dict[str, int]:
    width, height = CHANNELS[brief["channelProfile"]]
    steps = [
        {"id": "image.crop",
         "params": {"x": 0, "y": 0, "width": width, "height": height,
                    "deleteCroppedPixels": False}},
        {"id": "image.imageSize",
         "params": {"width": width, "height": height,
                    "resample": "bicubicSharper"}},
        {"id": "layer.newAdjustmentLayer.curves",
         "params": {"points": [[0, 0], [64, 52], [192, 208], [255, 255]]}},
    ]
    return apply_batch(client, steps)


SUGGESTIONS = {
    "warm_up": ("color", "layer.newAdjustmentLayer.photoFilter",
                {"filter": "warming81", "density": 12, "preserveLuminosity": True}),
    "cool_down": ("color", "layer.newAdjustmentLayer.photoFilter",
                  {"filter": "cooling80", "density": 12, "preserveLuminosity": True}),
    "add_contrast": ("exposure", "layer.newAdjustmentLayer.brightnessContrast",
                     {"brightness": 0, "contrast": 10, "legacy": False}),
    "lift_shadows": ("exposure", "layer.newAdjustmentLayer.curves",
                     {"points": [[0, 14], [64, 72], [192, 192], [255, 255]]}),
    "recover_highlights": ("exposure", "layer.newAdjustmentLayer.levels",
                           {"inBlack": 0, "gamma": 1, "inWhite": 244}),
}


def compile_from_critique(critique: dict[str, Any], brief: dict[str, Any],
                          doc: tuple[int, int]) -> list[dict[str, Any]]:
    """Deterministic translation: findings → registry commands."""
    width, height = doc
    steps: list[dict[str, Any]] = []
    covered: set[str] = set()

    for suggestion in critique.get("corrections", []):
        mapped = SUGGESTIONS.get(str(suggestion.get("command", "")).lower())
        if mapped:
            axis, command, params = mapped
            steps.append({"id": command, "params": dict(params)})
            covered.add(axis)

    for finding in critique.get("findings", []):
        if finding.get("severity") not in ("warn", "block"):
            continue
        axis = finding.get("axis")
        if axis in covered:
            continue
        covered.add(str(axis))
        message = str(finding.get("message", "")).lower()
        if axis == "exposure" and "highlight" in message:
            steps.append({"id": "layer.newAdjustmentLayer.levels",
                          "params": {"inWhite": 244, "gamma": 1}})
        elif axis == "exposure":
            steps.append({"id": "layer.newAdjustmentLayer.brightnessContrast",
                          "params": {"brightness": 4, "contrast": 6,
                                     "legacy": False}})
        elif axis == "color":
            steps.append({"id": "layer.newAdjustmentLayer.vibrance",
                          "params": {"vibrance": 10, "saturation": 0}})
        elif axis == "composition":
            steps.append({"id": "image.crop",
                          "params": {"x": round(width * 0.02),
                                     "y": round(height * 0.02),
                                     "width": round(width * 0.96),
                                     "height": round(height * 0.96),
                                     "deleteCroppedPixels": False}})
    # Collapse duplicates so two findings cannot double the same correction.
    unique: dict[str, dict[str, Any]] = {}
    for step in steps:
        unique[json.dumps(step, sort_keys=True)] = step
    return list(unique.values())


def audit_pass(client: ApertureSocket, vision: Vision,
               brief: dict[str, Any], cycle: int,
               doc: tuple[int, int]) -> dict[str, Any]:
    """One full cycle: render → audit → compile → apply."""
    preview = client.call("doc.render_preview", {"max_side": 1536})
    critique = vision.audit(preview["image"], AUDIT_PROMPT)

    steps = compile_from_critique(critique, brief, doc)
    if critique.get("verdict") == "revise" and not steps:
        steps = [{"id": "layer.newAdjustmentLayer.brightnessContrast",
                  "params": {"brightness": 0, "contrast": 4, "legacy": False}}]

    applied = apply_batch(client, steps)
    return {"cycle": cycle, "critique": critique, **applied}


def run(brief: dict[str, Any], vision: Vision, *,
        port: int = 7979, token: str | None = None) -> dict[str, Any]:
    """Full Max-Iteration-Policy loop."""
    width, height = CHANNELS[brief["channelProfile"]]
    client = ApertureSocket(port=port, token=token)
    history: list[dict[str, Any]] = []
    try:
        base = apply_base_edit(client, brief)
        if base["failed"]:
            return {"outcome": "base-edit-failed", "history": history}

        for cycle in range(int(brief["maxCycles"])):
            result = audit_pass(client, vision, brief, cycle, (width, height))
            history.append(result)
            critique = result["critique"]

            if result["failed"]:
                client.call("doc.save", {"path": brief["targetPath"]})
                return {"outcome": "rolled-back-then-escalated",
                        "history": history}

            if critique.get("verdict") == "escalate":
                client.call("doc.save", {"path": brief["targetPath"]})
                return {"outcome": "escalated", "history": history}

            confidence = float(critique.get("confidence", 0))
            if confidence < float(brief["confidenceFloor"]):
                client.call("doc.save", {"path": brief["targetPath"]})
                return {"outcome": "escalated", "history": history}

            if critique.get("verdict") == "pass":
                client.call("doc.save", {"path": brief["targetPath"]})
                return {"outcome": "accepted", "history": history}

        client.call("doc.save", {"path": brief["targetPath"]})
        return {"outcome": "max-cycles", "history": history}
    finally:
        client.close()
