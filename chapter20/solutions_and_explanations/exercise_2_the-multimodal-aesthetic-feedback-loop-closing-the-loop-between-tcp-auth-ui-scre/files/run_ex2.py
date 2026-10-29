#!/usr/bin/env python3
"""
run_ex2.py — the acceptance harness for the multimodal aesthetic feedback loop.

It builds a real customer photo, hosts a stub of the PhotoCraft control
channel, runs the reference solution against that channel with an injected
vision model, and then checks the artefacts the solution leaves behind
against the engine's own reports.

The stub exists because the control channel belongs to the desktop app: the
CLI cannot open it (`photocraft-cli --control 7978` answers "unknown
subcommand"). The stub speaks the same wire format — newline-delimited JSON
with a mandatory authentication frame first — and proxies the calls to a real
headless PhotoCraft session, so the composites the loop judges are real
renders of a real document.

No network and no API key are involved: the vision model is injected as a
deterministic stand-in.

    python3 run_ex2.py
"""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import threading
import zlib
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
WORK = HERE.parent / "output" / "work"
READ_ROOT = WORK / "in"
WRITE_ROOT = WORK / "out"
BINARY = os.environ.get("PHOTOCRAFT_CLI", "photocraft-cli")
TOKEN = "a3f19c7d5e2b48069c1df4e8a72b05c3d9e6f4812ac7d3059b8e27f4c1a60d93"

PASSED = 0
OPEN_STUBS: List["StubControlServer"] = []


def check(label: str, condition: Any, detail: str = "") -> None:
    """One assertion; a failure stops the run with a readable reason."""
    global PASSED
    if not condition:
        print("FAIL %s — %s" % (label, detail or "the assertion did not hold"))
        raise SystemExit(1)
    PASSED += 1
    print("PASS %s" % label)


# ────────────────────────────────────────────────────────────────────────
# The fixture.
# ────────────────────────────────────────────────────────────────────────
def write_png(path: Path, width: int, height: int, rgb: Tuple[int, int, int]) -> None:
    """Write a real RGB PNG, so the engine has a real photo to open."""

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + bytes(rgb) * width for _ in range(height))
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def build_fixture() -> Path:
    """The customer photo, inside the read root."""
    if WORK.exists():
        shutil.rmtree(WORK)
    READ_ROOT.mkdir(parents=True, exist_ok=True)
    WRITE_ROOT.mkdir(parents=True, exist_ok=True)
    source = READ_ROOT / "customer.png"
    # A warm, flat frame: a strong colour cast and no detail, so a colour
    # balance really does move the pixels.
    write_png(source, 240, 160, (198, 132, 74))
    return source


# ────────────────────────────────────────────────────────────────────────
# The engine session behind the stub.
# ────────────────────────────────────────────────────────────────────────
class EngineSession:
    """One headless PhotoCraft session, driven over its own JSON-lines port."""

    def __init__(self, argv: Sequence[str]) -> None:
        self._process = subprocess.Popen(
            list(argv),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
        self._next_id = 0
        self._lock = threading.Lock()

    def call(self, method: str, params: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            self._next_id += 1
            frame = {"id": self._next_id, "method": method, "params": params}
            assert self._process.stdin is not None
            self._process.stdin.write(json.dumps(frame) + "\n")
            self._process.stdin.flush()
            assert self._process.stdout is not None
            line = self._process.stdout.readline()
            if not line:
                raise RuntimeError("the PhotoCraft session closed")
            return json.loads(line)

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


# ────────────────────────────────────────────────────────────────────────
# The stub of the control channel.
# ────────────────────────────────────────────────────────────────────────
class StubControlServer:
    """A stub of the desktop app's TCP control channel.

    The wire format is newline-delimited JSON. The first frame a client
    sends must be the authentication frame

        {"id": "auth", "method": "auth", "params": {"token": "<64 hex>"}}

    and anything else closes the connection. The stub records every frame it
    receives so a test can assert on the traffic the loop produced.
    """

    def __init__(self, binary: str, read_root: Path, write_root: Path, token: str) -> None:
        self._token = token
        self._engine = EngineSession(
            [
                binary,
                "serve",
                "--automation-read-root",
                str(read_root),
                "--automation-write-root",
                str(write_root),
            ]
        )
        self._listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._listener.bind(("127.0.0.1", 0))
        self._listener.listen(8)
        self.host, self.port = self._listener.getsockname()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._accept, daemon=True)
        self._thread.start()
        self.received: List[Dict[str, Any]] = []
        self.auth_frames: List[Dict[str, Any]] = []
        self.rejected: List[str] = []
        self.connections = 0
        OPEN_STUBS.append(self)

    # -- the listener ------------------------------------------------------
    def _accept(self) -> None:
        while not self._stop.is_set():
            try:
                connection, _ = self._listener.accept()
            except OSError:
                return
            self.connections += 1
            threading.Thread(target=self._serve, args=(connection,), daemon=True).start()

    def _serve(self, connection: socket.socket) -> None:
        reader = connection.makefile("r", encoding="utf-8")
        try:
            first = reader.readline()
            if not first:
                return
            try:
                frame = json.loads(first)
            except json.JSONDecodeError:
                self.rejected.append(first.strip())
                return
            if not self._is_auth(frame):
                self.rejected.append(json.dumps(frame))
                return
            self.auth_frames.append(frame)
            connection.sendall(
                (
                    json.dumps({"id": "auth", "ok": True, "result": {"authenticated": True}})
                    + "\n"
                ).encode("utf-8")
            )
            while True:
                line = reader.readline()
                if not line:
                    return
                try:
                    request = json.loads(line)
                except json.JSONDecodeError:
                    return
                self.received.append(request)
                reply = self._dispatch(request)
                connection.sendall((json.dumps(reply) + "\n").encode("utf-8"))
        finally:
            try:
                connection.close()
            except Exception:
                pass

    def _is_auth(self, frame: Any) -> bool:
        if not isinstance(frame, dict):
            return False
        params = frame.get("params")
        if not isinstance(params, dict):
            return False
        return (
            frame.get("id") == "auth"
            and frame.get("method") == "auth"
            and params.get("token") == self._token
        )

    def _dispatch(self, request: Dict[str, Any]) -> Dict[str, Any]:
        method = request.get("method")
        params = request.get("params") or {}
        reply_id = request.get("id")
        if method == "ui.screenshot":
            return {
                "id": reply_id,
                "ok": False,
                "error": "the live app window is not available in a headless session",
            }
        if method == "engine.execute":
            result = self._engine.call(
                "engine.execute",
                {
                    "command": params.get("command"),
                    "params": params.get("params") or {},
                },
            )
            return {
                "id": reply_id,
                "ok": bool(result.get("ok", True)),
                "result": result.get("result"),
                "error": result.get("error"),
            }
        if method in ("doc.open", "doc.render", "doc.inspect", "doc.save", "engine.commands"):
            result = self._engine.call(method, params)
            return {
                "id": reply_id,
                "ok": bool(result.get("ok", True)),
                "result": result.get("result"),
                "error": result.get("error"),
            }
        return {"id": reply_id, "ok": False, "error": "unknown method %r" % (method,)}

    # -- helpers -----------------------------------------------------------
    def engine(self) -> EngineSession:
        return self._engine

    def commands(self) -> List[Dict[str, Any]]:
        return self._engine.call("engine.commands", {}).get("result") or []

    def frames(self, method: str) -> List[Dict[str, Any]]:
        return [frame for frame in self.received if frame.get("method") == method]

    def engine_commands(self) -> List[str]:
        return [
            str(frame.get("params", {}).get("command"))
            for frame in self.frames("engine.execute")
        ]

    def close(self) -> None:
        self._stop.set()
        try:
            self._listener.close()
        except Exception:
            pass
        self._engine.close()


# ────────────────────────────────────────────────────────────────────────
# The injected vision model.
# ────────────────────────────────────────────────────────────────────────
class ScriptedVision:
    """A deterministic stand-in for the multimodal model.

    The script is a flat list of answers, one per call. An answer is either
    a dict (serialised to JSON) or a string (used verbatim, so a malformed
    response can be scripted too).
    """

    def __init__(self, module: Any, answers: Sequence[Any]) -> None:
        self._module = module
        self._answers = list(answers)
        self.calls: List[Dict[str, Any]] = []

    def chat(
        self,
        *,
        system: str,
        image_b64: str,
        response_format: Any,
    ) -> Any:
        index = len(self.calls)
        raw = base64.b64decode(image_b64)
        self.calls.append(
            {
                "index": index,
                "bytes": len(raw),
                "png": raw[:8] == b"\x89PNG\r\n\x1a\n",
                "system": system,
            }
        )
        if index < len(self._answers):
            answer = self._answers[index]
        else:
            answer = {
                "status": "ok",
                "rationale": "The script is exhausted, so the photo is certified as delivered.",
            }
        text = answer if isinstance(answer, str) else json.dumps(answer)
        return self._module.VisionAnswer(text=text, input_tokens=1200, output_tokens=40)


# ────────────────────────────────────────────────────────────────────────
# The solution under test.
# ────────────────────────────────────────────────────────────────────────
def load_solution() -> Any:
    """Import the reference solution next to this harness."""
    path = HERE / "02_the-multimodal-aesthetic-feedback-loop-closing-the-loop-between-tcp-auth-ui-screenshot-and-a-vision-model.py"
    spec = importlib.util.spec_from_file_location("colorist_loop", path)
    if spec is None or spec.loader is None:
        raise SystemExit("cannot load %s" % path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def adjustments(
    target: str, delta: float, rationale: str = "The composite needs a change on this axis."
) -> Dict[str, Any]:
    return {
        "status": "adjust",
        "rationale": rationale,
        "adjustment": {"target": target, "delta": delta},
    }


def satisfied(rationale: str = "The composite satisfies every criterion of the rubric.") -> Dict[str, Any]:
    return {"status": "ok", "rationale": rationale}


# ────────────────────────────────────────────────────────────────────────
# One graded run.
# ────────────────────────────────────────────────────────────────────────
def grade(
    module: Any,
    binary: str,
    source: Path,
    photo_id: str,
    answers: Sequence[Any],
) -> Tuple[Dict[str, Any], StubControlServer, ScriptedVision, Path]:
    """Run the solution end to end against a fresh channel."""
    stub = StubControlServer(binary, READ_ROOT, WRITE_ROOT, TOKEN)
    vision = ScriptedVision(module, answers)
    client = module.ControlClient(stub.host, stub.port, TOKEN)
    try:
        colorist = module.Colorist(
            client=client,
            vision=vision,
            sandbox=module.Sandbox(read_root=READ_ROOT, write_root=WRITE_ROOT),
            rubric=(
                "muted highlights; teal-and-orange split tone; gently lifted "
                "shadows; filmic roll-off; slight grain"
            ),
            print_size="8x10 glossy",
        )
        colorist.verify_registry()
        colorist.open_source(source)
        colorist.build_grade_stack()
        delivery = colorist.run(photo_id)
    finally:
        client.close()
    return delivery, stub, vision, WRITE_ROOT / photo_id


def main() -> int:
    global PASSED
    binary = shutil.which(BINARY)
    check("the engine is on the PATH", binary is not None, "no %s" % BINARY)
    check("the engine is executable", os.access(str(binary), os.X_OK), str(binary))

    module = load_solution()
    check(
        "the solution exposes the loop contract",
        all(
            hasattr(module, name)
            for name in (
                "ADJUSTMENT_SCHEMA",
                "SYSTEM_PROMPT",
                "TARGETS",
                "SEVERITY",
                "Sandbox",
                "SandboxError",
                "ControlClient",
                "HeadlessClient",
                "Colorist",
                "VisionAnswer",
                "load_token",
                "validate_audit",
            )
        ),
        "a public name is missing",
    )
    check(
        "the audit schema names exactly the thirteen targets",
        sorted(
            module.ADJUSTMENT_SCHEMA["properties"]["adjustment"]["properties"]["target"]["enum"]
        )
        == sorted(module.TARGETS.keys()),
        "the schema and the target table disagree",
    )
    check(
        "the schema forbids extra properties",
        module.ADJUSTMENT_SCHEMA["additionalProperties"] is False
        and module.ADJUSTMENT_SCHEMA["properties"]["adjustment"]["additionalProperties"] is False,
        "a stray key would be tolerated",
    )
    check(
        "a stray key is a rejection, not an ignored field",
        module.validate_audit(
            {"status": "ok", "rationale": "x" * 30, "confidence": 0.9}
        )[0]
        is False,
        "the extra key was tolerated",
    )

    source = build_fixture()
    check("the fixture is a real PNG", source.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG")
    check("the fixture lives under the read root", READ_ROOT in source.parents, str(source))

    # ── run 1: a malformed answer, then a converging grade ────────────────
    answers = [
        "{not json at all",
        adjustments("highlights", -8.0),
        satisfied(),
        adjustments("saturation", 5.0),
        adjustments("vibrance", 4.0),
        satisfied(),
    ]
    delivery, stub, vision, out_dir = grade(module, str(binary), source, "P-001", answers)
    registry = [entry.get("id") for entry in stub.commands()]
    engine_calls = stub.engine_commands()
    renders = stub.frames("doc.render")

    check(
        "the channel authenticated the loop",
        len(stub.auth_frames) == 1,
        "%d auth frames" % len(stub.auth_frames),
    )
    check(
        "the first frame the loop sends is the authentication frame",
        stub.auth_frames[0].get("method") == "auth" and stub.auth_frames[0].get("id") == "auth",
        json.dumps(stub.auth_frames[0].get("method")),
    )
    check(
        "the authentication frame carries the token the channel expects",
        stub.auth_frames[0].get("params", {}).get("token") == TOKEN,
        "the token did not match",
    )
    check(
        "the loop never asks for a window screenshot",
        not stub.frames("ui.screenshot"),
        "the loop asked for the window chrome",
    )
    check(
        "every command the loop called is in the engine's registry",
        all(command in registry for command in engine_calls),
        "unknown: %s" % sorted(set(engine_calls) - set(registry)),
    )
    check(
        "the loop only calls commands it declares",
        set(engine_calls) <= set(module.engine_commands()),
        "undeclared: %s" % sorted(set(engine_calls) - set(module.engine_commands())),
    )
    check(
        "the composite is requested with a bounded long side",
        bool(renders) and all(0 < int(frame["params"]["max_side"]) <= 1024 for frame in renders),
        "a render was unbounded",
    )
    check(
        "the composite handed to the model is a real PNG",
        all(call["png"] for call in vision.calls),
        "the model was handed something that is not a PNG",
    )
    check(
        "the composite handed to the model is bounded",
        all(call["bytes"] > 0 for call in vision.calls),
        "an empty composite was handed to the model",
    )

    iterations = json.loads((out_dir / "iterations.json").read_text())
    check(
        "the iteration log holds one entry per decision",
        len(iterations) == delivery["iterationCount"],
        "%d entries, %d decisions" % (len(iterations), delivery["iterationCount"]),
    )
    check(
        "every iteration entry carries the contract keys",
        all(
            set(entry) >= {"audit", "delta", "latencyMs", "render", "applied", "rolledBack"}
            for entry in iterations
        ),
        "an entry is missing a key",
    )
    check(
        "the audit count includes the verification audits",
        delivery["auditCount"] == len(iterations)
        + sum(1 for entry in iterations if "verification" in entry),
        json.dumps(delivery["auditCount"]),
    )
    check(
        "a malformed answer is a soft failure",
        iterations[0]["audit"]["status"] == module.MALFORMED
        and iterations[0]["applied"] is False
        and iterations[0]["delta"] is None,
        json.dumps(iterations[0]),
    )
    check(
        "the loop advanced the iteration counter after a malformed answer",
        delivery["iterationCount"] == 4,
        "%d iterations" % delivery["iterationCount"],
    )
    check(
        "the delivery report names the outcome",
        delivery["outcome"] == "ok",
        delivery["outcome"],
    )
    check(
        "the loop clamped the proposal to the target's range",
        delivery["grade"]["highlights"] == 207.0,
        "highlights landed on %r" % delivery["grade"]["highlights"],
    )
    check(
        "the committed change moved the composite",
        (out_dir / "render_01.png").read_bytes()
        != (out_dir / "render_01_after.png").read_bytes(),
        "the composite did not change",
    )

    inspect = stub.engine().call("doc.inspect", {}).get("result", {})
    levels = None
    for layer in inspect.get("layers", []):
        if layer.get("kind") == "Adjustment" and "Levels" in (layer.get("adjustment") or {}):
            levels = layer["adjustment"]["Levels"]["master"]
    check(
        "the engine's own report shows the committed grade",
        levels is not None and abs(levels["in_white"] - 207.0 / 255.0) < 1e-6,
        json.dumps(levels),
    )
    check(
        "the engine's own report shows the untouched axes",
        levels is not None
        and abs(levels["in_black"]) < 1e-9
        and abs(levels["gamma"] - 1.0) < 1e-6,
        json.dumps(levels),
    )

    check("the best snapshot was delivered", (out_dir / "final.png").exists(), "final.png is missing")
    check(
        "the delivered image is a real PNG",
        (out_dir / "final.png").read_bytes()[:8] == b"\x89PNG\r\n\x1a\n",
        "final.png is not a PNG",
    )
    check(
        "the delivered image is the best snapshot",
        delivery["finalSha256"]
        == hashlib.sha256((out_dir / "final.png").read_bytes()).hexdigest(),
        "the digest does not match the file",
    )

    delivery_text = (out_dir / "delivery.json").read_text()
    iterations_text = (out_dir / "iterations.json").read_text()
    check("the delivery report never carries the token", TOKEN not in delivery_text, "the token leaked")
    check("the iteration log never carries the token", TOKEN not in iterations_text, "the token leaked")
    check(
        "the cost estimate is computed from the token counts",
        delivery["tokens"]["input"] == 1200 * len(vision.calls) and delivery["costUsd"] > 0.0,
        json.dumps(delivery["tokens"]),
    )
    check(
        "the artefacts stay under the write root",
        all(
            path.resolve().is_relative_to(WRITE_ROOT.resolve())
            for path in (
                out_dir / "final.png",
                out_dir / "iterations.json",
                out_dir / "delivery.json",
            )
        ),
        "an artefact escaped the write root",
    )
    check(
        "the audit prompt names the rubric and the enumerated targets",
        "teal-and-orange split tone" in vision.calls[0]["system"]
        and "split-tone-shadows" in vision.calls[0]["system"],
        "the prompt is incomplete",
    )
    check(
        "the audit prompt forbids inventing criteria",
        "Never invent new rubric criteria" in vision.calls[0]["system"],
        "the prompt does not forbid new criteria",
    )

    # ── run 2: a regression is rolled back ────────────────────────────────
    answers = [
        adjustments("contrast", 4.0),
        adjustments("highlights", -3.0, "A more severe violation than the contrast."),
        satisfied(),
    ]
    delivery, stub, vision, out_dir = grade(module, str(binary), source, "P-002", answers)
    iterations = json.loads((out_dir / "iterations.json").read_text())
    check(
        "a regression rolls the change back",
        iterations[0]["rolledBack"] is True and iterations[0]["applied"] is False,
        json.dumps(iterations[0]),
    )
    check(
        "the rollback restored the composite exactly",
        (out_dir / "render_00.png").read_bytes()
        == (out_dir / "render_00_restored.png").read_bytes(),
        "the restored composite differs from the one before the change",
    )
    check(
        "the rolled-back value is not in the delivery report",
        delivery["grade"]["contrast"] == 0.0,
        "contrast landed on %r" % delivery["grade"]["contrast"],
    )
    inspect = stub.engine().call("doc.inspect", {}).get("result", {})
    contrast = None
    for layer in inspect.get("layers", []):
        adjustment = layer.get("adjustment") or {}
        if "BrightnessContrast" in adjustment:
            contrast = adjustment["BrightnessContrast"]["contrast"]
    check(
        "the engine's own report shows the rolled-back value",
        contrast is not None and abs(contrast) < 1e-9,
        "contrast is %r" % (contrast,),
    )

    # ── run 3: the model repeats itself ──────────────────────────────────
    answers = [
        adjustments("highlights", -8.0),
        satisfied(),
        adjustments("highlights", -8.0),
        satisfied(),
        adjustments("highlights", -8.0),
        satisfied(),
        adjustments("highlights", -8.0),
    ]
    delivery, stub, vision, out_dir = grade(module, str(binary), source, "P-003", answers)
    check(
        "the loop stops when the model repeats itself",
        delivery["outcome"] == "stalled",
        delivery["outcome"],
    )
    check(
        "the stalled run stopped at the fourth identical verdict",
        delivery["iterationCount"] == 4,
        "%d iterations" % delivery["iterationCount"],
    )

    # ── run 4: the model oscillates ──────────────────────────────────────
    answers = [
        adjustments("saturation", 6.0),
        satisfied(),
        adjustments("saturation", -9.0),
    ]
    delivery, stub, vision, out_dir = grade(module, str(binary), source, "P-004", answers)
    check(
        "the loop stops when the model oscillates",
        delivery["outcome"] == "oscillating",
        delivery["outcome"],
    )
    check(
        "the oscillating run did not apply the reversing move",
        delivery["grade"]["saturation"] == 24.0,
        "saturation landed on %r" % delivery["grade"]["saturation"],
    )

    # ── the token discipline ──────────────────────────────────────────────
    for label, value in (("a missing token", ""), ("a malformed token", "not-a-token")):
        try:
            module.load_token({module.TOKEN_ENV: value})
        except SystemExit as exit_error:
            raised = exit_error.code == 1
        else:
            raised = False
        check("%s is a fatal startup error" % label, raised, "the loop did not die")

    check(
        "a valid token is accepted",
        module.load_token({module.TOKEN_ENV: TOKEN}) == TOKEN,
        "the token was rejected",
    )

    # ── the channel refuses a first frame that is not the authentication ──
    stub = StubControlServer(str(binary), READ_ROOT, WRITE_ROOT, TOKEN)
    before = stub.connections
    socket_ = socket.create_connection((stub.host, stub.port), timeout=10)
    socket_.sendall(
        (json.dumps({"id": 1, "method": "engine.execute", "params": {}}) + "\n").encode()
    )
    socket_.settimeout(10)
    data = socket_.recv(4096)
    socket_.close()
    check(
        "the channel refuses a first frame that is not the authentication",
        data == b"",
        repr(data[:80]),
    )
    check("the channel recorded the refusal", len(stub.rejected) == 1, "%d refusals" % len(stub.rejected))
    check("the refused connection never reached the engine", not stub.received, "the engine was called")

    socket_ = socket.create_connection((stub.host, stub.port), timeout=10)
    socket_.sendall(
        (
            json.dumps({"id": "auth", "method": "auth", "params": {"token": "0" * 64}}) + "\n"
        ).encode()
    )
    socket_.settimeout(10)
    data = socket_.recv(4096)
    socket_.close()
    check("the channel refuses a wrong token", data == b"", repr(data[:80]))
    check("the refused connections were counted", stub.connections == before + 2, "%d" % stub.connections)

    # ── the headless transport reaches the same engine ───────────────────
    headless = module.HeadlessClient(
        [
            str(binary),
            "mcp",
            "--automation-read-root",
            str(READ_ROOT),
            "--automation-write-root",
            str(WRITE_ROOT),
        ]
    )
    try:
        headless.open_source(source)
        composite = headless.render(256)
        check(
            "the headless transport renders the same engine",
            composite[:8] == b"\x89PNG\r\n\x1a\n" and len(composite) > 0,
            "%d bytes" % len(composite),
        )
        check(
            "the headless transport sees the same registry",
            "image.adjustments.levels" in headless.registry(),
            "the registry is missing a command",
        )
    finally:
        headless.close()

    # ── determinism ───────────────────────────────────────────────────────
    answers = [
        adjustments("highlights", -8.0),
        satisfied(),
        adjustments("saturation", 5.0),
        adjustments("vibrance", 4.0),
        satisfied(),
    ]
    first, _, _, first_dir = grade(module, str(binary), source, "P-005", answers)
    second, _, _, second_dir = grade(module, str(binary), source, "P-006", answers)
    check(
        "two runs of the same script deliver the same image",
        first["finalSha256"] == second["finalSha256"],
        "%s vs %s" % (first["finalSha256"][:12], second["finalSha256"][:12]),
    )
    check(
        "two runs of the same script deliver the same grade",
        first["grade"] == second["grade"],
        json.dumps(first["grade"]) + " vs " + json.dumps(second["grade"]),
    )
    check(
        "two runs of the same script deliver the same decision",
        first["bestIndex"] == second["bestIndex"],
        "%r vs %r" % (first["bestIndex"], second["bestIndex"]),
    )

    for stub in OPEN_STUBS:
        stub.close()
    for cache in HERE.rglob("__pycache__"):
        shutil.rmtree(cache, ignore_errors=True)

    publish = WORK.parent
    for photo in ("P-001", "P-002"):
        for source, suffix in (("final.png", "final.png"), ("delivery.json", "delivery.json"), ("iterations.json", "iterations.json")):
            shutil.copy2(WRITE_ROOT / photo / source, publish / f"{photo}-{suffix}")

    print("%d assertions passed" % PASSED)
    return 0


if __name__ == "__main__":
    sys.exit(main())
