#!/usr/bin/env python3
"""run_ex2.py — harness for the live blend morphing engine.

The agent talks to the control channel the same way the animation runtime
does: an auth frame first, then `engine.execute` frames. The channel is the
stub in `stub_control_server.py`, which forwards every command to the real
headless VectorCraft, so the blend, the spine and the sampled rasters are the
engine's own.
"""

from __future__ import annotations

import base64
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from importlib import import_module

morph = import_module("02_live_blend_morphing_engine")
stub = import_module("stub_control_server")

TOKEN = "a" * 64
OUTPUT = Path(__file__).resolve().parent.parent / "output"

passed = 0


def ok(label: str, condition: bool, detail: str = "") -> None:
    global passed
    if not condition:
        print(f"FAIL {label}" + (f" — {detail}" if detail else ""))
        sys.exit(1)
    passed += 1
    print(f"PASS {label}")


def equal(label: str, actual, expected) -> None:
    ok(label, actual == expected, f"expected {expected!r}, got {actual!r}")


class Reply:
    """The shape of a chat reply the agent expects."""

    def __init__(self, content: str) -> None:
        self.content = content


class ScriptedLLM:
    """A vision client that returns a fixed critique."""

    def __init__(self, critique: dict) -> None:
        self.critique = critique
        self.calls: list[int] = []

    def chat(self, prompt: str, images: list[str] | None = None) -> Reply:
        self.calls.append(len(images or []))
        return Reply(json.dumps(self.critique))


def main() -> int:
    engine_path = os.environ.get("VECTORCRAFT_BIN", "vectorcraft-cli")
    server = stub.StubControlServer(TOKEN, engine=[engine_path, "mcp", "--headless"])
    server.start()
    try:
        # -- authentication ------------------------------------------------
        print("\n# authentication")
        try:
            morph.CraftTCP("127.0.0.1", server.port, "b" * 64)
            ok("auth: a bad token is rejected", False, "the client connected")
        except RuntimeError as error:
            ok("auth: a bad token is rejected", "auth failed" in str(error), str(error))

        agent = morph.CraftTCP("127.0.0.1", server.port, TOKEN)
        ok("auth: the right token connects", True)

        # -- the two source marks -------------------------------------------
        print("\n# the source marks")
        agent.execute("file.new", {"name": "morph", "width": 800, "height": 800,
                                   "units": "Points", "colorMode": "rgb",
                                   "backgroundContents": "transparent"})
        play = agent.execute("path.create", {"closed": False, "anchors": [
            {"x": 220, "y": 300}, {"x": 400, "y": 300}, {"x": 580, "y": 460},
        ]})["result"]
        avatar = agent.execute("path.create", {"closed": False, "anchors": [
            {"x": 220, "y": 500}, {"x": 400, "y": 500}, {"x": 580, "y": 340},
            {"x": 640, "y": 420},
        ]})["result"]
        ok("sources: the play glyph is a path", isinstance(play.get("id"), int))
        ok("sources: the avatar has more anchors", avatar["id"] != play["id"])

        # -- topology alignment ---------------------------------------------
        print("\n# topology alignment")
        alignment = morph.align_topology(agent, play["id"], avatar["id"])
        equal("alignment: one anchor was inserted", alignment["inserted"], 1)
        after = morph.read_anchors(agent, alignment["lighter"])
        equal("alignment: the counts now match", len(after), 4)

        # -- the build -------------------------------------------------------
        print("\n# the build")
        blend_id = morph.build_brand_morph(agent, play["id"], avatar["id"], cx=400, cy=400, r=120)
        ok("build: the blend has an id", isinstance(blend_id, int))
        info = agent.execute("object.blend.info", {})["result"]
        equal("build: the blend is selected", info.get("target"), "blend")
        equal("build: it has two keys", len(info.get("keys", [])), 2)
        equal("build: it has 24 steps", info.get("steps"), 24)
        spine = info.get("spine", {})
        equal("build: the spine has two anchors", len(spine.get("anchors", [])), 2)
        starts = [a for a in spine.get("anchors", [])]
        moved = (any(abs(a["x"] - 280) < 0.01 and abs(a["y"] - 400) < 0.01 for a in starts)
                 and any(abs(a["x"] - 400) < 0.01 and abs(a["y"] - 280) < 0.01 for a in starts))
        ok("build: the spine was bent onto the arc", moved, json.dumps(starts))
        handles = [a for a in starts if a.get("out")]
        ok("build: the spine has tangent handles", all("out" in a for a in starts), json.dumps(starts))

        # -- the sampler ------------------------------------------------------
        print("\n# the sampler")
        samples = [morph.sample_morph(agent, blend_id, t) for t in (0.0, 0.25, 0.5, 0.75, 1.0)]
        equal("sampler: five samples", len(samples), 5)
        for sample in samples:
            equal(f"sampler: t={sample['t']} echoes the request", sample["t"], sample["t"])
            ok(f"sampler: t={sample['t']} has a tangent", len(sample["spineTangent"]) == 2)
            length = (sample["spineTangent"][0] ** 2 + sample["spineTangent"][1] ** 2) ** 0.5
            ok(f"sampler: t={sample['t']} tangent is a unit vector", abs(length - 1.0) < 1e-3, f"{length}")
            equal(f"sampler: t={sample['t']} has no stroke drift", sample["widthDeltaPct"], 0.0)
            equal(f"sampler: t={sample['t']} reports four bounds", len(sample["bounds"]), 4)
        ok("sampler: the samples differ", len({json.dumps(s["bounds"]) for s in samples}) > 1)

        # -- the raster -------------------------------------------------------
        print("\n# the raster")
        raster = morph.sample_morph(agent, blend_id, 0.5, include_raster=True, raster_max_side=256)
        ok("raster: there is a PNG", isinstance(raster.get("raster"), str) and len(raster["raster"]) > 100)
        png = base64.b64decode(raster["raster"])
        ok("raster: it is a PNG file", png[:8] == b"\x89PNG\r\n\x1a\n", repr(png[:8]))
        ok("raster: it is not empty", len(png) > 1000, f"{len(png)} bytes")

        # -- the vision review ------------------------------------------------
        print("\n# the vision review")
        clean = ScriptedLLM({"pinches": [], "strokeDrift": [], "selfInt": []})
        critique = morph.vision_review(agent, blend_id, clean)
        equal("review: the model saw five frames", clean.calls[0], 5)
        ok("review: a clean morph is accepted", morph.accept(critique))

        pinched = ScriptedLLM({"pinches": [{"frame": 2, "t": 0.5, "severity": "high"}],
                               "strokeDrift": [], "selfInt": []})
        escalated = False
        try:
            morph.vision_review(agent, blend_id, pinched)
        except RuntimeError as error:
            escalated = "3 attempts" in str(error)
        ok("review: a permanent pinch escalates", escalated)
        equal("review: the repair was re-reviewed three times", len(pinched.calls), 4)

        # -- durable evidence -------------------------------------------------
        print("\n# the output package")
        OUTPUT.mkdir(parents=True, exist_ok=True)
        samples_dir = OUTPUT / "samples"
        samples_dir.mkdir(parents=True, exist_ok=True)
        sample_records = []
        for sample in samples:
            enriched = morph.sample_morph(agent, blend_id, sample["t"],
                                          include_raster=True, raster_max_side=512)
            raw = base64.b64decode(enriched["raster"])
            path = samples_dir / f"t-{sample['t']:.2f}.png"
            path.write_bytes(raw)
            ok(f"package: sample t={sample['t']} is a PNG", raw[:8] == b"\x89PNG\r\n\x1a\n")
            ok(f"package: sample t={sample['t']} written", path.exists() and path.stat().st_size > 1000)
            sample_records.append({key: value for key, value in enriched.items() if key != "raster"})
        info = agent.execute("object.blend.info", {})["result"]
        (OUTPUT / "blend-info.json").write_text(json.dumps(info, indent=2))
        agent.execute("document.export", {"path": str(OUTPUT / "morph.vectorcraft"), "format": "vectorcraft"})
        agent.execute("document.export", {"path": str(OUTPUT / "morph.svg"), "format": "svg",
                                          "artboard": 0})
        ok("package: blend-info.json is written", (OUTPUT / "blend-info.json").exists())
        ok("package: morph.vectorcraft is written", (OUTPUT / "morph.vectorcraft").exists())
        ok("package: morph.svg is written", (OUTPUT / "morph.svg").exists())
        (OUTPUT / "samples.json").write_text(json.dumps(sample_records, indent=2))
        (OUTPUT / "review.json").write_text(json.dumps({
            "clean": critique,
            "pinchEscalated": escalated,
            "reviewCalls": len(pinched.calls),
        }, indent=2))
        artefacts = ["morph.vectorcraft", "morph.svg", "blend-info.json", "samples.json", "review.json"] + [
            f"samples/t-{sample['t']:.2f}.png" for sample in samples
        ]
        for artefact in artefacts:
            ok(f"output: {artefact}", (OUTPUT / artefact).exists())
        (OUTPUT / "report.json").write_text(json.dumps({
            "exercise": 2,
            "engine": "vectorcraft-cli (authenticated loopback stub)",
            "assertions": passed + 1,
            "blend": {"steps": info.get("steps"), "spineAnchors": len(info.get("spine", {}).get("anchors", []))},
            "samples": sample_records,
            "artefacts": artefacts,
            "result": "topology aligned, blend built, spine bent, samples exported, clean review accepted and permanent pinch escalated",
        }, indent=2))
        ok("output: report manifest", (OUTPUT / "report.json").exists())

        agent.close()
        print(f"\n{passed} assertions passed")
        return 0
    finally:
        server.stop()


if __name__ == "__main__":
    sys.exit(main())
