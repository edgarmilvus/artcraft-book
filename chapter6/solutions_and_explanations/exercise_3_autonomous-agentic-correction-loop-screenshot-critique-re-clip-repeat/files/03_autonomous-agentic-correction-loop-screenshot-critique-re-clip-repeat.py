# art_director.py
# TCP control-channel client with mandatory auth, a bounded vision-in-the-loop
# correction loop, and a full audit trail per iteration.
#
# The channel is the desktop app's authenticated loopback protocol:
#
#   {"id": "auth", "method": "auth", "params": {"token": "<64 hex>"}}
#   {"id": 1, "method": "engine.execute", "params": {"command": ..., "params": {...}}}
#
# Every reply is one JSON line: {"id": ..., "ok": true, "result": ...} or
# {"id": ..., "ok": false, "error": "..."}.

import base64
import hashlib
import json
import socket
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional, Protocol

import jsonschema


# ---------------------------------------------------------------------------
# 1. TCP client. The auth frame is *the first frame* on the socket; the server
#    dispatches nothing before it succeeds. A refusal is raised here, before any
#    command is sent, so a misconfigured token never looks like a slow render.
# ---------------------------------------------------------------------------
class ControlError(RuntimeError):
    """A well-formed request the server refused (`ok: false`)."""


class CraftControlClient:
    def __init__(self, host: str = "127.0.0.1", port: int = 7979,
                 token: Optional[str] = None, timeout: float = 60.0):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.reader = self.sock.makefile("r")
        self._req = 0
        if token:
            try:
                reply = self._rpc("auth", {"token": token}, _id="auth")
            except ControlError as exc:
                raise ConnectionRefusedError(str(exc)) from exc
            if not reply.get("authenticated"):
                raise ConnectionRefusedError("the control channel did not confirm the token")

    def close(self) -> None:
        try:
            self.reader.close()
        finally:
            self.sock.close()

    def _rpc(self, method: str, params: dict, _id: Any = None) -> dict:
        self._req += 1
        frame = {"id": self._req if _id is None else _id, "method": method, "params": params}
        self.sock.sendall((json.dumps(frame) + "\n").encode("utf-8"))
        line = self.reader.readline()
        if not line:
            raise ConnectionError("the control channel closed the connection")
        reply = json.loads(line)
        if not reply.get("ok"):
            raise ControlError(reply.get("error", "unspecified control error"))
        return reply.get("result") or {}

    # -- engine ------------------------------------------------------------
    def execute(self, command_id: str, params: Optional[dict] = None) -> Any:
        """Run one registry command. Each command is one undo step."""
        return self._rpc("engine.execute", {"command": command_id, "params": params or {}})

    def inspect(self) -> dict:
        return self.execute("document.inspect", {})

    def history_depth(self) -> int:
        """Number of history states; a command's undo cost is its delta."""
        return len(self.inspect().get("history") or [])

    def undo(self) -> None:
        self.execute("edit.undo", {})

    # -- documents and pixels ---------------------------------------------
    def save_png(self, path: str) -> dict:
        """Render the active document to a PNG under the automation write root."""
        return self._rpc("app.save", {"path": path})

    def screenshot(self, path: str, focus: bool = True) -> dict:
        """Capture the application window (PNG) under the automation write root."""
        return self._rpc("ui.screenshot", {"path": path, "focus": focus})


# ---------------------------------------------------------------------------
# 2. The critique schema. This is the *only* shape the vision model may return.
#    Anything else is a protocol violation and stops the loop.
# ---------------------------------------------------------------------------
CRITIQUE_SCHEMA = {
    "type": "object",
    "required": ["verdict", "issues"],
    "additionalProperties": False,
    "properties": {
        "verdict": {"enum": ["ok", "fix"]},
        "issues": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["kind", "severity", "hint", "region"],
                "additionalProperties": False,
                "properties": {
                    "kind": {"enum": ["clipping", "legibility", "palette", "composition"]},
                    "severity": {"type": "number", "minimum": 0, "maximum": 1},
                    "hint": {"type": "string"},
                    "region": {
                        "type": "array", "minItems": 4, "maxItems": 4,
                        "items": {"type": "number"},
                    },
                },
            },
        },
    },
}


# ---------------------------------------------------------------------------
# 3. The vision model is injected. The loop only needs `critique(png_bytes)`.
#    The OpenAI adapter imports its SDK lazily so the loop, the audit trail and
#    the tests run without a provider at all.
# ---------------------------------------------------------------------------
class VisionModel(Protocol):
    def critique(self, png: bytes) -> dict: ...


CRITIQUE_PROMPT = (
    "You are an art director auditing a banner. Return STRICT JSON ONLY, "
    "no prose, matching this shape: "
    '{"verdict":"ok"|"fix","issues":[{"kind":"clipping"|"legibility"|"palette"|"composition",'
    '"severity":0..1,"hint":"...","region":[x0,y0,x1,y1]}]}. '
    'If the banner is fine, return {"verdict":"ok","issues":[]}.'
)


class OpenAIVisionModel:
    """Adapter for the OpenAI chat-completions API with a JSON response format."""

    def __init__(self, model: str = "gpt-4o") -> None:
        from openai import OpenAI  # lazy: only the live adapter needs the SDK
        self._client = OpenAI()
        self._model = model

    def critique(self, png: bytes) -> dict:
        b64 = base64.b64encode(png).decode("ascii")
        reply = self._client.chat.completions.create(
            model=self._model,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "text", "text": CRITIQUE_PROMPT},
                    {"type": "image_url",
                     "image_url": {"url": f"data:image/png;base64,{b64}"}},
                ],
            }],
            response_format={"type": "json_object"},
        )
        return json.loads(reply.choices[0].message.content)


# ---------------------------------------------------------------------------
# 4. Per-iteration audit record. This is the *only* artifact a human reviewer
#    needs to reconstruct the agent's reasoning.
# ---------------------------------------------------------------------------
@dataclass
class IterationRecord:
    iteration: int
    preview_path: str
    window_path: str
    critique: dict
    commands_applied: list[dict]
    undo_cost: int          # history states the corrections actually added
    history_before: int
    history_after: int
    note: Optional[str] = None   # e.g. "corrections changed nothing"


# ---------------------------------------------------------------------------
# 5. Bounded correction table. Every correction is a pure function of the issue
#    and the run context: it applies its commands and returns them for the audit
#    trail. No correction moves geometry more than 5% of the canvas side.
# ---------------------------------------------------------------------------
CANVAS_SIDE = 1920
MAX_MOVE_PX = int(0.05 * CANVAS_SIDE)   # 96 px


def correct_clipping(client: CraftControlClient, issue: dict, ctx: dict) -> list[dict]:
    # Reset the clip: release, then re-create so the product clips to whatever
    # is directly below it. `layer.createClippingMask` takes only `layer`; the
    # clip base is positional, which is why the release comes first.
    commands = [
        {"id": "layer.releaseClippingMask", "params": {"layer": ctx["productId"]}},
        {"id": "layer.createClippingMask", "params": {"layer": ctx["productId"]}},
    ]
    for command in commands:
        client.execute(command["id"], command["params"])
    return commands


def correct_legibility(client: CraftControlClient, issue: dict, ctx: dict) -> list[dict]:
    # A scrim confined to the reported region: the marquee becomes the fill
    # layer's mask, so no transform is needed and the region is honoured
    # exactly. The scrim sits directly below the price group.
    x0, y0, x1, y1 = issue["region"]
    commands = [
        {"id": "select.rect", "params": {
            "x": int(x0), "y": int(y0),
            "width": max(1, int(x1) - int(x0)),
            "height": max(1, int(y1) - int(y0)),
            "mode": "replace",
        }},
        {"id": "layer.newFillLayer.solidColor", "params": {"color": "#111111"}},
    ]
    for command in commands:
        client.execute(command["id"], command["params"])

    scrim = client.inspect()["layers"][0]["id"]   # the fill layer is on top
    commands += [
        {"id": "layer.setProps", "params": {
            "layer": scrim, "name": "LegibilityScrim::Price",
            "opacity": 0.35, "blend": "Normal",
        }},
        {"id": "layer.moveTo", "params": {
            "layer": scrim, "target": ctx["priceGroupId"], "position": "below",
        }},
        {"id": "select.deselect", "params": {}},
    ]
    for command in commands[2:]:
        client.execute(command["id"], command["params"])
    return commands


def correct_palette(client: CraftControlClient, issue: dict, ctx: dict) -> list[dict]:
    # One vibrance layer, edited in place: stacking a new adjustment layer per
    # iteration would compound saturation instead of converging on a value.
    delta = 6 if issue["severity"] > 0.5 else 3
    ctx["saturation"] = max(-100, min(100, ctx.get("saturation", 0) + delta))
    params = {"hue": 0, "saturation": ctx["saturation"], "lightness": 0, "colorize": False}

    if ctx.get("saturationLayerId") is None:
        created = client.execute("layer.newAdjustmentLayer.hueSaturation", params)
        ctx["saturationLayerId"] = created["layer"]
        command = {"id": "layer.newAdjustmentLayer.hueSaturation", "params": params}
    else:
        params["layer"] = ctx["saturationLayerId"]
        client.execute("layer.setAdjustment", params)
        command = {"id": "layer.setAdjustment", "params": params}
    return [command]


def correct_composition(client: CraftControlClient, issue: dict, ctx: dict) -> list[dict]:
    # Nudge the product group; magnitude strictly bounded to ±MAX_MOVE_PX.
    x0, y0, x1, y1 = issue["region"]
    dx = max(-MAX_MOVE_PX, min(MAX_MOVE_PX, int(x1 - x0) // 4))
    dy = max(-MAX_MOVE_PX, min(MAX_MOVE_PX, int(y1 - y0) // 4))
    params = {"layer": ctx["productGroupId"], "dx": dx, "dy": dy, "target": "pixels"}
    client.execute("layer.translate", params)
    return [{"id": "layer.translate", "params": params}]


CORRECTIONS: dict[str, Callable[[CraftControlClient, dict, dict], list[dict]]] = {
    "clipping": correct_clipping,
    "legibility": correct_legibility,
    "palette": correct_palette,
    "composition": correct_composition,
}


# ---------------------------------------------------------------------------
# 6. The loop. Every iteration writes a PNG and a JSON. On any terminal failure
#    the corrections applied since the first iteration are undone exactly: the
#    count comes from the document's own history depth, never from a guess.
# ---------------------------------------------------------------------------
def art_director_loop(
    client: CraftControlClient,
    vision: VisionModel,
    ctx: dict,
    audit_dir: Path,
    max_iterations: int = 4,
) -> dict:
    audit_dir.mkdir(parents=True, exist_ok=True)
    records: list[IterationRecord] = []
    applied_since_start = 0
    previous_critique: Optional[str] = None

    try:
        for n in range(1, max_iterations + 1):
            # (1) Render the document and capture the live window. Both files
            #     are written by the server under the automation write root.
            preview_path = audit_dir / f"iter-{n}.png"
            window_path = audit_dir / f"iter-{n}-window.png"
            client.save_png(str(preview_path))
            client.screenshot(str(window_path))
            png = preview_path.read_bytes()

            # (2) Ask the vision model for a structured critique.
            critique = vision.critique(png)
            jsonschema.validate(critique, CRITIQUE_SCHEMA)

            # A critique that repeats verbatim means the previous correction did
            # not move the picture: another identical pass would only burn undo
            # steps, so the loop stops and reports the deadlock.
            fingerprint = hashlib.sha256(
                json.dumps(critique, sort_keys=True).encode()
            ).hexdigest()
            if fingerprint == previous_critique:
                records.append(IterationRecord(
                    iteration=n, preview_path=str(preview_path),
                    window_path=str(window_path), critique=critique,
                    commands_applied=[], undo_cost=0,
                    history_before=client.history_depth(),
                    history_after=client.history_depth(),
                    note="the critique repeated; the loop stopped instead of re-applying it",
                ))
                return _finish(client, audit_dir, records, resolved=False,
                               error="the critique did not change after a correction",
                               undo_steps=applied_since_start)
            previous_critique = fingerprint

            if critique["verdict"] == "ok":
                records.append(IterationRecord(
                    iteration=n, preview_path=str(preview_path),
                    window_path=str(window_path), critique=critique,
                    commands_applied=[], undo_cost=0,
                    history_before=client.history_depth(),
                    history_after=client.history_depth(),
                ))
                return _finish(client, audit_dir, records, resolved=True,
                               undo_steps=0)

            # (3) Apply corrections in order of decreasing severity.
            before = client.history_depth()
            applied: list[dict] = []
            for issue in sorted(critique["issues"], key=lambda i: -i["severity"]):
                applied.extend(CORRECTIONS[issue["kind"]](client, issue, ctx))
            after = client.history_depth()
            cost = max(0, after - before)
            applied_since_start += cost

            records.append(IterationRecord(
                iteration=n, preview_path=str(preview_path),
                window_path=str(window_path), critique=critique,
                commands_applied=applied, undo_cost=cost,
                history_before=before, history_after=after,
                note=None if cost else "corrections changed nothing",
            ))

        # Cap reached without an ok verdict: undo everything and report.
        return _finish(client, audit_dir, records, resolved=False,
                       error=f"iteration cap of {max_iterations} reached",
                       undo_steps=applied_since_start)

    except Exception as exc:  # noqa: BLE001 — the audit trail is the point
        return _finish(client, audit_dir, records, resolved=False,
                       error=f"{type(exc).__name__}: {exc}",
                       undo_steps=applied_since_start)


def _rollback(client: CraftControlClient, steps: int) -> int:
    """Undo `steps` history states; returns how many were actually undone."""
    undone = 0
    for _ in range(steps):
        if not client.inspect().get("canUndo", False):
            break
        client.undo()
        undone += 1
    return undone


def _finish(client: CraftControlClient, audit_dir: Path, records: list[IterationRecord],
            resolved: bool, undo_steps: int, error: Optional[str] = None) -> dict:
    undone = _rollback(client, undo_steps) if not resolved else 0

    for record in records:
        (audit_dir / f"iter-{record.iteration}.json").write_text(
            json.dumps(asdict(record), indent=2)
        )
    summary = {
        "resolved": resolved,
        "iterations": len(records),
        "undoStepsPlanned": 0 if resolved else undo_steps,
        "undoStepsApplied": undone,
        "error": error,
        "decisionTree": _decision_tree_prose(records),
    }
    (audit_dir / "summary.json").write_text(json.dumps(summary, indent=2))
    return summary


def _decision_tree_prose(records: list[IterationRecord]) -> list[str]:
    """Machine-readable-but-prose decision tree for the human reviewer."""
    lines: list[str] = []
    for record in records:
        if record.critique["verdict"] == "ok":
            lines.append(f"iter {record.iteration}: verdict ok — stopping")
            continue
        for issue in record.critique["issues"]:
            lines.append(
                f"iter {record.iteration}: {issue['kind']} "
                f"(severity {issue['severity']:.2f}) → corrected, "
                f"{record.undo_cost} undo step(s)"
            )
    return lines
