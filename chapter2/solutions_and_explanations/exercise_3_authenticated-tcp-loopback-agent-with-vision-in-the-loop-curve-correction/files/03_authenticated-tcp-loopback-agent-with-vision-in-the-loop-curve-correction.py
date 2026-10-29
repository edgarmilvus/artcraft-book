#!/usr/bin/env python3
"""
vision_curve_agent.py — authenticated TCP loopback agent with vision-in-the-loop.

Transport:   loopback TCP, line-delimited JSON-Lines, one frame per line.
Auth:        64-hex token from PHOTOCRAFT_TOKEN, sent as the VERY FIRST frame.
Sandbox:     --automation-read-root / --automation-write-root on the app.
Safety:      converges within MAX_PASSES, else unwinds every edit it made.

Two deployment shapes are supported by the same client:

  * desktop app (`photocraft --control <port>`): the channel has
    `ui.screenshot`, which writes a PNG of the live window;
  * headless server (`photocraft-cli serve --port <port>`): the channel has
    `doc.render`, which renders the document offscreen (same pixels, no
    window chrome).

`screenshot()` tries `ui.screenshot` first and falls back to `doc.render`, so
the loop below is identical in both.
"""
from __future__ import annotations

import base64, json, os, re, socket, struct, sys, time, urllib.request, zlib
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Contract types
# ---------------------------------------------------------------------------
TOKEN_RE = re.compile(r"^[0-9a-f]{64}$")

class CraftLiveClient:
    """
    Thin authenticated JSON-Lines client for the loopback control channel.

    Read loop invariant: `makefile('r').readline()` yields *exactly one*
    protocol frame per call. We never recv() into a fixed buffer and hope a
    line arrives — that path is the canonical source of partial-JSON bugs
    when the app emits a large screenshot ack.
    """

    def __init__(self, host: str, port: int, token: str, log_path: str,
                 write_root: Optional[str] = None) -> None:
        self._validate_token(token)
        self.sock = socket.create_connection((host, port))
        self.reader = self.sock.makefile("r", encoding="utf-8", newline="\n")
        self._id = 0
        self.log_path = log_path
        self.write_root = write_root or "."

        # MANDATORY: the very first frame on the socket MUST be auth.
        auth = {"id": "auth", "method": "auth", "params": {"token": token}}
        self._send_raw(auth)
        ack = self._read_frame()
        if not ack.get("ok"):
            raise ConnectionRefusedError(f"TCP auth failed: {ack!r}")
        self.log({"event": "auth", "ok": True})

    # -- public API -------------------------------------------------------
    def execute(self, command: str, params: Dict[str, Any]) -> Dict[str, Any]:
        """Send an engine.execute frame; return the app's result payload."""
        frame = self._frame("engine.execute",
                            {"command": command, "params": params})
        reply = self._read_frame()
        self.log({"event": "execute", "command": command, "params": params,
                  "reply_ok": bool(reply.get("ok"))})
        if not reply.get("ok"):
            # A refused command must not look like a successful edit: the
            # convergence loop would then believe it changed the document.
            raise RuntimeError(f"{command} failed: {reply.get('error')!r}")
        return reply.get("result") or {}

    def screenshot(self, rel_path: str, max_side: int = 768) -> str:
        """Capture a PNG beneath the write root and return the absolute path."""
        target = os.path.join(self.write_root, rel_path)
        os.makedirs(os.path.dirname(target) or ".", exist_ok=True)

        # Desktop channel: writes the live-window PNG itself.
        self._frame("ui.screenshot", {"path": rel_path})
        reply = self._read_frame()
        if reply.get("ok"):
            self.log({"event": "screenshot", "path": rel_path,
                      "via": "ui.screenshot", "reply_ok": True})
            return target

        # Headless channel: render the document offscreen. The path variant
        # writes the file; if the build ignores `path`, take the base64.
        self._frame("doc.render", {"path": rel_path, "maxSide": max_side})
        reply = self._read_frame()
        if not reply.get("ok"):
            raise RuntimeError(f"doc.render failed: {reply.get('error')!r}")
        result = reply.get("result") or {}
        if result.get("base64"):
            with open(target, "wb") as fh:
                fh.write(base64.b64decode(result["base64"]))
        self.log({"event": "screenshot", "path": rel_path,
                  "via": "doc.render", "reply_ok": True})
        return target

    def close(self) -> None:
        try: self.reader.close()
        except Exception: pass
        try: self.sock.close()
        except Exception: pass

    # -- internals --------------------------------------------------------
    @staticmethod
    def _validate_token(token: str) -> None:
        # Enforce the exact contract before any bytes leave the process.
        if not isinstance(token, str) or not TOKEN_RE.match(token):
            raise SystemExit(
                "PHOTOCRAFT_TOKEN must be 64 lowercase hex characters "
                "(regex: ^[0-9a-f]{64}$)"
            )

    def _frame(self, method: str, params: Dict[str, Any]) -> int:
        self._id += 1
        self._send_raw({"id": self._id, "method": method, "params": params})
        return self._id

    def _send_raw(self, obj: Dict[str, Any]) -> None:
        payload = (json.dumps(obj) + "\n").encode("utf-8")
        self.sock.sendall(payload)

    def _read_frame(self) -> Dict[str, Any]:
        line = self.reader.readline()
        if line == "":
            raise EOFError("control channel closed by peer")
        return json.loads(line)

    def log(self, record: Dict[str, Any]) -> None:
        record.setdefault("ts", time.time())
        os.makedirs(os.path.dirname(self.log_path) or ".", exist_ok=True)
        with open(self.log_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record) + "\n")


# ---------------------------------------------------------------------------
# Vision model contract
# ---------------------------------------------------------------------------
VISION_PROMPT = (
    "You are auditing a color grading result. Look at the image and decide "
    "whether the tonal balance is acceptable, or propose ONE correction.\n"
    "The target band for mean luma is 110-150 (the measured value is in the "
    "line below). Reply ONLY with JSON in exactly one of these shapes:\n"
    '  {"status":"ok"}\n'
    '  {"fix":"levels","gamma":<number>}\n'
    '  {"fix":"curves","points":[[x,y],...]}\n'
    '  {"fix":"vibrance","vibrance":<number>,"saturation":<number>}\n'
    "Points are in the 0..255 range."
)

VISION_MODEL = os.environ.get(
    "OPENROUTER_VISION_MODEL",
    os.environ.get("OPENAI_MODEL", "openai/gpt-4o-mini"),
)


def _whitelist(decision: Dict[str, Any]) -> Dict[str, Any]:
    """Keep only fields the discriminated union allows."""
    if decision.get("status") == "ok":
        return {"status": "ok"}
    fix = decision.get("fix")
    if fix == "levels" and isinstance(decision.get("gamma"), (int, float)):
        return {"fix": "levels", "gamma": float(decision["gamma"])}
    if fix == "curves" and isinstance(decision.get("points"), list):
        return {"fix": "curves", "points": decision["points"]}
    if fix == "vibrance" and isinstance(decision.get("vibrance"), (int, float)) \
       and isinstance(decision.get("saturation"), (int, float)):
        return {"fix": "vibrance",
                "vibrance": float(decision["vibrance"]),
                "saturation": float(decision["saturation"])}
    # Unknown verb → treat as a no-op, never as a mutation.
    return {"status": "ok"}


def call_vision(png_bytes: bytes) -> Dict[str, Any]:
    """
    Send the PNG to a multimodal model and delete any field not in the
    contract, so the agent never mutates the engine based on an off-schema
    reply (a Level 1 ground-truth violation waiting to happen).

    The request goes to any OpenAI-compatible endpoint — OpenRouter by
    default, via plain `urllib` so the agent has no third-party dependency.
    With no key configured, a deterministic luma heuristic stands in, which
    keeps the convergence/unwind logic testable offline.
    """
    key = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OPENAI_API_KEY")
    if not key:
        return _heuristic_decision(png_bytes)

    base = (os.environ.get("OPENROUTER_BASE_URL")
            or os.environ.get("OPENAI_BASE_URL")
            or "https://openrouter.ai/api/v1").rstrip("/")
    b64 = base64.b64encode(png_bytes).decode("ascii")
    # One number is enough context to stop the model asking for "brighter"
    # forever: the measured luma against the target band.
    measured = _png_mean_luma(png_bytes)
    prompt = VISION_PROMPT if measured is None else (
        f"{VISION_PROMPT}\nMeasured mean luma: {measured:.0f}/255.")
    body = {
        "model": VISION_MODEL,
        "max_tokens": 60,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url",
                 "image_url": {"url": f"data:image/png;base64,{b64}"}},
            ],
        }],
    }
    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {key}",
                 "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    content = payload["choices"][0]["message"]["content"]
    decision = json.loads(content) if isinstance(content, str) else content
    return _whitelist(decision)


# ---------------------------------------------------------------------------
# Deterministic stand-in for the vision model (no API key).
# ---------------------------------------------------------------------------
def _png_mean_luma(data: bytes) -> Optional[float]:
    """Mean luma of an 8-bit non-interlaced PNG, using only the stdlib."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    off, width, height, depth, color = 8, 0, 0, 0, 0
    idat = bytearray()
    while off < len(data):
        (length,) = struct.unpack(">I", data[off:off + 4])
        ctype = data[off + 4:off + 8]
        chunk = data[off + 8:off + 8 + length]
        if ctype == b"IHDR":
            width, height, depth, color = struct.unpack(">IIBB", chunk[:10])
        elif ctype == b"IDAT":
            idat += chunk
        elif ctype == b"IEND":
            break
        off += 12 + length
    if depth != 8 or color not in (0, 2, 4, 6):
        return None
    bpp = {0: 1, 2: 3, 4: 2, 6: 4}[color]
    stride = width * bpp
    raw = zlib.decompress(bytes(idat))
    prev = bytearray(stride)
    total, count = 0.0, 0
    pos = 0
    for _ in range(height):
        filt = raw[pos]; pos += 1
        row = bytearray(raw[pos:pos + stride]); pos += stride
        for x in range(stride):
            a = row[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            v = row[x]
            if filt == 1: v = (v + a) & 0xFF
            elif filt == 2: v = (v + b) & 0xFF
            elif filt == 3: v = (v + ((a + b) >> 1)) & 0xFF
            elif filt == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                v = (v + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 0xFF
            row[x] = v
        prev = row
        for x in range(width):
            i = x * bpp
            if color in (0, 4):
                r = g = bl = row[i]
            else:
                r, g, bl = row[i], row[i + 1], row[i + 2]
            total += 0.299 * r + 0.587 * g + 0.114 * bl
            count += 1
    return total / max(1, count)


def _heuristic_decision(png_bytes: bytes) -> Dict[str, Any]:
    luma = _png_mean_luma(png_bytes)
    if luma is None:
        return {"status": "ok"}
    if luma < 96:
        return {"fix": "levels", "gamma": 1.25}
    if luma > 176:
        return {"fix": "levels", "gamma": 0.85}
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
INITIAL_POINTS: List[List[int]] = [[0, 0], [64, 40], [192, 215], [255, 255]]
MAX_PASSES = 6
MIN_REFINEMENT_PASSES = 3   # the exercise requires at least three refinements


def ensure_document(client: "CraftLiveClient") -> None:
    """The desktop app always has a document; a headless server does not."""
    try:
        session = client._frame("session.list", {})
        reply = client._read_frame()
        docs = (reply.get("result") or {}).get("documents") or []
    except Exception:
        docs = []
    if docs:
        return
    width = int(os.environ.get("DOC_WIDTH", "640"))
    height = int(os.environ.get("DOC_HEIGHT", "400"))
    client._frame("doc.new", {"width": width, "height": height,
                              "mode": "rgb", "depth": 8,
                              "background": "#2a3346"})
    if not client._read_frame().get("ok"):
        raise RuntimeError("could not create a document")
    # Something for the curves to act on: a dark-to-light ramp.
    client.execute("layer.newFillLayer.gradient", {
        "from": "#0b1530", "to": "#f4d7a1", "angle": 90, "style": "linear"})


def main() -> int:
    token = os.environ.get("PHOTOCRAFT_TOKEN", "")
    host  = os.environ.get("PHOTOCRAFT_HOST", "127.0.0.1")
    port  = int(os.environ.get("PHOTOCRAFT_PORT", "7979"))
    write_root = os.environ.get("WRITE_ROOT", ".")

    log_path = os.environ.get("AGENT_LOG", "logs/vision_curve_exchange.jsonl")
    # Truncate on start so the JSONL is append-only per run.
    os.makedirs(os.path.dirname(log_path) or ".", exist_ok=True)
    open(log_path, "w").close()

    client = CraftLiveClient(host, port, token, log_path, write_root=write_root)
    applied_edits = 0
    winning_curve = list(INITIAL_POINTS)
    shot_paths: List[str] = []
    try:
        ensure_document(client)

        # Snapshot the visual state for the audit trail (no parameter
        # read-back: the exercise forbids a `layer.newAdjustmentLayer.curves`
        # "read-back"; a rendered snapshot is the read-only substitute).
        snap = "audit/vision_curve_pass_0.png"
        client.screenshot(snap)
        shot_paths.append(snap)

        # Pass 0: apply the initial curve so there is something to judge.
        client.execute("layer.newAdjustmentLayer.curves",
                       {"points": winning_curve})
        applied_edits += 1

        converged = False
        passes = 0
        while passes < MAX_PASSES:
            passes += 1
            rel = f"audit/vision_curve_pass_{passes}.png"
            shot_path = client.screenshot(rel)
            shot_paths.append(rel)

            with open(shot_path, "rb") as fh:
                png_bytes = fh.read()

            decision = call_vision(png_bytes)
            client.log({"event": "vision_decision",
                        "pass": passes, "decision": decision})

            if decision.get("status") == "ok" and passes >= MIN_REFINEMENT_PASSES:
                converged = True
                break

            # Translate decision into the next engine call.
            fix = decision.get("fix")
            if fix == "levels":
                client.execute("layer.newAdjustmentLayer.levels",
                               {"gamma": decision["gamma"]})
                applied_edits += 1
            elif fix == "curves":
                winning_curve = decision["points"]
                client.execute("layer.newAdjustmentLayer.curves",
                               {"points": winning_curve})
                applied_edits += 1
            elif fix == "vibrance":
                client.execute("layer.newAdjustmentLayer.vibrance", {
                    "vibrance": decision["vibrance"],
                    "saturation": decision["saturation"]})
                applied_edits += 1
            # Unknown verbs were already collapsed to "ok" in `call_vision`.

        if converged:
            client.log({"event": "final", "converged": True,
                        "passes": passes, "winning_curve": winning_curve,
                        "applied_edits": applied_edits})
            return 0

        # ---- Non-convergence: unwind every edit we made -------------------
        for _ in range(applied_edits):
            client.execute("edit.undo", {})
        client.log({"event": "final", "converged": False,
                    "passes": passes, "reverted_edits": applied_edits,
                    "winning_curve": None})
        return 2

    finally:
        client.close()

if __name__ == "__main__":
    sys.exit(main())
