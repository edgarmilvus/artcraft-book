#!/usr/bin/env python3
"""
run_ex1.py — the harness for the Banner Factory.

The harness builds the banner manifest, the brand chip and two alpha-masked
product cutouts with nothing outside the standard library, runs
`01_banner_factory.py` for real against PhotoCraft, and then checks the
banners, the crops, the report and the trace.

Every check prints one `PASS <label>` line; the run ends with the number of
assertions that passed. No API key and no network are involved.
"""

from __future__ import annotations

import json
import os
import shutil
import struct
import subprocess
import sys
import zlib
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

sys.dont_write_bytecode = True

FILES = Path(__file__).resolve().parent
WORK = FILES.parent / "output" / "work"
ASSETS = WORK / "assets"
OUT = WORK / "out"
MANIFEST = WORK / "manifest.json"
SOLUTION = FILES / "01_banner_factory.py"

RATIOS = {"amazon": (1080, 1080), "web": (1920, 1080), "instagram": (1080, 1350)}
PRODUCT_BAND = (0.88, 0.46)
BAND_TOP = 0.34

PASSED: List[str] = []
FAILED: List[Tuple[str, str]] = []


def check(label: str, condition: bool, detail: str = "") -> bool:
    if condition:
        PASSED.append(label)
        print("PASS %s" % label)
    else:
        FAILED.append((label, detail))
        print("FAIL %s %s" % (label, detail))
    return bool(condition)


# ---------------------------------------------------------------------------
# A minimal PNG writer (truecolour and truecolour-with-alpha)
# ---------------------------------------------------------------------------

def _png_chunk(tag: bytes, data: bytes) -> bytes:
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(path: Path, width: int, height: int,
              pixel, alpha: bool = False) -> None:
    channels = 4 if alpha else 3
    colour_type = 6 if alpha else 2
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # the "none" filter
        for x in range(width):
            value = pixel(x, y)
            if alpha:
                raw += bytes((value[0], value[1], value[2], value[3]))
            else:
                raw += bytes((value[0], value[1], value[2]))
    header = struct.pack(">IIBBBBB", width, height, 8, colour_type, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", header)
        + _png_chunk(b"IDAT", zlib.compress(bytes(raw), 6))
        + _png_chunk(b"IEND", b""))


def read_png_size(path: Path) -> Tuple[int, int]:
    data = path.read_bytes()
    return struct.unpack(">II", data[16:24])


# ---------------------------------------------------------------------------
# The fixtures
# ---------------------------------------------------------------------------

PRODUCTS = [
    # sku, colour, size of the opaque product
    ("nw-mug-01", (200, 90, 40), 300),
    ("nw-lamp-02", (60, 130, 190), 240),
]

CHIP = """<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60">
  <rect width="200" height="60" fill="#f4f6f8"/>
  <rect width="8" height="60" fill="#c85a28"/>
  <text x="24" y="38" fill="#101820" font-family="Helvetica" font-size="24">NORTHWIND</text>
</svg>
"""


def build_fixtures() -> Dict[str, Any]:
    ASSETS.mkdir(parents=True, exist_ok=True)
    (ASSETS / "chip.svg").write_text(CHIP, encoding="utf-8")

    for sku, colour, extent in PRODUCTS:
        def pixel(x: int, y: int, colour=colour, extent=extent) -> tuple:
            half = extent // 2
            inside = (half <= x < half + extent) and (half <= y < half + extent)
            return (colour[0], colour[1], colour[2], 255) if inside else (0, 0, 0, 0)
        write_png(ASSETS / ("%s.png" % sku), 600, 600, pixel, alpha=True)

    manifest = {
        "brand": {
            "name": "Northwind",
            "chipSvgPath": str(ASSETS / "chip.svg"),
            "disclaimer": "Terms apply. See northwind.example/terms for the full conditions.",
            "background": "#101820",
            "headlineColor": "#ffffff",
            "ctaColor": "#ffd166",
        },
        "skus": [
            {
                "sku": sku,
                "productCutoutPath": str(ASSETS / ("%s.png" % sku)),
                "copy": {
                    "headline": "Made for the windowsill",
                    "subhead": "Ceramic, hand-glazed, 350 ml",
                    "cta": "See the range",
                },
            }
            for sku, _colour, _extent in PRODUCTS
        ],
        "outputRoot": str(OUT),
        "concurrency": 2,
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


# ---------------------------------------------------------------------------
# Running the factory
# ---------------------------------------------------------------------------

def run_factory(manifest: Path, out: Optional[Path] = None, resume: bool = False) -> subprocess.CompletedProcess:
    command = [sys.executable, str(SOLUTION), str(manifest)]
    if resume:
        command.append("--resume")
    environment = dict(os.environ)
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    return subprocess.run(command, capture_output=True, text=True, env=environment)


# ---------------------------------------------------------------------------
# A synchronous MCP client, for the engine's own reports
# ---------------------------------------------------------------------------

class Engine:
    def __init__(self, command: List[str]) -> None:
        self.proc = subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self._id = 0
        self._request("initialize", {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "run-ex1", "version": "1.0"}})
        self._notify("notifications/initialized", {})

    def _request(self, method: str, params: dict) -> Any:
        self._id += 1
        assert self.proc.stdin is not None and self.proc.stdout is not None
        self.proc.stdin.write(json.dumps(
            {"jsonrpc": "2.0", "id": self._id, "method": method, "params": params}) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("the engine closed the pipe")
        response = json.loads(line)
        if "error" in response:
            raise RuntimeError(json.dumps(response["error"]))
        return response.get("result")

    def _notify(self, method: str, params: dict) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(
            {"jsonrpc": "2.0", "method": method, "params": params}) + "\n")
        self.proc.stdin.flush()

    def tool(self, name: str, arguments: dict) -> Any:
        result = self._request("tools/call", {"name": name, "arguments": arguments})
        if not isinstance(result, dict):
            return result
        if result.get("isError") is True:
            raise RuntimeError("%s: %s" % (name, json.dumps(result.get("content"))[:300]))
        for block in result.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "text":
                text = block.get("text", "")
                try:
                    return json.loads(text)
                except json.JSONDecodeError:
                    return text
        return result

    def close(self) -> None:
        try:
            if self.proc.stdin is not None:
                self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


def read_trace(path: Path) -> List[Dict[str, Any]]:
    if not path.is_file():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


# ---------------------------------------------------------------------------
# The main run
# ---------------------------------------------------------------------------

def main() -> int:
    if WORK.exists():
        shutil.rmtree(str(WORK))
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = build_fixtures()

    run = run_factory(MANIFEST)
    check("factory_exit_code_is_zero", run.returncode == 0,
          "rc=%s stderr=%s" % (run.returncode, run.stderr[-400:]))

    report_path = OUT / "report.json"
    check("factory_writes_the_report", report_path.is_file())
    report = json.loads(report_path.read_text(encoding="utf-8")) if report_path.is_file() else {}
    skus = report.get("skus", [])
    check("factory_report_lists_every_sku", len(skus) == len(PRODUCTS), str(len(skus)))
    check("factory_report_names_the_brand", report.get("brand") == "Northwind",
          str(report.get("brand")))
    check("factory_report_carries_no_timestamp",
          "generatedAt" not in json.dumps(report), "the report must be replayable")

    by_sku = {record["sku"]: record for record in skus}
    for sku, colour, _extent in PRODUCTS:
        record = by_sku.get(sku)
        if record is None:
            check("factory_reports_%s" % sku, False, "missing from the report")
            continue
        check("factory_reports_%s" % sku, record.get("status") == "ok", json.dumps(record)[:200])
        check("factory_samples_the_product_colour_of_%s" % sku,
              record.get("sampledColor") == "#%02x%02x%02x" % colour,
              str(record.get("sampledColor")))
        lab = record.get("sampledLab") or []
        check("factory_reports_the_lab_of_%s" % sku,
              len(lab) == 3 and all(isinstance(value, (int, float)) for value in lab),
              str(lab))
        check("factory_uses_the_sampled_colour_for_the_rule_of_%s" % sku,
              record.get("accentColor") == record.get("sampledColor"),
              str(record.get("accentColor")))

        outputs = record.get("outputs", {})
        check("factory_writes_three_banners_for_%s" % sku, len(outputs) == 3, str(sorted(outputs)))
        for ratio, (width, height) in RATIOS.items():
            banner = Path((outputs.get(ratio) or {}).get("path", ""))
            if not banner.is_file():
                check("factory_writes_the_%s_banner_of_%s" % (ratio, sku), False, str(banner))
                continue
            check("factory_writes_the_%s_banner_of_%s" % (ratio, sku), True)
            size = read_png_size(banner)
            check("factory_banner_%s_of_%s_has_the_ratio_size" % (ratio, sku),
                  size == (width, height), "%s vs %s" % (str(size), str((width, height))))
            check("factory_banner_%s_of_%s_is_not_empty" % (ratio, sku),
                  banner.stat().st_size > 1000, str(banner.stat().st_size))

        crops = record.get("crops", {})
        check("factory_writes_three_crops_for_%s" % sku, len(crops) == 3, str(sorted(crops)))
        for ratio, (width, height) in RATIOS.items():
            crop = Path((crops.get(ratio) or {}).get("path", ""))
            if not crop.is_file():
                check("factory_writes_the_%s_crop_of_%s" % (ratio, sku), False, str(crop))
                continue
            check("factory_writes_the_%s_crop_of_%s" % (ratio, sku), True)
            expected = (int(round(width * PRODUCT_BAND[0])), int(round(height * PRODUCT_BAND[1])))
            size = read_png_size(crop)
            check("factory_crop_%s_of_%s_has_the_band_size" % (ratio, sku),
                  size == expected, "%s vs %s" % (str(size), str(expected)))

        # -- the trace ------------------------------------------------------
        trace_path = OUT / sku / "trace.jsonl"
        trace = read_trace(trace_path)
        check("factory_writes_a_trace_for_%s" % sku, len(trace) > 0, str(len(trace)))
        check("factory_trace_sequence_is_monotonic_for_%s" % sku,
              [record["seq"] for record in trace] == list(range(1, len(trace) + 1)))
        tools = {record["tool"] for record in trace}
        check("factory_trace_records_photocraft_for_%s" % sku,
              {"doc_new", "doc_open", "doc_save", "command_run"}.issubset(tools),
              str(sorted(tools)))
        type_calls = [record for record in trace
                      if record.get("commandId") == "type.create"]
        texts = [record.get("params", {}).get("text", "") for record in type_calls]
        check("factory_trace_records_the_copy_for_%s" % sku,
              "Made for the windowsill" in texts, str(texts))
        check("factory_trace_records_the_disclaimer_for_%s" % sku,
              any("Terms apply" in text for text in texts), str(texts))
        rule_calls = [record for record in trace
                      if record.get("commandId") == "shape.create"]
        check("factory_trace_records_the_accent_rule_for_%s" % sku,
              bool(rule_calls) and rule_calls[0].get("params", {}).get("fill")
              == record.get("accentColor"),
              json.dumps(rule_calls[:1])[:200])
        crop_calls = [record for record in trace
                      if record.get("commandId") == "image.crop"]
        check("factory_trace_records_the_crops_for_%s" % sku,
              len(crop_calls) == 3, str(len(crop_calls)))

    # -- the banner's own pixels, read back through PhotoCraft -------------
    mug = by_sku.get("nw-mug-01", {})
    outputs = mug.get("outputs", {})
    banner = Path((outputs.get("amazon") or {}).get("path", ""))
    if banner.is_file():
        engine = Engine(["photocraft-cli", "mcp",
                         "--automation-read-root", str(OUT),
                         "--automation-write-root", str(OUT)])
        try:
            opened = engine.tool("doc_open", {"path": str(banner)})
            width = int(opened.get("width", 0))
            height = int(opened.get("height", 0))
            check("photocraft_opens_the_finished_banner",
                  width == 1080 and height == 1080, "%dx%d" % (width, height))
            centre_x = int(width / 2)
            centre_y = int(height * (BAND_TOP + PRODUCT_BAND[1] / 2.0))
            pixel = engine.tool("command_run", {
                "id": "document.pixel", "params": {"x": centre_x, "y": centre_y}})
            if isinstance(pixel, list) and len(pixel) >= 3:
                observed = tuple(int(round(float(value) * 255)) for value in pixel[:3])
                expected = (200, 90, 40)
                check("the_banner_carries_the_product",
                      all(abs(observed[i] - expected[i]) <= 14 for i in range(3)),
                      "%s vs %s" % (str(observed), str(expected)))
            rule = engine.tool("command_run", {
                "id": "document.pixel",
                "params": {"x": int(width * 0.20), "y": int(height * 0.818)}})
            if isinstance(rule, list) and len(rule) >= 3:
                observed = tuple(int(round(float(value) * 255)) for value in rule[:3])
                check("the_banner_carries_the_accent_rule",
                      abs(observed[0] - 200) <= 14 and abs(observed[1] - 90) <= 14
                      and abs(observed[2] - 40) <= 14,
                      str(observed))
        finally:
            engine.close()

    # -- determinism and resumability --------------------------------------
    first_report = report_path.read_text(encoding="utf-8") if report_path.is_file() else ""
    second = run_factory(MANIFEST)
    check("second_run_succeeds", second.returncode == 0, second.stderr[-300:])
    second_report = (OUT / "report.json").read_text(encoding="utf-8")
    check("the_report_is_replayable", first_report == second_report,
          "the report differs between two runs over the same manifest")

    resumed = run_factory(MANIFEST, resume=True)
    check("resumed_run_succeeds", resumed.returncode == 0, resumed.stderr[-300:])
    check("resumed_report_is_identical",
          (OUT / "report.json").read_text(encoding="utf-8") == first_report)

    # -- the validation gate ------------------------------------------------
    broken = json.loads(MANIFEST.read_text(encoding="utf-8"))
    broken["skus"][0]["productCutoutPath"] = str(ASSETS / "does-not-exist.png")
    broken_path = WORK / "manifest.missing.json"
    broken_path.write_text(json.dumps(broken, indent=2), encoding="utf-8")
    missing = run_factory(broken_path)
    check("validation_failure_on_a_missing_cutout", missing.returncode == 1,
          "rc=%s" % missing.returncode)
    check("validation_failure_is_reported_as_validation",
          "not found" in missing.stderr, missing.stderr[-200:])

    long_copy = json.loads(MANIFEST.read_text(encoding="utf-8"))
    long_copy["skus"][0]["copy"]["headline"] = "x" * 60
    long_path = WORK / "manifest.long.json"
    long_path.write_text(json.dumps(long_copy, indent=2), encoding="utf-8")
    too_long = run_factory(long_path)
    check("validation_failure_on_an_over_long_headline", too_long.returncode == 1,
          "rc=%s" % too_long.returncode)

    duplicate = json.loads(MANIFEST.read_text(encoding="utf-8"))
    duplicate["skus"].append(dict(duplicate["skus"][0]))
    duplicate_path = WORK / "manifest.duplicate.json"
    duplicate_path.write_text(json.dumps(duplicate, indent=2), encoding="utf-8")
    dupe = run_factory(duplicate_path)
    check("validation_failure_on_a_duplicate_sku", dupe.returncode == 1,
          "rc=%s" % dupe.returncode)

    # -- the hygiene -------------------------------------------------------
    for cache in FILES.rglob("__pycache__"):
        shutil.rmtree(str(cache), ignore_errors=True)

    publish = WORK.parent
    for source, name in (
        (OUT / "report.json", "campaign-report.json"),
        (OUT / "nw-lamp-02" / "banners" / "instagram.png", "nw-lamp-02-instagram.png"),
        (OUT / "nw-lamp-02" / "trace.jsonl", "nw-lamp-02-trace.jsonl"),
        (MANIFEST, "manifest.json"),
    ):
        shutil.copy2(source, publish / name)

    print("%d assertions passed" % len(PASSED))
    if FAILED:
        for label, detail in FAILED:
            print("FAILED %s %s" % (label, detail))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
