#!/usr/bin/env python3
"""Acceptance harness for Chapter 6 Exercise 3.

Runs the art-director loop against `stub_control_server.py`, which speaks the
same JSON-line protocol as the desktop app's control channel. The vision model
is scripted, so every branch of the loop is deterministic: converge, deadlock,
protocol violation, bad token, and a command sent before authenticating.

The evidence stays under ../output/: every iteration's render and window frame,
the per-iteration JSON, the summary and a machine-readable report.
"""
from __future__ import annotations

import hashlib
import json
import secrets
import shutil
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "output"
WORK = OUT / "workspace"
WRITE = WORK / "write"

sys.path.insert(0, str(HERE))

from art_director import (  # noqa: E402
    ControlError,
    CraftControlClient,
    art_director_loop,
)
from stub_control_server import StubControlServer  # noqa: E402

for directory in (WORK, OUT / "audit-resolved", OUT / "audit-deadlock", OUT / "audit-schema"):
    shutil.rmtree(directory, ignore_errors=True)
WRITE.mkdir(parents=True, exist_ok=True)

PASSED = 0
FAILED: list[str] = []
CHECKS: list[dict[str, object]] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    global PASSED
    CHECKS.append({"label": label, "ok": bool(condition), "detail": detail})
    if condition:
        PASSED += 1
        print(f"PASS {label}")
    else:
        FAILED.append(label)
        print(f"FAIL {label} {detail}")


def png_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path} is not a PNG")
    return struct.unpack(">II", data[16:24])


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class ScriptedVision:
    """Returns one prepared critique per call; repeats the last one forever."""

    def __init__(self, critiques: list[dict]) -> None:
        self._critiques = critiques
        self.calls = 0

    def critique(self, png: bytes) -> dict:
        index = min(self.calls, len(self._critiques) - 1)
        self.calls += 1
        assert png.startswith(b"\x89PNG"), "the model was handed something that is not a PNG"
        return self._critiques[index]


FIX_CLIPPING = {
    "verdict": "fix",
    "issues": [
        {"kind": "clipping", "severity": 0.8, "hint": "product escapes the card",
         "region": [0, 0, 100, 100]},
        {"kind": "legibility", "severity": 0.6, "hint": "price sits on the cutout",
         "region": [120, 700, 700, 900]},
    ],
}
FIX_PALETTE = {
    "verdict": "fix",
    "issues": [
        {"kind": "palette", "severity": 0.4, "hint": "shadows are flat",
         "region": [0, 0, 0, 0]},
    ],
}
OK = {"verdict": "ok", "issues": []}
BROKEN = {"verdict": "fix", "issues": [{"kind": "palette", "hint": "missing severity"}]}

token = secrets.token_hex(32)
summaries: dict[str, dict] = {}
calls_by_scenario: dict[str, list[str]] = {}

with StubControlServer(token, WRITE) as server:
    # 1. The happy path: two corrections, then a clean verdict.
    client = CraftControlClient(port=server.port, token=token)
    ctx = {"productId": 2, "gradientId": 3, "priceGroupId": 4,
           "productGroupId": 5}
    vision = ScriptedVision([FIX_CLIPPING, FIX_PALETTE, OK])
    summary = art_director_loop(client, vision, ctx, OUT / "audit-resolved")
    summaries["resolved"] = summary

    check("the loop resolved on the ok verdict", summary["resolved"], str(summary))
    check("it took three iterations", summary["iterations"] == 3,
          str(summary["iterations"]))
    check("a resolved run rolls nothing back",
          summary["undoStepsApplied"] == 0, str(summary))
    check("the decision tree explains every iteration",
          len(summary["decisionTree"]) == 4
          and summary["decisionTree"][-1].endswith("stopping"),
          json.dumps(summary["decisionTree"]))
    check("one record per iteration was written, with both PNGs",
          len(list((OUT / "audit-resolved").glob("iter-*.json"))) == 3
          and len(list((OUT / "audit-resolved").glob("iter-*.png"))) == 6,
          str(sorted(p.name for p in (OUT / "audit-resolved").iterdir())))
    check("the loop released and re-created the clip",
          server.calls.count("layer.releaseClippingMask") == 1
          and server.calls.count("layer.createClippingMask") == 1,
          str(server.calls))
    check("the scrim is confined by a marquee, not a transform",
          "select.rect" in server.calls and "transform.set" not in server.calls,
          str(server.calls))
    check("the palette correction edited one layer instead of stacking",
          server.calls.count("layer.newAdjustmentLayer.hueSaturation") == 1,
          str(server.calls))

    frames = sorted((OUT / "audit-resolved").glob("iter-[0-9].png"))
    sizes = [png_size(frame) for frame in frames]
    hashes = [sha256(frame) for frame in frames]
    check("every audited render is a real 320x200 PNG",
          len(frames) == 3 and all(size == (320, 200) for size in sizes), str(sizes))
    check("successive renders are visibly different",
          len(set(hashes)) == len(hashes), str(hashes))
    calls_by_scenario["resolved"] = list(server.calls)
    client.close()

    # 2. A critique that never changes stops the loop and rolls back.
    server.calls.clear()
    client = CraftControlClient(port=server.port, token=token)
    client.execute("file.new", {"width": 1920, "height": 1080})
    baseline = client.history_depth()
    stuck = ScriptedVision([FIX_CLIPPING])
    summary = art_director_loop(client, stuck, ctx, OUT / "audit-deadlock")
    summaries["deadlock"] = summary
    check("an unchanged critique is reported as a deadlock",
          not summary["resolved"]
          and "did not change" in (summary["error"] or ""), str(summary))
    check("the deadlock stops at the second iteration",
          summary["iterations"] == 2, str(summary["iterations"]))
    check("every planned undo ran",
          summary["undoStepsApplied"] == summary["undoStepsPlanned"] > 0,
          str(summary))
    check("the document is back at its opening history depth",
          client.history_depth() == baseline, str(client.history_depth()))
    calls_by_scenario["deadlock"] = list(server.calls)
    client.close()

    # 3. A critique that fails the schema is caught before any command.
    client = CraftControlClient(port=server.port, token=token)
    client.execute("file.new", {"width": 1920, "height": 1080})
    server.calls.clear()
    summary = art_director_loop(
        client, ScriptedVision([BROKEN]), ctx, OUT / "audit-schema")
    summaries["schema"] = summary
    check("a schema violation is reported, not swallowed",
          not summary["resolved"] and "ValidationError" in (summary["error"] or ""),
          str(summary))
    check("nothing was applied for a rejected critique",
          summary["undoStepsPlanned"] == 0 and not server.calls, str(server.calls))
    calls_by_scenario["schema"] = list(server.calls)
    client.close()

    # 4. A wrong token is refused at the auth frame.
    refused = ""
    try:
        CraftControlClient(port=server.port, token="0" * 64)
    except ConnectionRefusedError as exc:
        refused = str(exc)
    check("a bad token is refused before any command", bool(refused), refused)

    # 5. A client that never authenticates cannot dispatch.
    client = CraftControlClient(port=server.port, token=None)
    unauthorised = ""
    try:
        client.inspect()
    except ControlError as exc:
        unauthorised = str(exc)
    client.close()
    check("an unauthenticated command is refused",
          unauthorised == "authentication required", unauthorised)

artefacts = []
for path in sorted(OUT.rglob("*")):
    # The shell owns run_ex3.log; the harness cannot see the end of its own
    # stdout, so the artefact list stops at the evidence it wrote itself.
    if (path.is_file() and path.name != "report.json"
            and path.suffix != ".log" and "workspace" not in path.parts):
        artefacts.append({
            "file": str(path.relative_to(OUT)),
            "bytes": path.stat().st_size,
            "sha256": sha256(path),
        })

(OUT / "report.json").write_text(json.dumps({
    "chapter": 6,
    "exercise": 3,
    "checks": {"passed": PASSED, "failed": len(FAILED), "total": PASSED + len(FAILED)},
    "scenarios": summaries,
    "serverCalls": calls_by_scenario,
    "artefacts": artefacts,
    "failures": FAILED,
}, indent=2) + "\n")

print(f"\n{PASSED}/{PASSED + len(FAILED)} checks passed")
raise SystemExit(1 if FAILED else 0)
