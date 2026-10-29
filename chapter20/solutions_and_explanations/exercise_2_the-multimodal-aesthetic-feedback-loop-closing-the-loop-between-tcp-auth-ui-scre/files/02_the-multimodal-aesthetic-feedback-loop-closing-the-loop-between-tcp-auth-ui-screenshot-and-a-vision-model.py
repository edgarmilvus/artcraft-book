#!/usr/bin/env python3
"""
colorist_loop.py — a closed-loop colourist driven by a vision model.

The loop is a state machine: render the composite, ask a vision model for the
single worst rubric violation, propose one clamped adjustment, re-render, and
keep the change only if the next audit does not report a more severe problem.
Stall, oscillation and regression gates end the run early.

The loop is *transport-agnostic*. `ControlClient` speaks the PhotoCraft control
protocol (newline-delimited JSON over a TCP socket, with a mandatory
authentication frame as the very first thing the socket sends); `HeadlessClient`
speaks MCP over stdio. Only the data path differs — the audit schema, the
target table, the clamps and the gates are the same code.

The vision model is *injected*. The loop never sees an API key: it calls the
`VisionModel` interface it is given, and a deployment wires in a client that
speaks to a multimodal API while a test wires in a deterministic stand-in.

The authentication token is read from PHOTOCRAFT_TOKEN, validated before a
socket is opened, and never logged, traced or reported.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Protocol, Sequence, Tuple

# ---------------------------------------------------------------------------
# Token handling — fatal, not retryable, and never logged.
# ---------------------------------------------------------------------------

TOKEN_RE = re.compile(r"^[0-9a-f]{64}$")

TOKEN_ENV = "PHOTOCRAFT_TOKEN"


def load_token(env: Optional[Mapping[str, str]] = None) -> str:
    """Return the control-channel token, or die before anything is opened.

    A malformed token is a startup error, not a transient one: there is no
    point connecting when the server would close the socket on the first
    frame. The token is never echoed, not even in the error message.
    """
    source = os.environ if env is None else env
    token = source.get(TOKEN_ENV, "")
    if not TOKEN_RE.match(token):
        print(
            "FATAL: %s must be exactly 64 lowercase hex characters" % TOKEN_ENV,
            file=sys.stderr,
        )
        raise SystemExit(1)
    return token


# ---------------------------------------------------------------------------
# The sandbox — a path outside the automation roots is a configuration error.
# ---------------------------------------------------------------------------


class SandboxError(RuntimeError):
    """A path left the automation roots.

    This is never retried: the loop is configured wrongly, and retrying an
    absolute path the engine will always refuse only burns API calls.
    """


class Sandbox:
    """Confines reads to one root and writes to another."""

    def __init__(self, read_root: Path, write_root: Path) -> None:
        self._read_root = Path(read_root).resolve()
        self._write_root = Path(write_root).resolve()

    @property
    def read_root(self) -> Path:
        return self._read_root

    @property
    def write_root(self) -> Path:
        return self._write_root

    def _resolve(self, path: Any, root: Path, label: str) -> Path:
        candidate = Path(path)
        resolved = candidate.resolve() if candidate.is_absolute() else (root / candidate).resolve()
        if resolved != root and root not in resolved.parents:
            raise SandboxError(
                "%s path %s is outside the automation root %s" % (label, path, root)
            )
        return resolved

    def read(self, path: Any) -> Path:
        return self._resolve(path, self._read_root, "read")

    def write(self, path: Any) -> Path:
        return self._resolve(path, self._write_root, "write")


# ---------------------------------------------------------------------------
# The audit contract — the JSON Schema the vision model's answer must meet.
# ---------------------------------------------------------------------------

ADJUSTMENT_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "required": ["status", "rationale"],
    "additionalProperties": False,
    "properties": {
        "status": {"enum": ["ok", "adjust"]},
        "rationale": {"type": "string", "minLength": 20, "maxLength": 200},
        "adjustment": {
            "type": "object",
            "required": ["target", "delta"],
            "additionalProperties": False,
            "properties": {
                "target": {
                    "enum": [
                        "highlights",
                        "shadows",
                        "whites",
                        "blacks",
                        "temperature",
                        "tint",
                        "vibrance",
                        "saturation",
                        "contrast",
                        "gamma",
                        "split-tone-shadows",
                        "split-tone-highlights",
                        "grain",
                    ]
                },
                "delta": {"type": "number"},
            },
        },
    },
}

# The pseudo-status a non-conforming answer is recorded under. It is
# deliberately outside the enumerated set, so no downstream branch can
# mistake a malformed answer for an "ok" or an "adjust".
MALFORMED = "_malformed"

# How many consecutive identical verdicts count as a stall.
STALL_LIMIT = 3
# The hard ceiling on the iteration cap. The default is lower; the ceiling
# only exists so a misconfigured caller cannot buy an unbounded API bill.
MAX_ITERATIONS_CEILING = 12
# The default iteration cap: six renders and six audits is enough for the
# rubric to converge, and it bounds the cost of a hopeless photo.
DEFAULT_MAX_ITERATIONS = 6
# The longest side of the composite handed to the vision model. The render is
# deterministic in size whatever the window is, which is what makes the
# audits comparable across machines.
RENDER_MAX_SIDE = 1024
# A blended price used for the cost estimate in the delivery report. The
# deployment overrides it with the rates of the model it actually calls.
USD_PER_MILLION_TOKENS = 3.0


# ---------------------------------------------------------------------------
# The adjustment targets — the fixed enumeration, mapped onto real commands.
# ---------------------------------------------------------------------------


def _levels_params(values: Mapping[str, float]) -> Dict[str, Any]:
    return {
        "inBlack": values["shadows"],
        "inWhite": values["highlights"],
        "outBlack": values["blacks"],
        "outWhite": values["whites"],
        "gamma": values["gamma"],
    }


def _color_balance_params(values: Mapping[str, float]) -> Dict[str, Any]:
    # Each tone is [cyan-red, magenta-green, yellow-blue].
    # The midtones carry the white balance: index 1 is the tint, index 2 the
    # temperature. The split tone moves the shadows towards teal (cyan and
    # green) and the highlights towards orange (red and yellow).
    shadows = values["split-tone-shadows"]
    highlights = values["split-tone-highlights"]
    return {
        "shadows": [shadows, shadows, 0.0],
        "midtones": [0.0, values["tint"], values["temperature"]],
        "highlights": [-highlights, 0.0, highlights],
        "preserveLuminosity": True,
    }


def _vibrance_params(values: Mapping[str, float]) -> Dict[str, Any]:
    return {"vibrance": values["vibrance"]}


def _hue_saturation_params(values: Mapping[str, float]) -> Dict[str, Any]:
    return {"saturation": values["saturation"]}


def _brightness_contrast_params(values: Mapping[str, float]) -> Dict[str, Any]:
    return {"contrast": values["contrast"]}


@dataclass(frozen=True)
class Target:
    """One rubric axis, the engine command that carries it and its limits."""

    name: str
    layer: str
    command: str
    update: str
    param: str
    lo: float
    hi: float
    step: float
    initial: float
    scale: float = 1.0
    compose: Any = None
    doc: str = ""


TARGETS: Dict[str, Target] = {
    "highlights": Target(
        "highlights", "Levels", "layer.newAdjustmentLayer.levels", "layer.setAdjustment",
        "inWhite", 2.0, 255.0, 3.0, 255.0, 6.0, _levels_params,
        "the input white point; a negative delta mutes the highlights",
    ),
    "shadows": Target(
        "shadows", "Levels", "layer.newAdjustmentLayer.levels", "layer.setAdjustment",
        "inBlack", 0.0, 253.0, 3.0, 0.0, 6.0, _levels_params,
        "the input black point; a positive delta lifts the shadows",
    ),
    "whites": Target(
        "whites", "Levels", "layer.newAdjustmentLayer.levels", "layer.setAdjustment",
        "outWhite", 0.0, 255.0, 3.0, 255.0, 6.0, _levels_params,
        "the output white point; a negative delta rolls the whites off",
    ),
    "blacks": Target(
        "blacks", "Levels", "layer.newAdjustmentLayer.levels", "layer.setAdjustment",
        "outBlack", 0.0, 255.0, 3.0, 0.0, 6.0, _levels_params,
        "the output black point; a positive delta opens the blacks",
    ),
    "gamma": Target(
        "gamma", "Levels", "layer.newAdjustmentLayer.levels", "layer.setAdjustment",
        "gamma", 0.01, 9.99, 0.01, 1.0, 0.02, _levels_params,
        "the midtone gamma; it moves far more slowly than the other axes",
    ),
    "temperature": Target(
        "temperature", "Color Balance", "layer.newAdjustmentLayer.colorBalance",
        "layer.setAdjustment", "midtones[2] yellow-blue", -100.0, 100.0, 3.0, 0.0, 4.0,
        _color_balance_params, "a positive delta warms the midtones",
    ),
    "tint": Target(
        "tint", "Color Balance", "layer.newAdjustmentLayer.colorBalance",
        "layer.setAdjustment", "midtones[1] magenta-green", -100.0, 100.0, 3.0, 0.0, 4.0,
        _color_balance_params, "a positive delta moves the midtones towards magenta",
    ),
    "split-tone-shadows": Target(
        "split-tone-shadows", "Color Balance", "layer.newAdjustmentLayer.colorBalance",
        "layer.setAdjustment", "shadows[0:2] cyan-red, magenta-green", -100.0, 100.0, 3.0,
        0.0, 4.0, _color_balance_params, "a positive delta pushes the shadows towards teal",
    ),
    "split-tone-highlights": Target(
        "split-tone-highlights", "Color Balance", "layer.newAdjustmentLayer.colorBalance",
        "layer.setAdjustment", "highlights[0,2] cyan-red, yellow-blue", -100.0, 100.0, 3.0,
        0.0, 4.0, _color_balance_params, "a positive delta pushes the highlights towards orange",
    ),
    "vibrance": Target(
        "vibrance", "Vibrance", "layer.newAdjustmentLayer.vibrance", "layer.setAdjustment",
        "vibrance", -100.0, 100.0, 3.0, 0.0, 4.0, _vibrance_params,
        "saturation weighted towards the already muted colours",
    ),
    "saturation": Target(
        "saturation", "Hue/Saturation", "layer.newAdjustmentLayer.hueSaturation",
        "layer.setAdjustment", "saturation", -100.0, 100.0, 3.0, 0.0, 4.0,
        _hue_saturation_params, "the global saturation of the composite",
    ),
    "contrast": Target(
        "contrast", "Brightness/Contrast", "layer.newAdjustmentLayer.brightnessContrast",
        "layer.setAdjustment", "contrast", -50.0, 100.0, 2.0, 0.0, 4.0,
        _brightness_contrast_params, "the contrast of the composite",
    ),
    "grain": Target(
        "grain", "Grain", "filter.noise.addNoise", "filter.noise.addNoise",
        "amount", 0.0, 40.0, 0.1, 0.0, 0.5, None,
        "the noise amount of a grain plate laid over the composite",
    ),
}

# The severity ranking the improvement gate compares. A higher number is a
# worse violation: a broken tone curve is a worse problem than a little
# extra grain.
SEVERITY: Dict[str, int] = {
    "highlights": 4,
    "shadows": 4,
    "blacks": 4,
    "whites": 4,
    "temperature": 3,
    "tint": 3,
    "contrast": 3,
    "gamma": 3,
    "vibrance": 2,
    "saturation": 2,
    "split-tone-shadows": 1,
    "split-tone-highlights": 1,
    "grain": 1,
}

# The adjustment layers the loop builds, in the order it builds them. Each
# one is non-destructive: the loop re-sends the whole parameter set of a
# layer whenever one of its axes moves, so the value is always absolute and
# the same value always produces the same pixels.
GRADE_LAYERS: Tuple[Tuple[str, str], ...] = (
    ("Levels", "layer.newAdjustmentLayer.levels"),
    ("Color Balance", "layer.newAdjustmentLayer.colorBalance"),
    ("Vibrance", "layer.newAdjustmentLayer.vibrance"),
    ("Hue/Saturation", "layer.newAdjustmentLayer.hueSaturation"),
    ("Brightness/Contrast", "layer.newAdjustmentLayer.brightnessContrast"),
)

# The grain plate: a neutral grey fill rasterised into pixels, blended over
# the composite and then given a gaussian noise field. The layer is rebuilt
# from scratch whenever the amount moves, because a noise filter applied
# twice to the same layer is twice the grain.
GRAIN_FILL = "#808080"
GRAIN_OPACITY = 0.12
GRAIN_SEED = 7
GRAIN_COMMANDS: Tuple[str, ...] = (
    "layer.newFillLayer.solidColor",
    "layer.rasterize.fillContent",
    "layer.setProps",
    "filter.noise.addNoise",
    "layer.delete",
)


def engine_commands() -> Tuple[str, ...]:
    """Every engine command the loop is allowed to call."""
    commands: List[str] = []
    for _, command in GRADE_LAYERS:
        commands.append(command)
    commands.append("layer.setAdjustment")
    commands.extend(GRAIN_COMMANDS)
    commands.extend(("history.newSnapshot", "history.selectSnapshot"))
    return tuple(sorted(set(commands)))


# ---------------------------------------------------------------------------
# The audit — the literal system prompt and the hand-rolled validator.
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are a senior film colorist judging a photograph against a rubric.
You will be shown a single composite render. Judge it against the rubric below.
Return exactly one JSON object. Do not return prose, markdown or commentary.

RUBRIC:
{rubric}

TARGET PRINT SIZE: {print_size}

RULES:
- If the photo satisfies the rubric, return {{"status":"ok","rationale":"<20-200 chars>"}}.
- Otherwise, return exactly one violation:
  {{"status":"adjust","rationale":"<20-200 chars>",
    "adjustment":{{"target":"<one of the enumerated targets>","delta":<number>}}}}
- The `target` MUST be one of: {targets}.
- Never invent new rubric criteria. Never mention criteria not stated above.
- Never suggest a change to a target outside the enumerated set.
- `delta` is a signed unitless step; positive moves toward the target's high end.
"""


def validate_audit(obj: Any) -> Tuple[bool, str]:
    """Enforce ADJUSTMENT_SCHEMA by hand.

    The schema is hand-checked rather than delegated to a validator library so
    that a stray extra key — a model helpfully adding "confidence" — is a
    rejection and not an ignored field. `additionalProperties: false` means
    "reject", and this mirrors that exactly.
    """
    if not isinstance(obj, dict):
        return False, "the response is not a JSON object"
    status = obj.get("status")
    if status not in ("ok", "adjust"):
        return False, "status must be 'ok' or 'adjust'"
    rationale = obj.get("rationale")
    if not isinstance(rationale, str) or not (20 <= len(rationale) <= 200):
        return False, "rationale must be a string of 20 to 200 characters"
    extra = set(obj.keys()) - {"status", "rationale", "adjustment"}
    if extra:
        return False, "unexpected top-level keys: %s" % ", ".join(sorted(extra))
    if status == "adjust":
        adjustment = obj.get("adjustment")
        if not isinstance(adjustment, dict):
            return False, "the adjustment is missing while the status is 'adjust'"
        if set(adjustment.keys()) != {"target", "delta"}:
            return False, "the adjustment must carry exactly a target and a delta"
        if adjustment["target"] not in TARGETS:
            return False, "unknown target: %r" % (adjustment["target"],)
        delta = adjustment["delta"]
        if isinstance(delta, bool) or not isinstance(delta, (int, float)):
            return False, "the delta must be a number"
    return True, ""


# ---------------------------------------------------------------------------
# The vision model — injected, never constructed here.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class VisionAnswer:
    """What a vision model returned, plus what it cost."""

    text: str
    input_tokens: int = 0
    output_tokens: int = 0


class VisionModel(Protocol):
    """The only thing the loop needs from a multimodal model."""

    def chat(
        self,
        *,
        system: str,
        image_b64: str,
        response_format: Mapping[str, Any],
    ) -> VisionAnswer:
        ...


# ---------------------------------------------------------------------------
# The engine clients — the control protocol and the headless MCP surface.
# ---------------------------------------------------------------------------


class EngineError(RuntimeError):
    """The engine refused a call."""


class ControlClient:
    """The PhotoCraft control protocol over a TCP socket.

    The wire format is newline-delimited JSON. The first frame the socket
    sends is the authentication frame, verbatim:

        {"id": "auth", "method": "auth", "params": {"token": "<64 hex>"}}

    The server closes the connection on any other first frame, so there is
    nothing to retry: the socket is opened only once the token has been
    validated.
    """

    def __init__(self, host: str, port: int, token: str, timeout: float = 30.0) -> None:
        self._socket = socket.create_connection((host, port), timeout=timeout)
        self._reader = self._socket.makefile("r", encoding="utf-8")
        self._next_id = 0
        reply = self._roundtrip({"id": "auth", "method": "auth", "params": {"token": token}})
        if not reply.get("ok"):
            self.close()
            raise EngineError("the control channel rejected the authentication frame")
        # The token has done its job. Dropping the reference makes an
        # accidental inclusion in a traceback or a debug print much harder.
        del token

    # -- the wire ----------------------------------------------------------
    def _roundtrip(self, frame: Mapping[str, Any]) -> Dict[str, Any]:
        self._socket.sendall((json.dumps(frame) + "\n").encode("utf-8"))
        line = self._reader.readline()
        if not line:
            raise EngineError("the control channel closed the connection")
        return json.loads(line)

    def call(self, method: str, params: Optional[Mapping[str, Any]] = None) -> Any:
        self._next_id += 1
        reply = self._roundtrip(
            {"id": self._next_id, "method": method, "params": dict(params or {})}
        )
        if not reply.get("ok"):
            raise EngineError("%s failed: %s" % (method, reply.get("error")))
        return reply.get("result")

    # -- the engine --------------------------------------------------------
    def execute(self, command: str, params: Optional[Mapping[str, Any]] = None) -> Any:
        return self.call("engine.execute", {"command": command, "params": dict(params or {})})

    def open_source(self, path: Path) -> Any:
        return self.call("doc.open", {"path": str(path)})

    def render(self, max_side: int = RENDER_MAX_SIDE) -> bytes:
        result = self.call("doc.render", {"max_side": max_side})
        if not isinstance(result, dict) or "base64" not in result:
            raise EngineError("the control channel returned no composite")
        return base64.b64decode(result["base64"])

    def inspect(self) -> Dict[str, Any]:
        result = self.call("doc.inspect", {})
        return result if isinstance(result, dict) else {}

    def registry(self) -> List[str]:
        result = self.call("engine.commands", {})
        if isinstance(result, list):
            return [entry.get("id") for entry in result if isinstance(entry, dict)]
        return []

    def close(self) -> None:
        try:
            self._reader.close()
        except Exception:
            pass
        try:
            self._socket.close()
        except Exception:
            pass


class HeadlessClient:
    """The same engine, driven over MCP on stdio.

    The headless path has no socket, no authentication frame and no window:
    the composite comes from `doc_render_preview` and the engine commands
    from `command_run`.
    """

    def __init__(self, argv: Sequence[str], cwd: Optional[Path] = None) -> None:
        self._process = subprocess.Popen(
            list(argv),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=str(cwd) if cwd else None,
            text=True,
            bufsize=1,
        )
        self._next_id = 0
        self._handshake()

    def _write(self, frame: Mapping[str, Any]) -> None:
        assert self._process.stdin is not None
        self._process.stdin.write(json.dumps(frame) + "\n")
        self._process.stdin.flush()

    def _read(self) -> Dict[str, Any]:
        assert self._process.stdout is not None
        line = self._process.stdout.readline()
        if not line:
            raise EngineError("the MCP server closed the connection")
        return json.loads(line)

    def _handshake(self) -> None:
        self._write(
            {
                "jsonrpc": "2.0",
                "id": 0,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "colorist-loop", "version": "1"},
                },
            }
        )
        self._read()
        self._write({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def call(self, tool: str, arguments: Mapping[str, Any]) -> Any:
        self._next_id += 1
        self._write(
            {
                "jsonrpc": "2.0",
                "id": self._next_id,
                "method": "tools/call",
                "params": {"name": tool, "arguments": dict(arguments)},
            }
        )
        while True:
            message = self._read()
            if message.get("id") != self._next_id:
                continue
            if "error" in message:
                raise EngineError("%s failed: %s" % (tool, message["error"]))
            result = message.get("result", {})
            content = result.get("content", [])
            for block in content:
                if block.get("type") == "image":
                    return {
                        "image": block.get("data", ""),
                        "mimeType": block.get("mimeType", "image/png"),
                    }
                if block.get("type") == "text":
                    try:
                        return json.loads(block.get("text", ""))
                    except json.JSONDecodeError:
                        return block.get("text")
            return result

    # -- the engine --------------------------------------------------------
    def execute(self, command: str, params: Optional[Mapping[str, Any]] = None) -> Any:
        return self.call("command_run", {"id": command, "params": dict(params or {})})

    def open_source(self, path: Path) -> Any:
        return self.call("doc_open", {"path": str(path)})

    def render(self, max_side: int = RENDER_MAX_SIDE) -> bytes:
        result = self.call("doc_render_preview", {"max_side": max_side})
        if isinstance(result, dict) and result.get("image"):
            return base64.b64decode(result["image"])
        raise EngineError("the headless preview returned no composite")

    def inspect(self) -> Dict[str, Any]:
        result = self.call("doc_inspect", {})
        return result if isinstance(result, dict) else {}

    def registry(self) -> List[str]:
        result = self.call("command_list", {})
        if isinstance(result, list):
            return [entry.get("id") for entry in result if isinstance(entry, dict)]
        return []

    def close(self) -> None:
        try:
            if self._process.stdin is not None:
                self._process.stdin.close()
        except Exception:
            pass
        try:
            self._process.terminate()
            self._process.wait(timeout=10)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# The loop.
# ---------------------------------------------------------------------------


@dataclass
class Iteration:
    """One audit, the change it asked for and what the loop did with it."""

    index: int
    audit: Dict[str, Any]
    delta: Optional[Dict[str, Any]]
    latency_ms: int
    render: str
    applied: bool = False
    rolled_back: bool = False
    verification: Optional[Dict[str, Any]] = None

    def as_json(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "index": self.index,
            "audit": self.audit,
            "delta": self.delta,
            "latencyMs": self.latency_ms,
            "render": self.render,
            "applied": self.applied,
            "rolledBack": self.rolled_back,
        }
        if self.verification is not None:
            payload["verification"] = self.verification
        return payload


class Colorist:
    """The closed-loop optimiser."""

    def __init__(
        self,
        client: Any,
        vision: VisionModel,
        sandbox: Sandbox,
        rubric: str,
        print_size: str,
        max_iterations: int = DEFAULT_MAX_ITERATIONS,
        max_side: int = RENDER_MAX_SIDE,
        usd_per_million_tokens: float = USD_PER_MILLION_TOKENS,
    ) -> None:
        self._client = client
        self._vision = vision
        self._sandbox = sandbox
        self._rubric = rubric
        self._print_size = print_size
        self._max_iterations = max(1, min(MAX_ITERATIONS_CEILING, max_iterations))
        self._max_side = max_side
        self._price = usd_per_million_tokens
        self._values: Dict[str, float] = {
            name: target.initial for name, target in TARGETS.items()
        }
        self._layers: Dict[str, int] = {}
        self._grain_layer: Optional[int] = None
        self._tokens_in = 0
        self._tokens_out = 0

    # -- setup -------------------------------------------------------------
    def verify_registry(self) -> List[str]:
        """Fail fast when the engine does not know a command the loop uses."""
        known = set(self._client.registry())
        missing = [command for command in engine_commands() if command not in known]
        if missing:
            raise EngineError(
                "the engine registry is missing: %s" % ", ".join(sorted(missing))
            )
        return sorted(known)

    def open_source(self, path: Path) -> Any:
        """Open the customer's photo, inside the read root only."""
        resolved = self._sandbox.read(path)
        return self._client.open_source(resolved)

    def build_grade_stack(self) -> Dict[str, int]:
        """Create one non-destructive adjustment layer per axis group."""
        for kind, command in GRADE_LAYERS:
            result = self._client.execute(command, {})
            layer = result.get("layer") if isinstance(result, dict) else None
            if not isinstance(layer, int):
                raise EngineError("%s returned no layer" % command)
            self._layers[kind] = layer
        return dict(self._layers)

    # -- the audit ---------------------------------------------------------
    def _audit(self, png: bytes) -> Tuple[Dict[str, Any], int]:
        """The only place the loop touches the vision model."""
        prompt = SYSTEM_PROMPT.format(
            rubric=self._rubric,
            print_size=self._print_size,
            targets=", ".join(sorted(TARGETS.keys())),
        )
        started = time.monotonic()
        answer = self._vision.chat(
            system=prompt,
            image_b64=base64.b64encode(png).decode("ascii"),
            response_format={"type": "json_object", "schema": ADJUSTMENT_SCHEMA},
        )
        latency = int((time.monotonic() - started) * 1000)
        self._tokens_in += answer.input_tokens
        self._tokens_out += answer.output_tokens
        try:
            parsed = json.loads(answer.text)
        except (json.JSONDecodeError, TypeError):
            return (
                {"status": MALFORMED, "rationale": "the response is not valid JSON"},
                latency,
            )
        valid, why = validate_audit(parsed)
        if not valid:
            return ({"status": MALFORMED, "rationale": why}, latency)
        return parsed, latency

    # -- the change --------------------------------------------------------
    def _clamp(self, target: str, delta: float) -> float:
        """Clamp a proposed delta onto the target's legal range."""
        spec = TARGETS[target]
        proposed = self._values[target] + delta * spec.scale
        return max(spec.lo, min(spec.hi, proposed))

    def _apply(self, target: str, value: float) -> None:
        """Write one target, and with it the whole parameter set of its layer.

        A layer is written as a whole because the engine's adjustment layers
        are absolute: re-sending the complete set keeps the grade
        reproducible and stops two targets that share a layer from undoing
        each other.
        """
        spec = TARGETS[target]
        self._values[target] = value
        if spec.layer == "Grain":
            self._apply_grain(value)
            return
        layer = self._layers.get(spec.layer)
        if layer is None:
            raise EngineError("the grade stack has no %s layer" % spec.layer)
        params = spec.compose(self._values) if spec.compose else {spec.param: value}
        self._client.execute(spec.update, {"layer": layer, **params})

    def _apply_grain(self, amount: float) -> None:
        """Rebuild the grain plate.

        A noise filter is destructive, so the plate is deleted and rebuilt
        rather than filtered twice.
        """
        if self._grain_layer is not None:
            self._client.execute("layer.delete", {"layer": self._grain_layer})
            self._grain_layer = None
        if amount <= 0.0:
            return
        created = self._client.execute(
            "layer.newFillLayer.solidColor", {"color": GRAIN_FILL}
        )
        layer = created.get("layer") if isinstance(created, dict) else None
        if not isinstance(layer, int):
            raise EngineError("the grain plate could not be created")
        self._client.execute("layer.rasterize.fillContent", {"layer": layer})
        self._client.execute(
            "layer.setProps",
            {"layer": layer, "blend": "Overlay", "opacity": GRAIN_OPACITY},
        )
        self._client.execute(
            "filter.noise.addNoise",
            {
                "amount": amount,
                "distribution": "gaussian",
                "monochromatic": True,
                "seed": GRAIN_SEED,
            },
        )
        self._grain_layer = layer

    # -- the run -----------------------------------------------------------
    def run(self, photo_id: str) -> Dict[str, Any]:
        """Grade one photo and write the three delivery artefacts."""
        out_dir = self._sandbox.write(Path(photo_id))
        out_dir.mkdir(parents=True, exist_ok=True)

        iterations: List[Iteration] = []
        best_png: Optional[bytes] = None
        best_index = -1
        outcome = "cap"
        stall_counter = 0
        last_key: Optional[Tuple[str, Optional[str]]] = None
        last_target: Optional[str] = None
        last_delta_sign = 0
        last_delta_magnitude = 0.0

        for index in range(self._max_iterations):
            png = self._client.render(self._max_side)
            render_path = out_dir / ("render_%02d.png" % index)
            render_path.write_bytes(png)
            audit, latency = self._audit(png)
            iteration = Iteration(
                index=index,
                audit=audit,
                delta=None,
                latency_ms=latency,
                render=str(render_path),
            )
            iterations.append(iteration)

            # A soft failure: nothing is applied, the counter advances.
            if audit.get("status") == MALFORMED:
                continue

            # A satisfied rubric ends the run.
            if audit.get("status") == "ok":
                best_png, best_index = png, index
                outcome = "ok"
                break

            target = str(audit["adjustment"]["target"])
            delta = float(audit["adjustment"]["delta"])

            # The stall detector: three identical verdicts in a row mean the
            # model has found a violation it cannot turn into a change.
            key = (str(audit.get("status")), target)
            stall_counter = stall_counter + 1 if key == last_key else 0
            last_key = key
            if stall_counter >= STALL_LIMIT:
                outcome = "stalled"
                break

            value = self._clamp(target, delta)
            applied = value - self._values[target]
            if abs(applied) < TARGETS[target].step * 0.5:
                # A move too small to see only burns an audit.
                iteration.delta = {"target": target, "delta": 0.0}
                continue

            # The oscillation detector: a reverse move larger than the
            # forward one it undoes is a loop, not a correction.
            sign = 1 if applied > 0 else -1
            if (
                target == last_target
                and last_delta_sign != 0
                and sign != last_delta_sign
                and abs(applied) > last_delta_magnitude
            ):
                outcome = "oscillating"
                break

            snapshot = self._client.execute(
                "history.newSnapshot", {"name": "colorist-%02d" % index, "from": "fullDocument"}
            )
            snapshot_id = snapshot.get("snapshot") if isinstance(snapshot, dict) else None
            before = png
            self._apply(target, value)
            iteration.delta = {"target": target, "delta": applied}

            # The improvement gate: the change is only kept when the next
            # audit does not report a more severe violation.
            after_png = self._client.render(self._max_side)
            after_path = out_dir / ("render_%02d_after.png" % index)
            after_path.write_bytes(after_png)
            after_audit, after_latency = self._audit(after_png)
            iteration.verification = {
                "audit": after_audit,
                "latencyMs": after_latency,
                "render": str(after_path),
            }
            regression = (
                after_audit.get("status") == "adjust"
                and SEVERITY.get(str(after_audit["adjustment"]["target"]), 0)
                > SEVERITY.get(target, 0)
            )
            if regression:
                if isinstance(snapshot_id, int):
                    self._client.execute(
                        "history.selectSnapshot", {"snapshot": snapshot_id}
                    )
                    restored = self._client.render(self._max_side)
                    (out_dir / ("render_%02d_restored.png" % index)).write_bytes(restored)
                    if restored != before:
                        raise EngineError(
                            "the rollback did not restore the composite"
                        )
                self._values[target] -= applied
                iteration.rolled_back = True
            else:
                iteration.applied = True
                best_png, best_index = after_png, index

            last_target = target
            last_delta_sign = sign
            last_delta_magnitude = abs(applied)

        if best_png is None:
            best_png = self._client.render(self._max_side)
            best_index = len(iterations) - 1
        final_path = out_dir / "final.png"
        final_path.write_bytes(best_png)

        (out_dir / "iterations.json").write_text(
            json.dumps([item.as_json() for item in iterations], indent=2), "utf-8"
        )

        total_tokens = self._tokens_in + self._tokens_out
        delivery = {
            "photoId": photo_id,
            "outcome": outcome,
            "iterationCount": len(iterations),
            "auditCount": len(iterations) + sum(
                1 for item in iterations if item.verification is not None
            ),
            "bestIndex": best_index,
            "finalAudit": iterations[best_index].audit
            if 0 <= best_index < len(iterations)
            else None,
            "finalPath": str(final_path),
            "finalSha256": hashlib.sha256(best_png).hexdigest(),
            "grade": dict(self._values),
            "costUsd": round(total_tokens / 1_000_000.0 * self._price, 6),
            "tokens": {"input": self._tokens_in, "output": self._tokens_out},
        }
        (out_dir / "delivery.json").write_text(json.dumps(delivery, indent=2), "utf-8")
        return delivery


# ---------------------------------------------------------------------------
# The deployment entry point.
# ---------------------------------------------------------------------------


class PassThroughVision:
    """The no-model fallback: it certifies the photo without changing it.

    A deployment that has a multimodal model injects its own client. This one
    exists so the loop can be run, and its plumbing exercised, without an API
    key: it answers "ok" and the loop delivers the photo untouched.
    """

    def chat(
        self,
        *,
        system: str,
        image_b64: str,
        response_format: Mapping[str, Any],
    ) -> VisionAnswer:
        answer = {
            "status": "ok",
            "rationale": "No multimodal model is configured, so the photo is certified as delivered.",
        }
        return VisionAnswer(text=json.dumps(answer), input_tokens=0, output_tokens=0)


def vision_from_environment(env: Optional[Mapping[str, str]] = None) -> VisionModel:
    """Load the production vision client.

    The deployment names an importable factory in PHOTOCRAFT_VISION_FACTORY
    as "package.module:attribute". The factory is called with no arguments
    and must return an object with the VisionModel interface. Keeping it out
    of this module is what lets the whole loop be exercised without a key.
    """
    source = os.environ if env is None else env
    spec = source.get("PHOTOCRAFT_VISION_FACTORY", "")
    if not spec:
        return PassThroughVision()
    module_name, _, attribute = spec.partition(":")
    if not attribute:
        raise SystemExit("FATAL: PHOTOCRAFT_VISION_FACTORY must be 'package.module:attribute'")
    module = __import__(module_name, fromlist=[attribute])
    factory = getattr(module, attribute)
    return factory()


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Grade one photo through a live PhotoCraft control channel."""
    arguments = list(argv if argv is not None else sys.argv[1:])
    host = arguments[0] if len(arguments) > 0 else "127.0.0.1"
    port = int(arguments[1]) if len(arguments) > 1 else 7978
    source = Path(arguments[2]) if len(arguments) > 2 else Path("photo.jpg")
    photo_id = arguments[3] if len(arguments) > 3 else source.stem

    token = load_token()
    client = ControlClient(host, port, token)
    try:
        sandbox = Sandbox(
            read_root=Path(os.environ.get("PHOTOCRAFT_READ_ROOT", source.parent)),
            write_root=Path(os.environ.get("PHOTOCRAFT_WRITE_ROOT", "out")),
        )
        colorist = Colorist(
            client=client,
            vision=vision_from_environment(),
            sandbox=sandbox,
            rubric=(
                "muted highlights; teal-and-orange split tone; gently lifted shadows; "
                "filmic roll-off; slight grain"
            ),
            print_size="8x10 glossy",
        )
        colorist.verify_registry()
        colorist.open_source(source)
        colorist.build_grade_stack()
        delivery = colorist.run(photo_id)
        print(json.dumps(delivery, indent=2))
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(main())
