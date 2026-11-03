"""Live run of the curve-grading agent against a real vision model.

`run_ex2.py` is the deterministic harness: it asserts the offline heuristic's
exact trajectory, so it cannot pass when a model answers instead. This script
boots the same loopback server, runs the same agent file on one dark fixture,
and checks only what must hold for any model: a clean exit and an audit trail.

    LIVE=1 is implied: the three OPENAI_COMPATIBLE_* variables must be set.

Not printed in the book.
"""
from __future__ import annotations

import os
import socket
import struct
import subprocess
import sys
import time
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "output"
CLIS = HERE.parents[3] / "tools" / "craft-cli" / "bin"
SOLUTION = HERE / "03_agent_grade.py"
PY = sys.executable


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


def main() -> int:
    for stale in (OUT / "in", OUT / "grade", OUT / "serve.log", OUT / "grade.log",
                  OUT / "agent.stderr.log", OUT / "live.log"):
        if stale.is_dir():
            import shutil
            shutil.rmtree(stale)
        elif stale.exists():
            stale.unlink()
    (OUT / "in").mkdir(parents=True, exist_ok=True)
    (OUT / "grade").mkdir(parents=True, exist_ok=True)

    dark = OUT / "in" / "dark.png"
    write_png(dark, 600, 400, lambda x, y: (69 + (x * 18) // 600,
                                           65 + (y * 14) // 400,
                                           77 + ((x + y) * 10) // 1000))

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
        if not wait_for_server(serve_log, port):
            print("the control channel did not start", file=sys.stderr)
            return 1

        agent_env = {
            **env,
            "PHOTOCRAFT_CONTROL_TOKEN": token,
            "PHOTOCRAFT_PORT": str(port),
            "CRAFT_WRITE_ROOT": str(OUT),
            "GRADE_AUDIT_DIR": "grade",
        }
        run = subprocess.run([PY, SOLUTION.name, "dark.png"], cwd=HERE,
                             env=agent_env, capture_output=True, text=True, timeout=900)
        (OUT / "live.log").write_text(run.stdout + run.stderr, encoding="utf-8")
        trail = OUT / "grade" / "audit_trail.jsonl"

        print(run.stdout.strip().splitlines()[-1] if run.stdout.strip() else run.stderr[-300:])
        if run.returncode != 0:
            print(f"agent exited {run.returncode}", file=sys.stderr)
            return 1
        if not trail.exists():
            print("no audit trail was written", file=sys.stderr)
            return 1
        print(f"audit trail: {trail}")
        return 0
    finally:
        serve.terminate()
        try:
            serve.wait(timeout=10)
        except subprocess.TimeoutExpired:
            serve.kill()


if __name__ == "__main__":
    sys.exit(main())
