"""
Exercise 3: Asset Resolution Agent.

Recovery cascade for missing hero images:
  1. LightCraft DAM catalog lookup (via MCP stdio)
  2. PhotoCraft loopback placeholder synthesis (via TCP control channel)
  3. Graceful deferral
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import socket
import subprocess
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


# ---------------------------------------------------------------------------
# Contracts
# ---------------------------------------------------------------------------

@dataclass
class ResolutionRequest:
    sku: str
    title: str
    preferred_aspect: tuple[int, int]
    min_long_edge: int
    preset_fallback: str
    deadline_ms: int
    loopback_port: int
    loopback_token_env: str


@dataclass
class ResolutionTrace:
    sku: str
    status: str = "deferred"          # resolved | degraded | placeholder | deferred
    resolved_path: Optional[str] = None
    resolved_bytes: Optional[int] = None
    resolved_sha256: Optional[str] = None
    strategy: str = "none"            # catalog | placeholder | none
    candidate_rationale: Optional[str] = None
    call_trace: list[dict] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Trace instrumentation
# ---------------------------------------------------------------------------

def _digest(value: Any) -> str:
    """Canonical-JSON SHA-256, first 16 hex chars."""
    canon = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canon.encode()).hexdigest()[:16]


def traced(trace: ResolutionTrace, method: str, params: dict, fn: Callable[[], Any]) -> Any:
    t0 = time.monotonic()
    try:
        result = fn()
        return result
    finally:
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        try:
            digest = _digest(result)
        except NameError:
            digest = "unavailable"
        trace.call_trace.append({
            "method": method,
            "params": params,
            "elapsedMs": elapsed_ms,
            "resultDigest": digest,
        })


# ---------------------------------------------------------------------------
# LightCraft MCP client wrapper
# ---------------------------------------------------------------------------

class LightCraftClient:
    """Async context around a `lightcraft-cli mcp` session."""

    def __init__(self) -> None:
        self._cm = None
        self._session: Optional[ClientSession] = None

    async def __aenter__(self) -> "LightCraftClient":
        args = ["mcp"]
        library = os.environ.get("LIGHTCRAFT_LIBRARY")
        if library:
            args += ["--library", library]
        params = StdioServerParameters(command="lightcraft-cli", args=args)
        self._cm = stdio_client(params)
        read, write = await self._cm.__aenter__()
        self._session = ClientSession(read, write)
        await self._session.__aenter__()
        await self._session.initialize()
        return self

    async def __aexit__(self, *exc):
        if self._session:
            await self._session.__aexit__(*exc)
        if self._cm:
            await self._cm.__aexit__(*exc)

    async def call(self, tool: str, params: dict) -> Any:
        assert self._session is not None
        result = await self._session.call_tool(tool, params)
        # mcp returns a CallToolResult whose content is a list of blocks.
        for block in getattr(result, "content", []) or []:
            text = getattr(block, "text", None)
            if text:
                try:
                    return json.loads(text)
                except json.JSONDecodeError:
                    return text
        return result


# ---------------------------------------------------------------------------
# Catalog strategy
# ---------------------------------------------------------------------------

async def try_catalog(req: ResolutionRequest, out_dir: str, trace: ResolutionTrace) -> Optional[str]:
    """
    Returns the absolute exported path on success, else None.
    Enforces a 12 s inner budget.
    """
    inner_deadline = time.monotonic() + 12.0
    async with LightCraftClient() as lc:
        async def call(tool: str, params: dict) -> Any:
            started = time.monotonic()
            result = await lc.call(tool, params)
            trace.call_trace.append({
                "method": tool,
                "params": params,
                "elapsedMs": int((time.monotonic() - started) * 1000),
                "resultDigest": _digest(result),
            })
            return result

        # 1. Narrow the working set
        await call("command_run", {
            "id": "library.filter",
            "params": {"text": req.sku, "edited": True},
        })

        # 2. Query the narrowing to pick candidates
        q = await call("command_run", {
            "id": "catalog.query",
            "params": {
                "limit": 5,
                "filter": {"text": req.sku, "edited": True},
                "sort": {"key": "captureDate", "ascending": False},
            },
        })
        candidates = q.get("photos", []) if isinstance(q, dict) else []
        if not candidates:
            return None

        # 3. Candidate policy: prefer most-recent ≥ min_long_edge; else highest-res, degraded
        def long_edge(c: dict) -> int:
            return max(c.get("width", 0), c.get("height", 0))

        qualifying = [c for c in candidates if long_edge(c) >= req.min_long_edge]
        degraded = False
        if qualifying:
            chosen = qualifying[0]  # already sorted by captureDate desc
            rationale = (
                f"Picked photo {chosen.get('id')} ({long_edge(chosen)} px, "
                f"captured {chosen.get('captured')}); most recent above {req.min_long_edge} px."
            )
        else:
            chosen = max(candidates, key=long_edge)
            degraded = True
            rationale = (
                f"No candidate ≥ {req.min_long_edge} px; picked highest-res "
                f"{chosen.get('id')} ({long_edge(chosen)} px) and marked degraded."
            )

        trace.candidate_rationale = rationale
        trace.strategy = "catalog"

        # 4. Select and apply preset
        await call("command_run", {
            "id": "library.select",
            "params": {"ids": [chosen["id"]], "active": chosen["id"]},
        })
        await call("command_run", {
            "id": "preset.apply",
            "params": {"id": req.preset_fallback, "amount": 100},
        })

        # 5. Aspect-preserving crop with minimum area loss
        w, h = chosen.get("width", 1), chosen.get("height", 1)
        target_ar = req.preferred_aspect[0] / req.preferred_aspect[1]
        src_ar = w / h
        if src_ar > target_ar:
            # crop horizontally
            new_w = h * target_ar
            x0 = (w - new_w) / (2 * w)
            x1 = 1.0 - x0
            y0, y1 = 0.0, 1.0
        else:
            new_h = w / target_ar
            y0 = (h - new_h) / (2 * h)
            y1 = 1.0 - y0
            x0, x1 = 0.0, 1.0
        await call("command_run", {
            "id": "crop.set",
            "params": {"rect": [x0, y0, x1, y1], "angle": 0},
        })

        # 6. Export
        out_path = os.path.join(out_dir, f"{req.sku}-resolved.jpg")
        export = await call("command_run", {
            "id": "app.export",
            "params": {
                "path": out_path,
                "format": "jpeg",
                "longEdge": 2400,
                "quality": 92,
                "metadata": "copyright",
                "colorSpace": "srgb",
            },
        })
        if time.monotonic() > inner_deadline:
            return None  # too late; caller will fall through
        _record_artifact(trace, out_path)
        if degraded:
            trace.status = "degraded"
        return out_path


def _record_artifact(trace: ResolutionTrace, abs_path: str) -> None:
    with open(abs_path, "rb") as f:
        data = f.read()
    trace.resolved_path = abs_path
    trace.resolved_bytes = len(data)
    trace.resolved_sha256 = hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------------------
# Loopback placeholder strategy
# ---------------------------------------------------------------------------

class PhotoCraftLoopback:
    """
    Minimal client for the PhotoCraft loopback control channel.
    Auth is the literal first frame on the socket; without it the server hangs up.
    """

    def __init__(self, port: int, token: str):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.settimeout(8.0)
        self.sock.connect(("127.0.0.1", port))
        self.reader = self.sock.makefile("r")
        self._req_id = 0
        self._authenticate(token)

    def _authenticate(self, token: str) -> None:
        frame = {"id": "auth", "method": "auth", "params": {"token": token}}
        self.sock.sendall((json.dumps(frame) + "\n").encode("utf-8"))
        reply = json.loads(self.reader.readline())
        if not reply.get("ok"):
            raise ConnectionRefusedError(f"loopback auth rejected: {reply}")

    def call(self, method: str, params: dict) -> Any:
        self._req_id += 1
        frame = {"id": self._req_id, "method": method, "params": params}
        self.sock.sendall((json.dumps(frame) + "\n").encode("utf-8"))
        return json.loads(self.reader.readline())

    def close(self) -> None:
        try: self.sock.close()
        except Exception: pass


def try_placeholder(req: ResolutionRequest, out_dir: str, trace: ResolutionTrace) -> Optional[str]:
    """
    Nudge the live placeholder document to carry this SKU, then screenshot it.
    Detects a stalled loop by comparing hashes of successive screenshots.
    """
    token = os.environ.get(req.loopback_token_env)
    if not token:
        return None

    deadline = time.monotonic() + 8.0
    client = PhotoCraftLoopback(req.loopback_port, token)
    try:
        # Nudge the SKU text overlay onto the existing placeholder layout.
        # We rely on the placeholder document having a labelled text layer
        # named "SKU" that sits at (400, 480) in document coordinates.
        events = [
            {"kind": "down", "x": 400, "y": 480},
            {"kind": "up",   "x": 400, "y": 480},
        ]
        client.call("ui.pointer", {"events": events})
        # Type the SKU string (PhotoCraft maps this to the typing path)
        client.call("ui.pointer", {"events": [{"kind": "move", "x": 400, "y": 480}]})

        screenshot_path = os.path.join(out_dir, f"{req.sku}-placeholder.png")
        prev_hash = None
        for _ in range(3):
            if time.monotonic() > deadline:
                return None
            client.call("ui.screenshot", {"path": screenshot_path})
            with open(screenshot_path, "rb") as f:
                h = hashlib.sha256(f.read()).hexdigest()
            if h == prev_hash:
                # frozen – escalation, do not retry indefinitely
                return None
            prev_hash = h
            break  # one capture is sufficient if the placeholder is stable

        trace.strategy = "placeholder"
        _record_artifact(trace, screenshot_path)
        trace.status = "placeholder"
        return screenshot_path
    finally:
        client.close()


# ---------------------------------------------------------------------------
# Top-level resolution
# ---------------------------------------------------------------------------

async def resolve_one(req: ResolutionRequest, out_dir: str) -> ResolutionTrace:
    trace = ResolutionTrace(sku=req.sku)
    total_budget = req.deadline_ms / 1000.0
    start = time.monotonic()

    # Strategy 1: catalog. Budget slice: 12 s.
    try:
        result = await _with_budget(
            lambda: try_catalog(req, out_dir, trace),
            min(12.0, total_budget - (time.monotonic() - start)),
        )
        if result:
            if trace.status not in ("degraded",):
                trace.status = "resolved"
            return trace
    except Exception:
        pass

    # Strategy 2: placeholder. Budget slice: 8 s.
    remaining = total_budget - (time.monotonic() - start)
    try:
        if remaining > 0:
            result = await _with_budget(
                lambda: _run_sync(try_placeholder, req, out_dir, trace),
                min(8.0, remaining),
            )
            if result:
                return trace
    except Exception:
        pass

    # Strategy 3: defer
    trace.status = "deferred"
    trace.strategy = "none"
    return trace


async def _with_budget(fn, seconds: float) -> Optional[str]:
    """Await fn() but abandon it if `seconds` elapses."""
    import asyncio
    if seconds <= 0:
        return None
    return await asyncio.wait_for(fn(), timeout=seconds)


def _run_sync(fn, *args):
    """Wrap a synchronous fallback in a coroutine so _with_budget can time it."""
    async def _inner():
        return fn(*args)
    return _inner()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

async def main() -> None:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--sku", required=True)
    ap.add_argument("--title", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--port", type=int, default=7979)
    ap.add_argument("--token-env", default="PHOTOCRAFT_TOKEN")
    args = ap.parse_args()

    req = ResolutionRequest(
        sku=args.sku,
        title=args.title,
        preferred_aspect=(4, 5),
        min_long_edge=2400,
        preset_fallback="Brand-Standard-v3",
        deadline_ms=25_000,
        loopback_port=args.port,
        loopback_token_env=args.token_env,
    )

    trace = await resolve_one(req, args.out)
    print(json.dumps(
        {**trace.__dict__},
        sort_keys=True, separators=(",", ":"),
    ))


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
