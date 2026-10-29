#!/usr/bin/env python3
"""run_ex3.py — acceptance harness for the asset-resolution cascade.

It runs three real scenarios: a catalog hit, a placeholder through the
authenticated loopback stub, and a deferred row when neither path is
available. The trace is the verification surface.
"""
from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
OUTPUT = HERE.parent / "output"
LIBRARY = OUTPUT / "library"
RESOLVED = OUTPUT / "resolved"
PLACEHOLDER = OUTPUT / "placeholder"
DEFERRED = OUTPUT / "deferred"
SOURCE = OUTPUT / "source" / "hero.png"
TOKEN = "c" * 64

spec = importlib.util.spec_from_file_location(
    "asset_resolution", HERE / "03_long-running-asset-resolution-agent-mcp-driven-autonomous-fallback-for-missing-hero-images.py")
resolution = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = resolution
spec.loader.exec_module(resolution)
stub_spec = importlib.util.spec_from_file_location("stub_control_server", HERE / "stub_control_server.py")
stub = importlib.util.module_from_spec(stub_spec)
assert stub_spec.loader is not None
stub_spec.loader.exec_module(stub)

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


def make_hero() -> None:
    SOURCE.parent.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGB", (1600, 1600), "#f4f1ea")
    pixels = image.load()
    for y in range(1600):
        for x in range(1600):
            value = int(70 + 90 * (1 - abs(x - 800) / 800))
            pixels[x, y] = (value, min(255, value + 30), min(255, value + 70))
    image.save(SOURCE)


def prepare_library() -> None:
    import shutil
    for stale in (LIBRARY, RESOLVED, PLACEHOLDER, DEFERRED, SOURCE.parent):
        if stale.exists():
            shutil.rmtree(stale)
    make_hero()
    library = LIBRARY
    env = {**os.environ, "PATH": f"{HERE.parents[3] / 'tools' / 'craft-cli' / 'bin'}:{os.environ.get('PATH','')}"}
    commands = [
        "lightcraft-cli", "run", "--library", str(library), "--import", str(SOURCE),
        "photo.setMeta", json.dumps({"ids": [1], "title": "SKU-100", "keywords": ["SKU-100"]}),
        "develop.set", json.dumps({"ids": [1], "control": "light.exposure", "value": 0.1}),
        "preset.create", json.dumps({"name": "Brand-Standard-v3", "groups": ["light"]}),
    ]
    completed = subprocess.run(commands, capture_output=True, text=True, env=env)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr[-400:] or completed.stdout[-400:])


def request(sku: str, token_env: str, port: int, deadline_ms: int = 20_000):
    return resolution.ResolutionRequest(
        sku=sku, title="Trail Runner", preferred_aspect=(4, 5), min_long_edge=1200,
        preset_fallback="Brand-Standard-v3", deadline_ms=deadline_ms,
        loopback_port=port, loopback_token_env=token_env,
    )


async def main() -> int:
    prepare_library()
    os.environ["LIGHTCRAFT_LIBRARY"] = str(LIBRARY)
    RESOLVED.mkdir(parents=True, exist_ok=True)
    PLACEHOLDER.mkdir(parents=True, exist_ok=True)
    DEFERRED.mkdir(parents=True, exist_ok=True)
    for stale in ("report.json",):
        (OUTPUT / stale).unlink(missing_ok=True)

    print("\n# trace units")
    equal("digest: canonical json is stable",
          resolution._digest({"b": 1, "a": [1, 2]}), resolution._digest({"a": [1, 2], "b": 1}))
    equal("digest: 16 hex characters", len(resolution._digest({"x": 1})), 16)

    print("\n# catalog strategy")
    catalog_req = request("SKU-100", "PHOTOCRAFT_TOKEN", 0)
    catalog_trace = await resolution.resolve_one(catalog_req, str(RESOLVED))
    equal("catalog: resolved", catalog_trace.status, "resolved")
    equal("catalog: strategy", catalog_trace.strategy, "catalog")
    ok("catalog: a rationale is recorded", bool(catalog_trace.candidate_rationale), catalog_trace.candidate_rationale or "")
    ok("catalog: a file was produced", bool(catalog_trace.resolved_path) and Path(catalog_trace.resolved_path).exists())
    ok("catalog: bytes and sha are recorded", bool(catalog_trace.resolved_bytes) and len(catalog_trace.resolved_sha256 or "") == 64)
    ok("catalog: the call trace is ordered", len(catalog_trace.call_trace) >= 3, json.dumps(catalog_trace.call_trace))
    ok("catalog: each call has a digest", all(len(row["resultDigest"]) == 16 for row in catalog_trace.call_trace))
    if catalog_trace.resolved_path:
        ok("catalog: output is a real JPEG",
           Path(catalog_trace.resolved_path).read_bytes()[:2] == b"\xff\xd8")

    print("\n# placeholder strategy")
    server = stub.StubControlServer(TOKEN)
    server.start()
    try:
        os.environ["PHOTOCRAFT_TOKEN"] = TOKEN
        placeholder_req = request("SKU-200", "PHOTOCRAFT_TOKEN", server.port)
        placeholder_trace = await resolution.resolve_one(placeholder_req, str(PLACEHOLDER))
        equal("placeholder: status", placeholder_trace.status, "placeholder")
        equal("placeholder: strategy", placeholder_trace.strategy, "placeholder")
        ok("placeholder: screenshot written", bool(placeholder_trace.resolved_path)
           and Path(placeholder_trace.resolved_path).exists())
        if placeholder_trace.resolved_path:
            ok("placeholder: output is a PNG",
               Path(placeholder_trace.resolved_path).read_bytes()[:8] == b"\x89PNG\r\n\x1a\n")
        ok("placeholder: the loopback was called", "ui.screenshot" in server.calls, json.dumps(server.calls))
    finally:
        server.stop()

    print("\n# deferral")
    os.environ.pop("PHOTOCRAFT_TOKEN", None)
    deferred_req = request("SKU-200", "MISSING_TOKEN", 1)
    deferred_trace = await resolution.resolve_one(deferred_req, str(DEFERRED))
    equal("deferred: status", deferred_trace.status, "deferred")
    equal("deferred: no strategy", deferred_trace.strategy, "none")
    equal("deferred: no path", deferred_trace.resolved_path, None)

    print("\n# evidence")
    traces = {
        "catalog": {**catalog_trace.__dict__, "call_trace": catalog_trace.call_trace},
        "placeholder": {**placeholder_trace.__dict__, "call_trace": placeholder_trace.call_trace},
        "deferred": {**deferred_trace.__dict__, "call_trace": deferred_trace.call_trace},
    }
    (OUTPUT / "resolution-traces.json").write_text(json.dumps(traces, indent=2))
    artefacts = ["resolution-traces.json", "source/hero.png", "library/catalog.snap"]
    if catalog_trace.resolved_path:
        artefacts.append(str(Path(catalog_trace.resolved_path).relative_to(OUTPUT)))
    if placeholder_trace.resolved_path:
        artefacts.append(str(Path(placeholder_trace.resolved_path).relative_to(OUTPUT)))
    for artefact in artefacts:
        ok(f"output: {artefact}", (OUTPUT / artefact).exists())
    (OUTPUT / "report.json").write_text(json.dumps({
        "exercise": 3,
        "engine": "lightcraft-cli + PhotoCraft loopback stub",
        "assertions": PASSED + 1,
        "catalog": {"status": catalog_trace.status, "path": catalog_trace.resolved_path,
                    "sha256": catalog_trace.resolved_sha256},
        "placeholder": {"status": placeholder_trace.status, "path": placeholder_trace.resolved_path},
        "deferred": {"status": deferred_trace.status, "strategy": deferred_trace.strategy},
        "artefacts": artefacts,
        "result": "catalog hit resolved, missing hero synthesised through the authenticated loopback, empty row deferred with a trace",
    }, indent=2))
    ok("output: report manifest", (OUTPUT / "report.json").exists())

    print(f"\n{PASSED} assertions passed")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
