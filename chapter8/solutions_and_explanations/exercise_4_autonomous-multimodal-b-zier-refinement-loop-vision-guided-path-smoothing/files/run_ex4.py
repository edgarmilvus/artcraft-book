#!/usr/bin/env python3
"""run_ex4.py — harness for the autonomous Bézier refinement loop.

The loop is driven against the real headless VectorCraft: a 120-anchor
silhouette is reduced to the anchor budget, rendered, and refined with the
edits a scripted vision model asks for. The assertions check the geometry
that came out of the engine, not the model's prose.
"""

from __future__ import annotations

import base64
import json
import math
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from importlib import import_module

refine_module = import_module("04_bezier_refinement_loop")

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
    def __init__(self, content: str) -> None:
        self.content = content


class ScriptedVision:
    """Reports a kink at the sharpest anchor on the first call, then nothing."""

    def __init__(self, spike_t: float) -> None:
        self.spike_t = spike_t
        self.calls: list[int] = []
        self.zoomed = 0

    def chat(self, system: str, user: str, images: list[str] | None = None,
             response_format: dict | None = None) -> Reply:
        self.calls.append(len(images or []))
        if "zoomed" in user:
            self.zoomed += 1
            return Reply(json.dumps({"kinks": [], "selfIntersections": [],
                                     "flatnessErrors": [], "looksBroken": False}))
        return Reply(json.dumps({
            "kinks": [{"t": self.spike_t, "severity": "high"}],
            "selfIntersections": [],
            "flatnessErrors": [],
            "looksBroken": False,
        }))


def build_silhouette(agent, count: int = 120) -> int:
    """A jittery 120-anchor silhouette, the kind a CAD export produces."""
    anchors = []
    for i in range(count):
        angle = 2 * math.pi * i / count
        radius = 180 + 14 * math.sin(angle * 7) + 6 * math.cos(angle * 3)
        anchors.append({
            "x": round(256 + radius * math.cos(angle), 4),
            "y": round(256 + radius * math.sin(angle), 4),
        })
    created = agent.run("path.create", {"anchors": anchors, "closed": True})
    return created["id"]


def main() -> int:
    output = Path(__file__).resolve().parent.parent / "output"
    output.mkdir(parents=True, exist_ok=True)
    log_path = Path("refinement-log.jsonl")
    if log_path.exists():
        log_path.unlink()
    for stale in ("sofa-before.png", "sofa-after.png", "sofa-refined.vectorcraft",
                  "sofa-refined.svg", "report.json"):
        (output / stale).unlink(missing_ok=True)

    with refine_module.VectorAgent() as agent:
        agent.run("file.new", {"name": "sofa", "width": 512, "height": 512,
                               "units": "Points", "colorMode": "rgb",
                               "backgroundContents": "white"})
        path_id = build_silhouette(agent)
        before = refine_module.read_anchors(agent, path_id)
        equal("fixture: the silhouette has 120 anchors", len(before), 120)
        before_png = base64.b64decode(agent.render(max_side=1024))
        (output / "sofa-before.png").write_bytes(before_png)
        ok("output: before render is a PNG", before_png[:8] == b"\x89PNG\r\n\x1a\n")

        # The scripted vision flags the sharpest anchor of the reduced shape.
        vision = ScriptedVision(spike_t=0.0)

        print("\n# the loop")
        log = refine_module.refine(agent, vision, "sofa-042", path_id, artboard=512.0)

        ok("loop: it terminated", log["terminatedBy"] in ("converged", "fixed-point", "iteration-cap"),
           log["terminatedBy"])
        ok("loop: the anchor budget is met", log["finalAnchorCount"] <= 48, str(log["finalAnchorCount"]))
        ok("loop: the anchors were reduced", log["finalAnchorCount"] < len(before))
        ok("loop: the iterations are logged", len(log["iterations"]) >= 1)
        ok("loop: the model was called", len(vision.calls) >= 1)

        first = log["iterations"][0]
        ok("iteration: it records the anchor count", first["anchorCountBefore"] > 0)
        ok("iteration: it records the spikes", len(first["curvatureSpikes"]) == 3)
        ok("iteration: it records the critique", "kinks" in first["visionCritique"])
        ok("iteration: it records the content hash", len(first["contentHash"]) == 64)
        ok("iteration: it records the edits", isinstance(first["editsApplied"], list))

        after = refine_module.read_anchors(agent, path_id)
        equal("engine: the anchor count matches the log", len(after), log["finalAnchorCount"])
        after_png = base64.b64decode(agent.render(max_side=1024))
        (output / "sofa-after.png").write_bytes(after_png)
        agent.run("document.export", {"path": str(output / "sofa-refined.vectorcraft"),
                                      "format": "vectorcraft"})
        agent.run("document.export", {"path": str(output / "sofa-refined.svg"),
                                      "format": "svg", "artboard": 0})
        ok("output: after render is a PNG", after_png[:8] == b"\x89PNG\r\n\x1a\n")
        ok("output: before and after differ", before_png != after_png)
        ok("engine: the geometry changed",
           refine_module.canonical_hash(after) != refine_module.canonical_hash(before))
        ok("engine: the shape still has anchors", all("x" in a and "y" in a for a in after))

        spikes = refine_module.top3_spikes(after)
        ok("curvature: three spikes are reported", len(spikes) == 3)
        ok("curvature: the spikes are ordered", spikes[0]["kappa"] >= spikes[2]["kappa"])
        ok("curvature: every spike has a parameter", all(0 <= s["t"] <= 1 for s in spikes))

        # The log line the exercise asks for.
        ok("log: the jsonl file is written", log_path.exists())
        line = json.loads(log_path.read_text().splitlines()[0])
        equal("log: it names the sku", line["sku"], "sofa-042")
        ok("log: it has the elapsed time", line["elapsedMs"] >= 0)
        (output / "refinement-log.jsonl").write_text(log_path.read_text())

        artefacts = ["sofa-before.png", "sofa-after.png", "sofa-refined.vectorcraft",
                     "sofa-refined.svg", "refinement-log.jsonl"]
        for artefact in artefacts:
            ok(f"output: {artefact}", (output / artefact).exists())
        (output / "report.json").write_text(json.dumps({
            "exercise": 4,
            "engine": "vectorcraft-cli",
            "assertions": passed + 1,
            "sku": "sofa-042",
            "terminatedBy": log["terminatedBy"],
            "initialAnchorCount": len(before),
            "finalAnchorCount": log["finalAnchorCount"],
            "iterations": [{k: it[k] for k in ("anchorCountBefore", "contentHash", "editsApplied")}
                           for it in log["iterations"]],
            "artefacts": artefacts,
            "result": "jittery silhouette reduced to the anchor budget; curvature spikes, vision critique and atomic edits logged",
        }, indent=2))
        ok("output: report manifest", (output / "report.json").exists())

    print(f"\n{passed} assertions passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
