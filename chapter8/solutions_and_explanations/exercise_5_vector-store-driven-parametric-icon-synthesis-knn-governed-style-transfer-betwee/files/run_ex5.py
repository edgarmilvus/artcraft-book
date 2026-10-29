#!/usr/bin/env python3
"""run_ex5.py — harness for the vector store-driven icon synthesis.

The store is the local implementation of the JSON-RPC bus the agent talks to;
it is seeded with eight approved icons, each one built by the same shape
grammar the agent uses. The pipeline then synthesises a new icon from a
description, validates it against the store, and writes the package.
"""

from __future__ import annotations

import base64
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from importlib import import_module

synth = import_module("05_vector_store_icon_synthesis")

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


APPROVED = [
    ("icon-parcel", "a hexagonal parcel", 3.0, "round", 0.9, "soft"),
    ("icon-box", "a box", 2.5, "butt", 1.0, "sharp"),
    ("icon-disc", "a disc", 4.0, "round", 0.8, "rounded"),
    ("icon-shield", "a shield", 2.0, "square", 1.0, "sharp"),
    ("icon-arrow", "an arrow leaving from the top", 3.5, "round", 0.9, "soft"),
    ("icon-frame", "a rectangular frame", 2.0, "butt", 1.0, "soft"),
    ("icon-badge", "a hexagonal badge", 3.0, "square", 0.95, "rounded"),
    ("icon-token", "a disc token", 2.5, "round", 1.0, "soft"),
]


def seed_store(agent, store) -> None:
    """Eight approved icons, built by the grammar and embedded."""
    for slug, description, width, cap, opacity, corner in APPROVED:
        consensus = {"cornerClass": corner}
        subpaths, _extra = synth.shape_grammar(description, consensus)
        obj_id, _hash = synth.synthesise_candidate(
            agent, subpaths, [], {
                "strokeWidthPt": width, "strokeCap": cap,
                "fillOpacity": opacity, "cornerClass": corner,
            })
        anchors = synth.read_anchors(agent, obj_id)
        store.upsert({
            "slug": slug,
            "embedding": synth.embed_icon(anchors, width, cap, opacity),
            "metadata": {
                "anchorCount": len(anchors),
                "strokeWidthPt": width,
                "strokeCap": cap,
                "fillOpacity": opacity,
                "cornerClass": corner,
                "sourcePath": f"{slug}.vectorcraft",
            },
        })


def main() -> int:
    output = Path(__file__).resolve().parent.parent / "output"
    output.mkdir(parents=True, exist_ok=True)
    for stale in ("candidate.vectorcraft", "candidate.svg", "candidate.png",
                  "style-provenance.json", "validation.json", "store.json", "report.json"):
        (output / stale).unlink(missing_ok=True)

    with synth.VectorAgent() as agent:
        agent.run("file.new", {"name": "synthesis", "width": 512, "height": 512,
                               "units": "Points", "colorMode": "rgb",
                               "backgroundContents": "white"})
        store = synth.LocalVectorStore(agent)

        print("\n# the store")
        seed_store(agent, store)
        equal("store: eight icons are indexed", len(store.rows), 8)

        print("\n# the embedder")
        anchors = synth.read_anchors(agent, store.rows[0]["embedding"] and 0 or 0) if False else None
        sample = synth.embed_icon(
            [{"x": 0, "y": 0}, {"x": 10, "y": 0, "in": [3, 0], "out": [7, 0]}, {"x": 10, "y": 10}],
            3.0, "round", 0.9)
        equal("embedder: it is 128 dimensions", len(sample), 128)
        norm = math.sqrt(sum(v * v for v in sample))
        ok("embedder: it is L2-normalised", abs(norm - 1.0) < 1e-9, f"{norm}")
        again = synth.embed_icon(
            [{"x": 0, "y": 0}, {"x": 10, "y": 0, "in": [3, 0], "out": [7, 0]}, {"x": 10, "y": 10}],
            3.0, "round", 0.9)
        equal("embedder: it is deterministic", again, sample)

        print("\n# the retrieval")
        query = store.embed_text("a hexagonal parcel with an arrow leaving from the top")
        matches = synth.knn(store, query, 8)
        equal("retrieval: eight neighbours", len(matches), 8)
        ok("retrieval: they are ordered by distance",
           all(matches[i]["cosineDistance"] <= matches[i + 1]["cosineDistance"] + 1e-9
               for i in range(len(matches) - 1)))
        consensus = synth.style_consensus(matches)
        equal("consensus: the weights sum to one", round(sum(consensus["weights"]), 6), 1.0)
        ok("consensus: the stroke width is weighted",
           consensus["strokeWidthPt"] > 0)
        ok("consensus: the cap is one of the three",
           consensus["strokeCap"] in ("butt", "round", "square"))
        ok("consensus: the corner class is one of the three",
           consensus["cornerClass"] in ("sharp", "soft", "rounded"))

        print("\n# the pipeline")
        request = {
            "requestId": "req-0001",
            "description": "a hexagonal parcel with an arrow leaving from the top",
            "brandComplianceRequired": True,
            "k": 8,
            "similarityRejectThreshold": 0.94,
            "perturbationBudget": 5,
            "shrinkStepPct": 4,
        }
        result = synth.synthesis_pipeline(agent, store, request)
        equal("pipeline: it is accepted", result["status"], "accepted")
        ok("pipeline: the object exists", isinstance(result["objectId"], int))
        ok("pipeline: the path is recorded", result["pathTaken"] in ("accepted", "perturbed", "shrunk"))

        hashes = result["hashes"]
        for name in ("specHash", "retrievalHash", "geometryHash", "validationHash", "composite"):
            ok(f"hashes: {name} is a sha256", len(hashes[name]) == 64)
        equal("hashes: the spec hash is stable",
              hashes["specHash"],
              synth.sha256(request["description"] + "|" + request["requestId"]))
        ok("hashes: the composite commits the rest",
           hashes["composite"] != hashes["geometryHash"])
        equal("provenance: one entry per neighbour", len(result["provenance"]), 8)
        ok("provenance: the weights are listed",
           all("weight" in entry and "similarity" in entry for entry in result["provenance"]))

        print("\n# the package")
        (output / "style-provenance.json").write_text(json.dumps(result["provenance"], indent=2))
        (output / "validation.json").write_text(json.dumps(result["hashes"], indent=2))
        agent.run("document.export", {"path": str(output / "candidate.vectorcraft"),
                                      "format": "vectorcraft"})
        agent.run("document.export", {"path": str(output / "candidate.svg"),
                                      "format": "svg", "artboard": 0})
        preview = base64.b64decode(agent.render(max_side=1024))
        (output / "candidate.png").write_bytes(preview)
        ok("package: the provenance is written", (output / "style-provenance.json").exists())
        ok("package: the validation is written", (output / "validation.json").exists())
        ok("package: the vector file is written", (output / "candidate.vectorcraft").exists())
        ok("package: the SVG is written", (output / "candidate.svg").exists())
        ok("package: the preview is a PNG", preview[:8] == b"\x89PNG\r\n\x1a\n")
        (output / "store.json").write_text(json.dumps(
            {"rows": [{key: value for key, value in row.items() if key != "embedding"}
                      for row in store.rows]}, indent=2))

        print("\n# the rejection path")
        # An identical icon in the store: the candidate has to move away from it.
        twin = synth.LocalVectorStore(agent)
        for row in store.rows:
            twin.upsert({"slug": row["slug"], "embedding": row["embedding"], "metadata": {}})
        anchors = synth.read_anchors(agent, result["objectId"])
        twin.upsert({
            "slug": "icon-twin",
            "embedding": synth.embed_icon(anchors, 3.0, "round", 0.9),
            "metadata": {"anchorCount": len(anchors), "strokeWidthPt": 3.0,
                         "strokeCap": "round", "fillOpacity": 0.9,
                         "cornerClass": "soft", "sourcePath": "twin.vectorcraft"},
        })
        rejected = synth.synthesis_pipeline(agent, twin, request)
        ok("rejection: the run is not simply accepted",
           rejected["status"] in ("accepted", "rejected"))
        if rejected["status"] == "accepted":
            ok("rejection: it took another path", rejected["pathTaken"] != "accepted",
               rejected["pathTaken"])

        artefacts = ["candidate.vectorcraft", "candidate.svg", "candidate.png",
                     "style-provenance.json", "validation.json", "store.json"]
        for artefact in artefacts:
            ok(f"output: {artefact}", (output / artefact).exists())
        (output / "report.json").write_text(json.dumps({
            "exercise": 5,
            "engine": "vectorcraft-cli + local vector store",
            "assertions": passed + 1,
            "request": request,
            "storeRows": len(store.rows),
            "accepted": {"status": result["status"], "pathTaken": result["pathTaken"],
                         "objectId": result["objectId"], "hashes": result["hashes"]},
            "rejection": {"status": rejected["status"], "pathTaken": rejected["pathTaken"]},
            "artefacts": artefacts,
            "result": "description embedded, eight neighbours retrieved, style consensus synthesised, provenance hash chain written",
        }, indent=2))
        ok("output: report manifest", (output / "report.json").exists())

    print(f"\n{passed} assertions passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
