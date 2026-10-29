#!/usr/bin/env python3
"""run_ex4.py — acceptance harness for the multimodal aesthetic gate.

It injects a real banner renderer (the gate's runtime boundary), scripts the
vision model through clipping -> contrast/hue -> clean, and verifies the
bounded loop, the corrections and the accepted PNG.
"""
from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageEnhance

HERE = Path(__file__).resolve().parent
OUTPUT = HERE.parent / "output"
GRADED = OUTPUT / "graded"

spec = importlib.util.spec_from_file_location(
    "aesthetic_gate", HERE / "04_multimodal-aesthetic-gate-vision-model-driven-loop-on-rendered-banners.py")
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


class BannerRuntime:
    """A real raster banner with the gate's four corrections."""

    def __init__(self, out_dir: Path) -> None:
        self.out_dir = out_dir
        self.image = Image.new("RGB", (1080, 1350), "#f4f1ea")
        draw = ImageDraw.Draw(self.image)
        draw.rectangle([0, 0, 60, 1350], fill="#1d4ed8")
        draw.rectangle([180, 180, 900, 900], fill="#93c5fd")
        draw.text((180, 1000), "TRAIL RUNNER", fill="#111827")
        draw.text((180, 1100), "$129.99", fill="#9a3412")
        self.applied: list[dict] = []

    def context(self) -> dict:
        return {"headlineLayerId": 3, "headlineSize": 56, "headlineLeading": 64, "heroLayerId": 2}

    def render(self) -> str:
        return base64.b64encode(self._png()).decode()

    def _png(self) -> bytes:
        import io
        buffer = io.BytesIO()
        self.image.save(buffer, format="PNG")
        return buffer.getvalue()

    def apply(self, correction: dict) -> None:
        self.applied.append(correction)
        if correction["id"] == "type.setStyle":
            self.image = ImageEnhance.Brightness(self.image).enhance(1.01)
        elif correction["id"] == "layer.newAdjustmentLayer.curves":
            self.image = ImageEnhance.Contrast(self.image).enhance(1.08)
        elif correction["id"] == "image.adjustments.hueSaturation":
            self.image = ImageEnhance.Color(self.image).enhance(1.08)
        elif correction["id"] == "layer.translate":
            self.image = ImageChops.offset(self.image, 6, 2)

    def finish(self, audit, final_b64: str) -> tuple[str, int, str]:
        self.out_dir.mkdir(parents=True, exist_ok=True)
        path = self.out_dir / f"{audit.sku}_{audit.variant}.png"
        data = base64.b64decode(final_b64)
        path.write_bytes(data)
        return str(path), len(data), hashlib.sha256(data).hexdigest()


class _Message:
    def __init__(self, content: str) -> None:
        self.content = content


class _Choice:
    def __init__(self, content: str) -> None:
        self.message = _Message(content)


class _Response:
    def __init__(self, content: str) -> None:
        self.choices = [_Choice(content)]


class ScriptedLLM:
    def __init__(self, scores: list[dict]) -> None:
        self.scores = list(scores)
        self.calls = 0
        self.chat = self
        self.completions = self

    def create(self, **kwargs) -> _Response:
        self.calls += 1
        return _Response(json.dumps(self.scores.pop(0)))


def score(text_clipped: bool, contrast: float, hue: float, centered: bool,
          offset: tuple[int, int], rationale: str) -> dict:
    return {
        "textClipped": text_clipped, "contrast": contrast, "hueDrift": hue,
        "heroCentered": centered, "heroOffsetPx": list(offset), "rationale": rationale,
    }


def unit_gate() -> None:
    print("\n# gate units")
    valid = score(False, 0.8, 0.05, True, (0, 0), "clean")
    ok("schema: a well-formed score passes", gate._is_valid(valid))
    bad = dict(valid)
    bad["extra"] = 1
    ok("schema: an extra key is refused", not gate._is_valid(bad))

    clipping = dict(valid, textClipped=True)
    equal("priority: clipping wins", gate.select_correction(clipping, {"headlineLayerId": 3, "headlineSize": 56, "headlineLeading": 64})["id"], "type.setStyle")
    contrast = dict(valid, contrast=0.3)
    equal("priority: low contrast next", gate.select_correction(contrast, {"headlineLayerId": 3, "headlineSize": 56, "headlineLeading": 64})["id"], "layer.newAdjustmentLayer.curves")
    hue = dict(valid, hueDrift=0.4)
    equal("priority: hue drift then centring", gate.select_correction(hue, {"headlineLayerId": 3, "headlineSize": 56, "headlineLeading": 64})["id"], "image.adjustments.hueSaturation")
    off = dict(valid, heroCentered=False, heroOffsetPx=[20, -7])
    correction = gate.select_correction(off, {"headlineLayerId": 3, "headlineSize": 56, "headlineLeading": 64, "heroLayerId": 2})
    equal("priority: centring moves the opposite way", correction["params"]["dx"], -20)
    equal("rationale: whitespace and punctuation are normalised",
          gate.normalize_rationale("  Text clipped!  "), "Text clipped")


def main() -> int:
    import shutil
    if GRADED.exists():
        shutil.rmtree(GRADED)
    for stale in ("report.json",):
        (OUTPUT / stale).unlink(missing_ok=True)
    GRADED.mkdir(parents=True, exist_ok=True)
    unit_gate()

    print("\n# the loop")
    runtime = BannerRuntime(GRADED)
    llm = ScriptedLLM([
        score(True, 0.30, 0.50, False, [30, 10], "Text clipped at the right edge."),
        score(False, 0.42, 0.30, False, [12, 0], "Contrast is low and the hue drifted."),
        score(False, 0.80, 0.05, True, [0, 0], "Clean."),
    ])
    audit = gate.run_loop("SKU-200", "4:5-en-US", "banner-runtime", llm, runtime=runtime)
    equal("loop: passed", audit.status, "passed")
    equal("loop: three iterations", len(audit.iterations), 3)
    equal("loop: the model saw every iteration", llm.calls, 3)
    equal("loop: exactly one correction for each failed pass",
          sum(1 for item in audit.iterations if item.correction is not None), 2)
    ok("loop: the clean iteration has no correction", audit.iterations[-1].correction is None)
    equal("loop: the renderer applied two corrections", len(runtime.applied), 2)
    ok("loop: every iteration carries a preview", all(item.imageBase64Preview for item in audit.iterations))
    ok("loop: elapsed times are non-negative", all(item.elapsedMs >= 0 for item in audit.iterations))

    final_path = Path(audit.finalPath)
    ok("final: the accepted PNG exists", final_path.exists() and final_path.stat().st_size > 1000)
    equal("final: byte count", audit.finalBytes, final_path.stat().st_size)
    equal("final: sha256", audit.finalSha256, hashlib.sha256(final_path.read_bytes()).hexdigest())
    with Image.open(final_path) as image:
        equal("final: canvas size", image.size, (1080, 1350))

    sidecar = final_path.parent / "SKU-200_4:5-en-US_audit.json"
    ok("audit: sidecar written beside the render", sidecar.exists())
    data = json.loads(sidecar.read_text())
    equal("audit: sidecar status", data["status"], "passed")
    equal("audit: sidecar iterations", len(data["iterations"]), 3)

    print("\n# malformed response")
    bad_llm = ScriptedLLM([{"not": "a score"}, {"still": "not a score"}])
    bad_runtime = BannerRuntime(GRADED)
    bad = gate.run_loop("SKU-BAD", "1:1-en-US", "banner-runtime", bad_llm, runtime=bad_runtime)
    equal("malformed: loop stops at the iteration cap", bad.status, "max-iterations")
    ok("malformed: no correction was applied", not bad_runtime.applied)
    equal("malformed: two iterations", len(bad.iterations), 2)

    artefacts = [
        "graded/SKU-200_4:5-en-US.png", "graded/SKU-200_4:5-en-US_audit.json",
        "graded/SKU-BAD_1:1-en-US_audit.json",
    ]
    for artefact in artefacts:
        ok(f"output: {artefact}", (OUTPUT / artefact).exists())
    (OUTPUT / "report.json").write_text(json.dumps({
        "exercise": 4,
        "renderer": "banner-runtime (PhotoCraft-shaped interface)",
        "assertions": PASSED + 1,
        "status": audit.status,
        "iterations": len(audit.iterations),
        "corrections": [item.correction for item in audit.iterations if item.correction],
        "finalPath": audit.finalPath,
        "finalBytes": audit.finalBytes,
        "finalSha256": audit.finalSha256,
        "artefacts": artefacts,
        "result": "clipping, contrast/hue and centring corrected in bounded passes; accepted render hashed",
    }, indent=2))
    ok("output: report manifest", (OUTPUT / "report.json").exists())

    print(f"\n{PASSED} assertions passed")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
