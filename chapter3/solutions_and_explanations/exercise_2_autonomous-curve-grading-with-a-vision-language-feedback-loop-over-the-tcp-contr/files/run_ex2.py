#!/usr/bin/env python3
"""
run_ex2.py -- acceptance harness for Chapter 3, Exercise 2.

Starts a real PhotoCraft TCP control channel, grades a dark fixture with the
agent, and verifies the render trail, the applied commands, the convergence
numbers, authentication failure and the malformed-response rollback.

The engine quirks this harness relies on:
  * `photocraft-cli serve` prints its "serving on" line on stderr;
  * `doc.render` writes relative to the automation write root;
  * the control channel answers `jobs.list`, not `command_run`.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import random
import socket
import struct
import subprocess
import sys
import time
import zlib
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "output"
CLIS = HERE.parents[3] / "tools" / "craft-cli" / "bin"
SOLUTION = HERE / "03_agent_grade.py"
PY = sys.executable

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
    say(f"{' ok ' if condition else 'FAIL'} {label:<62}{detail}")


def equal(label: str, actual: object, expected: object) -> None:
    check(label, actual == expected, f"expected {expected!r}, got {actual!r}")


# ── deterministic PNG fixtures ───────────────────────────────────────────────
def _crc32(data: bytes) -> int:
    return zlib.crc32(data) & 0xFFFFFFFF


def write_png(path: Path, width: int, height: int, pixel) -> None:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (struct.pack(">I", len(payload)) + kind + payload
                + struct.pack(">I", _crc32(kind + payload)))
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            raw.extend(pixel(x, y))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
                     + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))


_MODULE = None


def solution_module():
    global _MODULE
    if _MODULE is None:
        spec = importlib.util.spec_from_file_location("grade_solution", SOLUTION)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        _MODULE = module
    return _MODULE


def luma(path: Path) -> float:
    value = solution_module()._png_mean_luma(path.read_bytes())
    return float(value) if value is not None else -1.0


def png_size(path: Path) -> tuple[int, int]:
    b = path.read_bytes()
    return struct.unpack(">II", b[16:24])


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_for_server(log: Path, port: int, deadline: float = 15.0) -> bool:
    start = time.time()
    while time.time() - start < deadline:
        text = log.read_text(encoding="utf-8", errors="replace") if log.exists() else ""
        if f"127.0.0.1:{port}" in text:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=1):
                    return True
            except OSError:
                pass
        time.sleep(0.1)
    return False


def run_agent(env: dict[str, str], args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run([PY, SOLUTION.name, *args], cwd=HERE, env=env,
                          capture_output=True, text=True, timeout=300)


def main() -> int:
    for stale in (OUT / "in", OUT / "grade", OUT / "serve.log", OUT / "grade.log",
                  OUT / "agent.stderr.log", OUT / "run-log.json", OUT / "run_ex2.log"):
        if stale.is_dir():
            import shutil
            shutil.rmtree(stale)
        elif stale.exists():
            stale.unlink()
    (OUT / "in").mkdir(parents=True, exist_ok=True)

    # A genuinely dark frame: the offline auditor's first move must be levels.
    dark = OUT / "in" / "dark.png"
    # Tuned to land near mean luma 76: the offline auditor needs one levels
    # pass (76 -> ~100), then one exposure pass, then converges on render 3.
    write_png(dark, 600, 400, lambda x, y: (69 + (x * 18) // 600,
                                            65 + (y * 14) // 400,
                                            77 + ((x + y) * 10) // 1000))
    before = luma(dark)
    check("dark fixture is a real PNG", dark.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n")
    check("dark fixture is actually dark", 0 <= before < 96, f"mean luma {before:.1f}")

    port = free_port()
    token = os.urandom(32).hex()
    serve_log = OUT / "serve.log"
    env = dict(os.environ)
    env["PATH"] = f"{CLIS}:{env.get('PATH', '')}"
    serve = subprocess.Popen(
        [str(CLIS / "photocraft-cli"), "serve", "--port", str(port),
         "--control-token", token,
         "--automation-read-root", str(OUT / "in"),
         "--automation-write-root", str(OUT)],
        cwd=HERE, env=env, stdout=serve_log.open("w"), stderr=subprocess.STDOUT,
    )
    try:
        check("control channel starts", wait_for_server(serve_log, port), f"port {port}")

        agent_env = {
            **env,
            "PHOTOCRAFT_CONTROL_TOKEN": token,
            "PHOTOCRAFT_PORT": str(port),
            "CRAFT_WRITE_ROOT": str(OUT),
            "GRADE_AUDIT_DIR": "grade",
        }
        run = run_agent(agent_env, ["dark.png"])
        (OUT / "grade.log").write_text(run.stdout, encoding="utf-8")
        (OUT / "agent.stderr.log").write_text(run.stderr, encoding="utf-8")
        equal("agent exits cleanly", run.returncode, 0)
        check("agent printed no traceback", "Traceback (most recent call last)" not in run.stderr,
              run.stderr[:180])

        summary_lines = [l for l in run.stdout.splitlines() if l.strip().startswith("{")]
        check("agent prints one summary line", len(summary_lines) == 1, str(len(summary_lines)))
        summary = json.loads(summary_lines[-1]) if summary_lines else {}
        equal("summary names the photo", summary.get("photo"), "dark.png")
        equal("summary converged", summary.get("status"), "ok")
        equal("summary converged on the third render", summary.get("convergedAt"), 2)
        equal("summary counts three iterations", summary.get("iterations"), 3)
        equal("offline auditor spends no tokens", summary.get("tokensUsed"), 0)

        trail_path = OUT / "grade" / "audit_trail.jsonl"
        check("audit trail exists", trail_path.exists())
        trail_lines = [json.loads(l) for l in trail_path.read_text().splitlines() if l.strip()]
        equal("audit trail has one photograph", len(trail_lines), 1)
        trail = trail_lines[0] if trail_lines else {}
        equal("trail names the final document", trail.get("finalDocument"), "dark.png")
        equal("trail converged at iteration 2", trail.get("convergedAt"), 2)
        records = trail.get("audit") or []
        equal("trail records every iteration", len(records), 3)
        check("every record has a prompt hash", all(
            isinstance(r.get("promptHash"), str) and len(r["promptHash"]) == 64 for r in records))
        check("every record has an image hash", all(
            isinstance(r.get("imageSha"), str) and len(r["imageSha"]) == 64 for r in records))
        equal("three distinct renders are hashed", len({r.get("imageSha") for r in records}), 3)
        applied = [(r.get("appliedCommand"), r.get("appliedParams")) for r in records
                   if r.get("appliedCommand")]
        equal("two corrections are applied", len(applied), 2)
        equal("first correction is levels", applied[0][0] if applied else None,
              "image.adjustments.levels")
        equal("second correction is exposure", applied[1][0] if applied else None,
              "image.adjustments.exposure")
        check("every applied command is whitelisted", all(
            cmd in {"image.adjustments.levels", "image.adjustments.curves",
                    "image.adjustments.exposure", "image.adjustments.vibrance",
                    "image.adjustments.hueSaturation"} for cmd, _ in applied))
        check("the audit records the model's JSON",
              all(isinstance(r.get("audit"), dict) and "status" in r["audit"] for r in records))
        equal("the last audit is ok", records[-1].get("audit", {}).get("status"), "ok")
        check("the final confidence clears the threshold",
              float(records[-1].get("audit", {}).get("confidence", 0)) >= 0.85,
              str(records[-1].get("audit", {}).get("confidence")))
        check("the trail carries no error record", all("error" not in r for r in records))

        renders = sorted((OUT / "grade").glob("audit_*.png"))
        equal("three audit renders exist", len(renders), 3)
        luma_values = [luma(p) for p in renders]
        check("renders are bounded to 768 px",
              all(max(png_size(p)) <= 768 for p in renders),
              ", ".join(f"{png_size(p)[0]}x{png_size(p)[1]}" for p in renders))
        check("rendering got brighter and stayed readable",
              luma_values[0] < luma_values[-1] and luma_values[-1] >= 110,
              " -> ".join(f"{v:.0f}" for v in luma_values))
        check("the final render is inside the accepted luma band",
              110 <= luma_values[-1] <= 160, f"{luma_values[-1]:.1f}")
        equal("render #0 is the initial frame", luma_values[0], before)

        # Snapshot the converged run: the failure-path probes below overwrite
        # `grade/audit_*.png` and `audit_trail.jsonl`, and the directory should
        # be left holding the run the log describes.
        canonical_renders = [(f"audit_{i:02d}.png", p.read_bytes())
                             for i, p in enumerate(renders)]
        canonical_trail = trail_path.read_text(encoding="utf-8")

        # ── authentication failure ─────────────────────────────────────────
        wrong = os.urandom(32).hex()
        bad = run_agent({**agent_env, "PHOTOCRAFT_CONTROL_TOKEN": wrong}, ["dark.png"])
        check("a wrong token is rejected", bad.returncode != 0, f"exit {bad.returncode}")
        check("the rejection names authentication",
              "auth" in (bad.stdout + bad.stderr).lower(), (bad.stdout + bad.stderr)[:160])

        # ── versioned prompt hash ──────────────────────────────────────────
        prompt = OUT / "prompt_v3.txt"
        prompt.write_text("prompt v3: cool neutral highlights, warm-shadowed lows\n", encoding="utf-8")
        expected_hash = hashlib.sha256(prompt.read_bytes()).hexdigest()
        versioned = run_agent({**agent_env, "PROMPT_PATH": str(prompt)}, ["dark.png"])
        equal("versioned-prompt run exits cleanly", versioned.returncode, 0)
        trail2 = [json.loads(l) for l in trail_path.read_text().splitlines() if l.strip()][0]
        equal("the versioned prompt hash is recorded", trail2["audit"][0]["promptHash"], expected_hash)
        check("the trail changes when the prompt changes",
              expected_hash != records[0]["promptHash"])

        # ── malformed-response rollback (real TCP, stubbed auditor) ───────
        module = solution_module()
        calls = {"n": 0}

        def fake_vision(_path: str, _budget: dict[str, int]) -> dict[str, Any]:
            calls["n"] += 1
            if calls["n"] == 1:
                return {"status": "fix", "confidence": 0.7,
                        "fix": {"kind": "levels", "gamma": 1.2}}
            raise json.JSONDecodeError("bad payload", "", 0)

        module.call_vision_with_backoff = fake_vision
        with module.TcpControl(port=port, token=token, write_root=str(OUT)) as tcp:
            try:
                module.grade_photo(tcp, "dark.png")
                check("three malformed responses abort the loop", False, "no exception")
            except RuntimeError as err:
                check("three malformed responses abort the loop", "rolled back" in str(err), str(err))
        equal("the stub saw the fix and the malformed streak", calls["n"], 4)

        # An unknown verb must not be read as approval: the whitelist turns it
        # into `invalid`, which counts toward the same streak.
        def fake_unknown(_path: str, _budget: dict[str, int]) -> dict[str, Any]:
            return {"status": "fix", "confidence": 0.99,
                    "fix": {"kind": "contrast", "amount": 2}}

        # Bypass the backoff wrapper but keep `_whitelist` in the path, so the
        # raw decision really is filtered before the loop sees it.
        module.call_vision_with_backoff = module.call_vision
        module._vl_client_audit = lambda _png: (fake_unknown("", {}), 0)
        with module.TcpControl(port=port, token=token, write_root=str(OUT)) as tcp:
            try:
                module.grade_photo(tcp, "dark.png")
                check("an unknown verb is not treated as approval", False, "converged")
            except RuntimeError as err:
                check("an unknown verb is not treated as approval",
                      "rolled back" in str(err), str(err))

        # ── token budget is enforced before dispatch ──────────────────────
        saved_max = module.MAX_TOKENS
        module.MAX_TOKENS = 1
        try:
            module.call_vision(str(renders[0]), {"used": 2})
            check("token budget is enforced", False, "no exception")
        except RuntimeError as err:
            check("token budget is enforced", "budget" in str(err).lower(), str(err))
        finally:
            module.MAX_TOKENS = saved_max

        # ── engine still alive and serving after all runs ─────────────────
        check("server survives the failed runs", serve.poll() is None, f"exit {serve.poll()}")
        quirks.append("control channel has no ui.screenshot; the audit render is `doc.render`")
    finally:
        serve.terminate()
        try:
            serve.wait(timeout=10)
        except subprocess.TimeoutExpired:
            serve.kill()

    grade = OUT / "grade"
    for stale in grade.glob("audit_*.png"):
        stale.unlink()
    for name, data in canonical_renders:
        (grade / name).write_bytes(data)
    (grade / "audit_trail.jsonl").write_text(canonical_trail, encoding="utf-8")

    summary = {"checks": checks, "failures": failures, "quirks": quirks,
               "port": port, "initialLuma": round(before, 2)}
    (OUT / "run-log.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    say("")
    say(f"{checks} checks, {len(failures)} failing; artefacts in {OUT}")
    (OUT / "run_ex2.log").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
