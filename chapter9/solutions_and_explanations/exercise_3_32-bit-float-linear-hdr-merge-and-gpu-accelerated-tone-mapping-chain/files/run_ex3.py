#!/usr/bin/env python3
"""run_ex3.py — acceptance harness for the 32-bit float HDR pipeline.

It stages a real three-frame bracket, imports it into a temporary LightCraft
library, runs merge -> Rec.2020 assertion -> grade -> four exports, and checks
the files and the stage report. A fake client covers the canonical input order
and the failed-merge refusal without touching the engine.
"""
from __future__ import annotations

import importlib.util
import json
import struct
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
OUTPUT = HERE.parent / "output"
BRACKETS = OUTPUT / "brackets"
DELIVER = OUTPUT / "deliver"
HDR_DIR = OUTPUT / "hdr"
LIBRARY = OUTPUT / "library"

spec = importlib.util.spec_from_file_location(
    "hdr_pipeline", HERE / "03_32-bit-float-linear-hdr-merge-and-gpu-accelerated-tone-mapping-chain.py")
pipeline = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(pipeline)

pipeline.LIBRARY = str(LIBRARY)
pipeline.READ_ROOT = str(BRACKETS)
pipeline.WRITE_ROOT = str(DELIVER)
pipeline.HDR_DIR = HDR_DIR

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


def make_bracket() -> None:
    BRACKETS.mkdir(parents=True, exist_ok=True)
    for index, (gain, lift) in enumerate(((0.45, -8), (1.0, 0), (1.8, 8))):
        image = Image.new("RGB", (1200, 800))
        pixels = image.load()
        for y in range(800):
            for x in range(1200):
                base = 28 + int(150 * ((x / 1200) * 0.65 + (y / 800) * 0.35))
                value = max(0, min(255, int(base * gain + lift)))
                pixels[x, y] = (value, max(0, int(value * 0.9)), max(0, int(value * 0.75)))
        image.save(BRACKETS / f"bracket-{index}.png")


class FakeClient:
    """Captures the merge command without spawning the engine."""

    def __init__(self, status: str = "ok") -> None:
        self.status = status
        self.calls: list[tuple[str, dict]] = []

    def run(self, cmd_id: str, params: dict | None = None, wait: bool = True):
        self.calls.append((cmd_id, params or {}))
        if cmd_id == "merge.hdr":
            if self.status != "ok":
                return {"status": self.status, "error": "merge failed"}
            return {"status": "ok", "id": 99, "ev": [-3, 0, 2]}
        return {}


def unit_merge_order() -> None:
    print("\n# merge contract")
    client = FakeClient()
    ids = pipeline.merge_bracket(
        client,
        pipeline.BracketSet(name="order", photo_ids=[9, 7, 8], ev_offsets=[2, -2, 0], fusion_seed=7),
    )
    equal("merge: the merged id is returned", ids, 99)
    merge = next(params for command, params in client.calls if command == "merge.hdr")
    equal("merge: bracket is sorted by EV", merge["ids"], [7, 8, 9])
    equal("merge: auto settings are disabled", merge["autoSettings"], False)
    equal("merge: deghost is fixed", merge["deghost"], "medium")

    broken = FakeClient(status="error")
    raised = False
    try:
        pipeline.merge_bracket(
            broken,
            pipeline.BracketSet(name="bad", photo_ids=[1, 2], ev_offsets=[0, 1], fusion_seed=1),
        )
    except RuntimeError as error:
        raised = "merge.hdr failed" in str(error)
    ok("merge: a non-ok merge raises", raised)


def tiff_info(path: Path) -> tuple[list[int], list[int], int, int]:
    """Read the TIFF tags the export contract cares about, without a TIFF lib."""
    data = path.read_bytes()
    endian = "<" if data[:2] == b"II" else ">"
    ifd = struct.unpack(endian + "I", data[4:8])[0]
    count = struct.unpack(endian + "H", data[ifd:ifd + 2])[0]
    tags: dict[int, tuple[int, int, int]] = {}
    pos = ifd + 2
    for _ in range(count):
        tag, kind, n, value = struct.unpack(endian + "HHII", data[pos:pos + 12])
        tags[tag] = (kind, n, value)
        pos += 12

    def shorts(tag: int) -> list[int]:
        kind, n, value = tags[tag]
        assert kind == 3
        if n == 1:
            return [value & 0xFFFF]
        return list(struct.unpack(endian + f"{n}H", data[value:value + 2 * n]))

    width = tags[256][2]
    height = tags[257][2]
    return shorts(258), shorts(339), width, height


def main() -> int:
    for stale in (BRACKETS, DELIVER, HDR_DIR, LIBRARY):
        if stale.exists():
            import shutil
            shutil.rmtree(stale)
    for stale in ("report.json", "stage-log.json"):
        (OUTPUT / stale).unlink(missing_ok=True)

    unit_merge_order()
    make_bracket()

    print("\n# import")
    client = pipeline.MCPClient()
    try:
        imported = client.run("library.import", {"paths": [str(BRACKETS)], "mode": "add"})
        equal("import: three bracketed frames", len(imported.get("imported", [])), 3)
        photos = client.run("catalog.query", {"limit": 20}).get("photos", [])
        ids = sorted(photo["id"] for photo in photos)
        equal("import: the catalogue has three ids", len(ids), 3)

        recipe = pipeline.GradeRecipe(
            curve_points=[(0.0, 0.0), (0.22, 0.18), (0.5, 0.52), (0.82, 0.86), (1.0, 1.0)],
            shadow_hue_deg=210.0,
            shadow_sat_pct=8.0,
        )
        matrix = pipeline.ExportMatrix(long_edge_sdr=1000, long_edge_avif=800, long_edge_thumb=480)
        bracket = pipeline.BracketSet(
            name="set-a", photo_ids=ids, ev_offsets=[-2.0, 0.0, 2.0], fusion_seed=20260314)

        print("\n# the pipeline")
        report = pipeline.run_pipeline(client, [bracket], recipe, matrix)
        if report["failed"]:
            print("   stage log:", json.dumps([s for s in report["stage_log"] if not s["ok"]], indent=2))
        equal("pipeline: one bracket set", report["total"], 1)
        equal("pipeline: no failed sets", report["failed"], [])
        equal("pipeline: exit code is zero", report["exit_code"], 0)
        if report["produced"]:
            equal("pipeline: one produced set", list(report["produced"]), ["set-a"])

        stage_log = report["stage_log"]
        ok("report: pre-merge GPU probe exists", any(s["stage"] == "pre_merge_set-a" for s in stage_log))
        ok("report: every stage carries a GPU record", all("gpu_used" in s for s in stage_log))

        print("\n# deliverables")
        deliver = DELIVER / "set-a"
        expected = ["master_hdr.tif", "master_sdr.jpg", "web_hero.avif", "thumbnail.png"]
        equal("export: four planned files", report["produced"]["set-a"], expected)
        for name in expected:
            path = deliver / name
            minimum = 500 if name.endswith(".avif") else 1000
            ok(f"export: {name} exists", path.exists() and path.stat().st_size > minimum,
               f"{path.stat().st_size if path.exists() else 0} bytes")
        equal("export: thumbnail long edge", max(Image.open(deliver / "thumbnail.png").size), 480)
        equal("export: SDR long edge", max(Image.open(deliver / "master_sdr.jpg").size), 1000)
        hdr = deliver / "master_hdr.tif"
        bits, sample_format, width, height = tiff_info(hdr)
        equal("export: HDR TIFF has three 32-bit samples", bits, [32, 32, 32])
        equal("export: HDR TIFF stores IEEE floats", sample_format, [3, 3, 3])
        equal("export: HDR source size", [width, height], [1200, 800])
        ok("export: AVIF signature", (deliver / "web_hero.avif").read_bytes()[4:12] == b"ftypavif")

        print("\n# working space")
        hdr_probe = list(HDR_DIR.glob("merged-*.tif"))
        eq = len(hdr_probe)
        equal("working space: Rec.2020 probe exported", eq, 1)
        ok("working space: probe is non-empty", hdr_probe[0].stat().st_size > 1000)
        merged_id = int(hdr_probe[0].stem.split("-")[-1])
        develop = client.run("develop.get", {"id": merged_id})
        ok("grade: the merged item has develop settings", isinstance(develop, dict) and "light" in develop)

        (OUTPUT / "stage-log.json").write_text(json.dumps(stage_log, indent=2))
        artefacts = [
            "brackets/bracket-0.png", "brackets/bracket-1.png", "brackets/bracket-2.png",
            "deliver/set-a/master_hdr.tif", "deliver/set-a/master_sdr.jpg",
            "deliver/set-a/web_hero.avif", "deliver/set-a/thumbnail.png",
            f"hdr/{hdr_probe[0].name}", "stage-log.json",
        ]
        for artefact in artefacts:
            ok(f"output: {artefact}", (OUTPUT / artefact).exists())
        (OUTPUT / "report.json").write_text(json.dumps({
            "exercise": 3,
            "engine": "lightcraft-cli",
            "assertions": PASSED + 1,
            "bracketSet": bracket.__dict__,
            "exitCode": report["exit_code"],
            "failed": report["failed"],
            "produced": report["produced"],
            "stageCount": len(stage_log),
            "artefacts": artefacts,
            "result": "three-frame bracket merged to a 32-bit Rec.2020 master and four deliverables",
        }, indent=2))
        ok("output: report manifest", (OUTPUT / "report.json").exists())
    finally:
        client.close()

    print(f"\n{PASSED} assertions passed")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
