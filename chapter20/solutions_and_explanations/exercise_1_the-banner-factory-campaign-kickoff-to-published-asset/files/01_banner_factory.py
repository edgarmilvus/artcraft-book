#!/usr/bin/env python3
"""
banner_factory.py — the reference implementation of the Banner Factory spec.

The factory ingests a banner manifest, samples the SKU's primary colour
from the product photo's opaque silhouette, emits one aspect-ratio crop per
placement, composites every crop into a finished banner — brand chip, accent
rule, copy and disclaimer — and writes a report that can be replayed.

Design commitments made in-code:

  * All crop and composite work happens in PhotoCraft. No post-export
    image utility ever touches an asset.
  * Every SKU owns its own engine process. No cross-SKU sharing.
  * Every non-deterministic parameter (the sampling phase) is derived from
    a SHA-256 of the manifest entry, never from the wall clock.
  * Every MCP call is traced to {sku}/trace.jsonl with a monotonic
    sequence, so a run can be replayed from the trace alone.
  * The report carries no timestamp: two runs over the same manifest
    produce the same report, byte for byte.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Optional

# ---------------------------------------------------------------------------
# The placements the factory produces.
# ---------------------------------------------------------------------------

RATIOS: dict = {
    "amazon": (1080, 1080),
    "web": (1920, 1080),
    "instagram": (1080, 1350),
}

# The product band of a banner, as a fraction of the canvas. The crop is
# taken at the band's aspect, so the product is never distorted.
PRODUCT_BAND = (0.88, 0.46)
BAND_TOP = 0.34

MAX_HEADLINE, MAX_SUBHEAD, MAX_CTA = 40, 80, 20
HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")

# The sampling grid. Twelve by twelve is cheap and stable, and the phase
# offset comes from the SKU's seed so the grid never lands on the same
# pixels for two products.
PIXEL_GRID = 12
ALPHA_THRESHOLD = 0.5


class ValidationError(Exception):
    """The manifest is not usable; the factory refuses to start."""


class EngineError(Exception):
    """An engine call failed."""


# ---------------------------------------------------------------------------
# Manifest validation (fail fast, before any engine is spawned)
# ---------------------------------------------------------------------------

def validate_manifest(manifest: Any) -> None:
    if not isinstance(manifest, dict):
        raise ValidationError("manifest must be a JSON object")
    for key in ("brand", "skus", "outputRoot"):
        if key not in manifest:
            raise ValidationError("missing top-level key: %s" % key)

    brand = manifest["brand"]
    if not isinstance(brand, dict):
        raise ValidationError("brand must be an object")
    for key in ("name", "chipSvgPath", "disclaimer"):
        if key not in brand:
            raise ValidationError("brand.%s is required" % key)
    if not Path(brand["chipSvgPath"]).is_file():
        raise ValidationError("brand.chipSvgPath not found: %s" % brand["chipSvgPath"])
    if "accentRuleColor" in brand and not HEX_RE.match(str(brand["accentRuleColor"])):
        raise ValidationError("brand.accentRuleColor must be #rrggbb")
    if "background" in brand and not HEX_RE.match(str(brand["background"])):
        raise ValidationError("brand.background must be #rrggbb")

    skus = manifest["skus"]
    if not isinstance(skus, list) or not skus:
        raise ValidationError("skus must be a non-empty array")
    seen: set = set()
    for index, sku in enumerate(skus):
        if not isinstance(sku, dict):
            raise ValidationError("skus[%d] must be an object" % index)
        for key in ("sku", "productCutoutPath", "copy"):
            if key not in sku:
                raise ValidationError("skus[%d].%s is required" % (index, key))
        if sku["sku"] in seen:
            raise ValidationError("duplicate sku: %s" % sku["sku"])
        seen.add(sku["sku"])
        if not Path(sku["productCutoutPath"]).is_file():
            raise ValidationError("cutout not found: %s" % sku["productCutoutPath"])
        copy = sku["copy"]
        if not isinstance(copy, dict):
            raise ValidationError("skus[%d].copy must be an object" % index)
        for key, limit in (("headline", MAX_HEADLINE), ("subhead", MAX_SUBHEAD), ("cta", MAX_CTA)):
            if key not in copy or not isinstance(copy[key], str):
                raise ValidationError("skus[%d].copy.%s must be a string" % (index, key))
            if len(copy[key]) > limit:
                raise ValidationError("skus[%d].copy.%s exceeds %d characters" % (index, key, limit))

    root = Path(manifest["outputRoot"])
    root.mkdir(parents=True, exist_ok=True)
    if not os.access(root, os.W_OK):
        raise ValidationError("outputRoot is not writable: %s" % root)

    concurrency = manifest.get("concurrency")
    if concurrency is not None and (not isinstance(concurrency, int) or concurrency < 1):
        raise ValidationError("concurrency must be a positive integer")


# ---------------------------------------------------------------------------
# Deterministic seed (never the wall clock)
# ---------------------------------------------------------------------------

def seed_for(sku: str, salt: str = "") -> int:
    """A stable 32-bit seed derived from the SKU and a salt."""
    digest = hashlib.sha256(("%s|%s" % (sku, salt)).encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big")


# ---------------------------------------------------------------------------
# A synchronous MCP client (JSON-RPC 2.0 over line-delimited frames)
# ---------------------------------------------------------------------------

class McpClient:
    """Drives one engine's MCP server over stdio."""

    def __init__(self, command: list, cwd: Optional[Path] = None) -> None:
        self.command = list(command)
        self.proc = subprocess.Popen(
            self.command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
            cwd=str(cwd) if cwd is not None else None,
        )
        self._id = 0
        self._lock = threading.Lock()
        self._request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "banner-factory", "version": "1.0"},
        })
        self._notify("notifications/initialized", {})

    def _request(self, method: str, params: dict) -> Any:
        with self._lock:
            self._id += 1
            assert self.proc.stdin is not None and self.proc.stdout is not None
            self.proc.stdin.write(json.dumps(
                {"jsonrpc": "2.0", "id": self._id, "method": method, "params": params}) + "\n")
            self.proc.stdin.flush()
            line = self.proc.stdout.readline()
            if not line:
                raise EngineError("%s closed the pipe" % self.command[0])
            response = json.loads(line)
            if "error" in response:
                raise EngineError("%s: %s" % (self.command[0], json.dumps(response["error"])))
            return response.get("result")

    def _notify(self, method: str, params: dict) -> None:
        with self._lock:
            assert self.proc.stdin is not None
            self.proc.stdin.write(json.dumps(
                {"jsonrpc": "2.0", "method": method, "params": params}) + "\n")
            self.proc.stdin.flush()

    def call_tool(self, tool: str, args: dict) -> Any:
        result = self._request("tools/call", {"name": tool, "arguments": args})
        if not isinstance(result, dict):
            return result
        if result.get("isError") is True:
            raise EngineError("%s rejected %s: %s" % (
                self.command[0], tool, json.dumps(result.get("content"))[:300]))
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


# ---------------------------------------------------------------------------
# Trace (JSON Lines, streaming, per SKU)
# ---------------------------------------------------------------------------

class Trace:
    """Every engine call the factory makes, in order."""

    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = open(path, "w", encoding="utf-8")
        self.seq = 0

    def log(self, tool: str, command_id: str, elapsed_ms: int, error: Optional[str],
            params: Optional[dict] = None) -> None:
        self.seq += 1
        record = {
            "seq": self.seq,
            "tool": tool,
            "commandId": command_id,
            "elapsedMs": elapsed_ms,
            "error": error,
        }
        if params is not None:
            record["params"] = params
        self.handle.write(json.dumps(record) + "\n")
        self.handle.flush()  # crash-resilient by construction

    def close(self) -> None:
        self.handle.close()


# ---------------------------------------------------------------------------
# Colour
# ---------------------------------------------------------------------------

def srgb_to_lab(red: float, green: float, blue: float) -> tuple:
    """sRGB (0..1) -> CIE L*a*b* (D65). Deterministic, closed-form."""
    def linearise(channel: float) -> float:
        return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4

    r, g, b = linearise(red), linearise(green), linearise(blue)
    x = r * 0.4124 + g * 0.3576 + b * 0.1805
    y = r * 0.2126 + g * 0.7152 + b * 0.0722
    z = r * 0.0193 + g * 0.1192 + b * 0.9505
    x, y, z = x / 0.95047, y / 1.0, z / 1.08883

    def f(t: float) -> float:
        return t ** (1 / 3) if t > 0.008856 else (7.787 * t + 16 / 116)

    fx, fy, fz = f(x), f(y), f(z)
    return (116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz))


def median(values: list) -> float:
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2.0


# ---------------------------------------------------------------------------
# The PhotoCraft stage: sample the silhouette, cut the crops
# ---------------------------------------------------------------------------

def spawn_photocraft(read_root: Path, write_root: Path) -> McpClient:
    return McpClient([
        "photocraft-cli", "mcp",
        "--automation-read-root", str(read_root),
        "--automation-write-root", str(write_root),
    ])


def sample_primary_colour(client: McpClient, cutout: Path, seed: int,
                          trace: Trace, invoked: list) -> tuple:
    """Open the cutout, sample its opaque silhouette, return (#rrggbb, Lab).

    Only the opaque pixels count: a cutout is a product on a transparent
    ground, and the transparent ground has no colour to report.
    """
    opened = client.call_tool("doc_open", {"path": str(cutout)})
    trace.log("doc_open", "doc_open", 0, None)
    invoked.append("doc_open")
    if not isinstance(opened, dict):
        raise EngineError("doc_open did not answer with a document")
    width = int(opened.get("width", 0))
    height = int(opened.get("height", 0))
    if width <= 0 or height <= 0:
        raise EngineError("the cutout has no pixels")

    # The grid's phase comes from the seed, so two SKUs never sample the
    # same pixels — and the same SKU always samples the same ones.
    phase_x = seed % max(width, 1)
    phase_y = (seed // 7) % max(height, 1)

    samples: list = []
    for row in range(PIXEL_GRID):
        for column in range(PIXEL_GRID):
            x = min(width - 1, (column * width) // PIXEL_GRID + phase_x % max(width // PIXEL_GRID, 1))
            y = min(height - 1, (row * height) // PIXEL_GRID + phase_y % max(height // PIXEL_GRID, 1))
            started = time.monotonic()
            params = {"x": int(x), "y": int(y)}
            pixel = client.call_tool("command_run", {
                "id": "document.pixel", "params": params})
            trace.log("command_run", "document.pixel",
                      int((time.monotonic() - started) * 1000), None, params)
            invoked.append("document.pixel")
            if not isinstance(pixel, list) or len(pixel) < 4:
                continue
            if float(pixel[3]) < ALPHA_THRESHOLD:
                continue
            samples.append((float(pixel[0]), float(pixel[1]), float(pixel[2])))

    if not samples:
        raise EngineError("no opaque samples — is the cutout actually alpha-masked?")

    red = median([sample[0] for sample in samples])
    green = median([sample[1] for sample in samples])
    blue = median([sample[2] for sample in samples])
    hex_colour = "#%02x%02x%02x" % (
        max(0, min(255, int(round(red * 255)))),
        max(0, min(255, int(round(green * 255)))),
        max(0, min(255, int(round(blue * 255)))),
    )
    return hex_colour, srgb_to_lab(red, green, blue)


def crop_rectangle(source_w: int, source_h: int, target_w: int, target_h: int) -> tuple:
    """The centre rectangle of the source that carries the target aspect."""
    target_aspect = target_w / target_h
    source_aspect = source_w / source_h if source_h else 0.0
    if source_aspect > target_aspect:
        crop_h = source_h
        crop_w = int(round(source_h * target_aspect))
    else:
        crop_w = source_w
        crop_h = int(round(source_w / target_aspect)) if target_aspect else source_h
    crop_w = max(1, min(crop_w, source_w))
    crop_h = max(1, min(crop_h, source_h))
    return (source_w - crop_w) // 2, (source_h - crop_h) // 2, crop_w, crop_h


def cut_crops(client: McpClient, cutout: Path, out_dir: Path, brand: dict,
              trace: Trace, invoked: list) -> dict:
    """One crop per placement, each in its own document."""
    crops: dict = {}
    crops_dir = out_dir / "cutouts"
    crops_dir.mkdir(parents=True, exist_ok=True)

    for ratio, (width, height) in RATIOS.items():
        band_w = int(round(width * PRODUCT_BAND[0]))
        band_h = int(round(height * PRODUCT_BAND[1]))
        opened = client.call_tool("doc_open", {"path": str(cutout)})
        trace.log("doc_open", "doc_open", 0, None)
        invoked.append("doc_open")
        if not isinstance(opened, dict):
            raise EngineError("doc_open did not answer with a document")
        source_w = int(opened.get("width", width))
        source_h = int(opened.get("height", height))
        x, y, crop_w, crop_h = crop_rectangle(source_w, source_h, band_w, band_h)

        started = time.monotonic()
        params = {
            "x": x, "y": y, "width": crop_w, "height": crop_h,
            "targetWidth": band_w, "targetHeight": band_h,
        }
        client.call_tool("command_run", {"id": "image.crop", "params": params})
        trace.log("command_run", "image.crop",
                  int((time.monotonic() - started) * 1000), None, params)
        invoked.append("image.crop")

        target = crops_dir / ("%s.png" % ratio)
        started = time.monotonic()
        params = {"path": str(target), "format": "png"}
        client.call_tool("doc_save", params)
        trace.log("doc_save", "doc_save",
                  int((time.monotonic() - started) * 1000), None, params)
        invoked.append("doc_save")
        client.call_tool("doc_close", {})
        trace.log("doc_close", "doc_close", 0, None)
        invoked.append("doc_close")
        crops[ratio] = {"path": str(target), "width": band_w, "height": band_h}
    return crops


# ---------------------------------------------------------------------------
# The composite stage: the finished banners
# ---------------------------------------------------------------------------

def composite_banner(client: McpClient, ratio: str, width: int, height: int,
                     crop: dict, chip: Path, brand: dict, copy: dict,
                     accent: str, out_dir: Path, trace: Trace, invoked: list) -> dict:
    """Build one banner: the crop, the chip, the rule, the copy, the legal line."""
    started = time.monotonic()
    params = {
        "width": width, "height": height, "mode": "rgb", "depth": 8,
        "background": brand.get("background", "#101820"),
    }
    client.call_tool("doc_new", params)
    trace.log("doc_new", "doc_new", int((time.monotonic() - started) * 1000), None, params)
    invoked.append("doc_new")

    # The product, centred in its band.
    band_centre_x = width / 2.0
    band_centre_y = height * (BAND_TOP + PRODUCT_BAND[1] / 2.0)
    started = time.monotonic()
    params = {"path": crop["path"], "center": [band_centre_x, band_centre_y]}
    client.call_tool("doc_place", params)
    trace.log("doc_place", "doc_place",
              int((time.monotonic() - started) * 1000), None, params)
    invoked.append("doc_place")

    # The brand chip, in the top left corner.
    chip_margin = int(round(width * 0.06))
    started = time.monotonic()
    params = {"path": str(chip), "center": [chip_margin + 100, int(round(height * 0.06))]}
    client.call_tool("doc_place", params)
    trace.log("doc_place", "doc_place",
              int((time.monotonic() - started) * 1000), None, params)
    invoked.append("doc_place")

    # The accent rule: the SKU's own colour, unless the brand overrides it.
    rule_top = int(round(height * 0.815))
    rule_height = max(2, int(round(height * 0.006)))
    started = time.monotonic()
    params = {
        "kind": "rect",
        "rect": [chip_margin, rule_top, int(round(width * 0.34)), rule_height],
        "fill": accent,
        "name": "accent-rule",
    }
    client.call_tool("command_run", {"id": "shape.create", "params": params})
    trace.log("command_run", "shape.create",
              int((time.monotonic() - started) * 1000), None, params)
    invoked.append("shape.create")

    # The copy.
    text_blocks = [
        {"text": copy["headline"], "size": max(18, int(round(height * 0.062))),
         "color": brand.get("headlineColor", "#ffffff"),
         "top": 0.10, "height": 0.13, "align": "left"},
        {"text": copy["subhead"], "size": max(12, int(round(height * 0.032))),
         "color": brand.get("subheadColor", "#d8dee6"),
         "top": 0.235, "height": 0.09, "align": "left"},
        {"text": copy["cta"], "size": max(12, int(round(height * 0.038))),
         "color": brand.get("ctaColor", "#ffd166"),
         "top": 0.845, "height": 0.08, "align": "left"},
        {"text": copy.get("disclaimer", brand["disclaimer"]),
         "size": max(9, int(round(height * 0.021))),
         "color": brand.get("disclaimerColor", "#8b98a5"),
         "top": 0.935, "height": 0.05, "align": "left"},
    ]
    for block in text_blocks:
        started = time.monotonic()
        params = {
            "x": 0, "y": 0,
            "box": [
                chip_margin,
                int(round(height * block["top"])),
                int(round(width * PRODUCT_BAND[0])),
                int(round(height * block["height"])),
            ],
            "align": block["align"],
            "text": block["text"],
            "font": brand.get("font", "Source Serif 4"),
            "size": block["size"],
            "color": block["color"],
        }
        client.call_tool("command_run", {"id": "type.create", "params": params})
        trace.log("command_run", "type.create",
                  int((time.monotonic() - started) * 1000), None, params)
        invoked.append("type.create")

    banners_dir = out_dir / "banners"
    banners_dir.mkdir(parents=True, exist_ok=True)
    target = banners_dir / ("%s.png" % ratio)
    started = time.monotonic()
    params = {"path": str(target), "format": "png"}
    client.call_tool("doc_save", params)
    trace.log("doc_save", "doc_save",
              int((time.monotonic() - started) * 1000), None, params)
    invoked.append("doc_save")
    client.call_tool("doc_close", {})
    trace.log("doc_close", "doc_close", 0, None)
    invoked.append("doc_close")
    return {"path": str(target), "width": width, "height": height}


# ---------------------------------------------------------------------------
# The per-SKU driver
# ---------------------------------------------------------------------------

def process_sku(entry: dict, manifest: dict, read_root: Path, write_root: Path) -> dict:
    sku = entry["sku"]
    base = Path(manifest["outputRoot"]) / sku
    (base / "banners").mkdir(parents=True, exist_ok=True)
    (base / "cutouts").mkdir(parents=True, exist_ok=True)

    trace = Trace(base / "trace.jsonl")
    invoked: list = []
    warnings: list = []
    client = None
    try:
        client = spawn_photocraft(read_root, write_root)
        cutout = Path(entry["productCutoutPath"])
        seed = seed_for(sku)

        hex_colour, lab = sample_primary_colour(client, cutout, seed, trace, invoked)
        client.call_tool("doc_close", {})
        trace.log("doc_close", "doc_close", 0, None)
        invoked.append("doc_close")

        crops = cut_crops(client, cutout, base, manifest["brand"], trace, invoked)

        accent = manifest["brand"].get("accentRuleColor") or hex_colour
        copy = dict(entry["copy"])
        overrides = entry.get("legalOverrides") or {}
        if overrides.get("disclaimer"):
            copy["disclaimer"] = overrides["disclaimer"]

        outputs: dict = {}
        for ratio, (width, height) in RATIOS.items():
            outputs[ratio] = composite_banner(
                client, ratio, width, height, crops[ratio],
                Path(manifest["brand"]["chipSvgPath"]), manifest["brand"],
                copy, accent, base, trace, invoked)
        for ratio, output in outputs.items():
            output["bytes"] = Path(output["path"]).stat().st_size

        return {
            "sku": sku,
            "status": "ok",
            "seed": seed,
            "sampledColor": hex_colour,
            "sampledLab": [round(value, 3) for value in lab],
            "accentColor": accent,
            "crops": {ratio: {"path": crop["path"], "width": crop["width"],
                              "height": crop["height"],
                              "bytes": Path(crop["path"]).stat().st_size}
                      for ratio, crop in crops.items()},
            "outputs": outputs,
            "commandsInvoked": invoked,
            "warnings": warnings,
        }
    except Exception as exc:
        return {
            "sku": sku,
            "status": "failed",
            "error": "%s: %s" % (type(exc).__name__, exc),
            "commandsInvoked": invoked,
            "warnings": warnings,
        }
    finally:
        if client is not None:
            client.close()
        trace.close()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def common_root(paths: list) -> Path:
    """The deepest directory that contains every path in the list."""
    resolved = [str(Path(path).resolve()) for path in paths]
    return Path(os.path.commonpath(resolved))


def needs_processing(base: Path, previous: Optional[dict]) -> bool:
    if previous is None:
        return True
    if previous.get("status") == "failed":
        return True
    for ratio in RATIOS:
        if not (base / "banners" / ("%s.png" % ratio)).is_file():
            return True
    return False


def main(argv: list) -> int:
    parser = argparse.ArgumentParser(description="The banner factory.")
    parser.add_argument("manifest")
    parser.add_argument("--resume", action="store_true",
                        help="skip the SKUs that are already published")
    parser.add_argument("--concurrency", type=int, default=None)
    arguments = parser.parse_args(argv)

    manifest_path = Path(arguments.manifest).resolve()
    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        print(json.dumps({"ok": False, "stage": "validate", "error": str(error)}), file=sys.stderr)
        return 1
    try:
        validate_manifest(raw)
    except ValidationError as error:
        print(json.dumps({"ok": False, "stage": "validate", "error": str(error)}), file=sys.stderr)
        return 1

    root = Path(raw["outputRoot"]).resolve()
    report_path = root / "report.json"
    previous: dict = {}
    if arguments.resume and report_path.is_file():
        try:
            for record in json.loads(report_path.read_text(encoding="utf-8")).get("skus", []):
                previous[record["sku"]] = record
        except (OSError, json.JSONDecodeError, KeyError):
            previous = {}

    read_root = common_root([manifest_path.parent, root])
    write_root = root

    default_workers = max(1, min(4, (os.cpu_count() or 2) // 2))
    workers = arguments.concurrency or raw.get("concurrency") or default_workers

    results: list = []
    todo: list = []
    for entry in raw["skus"]:
        base = root / entry["sku"]
        if arguments.resume and not needs_processing(base, previous.get(entry["sku"])):
            results.append(previous[entry["sku"]])
            continue
        todo.append(entry)

    if todo:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for record in pool.map(lambda entry: process_sku(entry, raw, read_root, write_root), todo):
                results.append(record)

    report = {
        "manifestPath": str(manifest_path),
        "brand": raw["brand"]["name"],
        "ratios": {name: {"width": size[0], "height": size[1]} for name, size in RATIOS.items()},
        "skus": sorted(results, key=lambda record: record["sku"]),
    }
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    failed = [record for record in results if record["status"] == "failed"]
    for record in failed:
        print(json.dumps({"sku": record["sku"], "error": record.get("error")}), file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
