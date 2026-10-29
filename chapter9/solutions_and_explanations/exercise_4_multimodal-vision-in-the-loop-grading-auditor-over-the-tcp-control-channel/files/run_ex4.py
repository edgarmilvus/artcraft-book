#!/usr/bin/env python3
"""run_ex4.py — acceptance harness for the TCP grading auditor.

Stages a deliberately dark product frame, starts the authenticated loopback
control stub, and runs the bounded numeric + vision audit. The model is
scripted, so the numeric pass is what drives every correction.
"""
from __future__ import annotations

import base64
import importlib.util
import json
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
OUTPUT = HERE.parent / "output"
AUDIT = OUTPUT / "audit"
LIBRARY = OUTPUT / "library"
PHOTO = OUTPUT / "source" / "product.png"
TOKEN = "a" * 64

spec = importlib.util.spec_from_file_location(
    "tcp_audit", HERE / "04_multimodal-vision-in-the-loop-grading-auditor-over-the-tcp-control-channel.py")
pipeline = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = pipeline
spec.loader.exec_module(pipeline)
stub = importlib.util.spec_from_file_location("stub_control_server", HERE / "stub_control_server.py")
stub_module = importlib.util.module_from_spec(stub)
assert stub.loader is not None
stub.loader.exec_module(stub_module)

pipeline.WRITE_ROOT = AUDIT

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


class _Message:
    def __init__(self, content: str) -> None:
        self.content = content


class _Choice:
    def __init__(self, content: str) -> None:
        self.message = _Message(content)


class _Response:
    def __init__(self, content: str) -> None:
        self.choices = [_Choice(content)]


class ScriptedOpenAI:
    """The shape `vision_critique()` calls: chat.completions.create."""

    def __init__(self, payload: dict) -> None:
        self.payload = payload
        self.calls = 0
        self.chat = self
        self.completions = self

    def create(self, **kwargs) -> _Response:
        self.calls += 1
        return _Response(json.dumps(self.payload))


def make_product() -> None:
    PHOTO.parent.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGB", (900, 600), (24, 22, 20))
    pixels = image.load()
    for y in range(600):
        for x in range(900):
            # A dark product plate on a non-neutral background: the centre is
            # below the 0.62 luma floor and the corners are warm, not neutral.
            if 260 < x < 640 and 170 < y < 500:
                value = 55 + int(20 * (x / 900))
                pixels[x, y] = (value, int(value * 0.94), int(value * 0.86))
            else:
                pixels[x, y] = (18 + x // 90, 22 + y // 90, 16 + x // 120)
    image.save(PHOTO)


def unit_numeric() -> None:
    print("\n# numeric enforcement")
    low = pipeline.PixelStats(center_luma=0.40, shadow_clip=0.10, highlight_clip=0.0,
                              skin_hue=None, background_deltaE=14.0)
    codes = {issue["code"] for issue in pipeline.numeric_violations(low)}
    ok("numeric: low centre is a violation", "CENTER_LUMA" in codes, str(codes))
    ok("numeric: shadow clipping is a violation", "SHADOW_CLIPPING" in codes, str(codes))
    ok("numeric: warm background is a violation", "BACKGROUND_NEUTRALITY" in codes, str(codes))

    clean = pipeline.PixelStats(center_luma=0.70, shadow_clip=0.0, highlight_clip=0.0,
                                skin_hue=None, background_deltaE=2.0)
    equal("numeric: a clean frame has no violations", pipeline.numeric_violations(clean), [])

    plan = pipeline.plan_adjustments(
        [{"code": "CENTER_LUMA", "delta": -10.0},
         {"code": "SHADOW_CLIPPING", "delta": 0.2},
         {"code": "HIGHLIGHT_CLIPPING", "delta": 0.2},
         {"code": "SKIN_HUE", "delta": 90.0}])
    ok("plan: at most three controls", len(plan) <= 3, str(plan))
    ok("plan: every light delta is clamped",
       all(abs(value) <= pipeline.MAX_DELTA_LIGHT for key, value in plan.items()
           if key.startswith("light.")), str(plan))
    ok("plan: every colour delta is clamped",
       all(abs(value) <= pipeline.MAX_DELTA_COLOR for key, value in plan.items()
           if key.startswith(("wb.", "mixer."))), str(plan))
    equal("numeric: identical Lab colours have zero deltaE",
          pipeline._deltaE2000(pipeline._srgb_to_lab(
              pipeline.np.array([[120, 120, 120]], dtype=pipeline.np.float32))[0],
              pipeline._srgb_to_lab(
              pipeline.np.array([[120, 120, 120]], dtype=pipeline.np.float32))[0]), 0.0)


def main() -> int:
    import shutil
    for stale in (AUDIT, LIBRARY, PHOTO.parent):
        if stale.exists():
            shutil.rmtree(stale)
    for stale in ("report.json", "final.jpg"):
        (OUTPUT / stale).unlink(missing_ok=True)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    make_product()
    unit_numeric()

    engine = ["lightcraft-cli", "mcp", "--library", str(LIBRARY)]
    server = stub_module.StubControlServer(TOKEN, engine=engine)
    server.start()
    try:
        print("\n# authentication")
        refused = False
        try:
            pipeline.LightCraftTCP("127.0.0.1", server.port, "b" * 64)
        except pipeline.AuthRefused as error:
            refused = "bad token" in str(error) or "auth" in str(error).lower()
        ok("auth: a bad token is refused", refused)

        short = False
        try:
            pipeline.LightCraftTCP("127.0.0.1", server.port, "abc")
        except pipeline.AuthRefused as error:
            short = "64 hex" in str(error)
        ok("auth: a short token is refused before a frame is sent", short)

        lc = pipeline.LightCraftTCP("127.0.0.1", server.port, TOKEN)
        try:
            print("\n# the audit")
            imported = lc.execute("library.import", {"paths": [str(PHOTO)], "mode": "add"})
            ok("source: the product frame was imported",
               bool(imported.get("imported")), json.dumps(imported)[:160])
            photos = lc.execute("catalog.query", {"limit": 10}).get("photos", [])
            equal("source: one catalogue photo", len(photos), 1)
            photo_id = int(photos[0]["id"])

            llm = ScriptedOpenAI({"status": "ok", "issues": [], "notes": "nothing to add"})
            report = pipeline.audit_photo(lc, llm, photo_id)
            equal("audit: the report names the photo", report["photo_id"], photo_id)
            ok("audit: one to three iterations", 1 <= report["iterations"] <= 3, str(report["iterations"]))
            equal("audit: the model was consulted", llm.calls, report["iterations"])
            ok("audit: the verdict is consistent",
               report["flagged_for_human"] is (not report["converged"]),
               f"converged={report['converged']} flagged={report['flagged_for_human']}")
            ok("audit: every iteration has a render",
               all(Path(item["render_path"]).exists() and Path(item["render_path"]).stat().st_size > 1000
                   for item in report["history"]))
            ok("audit: every iteration has a version snapshot",
               all(item["version_name"] == f"audit_iter_{item['iter']}" for item in report["history"]))
            ok("audit: every delta plan has at most three controls",
               all(len(item["deltas"]) <= 3 for item in report["history"]))
            ok("audit: the numeric pass found work to do",
               any(item["issues"] for item in report["history"]),
               json.dumps([item["issues"] for item in report["history"]]))
            final_dev = report["final_dev"]
            ok("audit: final develop state was captured",
               isinstance(final_dev, dict) and "light" in final_dev)
            changed = any(item["deltas"] for item in report["history"])
            if changed:
                ok("audit: an adjustment moved exposure or shadows",
                   abs(float(final_dev["light"]["exposure"])) > 1e-9 or
                   abs(float(final_dev["light"]["shadows"])) > 1e-9,
                   json.dumps(final_dev["light"]))

            final_path = OUTPUT / "final.jpg"
            lc.execute("render_photo", {"id": photo_id, "size": 1024,
                                         "format": "jpeg", "path": str(final_path)})
            ok("output: final render is a JPEG",
               final_path.exists() and final_path.read_bytes()[:2] == b"\xff\xd8")

            renders = sorted(AUDIT.glob(f"{photo_id}/iter_*.jpg"))
            artefacts = [f"audit/{photo_id}/{path.name}" for path in renders] + ["final.jpg", "source/product.png"]
            for artefact in artefacts:
                ok(f"output: {artefact}", (OUTPUT / artefact).exists())
            (OUTPUT / "report.json").write_text(json.dumps({
                "exercise": 4,
                "engine": "lightcraft-cli (authenticated loopback stub)",
                "assertions": PASSED + 1,
                "photoId": photo_id,
                "converged": report["converged"],
                "flaggedForHuman": report["flagged_for_human"],
                "iterations": report["iterations"],
                "history": report["history"],
                "finalDevelop": final_dev,
                "artefacts": artefacts,
                "result": "numeric audit drove bounded develop corrections over the authenticated control channel",
            }, indent=2))
            ok("output: report manifest", (OUTPUT / "report.json").exists())
        finally:
            lc.close()
    finally:
        server.stop()

    print(f"\n{PASSED} assertions passed")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
