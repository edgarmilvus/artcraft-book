#!/usr/bin/env python3
"""
run_ex1.py -- acceptance harness for Chapter 2, Exercise 1.

Builds the 8000 x 6000 retouch fixture, runs the sparse-tile delta harness
against the real PhotoCraft engine, then re-derives the tile arithmetic from
the damage rectangles in the report and reopens the TIFF with a second engine
session. A failure exits non-zero.

Engine behaviour this harness works around:
  * `doc_save` does not create missing parent directories, so `output/retouch`
    is created before the fixture builder runs.
  * `doc_inspect` exposes the layer tree but not a tile census; the report
    therefore estimates tiles from engine-reported damage rectangles.
"""
from __future__ import annotations

import importlib.util
import json
import math
import os
import shutil
import struct
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "output"
CLIS = HERE.parents[3] / "tools" / "craft-cli" / "bin"
SOLUTION = HERE / "01_sparse_tile_delta.py"
REPORT = OUT / "reports" / "sparse_tile_delta_FW26_hero_048.json"
FIXTURE = OUT / "retouch" / "FW26_hero_048.tif"

TILE = 256
CANVAS = (8000, 6000)

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


def equal(label: str, actual: object, expected: object) -> None:
    check(label, actual == expected, f"expected {expected!r}, got {actual!r}")


def tiles_for_rect(rect: list[int]) -> set[tuple[int, int]]:
    x0, y0, x1, y1 = (int(v) for v in rect)
    return {(x, y) for x in range(x0 // TILE, x1 // TILE + 1)
            for y in range(y0 // TILE, y1 // TILE + 1)}


def tiff_dimensions(path: Path) -> tuple[int, int] | None:
    """Read width/height from the TIFF IFD without loading the pixels."""
    with path.open("rb") as fh:
        header = fh.read(8)
        if len(header) < 8 or header[:2] not in (b"II", b"MM"):
            return None
        endian = "<" if header[:2] == b"II" else ">"
        ifd = struct.unpack(endian + "I", header[4:8])[0]
        fh.seek(ifd)
        count_raw = fh.read(2)
        if len(count_raw) != 2:
            return None
        count = struct.unpack(endian + "H", count_raw)[0]
        dims: dict[int, int] = {}
        for _ in range(count):
            entry = fh.read(12)
            if len(entry) != 12:
                return None
            tag, kind, n = struct.unpack(endian + "HHI", entry[:8])
            if tag in (256, 257) and n == 1:
                if kind == 3:
                    dims[tag] = struct.unpack(endian + "H", entry[8:10])[0]
                elif kind == 4:
                    dims[tag] = struct.unpack(endian + "I", entry[8:12])[0]
        if 256 in dims and 257 in dims:
            return dims[256], dims[257]
    return None


def load_solution_module():
    spec = importlib.util.spec_from_file_location("sparse_tile_solution", SOLUTION)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def main() -> int:
    env = dict(os.environ)
    env["PATH"] = f"{CLIS}:{env.get('PATH', '')}"
    env["READ_ROOT"] = str(OUT)
    env["WRITE_ROOT"] = str(OUT)
    env["REPORT_PATH"] = str(REPORT)

    # ── clean slate ────────────────────────────────────────────────────────
    for stale in (OUT / "retouch", OUT / "reports", OUT / "run-log.json", OUT / "run_ex1.log"):
        if stale.is_dir():
            shutil.rmtree(stale)
        elif stale.exists():
            stale.unlink()
    (OUT / "retouch").mkdir(parents=True, exist_ok=True)
    (OUT / "reports").mkdir(parents=True, exist_ok=True)

    # ── fixture ────────────────────────────────────────────────────────────
    fixture_run = subprocess.run(
        ["node", "make-fixture.mjs"], cwd=HERE, env=env,
        capture_output=True, text=True, timeout=180,
    )
    (OUT / "fixture.log").write_text(fixture_run.stdout + fixture_run.stderr, encoding="utf-8")
    equal("fixture builder exits cleanly", fixture_run.returncode, 0)
    check("fixture TIFF exists", FIXTURE.exists(),
          f"{FIXTURE.stat().st_size if FIXTURE.exists() else 0} bytes")
    check("fixture is a non-trivial TIFF (> 100 kB)",
          FIXTURE.exists() and FIXTURE.stat().st_size > 100_000,
          f"{FIXTURE.stat().st_size if FIXTURE.exists() else 0} bytes (deflate-compressed)")
    if FIXTURE.exists():
        equal("fixture TIFF dimensions", tiff_dimensions(FIXTURE), CANVAS)

    # ── solution ───────────────────────────────────────────────────────────
    run = subprocess.run(
        [sys.executable, SOLUTION.name], cwd=HERE, env=env,
        capture_output=True, text=True, timeout=300,
    )
    transcript = run.stdout + run.stderr
    (OUT / "sparse_tile_delta.stdout.json").write_text(transcript, encoding="utf-8")
    equal("sparse-tile harness exits cleanly", run.returncode, 0)
    check("harness printed no traceback", "Traceback (most recent call last)" not in run.stderr)
    check("engine reported no tool error", '"isError": true' not in transcript)
    check("harness prints the report", '"harness": "sparse_tile_delta"' in run.stdout)

    # ── report ─────────────────────────────────────────────────────────────
    check("report exists at the contract path", REPORT.exists(),
          f"{REPORT.stat().st_size if REPORT.exists() else 0} bytes")
    report = json.loads(REPORT.read_text(encoding="utf-8"))
    equal("report harness id", report.get("harness"), "sparse_tile_delta")
    equal("document size", report.get("document_size"), {"width": 8000, "height": 6000})
    equal("tile size", report.get("tile_geometry", {}).get("size"), 256)
    equal("tile origin", report.get("tile_geometry", {}).get("origin_px"), [0, 0])
    equal("baseline layer-tree nodes", report.get("layer_tree_nodes_baseline"), 2)
    equal("final layer-tree nodes", report.get("layer_tree_nodes_final"), 3)
    equal("document path points at the fixture", Path(report.get("document", "")).resolve(),
          FIXTURE.resolve())

    steps = report.get("steps") or []
    equal("three operations are measured", len(steps), 3)
    equal("operation ids", [s.get("id") for s in steps],
          ["localized_brush_strokes", "layer.newAdjustmentLayer.curves",
           "filter.blur.gaussianBlur"])
    equal("operation categories", [s.get("category") for s in steps],
          ["batch", "command", "async_command"])
    check("all operations return a finite duration",
          all(isinstance(s.get("elapsed_ms"), (int, float)) and math.isfinite(s["elapsed_ms"])
              and s["elapsed_ms"] >= 0 for s in steps))
    check("all operations report damage", all(s.get("damage_area_px", 0) > 0 for s in steps))

    # ── tile arithmetic, recomputed from the recorded damage rects ─────────
    prior: set[tuple[int, int]] = set()
    recomputed: list[int] = []
    for step in steps:
        rects = step.get("damage_rects") or []
        check(f"{step.get('id')} records damage rects", len(rects) > 0, f"{len(rects)} rect(s)")
        touched = set()
        for rect in rects:
            x0, y0, x1, y1 = rect
            check(f"{step.get('id')} damage rect is inside the canvas",
                  x0 >= 0 and y0 >= 0 and x1 < CANVAS[0] and y1 < CANVAS[1], str(rect))
            touched |= tiles_for_rect(rect)
        new = touched - prior
        prior |= touched
        recomputed.append(len(new))
        equal(f"{step.get('id')} tile count matches its rects",
              step.get("estimated_tiles_touched"), len(new))
        area = sum((r[2] - r[0] + 1) * (r[3] - r[1] + 1) for r in rects)
        equal(f"{step.get('id')} damage area matches its rects", step.get("damage_area_px"), area)
        expected_pct = round(100.0 * area / (CANVAS[0] * CANVAS[1]), 2)
        check(f"{step.get('id')} coverage percentage", step.get("sparse_coverage_pct") == expected_pct,
              f"{step.get('sparse_coverage_pct')} vs {expected_pct}")

    equal("localised batch touches 60 tiles", recomputed[0], 60)
    equal("global curves touches the remaining 708 tiles", recomputed[1], 708)
    equal("blur after a full-canvas edit touches no new tiles", recomputed[2], 0)
    equal("cumulative tile union", report.get("cumulative_estimated_tiles"), 768)
    equal("cumulative equals the recomputed union", report.get("cumulative_estimated_tiles"), len(prior))
    equal("the ten strokes stay localised", len(steps[0]["damage_rects"]), 10)
    check("the batch covers under 10% of the canvas", steps[0]["sparse_coverage_pct"] < 10.0,
          f"{steps[0]['sparse_coverage_pct']}%")
    check("the global edits cover 100% of the canvas",
          steps[1]["sparse_coverage_pct"] == 100.0 and steps[2]["sparse_coverage_pct"] == 100.0)
    equal("step tile counts are disjoint", sum(recomputed), report.get("cumulative_estimated_tiles"))

    # ── engine census and notes ────────────────────────────────────────────
    census = report.get("engine_tile_census") or {}
    check("engine census keys are present", set(census) == {"baseline", "final"})
    if census.get("baseline") is None and census.get("final") is None:
        quirks.append("doc_inspect exposes no tile census in the headless CLI; the report estimates tiles from damage rectangles")
    equal("report carries three notes", len(report.get("notes") or []), 3)
    notes = " ".join(report.get("notes") or [])
    check("notes name the 256-px geometry", "256" in notes)
    check("notes name the CPU SIMD oracle", "CPU SIMD" in notes)
    check("notes state that tiles are never double counted", "double count" in notes)

    # ── reopen the fixture with a fresh engine session ────────────────────
    module = load_solution_module()
    mcp = module.StdioMCP([
        str(CLIS / "photocraft-cli"), "mcp",
        "--automation-read-root", str(OUT),
        "--automation-write-root", str(OUT),
    ])
    mcp.initialize()
    try:
        opened = mcp.tool("doc_open", path="retouch/FW26_hero_048.tif")
        index = int(opened.get("index", 0))
        equal("fixture reopens", opened.get("width"), 8000)
        equal("fixture reopens at full height", opened.get("height"), 6000)
        inspected = mcp.tool("doc_inspect", index=index)
        equal("reopened document width", inspected.get("width"), 8000)
        equal("reopened document height", inspected.get("height"), 6000)
        equal("reopened document is RGB", str(inspected.get("mode")).lower(), "rgb")
        mcp.tool("doc_close", index=index)
    finally:
        mcp.close()

    # ── summary ───────────────────────────────────────────────────────────
    say()
    say(f"{checks} checks, {len(failures)} failing; {len(quirks)} engine quirk(s); artefacts in {OUT}")
    (OUT / "run-log.json").write_text(json.dumps({
        "checks": checks,
        "failures": failures,
        "quirks": quirks,
        "report": {
            "document": report.get("document"),
            "steps": [{"id": s["id"], "tiles": s["estimated_tiles_touched"],
                       "coverage_pct": s["sparse_coverage_pct"]} for s in steps],
            "cumulative_estimated_tiles": report.get("cumulative_estimated_tiles"),
        },
    }, indent=2), encoding="utf-8")
    (OUT / "run_ex1.log").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:  # noqa: BLE001 - the harness must fail loudly
        say(f"FAIL harness crashed: {error}")
        (OUT / "run_ex1.log").write_text("\n".join(lines) + "\n", encoding="utf-8")
        raise
