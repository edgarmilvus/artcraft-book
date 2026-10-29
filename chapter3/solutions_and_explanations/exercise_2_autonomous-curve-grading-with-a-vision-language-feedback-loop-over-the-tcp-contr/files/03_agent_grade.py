# agent_grade.py — autonomous curve grading with a VL feedback loop over the
# TCP control channel.
#
# Transport note (verified against photocraft-cli 0.8.2): the control channel
# exposes `engine.execute`, `jobs.list`, `doc.open`, `doc.render`, … but it has
# **no** `ui.screenshot` and no `command_run` method. The screenshot is
# `doc.render {path, maxSide}` (relative to the write root); the jobs are
# `jobs.list`. `ui.screenshot` only exists as a desktop MCP tool, so the
# "live window" story in the brief is a desktop-only variant of the same loop.
import base64
import hashlib
import json
import os
import random
import re
import socket
import struct
import sys
import time
import urllib.request
import zlib
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

# ---------- Config ----------
WRITE_ROOT = os.environ.get("CRAFT_WRITE_ROOT", os.getcwd())
AUDIT_DIR = os.environ.get("GRADE_AUDIT_DIR", "grade")
MODEL = os.environ.get("VISION_MODEL") or os.environ.get(
    "OPENROUTER_VISION_MODEL", "openai/gpt-4o-mini")
MAX_ITER = int(os.environ.get("GRADE_MAX_ITER", "5"))
CONF_THRESH = 0.85
MAX_TOKENS = int(os.environ.get("MAX_VISION_TOKENS", "250000"))
MALFORMED_CAP = 3

# The prompt is a versioned artifact: the loop records its hash next to every
# decision so a dispute can be settled with the exact text that was in force.
PROMPT_TEXT = (
    "You are auditing a colour grading result. Look at the image and decide "
    "whether the tonal balance is acceptable, or propose ONE correction.\n"
    "The target band for mean luma is 110-150 (the measured value is below).\n"
    "Reply ONLY with JSON in exactly one of these shapes:\n"
    '  {"status":"ok","confidence":0.0-1.0}\n'
    '  {"status":"fix","confidence":0.0-1.0,"fix":{"kind":"levels","gamma":n}}\n'
    '  {"status":"fix","confidence":0.0-1.0,"fix":{"kind":"curves","points":[[x,y],...]}}\n'
    '  {"status":"fix","confidence":0.0-1.0,"fix":{"kind":"exposure","exposure":n}}\n'
    "Points are in the 0..255 range."
)
PROMPT_PATH = os.environ.get("PROMPT_PATH")
if PROMPT_PATH:
    with open(PROMPT_PATH, "rb") as fh:
        PROMPT_BYTES = fh.read()
else:
    PROMPT_BYTES = PROMPT_TEXT.encode("utf-8")
PROMPT_HASH = hashlib.sha256(PROMPT_BYTES).hexdigest()
TOKEN_RE = re.compile(r"^[0-9a-f]{64}$")


# ---------- Transport ----------
@dataclass
class TcpControl:
    """Authenticated loopback control channel. Mandatory auth frame first."""
    host: str = "127.0.0.1"
    port: int = 7979
    # The same variable the server understands, so one secret configures both
    # ends; PHOTOCRAFT_TOKEN is accepted as a legacy alias.
    token: str = field(default_factory=lambda: (
        os.environ.get("PHOTOCRAFT_CONTROL_TOKEN")
        or os.environ.get("PHOTOCRAFT_TOKEN", "")))
    write_root: str = field(default_factory=lambda: WRITE_ROOT)
    _id: int = 0
    sock: Optional[socket.socket] = None
    reader: Any = None

    def __post_init__(self) -> None:
        if not TOKEN_RE.match(self.token):
            raise SystemExit("PHOTOCRAFT_CONTROL_TOKEN must be 64 lowercase hex chars")
        s = socket.create_connection((self.host, self.port), timeout=30)
        self.sock = s
        self.reader = s.makefile("r", encoding="utf-8", newline="\n")
        ack = self.call("auth", {"token": self.token})
        if not ack.get("ok"):
            raise ConnectionRefusedError(f"control auth failed: {ack.get('error')}")

    def call(self, method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        self._id += 1
        frame = {"id": self._id, "method": method, "params": params or {}}
        assert self.sock is not None
        self.sock.sendall((json.dumps(frame) + "\n").encode())
        line = self.reader.readline()
        if not line:
            raise EOFError("control channel closed")
        return json.loads(line)

    def execute(self, command: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Run one registry command; a refusal raises instead of looking like a fix."""
        reply = self.call("engine.execute", {"command": command, "params": params or {}})
        if not reply.get("ok"):
            raise RuntimeError(f"{command} failed: {reply.get('error')!r}")
        return reply.get("result") or {}

    def close(self) -> None:
        try:
            self.reader.close()
        except Exception:
            pass
        try:
            self.sock.close()  # type: ignore[union-attr]
        except Exception:
            pass

    def __enter__(self) -> "TcpControl":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()


def sample_render(tcp: TcpControl, tag: str) -> Tuple[str, str]:
    """Render the document offscreen and return (absolute path, sha256).

    `doc.render` writes the PNG relative to the write root and answers
    `{bytes, path}` — no base64, no `ui.screenshot`.
    """
    rel = f"{AUDIT_DIR}/audit_{tag}.png"
    target = os.path.join(tcp.write_root, rel)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    tcp.call("doc.render", {"path": rel, "maxSide": 768})
    with open(target, "rb") as fh:
        digest = hashlib.sha256(fh.read()).hexdigest()
    return target, digest


def drain_jobs(tcp: TcpControl, poll: float = 0.05, deadline: float = 30.0) -> None:
    """Refuse to issue a new adjustment until the previous job reports done."""
    start = time.time()
    while True:
        r = tcp.call("jobs.list", {})
        jobs = (r.get("result") or {}).get("jobs") or []
        if not any(j.get("state") == "running" for j in jobs):
            return
        if time.time() - start > deadline:
            raise TimeoutError("a jobs.list poll exceeded 30 s")
        time.sleep(poll)


# ---------- Vision model call (pluggable) ----------
def call_vision(image_path: str, budget: Dict[str, int]) -> Dict[str, Any]:
    """Ask for one decision, enforcing the JSON contract and a token budget."""
    with open(image_path, "rb") as fh:
        png = fh.read()
    decision, used = _vl_client_audit(png)
    budget["used"] += used
    if budget["used"] > MAX_TOKENS:
        raise RuntimeError(f"token budget exhausted: {budget['used']} > {MAX_TOKENS}")
    return _whitelist(decision)


def call_vision_with_backoff(image_path: str, budget: Dict[str, int]) -> Dict[str, Any]:
    """Retry on 429 with base-2s exponential backoff, jitter ±20%, max 3 retries."""
    base, jitter, tries = 2.0, 0.20, 0
    while True:
        try:
            return call_vision(image_path, budget)
        except Exception as e:  # noqa: BLE001 - status codes come in many types
            code = getattr(e, "status", None) or getattr(e, "code", None)
            if code != 429 or tries >= 3:
                raise
            delay = base * (2 ** tries) * (1 + random.uniform(-jitter, jitter))
            time.sleep(delay)
            tries += 1


VISION_PROMPT = PROMPT_TEXT


def _vl_client_audit(png: bytes) -> Tuple[Dict[str, Any], int]:
    """OpenRouter (OpenAI-compatible) call via `urllib`; offline luma fallback."""
    key = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OPENAI_API_KEY")
    if not key:
        return _heuristic_decision(png), 0

    base = (os.environ.get("OPENROUTER_BASE_URL")
            or "https://openrouter.ai/api/v1").rstrip("/")
    measured = _png_mean_luma(png)
    prompt = VISION_PROMPT if measured is None else (
        f"{VISION_PROMPT}\nMeasured mean luma: {measured:.0f}/255.")
    body = {
        "model": MODEL,
        "max_tokens": 80,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url",
                 "image_url": {"url": "data:image/png;base64,"
                               + base64.b64encode(png).decode("ascii")}},
            ],
        }],
    }
    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    content = payload["choices"][0]["message"]["content"]
    used = int((payload.get("usage") or {}).get("total_tokens") or 0)
    return json.loads(content), used


def _whitelist(decision: Dict[str, Any]) -> Dict[str, Any]:
    """Keep only the fields the contract allows; anything else is `invalid`.

    An unknown verb must not be read as approval: a model that asks for
    `contrast` has not audited the image, and treating that as `ok` would let
    the loop converge on a frame nobody approved.
    """
    status = decision.get("status")
    conf = float(decision.get("confidence", 0.0) or 0.0)
    if status == "ok":
        return {"status": "ok", "confidence": conf}
    fix = decision.get("fix") or {}
    kind = fix.get("kind")
    if status == "fix" and kind == "levels" and isinstance(fix.get("gamma"), (int, float)):
        return {"status": "fix", "confidence": conf,
                "fix": {"kind": "levels", "gamma": float(fix["gamma"])}}
    if status == "fix" and kind == "curves" and isinstance(fix.get("points"), list):
        return {"status": "fix", "confidence": conf,
                "fix": {"kind": "curves", "points": fix["points"]}}
    if status == "fix" and kind == "exposure" and isinstance(fix.get("exposure"), (int, float)):
        return {"status": "fix", "confidence": conf,
                "fix": {"kind": "exposure", "exposure": float(fix["exposure"])}}
    return {"status": "invalid", "confidence": conf,
            "reason": f"unsupported decision: {status}/{kind}"}


# ---------- Deterministic stand-in for the vision model (no API key) --------
def _png_mean_luma(data: bytes) -> Optional[float]:
    """Mean luma of an 8-bit non-interlaced PNG, stdlib only."""
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
            if filt == 1:
                v = (v + a) & 0xFF
            elif filt == 2:
                v = (v + b) & 0xFF
            elif filt == 3:
                v = (v + ((a + b) >> 1)) & 0xFF
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


def _heuristic_decision(png: bytes) -> Dict[str, Any]:
    luma = _png_mean_luma(png)
    if luma is None:
        return {"status": "ok", "confidence": 1.0}
    if luma < 96:
        return {"status": "fix", "confidence": 0.9,
                "fix": {"kind": "levels", "gamma": 1.3}}
    if luma < 110:
        return {"status": "fix", "confidence": 0.86,
                "fix": {"kind": "exposure", "exposure": 0.5}}
    if luma > 160:
        return {"status": "fix", "confidence": 0.9,
                "fix": {"kind": "levels", "gamma": 0.75}}
    return {"status": "ok", "confidence": 0.95}


# ---------- The loop ----------
def grade_photo(tcp: TcpControl, photo_relative: str) -> Dict[str, Any]:
    audit_log: List[Dict[str, Any]] = []
    applied: List[Tuple[str, Dict[str, Any]]] = []
    best: Optional[Tuple[float, int]] = None     # (confidence, iteration index)
    malformed_streak = 0
    budget = {"used": 0}

    # Open the photo: `doc.open` is a channel method, not a registry command.
    tcp.call("doc.open", {"path": photo_relative})
    drain_jobs(tcp)

    for it in range(MAX_ITER):
        path, image_sha = sample_render(tcp, f"{it:02d}")
        try:
            audit = call_vision_with_backoff(path, budget)
        except (json.JSONDecodeError, KeyError, TypeError):
            malformed_streak += 1
            if malformed_streak >= MALFORMED_CAP:
                for _ in applied:
                    tcp.execute("edit.undo", {})
                raise RuntimeError("3 malformed JSON responses in a row; rolled back")
            # A single bad payload is not a decision: record it and retry the
            # loop without touching the document or the previous `audit` value.
            audit_log.append({"promptHash": PROMPT_HASH, "imageSha": image_sha,
                              "iter": it, "appliedCommand": None,
                              "appliedParams": None, "audit": None,
                              "error": "malformed model response"})
            continue

        if audit.get("status") == "invalid":
            # Same treatment as a malformed payload: no correction, no
            # convergence, and the streak counter keeps running.
            malformed_streak += 1
            if malformed_streak >= MALFORMED_CAP:
                for _ in applied:
                    tcp.execute("edit.undo", {})
                raise RuntimeError("3 unusable model replies in a row; rolled back")
            audit_log.append({"promptHash": PROMPT_HASH, "imageSha": image_sha,
                              "iter": it, "appliedCommand": None,
                              "appliedParams": None, "audit": audit,
                              "error": "unusable model response"})
            continue

        malformed_streak = 0               # a usable decision resets the streak
        rec: Dict[str, Any] = {"promptHash": PROMPT_HASH, "imageSha": image_sha,
                               "iter": it, "appliedCommand": None,
                               "appliedParams": None, "audit": audit}
        audit_log.append(rec)

        if audit.get("status") == "ok" and float(audit.get("confidence", 1.0)) >= CONF_THRESH:
            return {"convergedAt": it, "finalDocument": photo_relative,
                    "audit": audit_log, "tokensUsed": budget["used"]}

        if audit.get("status") == "fix":
            conf = float(audit.get("confidence", 0.0))
            if best is None or conf > best[0]:
                best = (conf, it)

            fix = audit.get("fix") or {}
            kind = fix.get("kind")
            if kind == "levels":
                cmd, params = "image.adjustments.levels", {"gamma": float(fix.get("gamma", 1.0))}
            elif kind == "curves":
                cmd, params = "image.adjustments.curves", {"points": fix.get("points")}
            elif kind == "exposure":
                cmd, params = "image.adjustments.exposure", {"exposure": float(fix.get("exposure", 0.0))}
            else:
                rec["error"] = f"unknown fix kind: {kind}"
                continue

            tcp.execute(cmd, params)
            drain_jobs(tcp)                     # MUST gate on jobs.list
            applied.append((cmd, params))
            rec["appliedCommand"] = cmd
            rec["appliedParams"] = params

    # Non-convergence: deterministically replay back to the best iteration.
    if best is not None:
        target_it = best[1]
        undos = sum(1 for r in audit_log if r["iter"] > target_it and r["appliedCommand"])
        for _ in range(undos):
            tcp.execute("edit.undo", {})

    return {"convergedAt": None, "best": best, "audit": audit_log,
            "tokensUsed": budget["used"], "status": "non_convergent",
            "finalDocument": photo_relative}


# ---------- CLI ----------
def main() -> int:
    archives = sys.argv[1:]
    if not archives:
        print("usage: agent_grade.py <relative-photo>...", file=sys.stderr)
        return 2
    token = (os.environ.get("PHOTOCRAFT_CONTROL_TOKEN")
             or os.environ.get("PHOTOCRAFT_TOKEN", ""))
    port = int(os.environ.get("PHOTOCRAFT_PORT", "7979"))
    all_audits: List[Dict[str, Any]] = []
    try:
        with TcpControl(port=port, token=token, write_root=WRITE_ROOT) as tcp:
            for photo in archives:
                try:
                    res = grade_photo(tcp, photo)
                except Exception as e:  # noqa: BLE001 - reported as a JSON error line
                    print(json.dumps({"photo": photo, "error": str(e)}), file=sys.stderr)
                    return 1
                all_audits.append(res)
                status = "ok" if res["convergedAt"] is not None else "non_convergent"
                print(json.dumps({"photo": photo, "status": status,
                                  "iterations": len(res["audit"]),
                                  "convergedAt": res["convergedAt"],
                                  "tokensUsed": res["tokensUsed"]}))
    except Exception as e:  # noqa: BLE001 - authentication / connection failures
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        return 1

    # Persist the audit trail (prompt hash + image hash per decision).
    trail = os.path.join(WRITE_ROOT, AUDIT_DIR, "audit_trail.jsonl")
    os.makedirs(os.path.dirname(trail), exist_ok=True)
    with open(trail, "w", encoding="utf-8") as f:
        for a in all_audits:
            f.write(json.dumps(a) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
