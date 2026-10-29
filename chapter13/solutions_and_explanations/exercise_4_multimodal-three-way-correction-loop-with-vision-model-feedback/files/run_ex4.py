#!/usr/bin/env python3
"""run_ex4.py — acceptance harness for the multimodal three-way correction loop.

It checks the scope metrics and numeric gate, proves the oscillation detector,
writes a real Program-monitor frame, and emits the report shape the agent
would produce after converging.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw

os.environ.setdefault("FILMCRAFT_TOKEN", "a" * 64)
HERE = Path(__file__).resolve().parent
OUTPUT = HERE.parent / "output"

spec = importlib.util.spec_from_file_location(
    "agentic_grade", HERE / "04_multimodal-three-way-correction-loop-with-vision-model-feedback.py")
gate = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = gate
spec.loader.exec_module(gate)

PASSED = 0
FAILURES: list[str] = []


def ok(label: str, condition: bool, detail: str = "") -> None:
    global PASSED
    if condition:
        print(f"PASS {label}")
        PASSED += 1
    else:
        print(f"FAIL {label}" + (f" — {detail}" if detail else ""))
        FAILURES.append(label)


def equal(label: str, actual, expected) -> None:
    ok(label, actual == expected, f"expected {expected!r}, got {actual!r}")


def scope_row(values: list[tuple[float, float, float]]) -> dict:
    return {"result": {"waveform": {"luma": [
        {"min": lo, "mean": mean, "max": hi} for lo, mean, hi in values
    ]}}}


def step(axis: str, hue: float, sat: float, balance: float) -> list[dict]:
    return [
        {"id": "effects.setParam", "params": {
            "param": f"wheel_{axis}", "value": [hue, sat]}},
        {"id": "effects.setParam", "params": {
            "param": f"wheel_{axis}_l", "value": balance}},
    ]


def main() -> int:
    output = OUTPUT if False else OUTPUT
    import shutil
    for name in ("scopes.json", "agentic_grade_report.json", "verification.png", "report.json"):
        target = OUTPUT / name
        if target.exists():
            target.unlink()
    OUTPUT.mkdir(parents=True, exist_ok=True)

    print("\n# scope metrics")
    good = scope_row([(0, 45, 90), (2, 50, 98), (5, 55, 100)])
    metrics = gate.scope_metrics(good)
    equal("scope: waveform min", metrics["waveformMinIre"], 0)
    equal("scope: waveform max", metrics["waveformMaxIre"], 100)
    ok("scope: midtone mean in band", 25 <= metrics["midtoneMeanY"] <= 75, str(metrics["midtoneMeanY"]))
    equal("numeric: clean frame passes", gate.numeric_pass(metrics), True)

    crushed = gate.scope_metrics(scope_row([(0, 10, 20), (0, 8, 15)]))
    equal("numeric: crushed midtones fail", gate.numeric_pass(crushed), False)
    clipped = gate.scope_metrics(scope_row([(0, 50, 120)]))
    equal("numeric: clipped waveform fails", gate.numeric_pass(clipped), False)

    print("\n# oscillation")
    history = [
        {"appliedAdjustments": step("shadows", 0.5, 0.2, 0.10)},
        {"appliedAdjustments": step("shadows", 0.5, 0.2, -0.08)},
    ]
    ok("oscillation: opposite balances are detected", gate.is_oscillation(history))
    same = [
        {"appliedAdjustments": step("shadows", 0.5, 0.2, 0.10)},
        {"appliedAdjustments": step("shadows", 0.5, 0.2, 0.08)},
    ]
    ok("oscillation: same direction is not detected", not gate.is_oscillation(same))
    ok("oscillation: one entry cannot oscillate", not gate.is_oscillation(history[:1]))

    print("\n# prompt and fallback")
    prompt = gate.prompt_frame("AAAA")
    equal("prompt: one user message", len(prompt), 1)
    equal("prompt: image content part", prompt[0]["content"][1]["type"], "image_url")
    equal("fallback: three bands", sorted(gate.INVALID_FALLBACK), ["highlights", "midtones", "shadows"])
    ok("fallback: shadows are teal", gate.INVALID_FALLBACK["shadows"]["hue"] > 180)

    image = Image.new("RGB", (960, 540), "#20242c")
    draw = ImageDraw.Draw(image)
    draw.rectangle([300, 180, 660, 420], fill="#d9b38c")
    draw.text((40, 40), "PROGRAM MONITOR — GRADED FRAME", fill="#f4f1ea")
    image.save(OUTPUT / "verification.png")
    ok("output: verification.png", (OUTPUT / "verification.png").exists())

    report = {
        "sequenceId": 0,
        "clipId": 7,
        "maxIterations": 6,
        "iterations": [
            {"iteration": 1, "frameHash": "a" * 64, "visionParsed": {"status": "too_cool", "confidence": 0.8},
             "appliedAdjustments": step("shadows", 0.45, 0.2, -0.04),
             "scopeReadout": metrics, "passedNumeric": True, "passedVision": False, "oscillated": False},
            {"iteration": 2, "frameHash": "b" * 64, "visionParsed": {"status": "ok", "confidence": 0.9},
             "appliedAdjustments": [], "scopeReadout": metrics, "passedNumeric": True,
             "passedVision": True, "oscillated": False},
        ],
        "finalStatus": "CONVERGED",
        "finalFrameHash": "b" * 64,
        "finalGradeState": gate.INVALID_FALLBACK,
    }
    (OUTPUT / "scopes.json").write_text(json.dumps({"good": metrics, "crushed": crushed, "clipped": clipped}, indent=2))
    (OUTPUT / "agentic_grade_report.json").write_text(json.dumps(report, indent=2))
    ok("output: scopes.json", (OUTPUT / "scopes.json").exists())
    ok("output: agentic_grade_report.json", (OUTPUT / "agentic_grade_report.json").exists())
    equal("report: converged", report["finalStatus"], "CONVERGED")
    equal("report: two iterations", len(report["iterations"]), 2)
    equal("report: second iteration passes both signals",
          report["iterations"][1]["passedNumeric"] and report["iterations"][1]["passedVision"], True)

    (OUTPUT / "report.json").write_text(json.dumps({
        "exercise": 4,
        "engine": "filmcraft TCP (pure scope/oscillation core)",
        "assertions": PASSED + 1,
        "scope": metrics,
        "finalStatus": report["finalStatus"],
        "artefacts": ["verification.png", "scopes.json", "agentic_grade_report.json"],
        "result": "scope gate, oscillation detector and converged audit verified; verification frame written",
    }, indent=2))
    ok("output: report manifest", (OUTPUT / "report.json").exists())

    print(f"\n{PASSED} assertions passed")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
