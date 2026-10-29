#!/usr/bin/env python3
"""
run_ex3.py -- acceptance harness for Chapter 2, Exercise 3.

Starts a real `photocraft-cli serve` loopback server with a fresh 64-hex
control token, runs the vision-in-the-loop agent with the deterministic luma
stand-in (no API key), then reads the exchange log, the rendered PNGs and the
live session back out of the engine. Also checks that a wrong token is
refused and that a correct token still works afterwards.
"""
from __future__ import annotations

import importlib.util
import json
import os
import secrets
import shutil
import socket
import struct
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "output"
REPO = HERE.parents[3]
CLIS = REPO / "tools" / "craft-cli" / "bin"
SOLUTION = HERE / "03_authenticated-tcp-loopback-agent-with-vision-in-the-loop-curve-correction.py"
INITIAL_CURVE = [[0, 0], [64, 40], [192, 215], [255, 255]]

checks = 0
failures: list[str] = []
quirks: list[str] = []
lines: list[str] = []


def say(line: str = "") -> None:
    lines.append(line)
    print(line)


def check(label: str, condition: bool, detail: str = "") -> None:
    global checks
    checks += 1
    if not condition:
        failures.append(label)
    say(f"{' ok ' if condition else 'FAIL'} {label:<58}{detail}")


def equal(label: str, actual: object, expected: object, detail: str = "") -> None:
    check(label, actual == expected, detail or f"expected {expected!r}, got {actual!r}")


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def png_ihdr(path: Path) -> tuple[int, int, int, int] | None:
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    length = struct.unpack(">I", data[8:12])[0]
    if data[12:16] != b"IHDR" or length < 13:
        return None
    width, height, depth, color = struct.unpack(">IIBB", data[16:26])
    return width, height, depth, color


def rpc(port: int, token: str, frames: list[dict]) -> list[dict]:
    """Authenticate, then send each frame and return its reply."""
    with socket.create_connection(("127.0.0.1", port), timeout=10) as sock:
        reader = sock.makefile("r", encoding="utf-8", newline="\n")
        sock.sendall((json.dumps({"id": "auth", "method": "auth",
                                  "params": {"token": token}}) + "\n").encode())
        replies = [json.loads(reader.readline())]
        for frame in frames:
            sock.sendall((json.dumps(frame) + "\n").encode())
            replies.append(json.loads(reader.readline()))
        return replies


def load_solution():
    spec = importlib.util.spec_from_file_location("vision_curve_solution", SOLUTION)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def main() -> int:
    env = dict(os.environ)
    env["PATH"] = f"{CLIS}:{env.get('PATH', '')}"
    # Force the deterministic stand-in: no network, no API key required.
    for key in ("OPENROUTER_API_KEY", "OPENAI_API_KEY", "OPENROUTER_BASE_URL", "OPENAI_BASE_URL"):
        env.pop(key, None)

    for stale in ("audit", "logs", "serve.out", "serve.err", "agent.log", "run-log.json", "run_ex3.log"):
        target = OUT / stale
        if target.is_dir():
            shutil.rmtree(target)
        elif target.exists():
            target.unlink()
    OUT.mkdir(parents=True, exist_ok=True)

    token = secrets.token_hex(32)
    port = free_port()
    equal("control token is 64 lowercase hex", len(token) == 64 and token == token.lower()
          and all(c in "0123456789abcdef" for c in token), True)

    server = subprocess.Popen(
        [str(CLIS / "photocraft-cli"), "serve",
         "--port", str(port), "--control-token", token,
         "--automation-read-root", str(OUT), "--automation-write-root", str(OUT)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    server_out = OUT / "serve.out"
    server_err = OUT / "serve.err"

    try:
        deadline = time.monotonic() + 15
        ready = False
        while time.monotonic() < deadline:
            if server.poll() is not None:
                break
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                    ready = True
                    break
            except OSError:
                time.sleep(0.1)
        check("loopback server accepts connections", ready, f"127.0.0.1:{port}")
        if not ready:
            raise RuntimeError(f"server did not start: {server.stderr.read() if server.stderr else ''}")

        # ── run the agent ──────────────────────────────────────────────────
        run = subprocess.run(
            [sys.executable, SOLUTION.name], cwd=HERE,
            env={**env,
                 "PHOTOCRAFT_TOKEN": token,
                 "PHOTOCRAFT_HOST": "127.0.0.1",
                 "PHOTOCRAFT_PORT": str(port),
                 "WRITE_ROOT": str(OUT),
                 "AGENT_LOG": str(OUT / "logs" / "vision_curve_exchange.jsonl")},
            capture_output=True, text=True, timeout=240,
        )
        (OUT / "agent.log").write_text(run.stdout + run.stderr, encoding="utf-8")
        equal("agent exits cleanly", run.returncode, 0)
        check("agent printed no traceback", "Traceback (most recent call last)" not in run.stderr)

        # ── exchange log ───────────────────────────────────────────────────
        log_path = OUT / "logs" / "vision_curve_exchange.jsonl"
        check("exchange log exists", log_path.exists(),
              f"{log_path.stat().st_size if log_path.exists() else 0} bytes")
        raw_lines = [ln for ln in log_path.read_text(encoding="utf-8").splitlines() if ln.strip()]
        events: list[dict] = []
        parse_ok = True
        for line in raw_lines:
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                parse_ok = False
        check("every log line is JSON", parse_ok, f"{len(raw_lines)} lines")
        check("log is append-only and non-trivial", len(events) >= 8, f"{len(events)} events")

        auth = [e for e in events if e.get("event") == "auth"]
        equal("exactly one auth event", len(auth), 1)
        equal("auth succeeded", auth[0].get("ok") if auth else None, True)
        executes = [e for e in events if e.get("event") == "execute"]
        check("all engine commands succeeded",
              all(e.get("reply_ok") is True for e in executes), f"{len(executes)} commands")
        equal("commands are the gradient base and one curve",
              [e.get("command") for e in executes],
              ["layer.newFillLayer.gradient", "layer.newAdjustmentLayer.curves"])
        check("no levels or vibrance edits were needed",
              not any(e.get("command", "").endswith((".levels", ".vibrance")) for e in executes))

        shots = [e for e in events if e.get("event") == "screenshot"]
        equal("one snapshot plus one per pass", len(shots), 4)
        equal("snapshot sequence", [s.get("path") for s in shots],
              [f"audit/vision_curve_pass_{i}.png" for i in range(4)])
        check("all renders use the headless path",
              all(s.get("via") == "doc.render" for s in shots),
              sorted({s.get("via") for s in shots}))
        check("the desktop screenshot path is never used",
              not any(s.get("via") == "ui.screenshot" for s in shots))

        decisions = [e for e in events if e.get("event") == "vision_decision"]
        equal("three refinement passes", len(decisions), 3)
        equal("pass numbers", [d.get("pass") for d in decisions], [1, 2, 3])
        whitelisted = True
        for d in decisions:
            decision = d.get("decision") or {}
            keys = set(decision)
            if keys == {"status"}:
                whitelisted &= decision["status"] == "ok"
            elif keys == {"fix", "gamma"}:
                whitelisted &= decision["fix"] == "levels" and isinstance(decision["gamma"], float)
            elif keys == {"fix", "points"}:
                whitelisted &= decision["fix"] == "curves" and isinstance(decision["points"], list)
            elif keys == {"fix", "vibrance", "saturation"}:
                whitelisted &= decision["fix"] == "vibrance"
            else:
                whitelisted = False
        check("every decision is inside the contract union", whitelisted)

        finals = [e for e in events if e.get("event") == "final"]
        equal("exactly one final event", len(finals), 1)
        final = finals[0] if finals else {}
        equal("agent converged", final.get("converged"), True)
        equal("agent used three passes", final.get("passes"), 3)
        equal("agent applied one edit", final.get("applied_edits"), 1)
        equal("winning curve is the initial curve", final.get("winning_curve"), INITIAL_CURVE)
        equal("final event closes the log", events[-1].get("event") if events else None, "final")

        # ── artefacts ──────────────────────────────────────────────────────
        pngs = sorted((OUT / "audit").glob("*.png"))
        equal("four audit renders exist", len(pngs), 4)
        sizes = []
        for png in pngs:
            header = png_ihdr(png)
            check(f"{png.name} is a valid PNG", header is not None)
            if header:
                width, height, depth, color = header
                sizes.append((png.name, width, height, depth, color))
        equal("all renders share one size", len({(w, h) for _, w, h, _, _ in sizes}), 1,
              str({(w, h) for _, w, h, _, _ in sizes}))
        check("rendered document is 640x400", all((w, h) == (640, 400) for _, w, h, _, _ in sizes),
              str({(w, h) for _, w, h, _, _ in sizes}))
        check("renders are 8-bit images", all(depth == 8 for _, _, _, depth, _ in sizes))
        check("renders are non-trivial", all(png.stat().st_size > 1000 for png in pngs))

        # ── auth is actually enforced ──────────────────────────────────────
        wrong = "0" * 64
        replies = rpc(port, wrong, [])
        check("a wrong token is refused", replies[0].get("ok") is False, str(replies[0])[:120])
        check("the server survives a refused auth", server.poll() is None)

        replies = rpc(port, token, [
            {"id": 1, "method": "session.list", "params": {}},
            {"id": 2, "method": "doc.inspect", "params": {"index": 0}},
            {"id": 3, "method": "doc.close", "params": {"index": 0}},
        ])
        equal("correct token still authenticates", replies[0].get("ok"), True)
        session = replies[1].get("result") or {}
        docs = session.get("documents") or []
        equal("the agent left one document open", len(docs), 1)
        inspected = replies[2].get("result") or {}
        equal("live document width", inspected.get("width"), 640)
        equal("live document height", inspected.get("height"), 400)
        equal("live document is RGB", str(inspected.get("mode", "")).lower(), "rgb")
        equal("document closes", replies[3].get("ok"), True)

        # ── client-side token validation ──────────────────────────────────
        module = load_solution()
        rejected = 0
        for bad in ("abc", "A" * 64, "a" * 63, "g" * 64, 123):
            try:
                module.CraftLiveClient._validate_token(bad)  # type: ignore[arg-type]
            except SystemExit:
                rejected += 1
        equal("malformed tokens are rejected before connecting", rejected, 5)

        # ── paths stay inside the sandbox ─────────────────────────────────
        check("exchange log lives under the write root",
              str(log_path.resolve()).startswith(str(OUT.resolve())))
        check("every screenshot lives under the write root",
              all(str((OUT / s["path"]).resolve()).startswith(str(OUT.resolve())) for s in shots))
        quirks.append("the headless server has no ui.screenshot, so the agent falls back to doc.render")

    finally:
        server.terminate()
        try:
            out, err = server.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
            out, err = server.communicate()
        server_out.write_text(out or "", encoding="utf-8")
        server_err.write_text(err or "", encoding="utf-8")

    announcement = server_out.read_text(encoding="utf-8") + server_err.read_text(encoding="utf-8")
    check("server announced its loopback port", f"serving on 127.0.0.1:{port}" in announcement)

    say()
    say(f"{checks} checks, {len(failures)} failing; {len(quirks)} engine quirk(s); artefacts in {OUT}")
    (OUT / "run-log.json").write_text(json.dumps({
        "checks": checks,
        "failures": failures,
        "quirks": quirks,
        "port": port,
        "final": final if 'final' in locals() else None,
    }, indent=2), encoding="utf-8")
    (OUT / "run_ex3.log").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:  # noqa: BLE001 - the harness must fail loudly
        say(f"FAIL harness crashed: {error}")
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / "run_ex3.log").write_text("\n".join(lines) + "\n", encoding="utf-8")
        raise
