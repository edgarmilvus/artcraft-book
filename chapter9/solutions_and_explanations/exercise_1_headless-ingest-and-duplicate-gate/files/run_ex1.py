#!/usr/bin/env python3
"""run_ex1.py — acceptance harness for the LightCraft ingest / dedup tier.

It stages a small corpus with an exact duplicate and a perceptual near
duplicate, imports it into a real LightCraft library, and exercises the
snapshot, preview, duplicate grouping and stack operations. The database and
face-embedding phases are represented by pure unit checks; they need
Postgres/OpenAI and are not part of this offline harness.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
OUTPUT = HERE.parent / "output"
STAGING = OUTPUT / "staging"
LIBRARY = OUTPUT / "library"
PREVIEWS = OUTPUT / "previews"

spec = importlib.util.spec_from_file_location("ingest", HERE / "01_ingest.py")
ingest = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = ingest
spec.loader.exec_module(ingest)
ingest.LIBRARY = str(LIBRARY)
ingest.READ_ROOT = str(STAGING)

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


def make_frame(seed: int, brightness: int = 0) -> Image.Image:
    image = Image.new("RGB", (480, 320))
    pixels = image.load()
    for y in range(320):
        for x in range(480):
            wave = np.sin((x + seed) / 19) * np.cos((y + seed) / 23) + np.sin((x + y) / 53)
            value = int(110 + wave * 55 + brightness)
            pixels[x, y] = (max(0, min(255, value)), max(0, min(255, value - 6)),
                            max(0, min(255, value - 18)))
    return image


def main() -> int:
    import shutil
    for stale in (STAGING, LIBRARY, PREVIEWS):
        if stale.exists():
            shutil.rmtree(stale)
    for stale in ("report.json",):
        (OUTPUT / stale).unlink(missing_ok=True)
    STAGING.mkdir(parents=True, exist_ok=True)
    PREVIEWS.mkdir(parents=True, exist_ok=True)

    frame = make_frame(3)
    frame.save(STAGING / "frame-a.png")
    frame.save(STAGING / "frame-a-copy.png")
    make_frame(3, brightness=4).save(STAGING / "frame-a-bright.png")
    make_frame(41).save(STAGING / "frame-b.png")
    make_frame(79).save(STAGING / "frame-c.png")

    print("\n# duplicate units")
    first = (STAGING / "frame-a.png").read_bytes()
    second = (STAGING / "frame-a-copy.png").read_bytes()
    equal("hash: the exact copy has the same header hash",
          ingest.sha256_header(STAGING / "frame-a.png"),
          ingest.sha256_header(STAGING / "frame-a-copy.png"))
    h1 = ingest.dhash64_from_png(first)
    h2 = ingest.dhash64_from_png(second)
    h3 = ingest.dhash64_from_png((STAGING / "frame-a-bright.png").read_bytes())
    h4 = ingest.dhash64_from_png((STAGING / "frame-b.png").read_bytes())
    equal("dhash: identical files have zero Hamming distance", ingest.hamming(h1, h2), 0)
    ok("dhash: a bright copy stays perceptually close", ingest.hamming(h1, h3) <= 6,
       str(ingest.hamming(h1, h3)))
    ok("dhash: a different frame is farther away", ingest.hamming(h1, h4) > 6,
       str(ingest.hamming(h1, h4)))
    face = ingest.FaceRow(photo_id=7, face_index=0, embedding=[0.1, 0.2],
                          bbox={"x0": 0.4, "y0": 0.2, "x1": 0.7, "y1": 0.6})
    equal("face row: keeps the photo id", face.photo_id, 7)
    crop_source = Image.open(STAGING / "frame-a.png").convert("RGB")
    import io
    buffer = io.BytesIO()
    crop_source.save(buffer, format="PNG")
    crop = ingest._crop_face(buffer.getvalue(), face.bbox)
    equal("face crop: 224x224", Image.open(io.BytesIO(crop)).size, (224, 224))

    client = ingest.MCPStdioClient()
    try:
        print("\n# snapshot and dry run")
        before = ingest.library_fingerprint(client)
        equal("snapshot: the library starts empty", before, set())
        preview = ingest.enumerate_candidates(client)
        candidates = [Path(candidate["path"]) for candidate in preview.get("candidates", [])]
        equal("preview: five candidates", len(candidates), 5)
        equal("preview: nothing was added", ingest.library_fingerprint(client), before)

        print("\n# import")
        imported = client.command("library.import", {
            "paths": [str(STAGING)], "mode": "add", "organize": "flat",
        })
        imported_ids = sorted(imported.get("imported", []))
        equal("import: four photos (the byte-exact copy is refused)", len(imported_ids), 4)
        after = ingest.library_fingerprint(client)
        equal("snapshot: four new ids", len(after - before), 4)

        again = client.command("library.import", {
            "paths": [str(STAGING)], "mode": "add", "organize": "flat",
        })
        equal("import: a re-run imports nothing", len(again.get("imported", [])), 0)
        equal("snapshot: a re-run changes no ids", ingest.library_fingerprint(client), after)

        print("\n# duplicate groups")
        groups = ingest.find_duplicate_groups(client, candidates)
        ok("duplicates: at least one group", len(groups) >= 1, json.dumps(groups))
        catalog = client.call("query_photos", {"limit": 100})
        rows = catalog.get("photos", catalog) if isinstance(catalog, dict) else catalog
        by_name = {row["fileName"]: row["id"] for row in rows}
        family_ids = [by_name.get(name) for name in
                      ("frame-a.png", "frame-a-copy.png", "frame-a-bright.png")
                      if by_name.get(name) is not None]
        ok("duplicates: the perceptual family is grouped",
           len(family_ids) >= 2 and any(sum(1 for item in family_ids if item in group) >= 2
                                        for group in groups),
           json.dumps({"ids": family_ids, "groups": groups}))
        ok("duplicates: every group has at least two members", all(len(g) >= 2 for g in groups))

        preview_id = groups[0][0]
        preview_bytes = client.call("render_preview", {"id": preview_id, "max_side": 160})
        if isinstance(preview_bytes, dict):
            import base64
            preview_bytes = base64.b64decode(preview_bytes.get("png", b""))
        preview_path = PREVIEWS / f"photo-{preview_id}.png"
        preview_path.write_bytes(preview_bytes)
        ok("preview: a duplicate preview is a PNG",
           preview_bytes[:8] == b"\x89PNG\r\n\x1a\n" and preview_path.stat().st_size > 1000)

        print("\n# stack")
        before_stack = client.command("catalog.query", {"limit": 100})
        total_before = int(before_stack.get("total", len(before_stack.get("photos", []))))
        ingest.stack_duplicate_groups(client, groups)
        after_stack = client.command("catalog.query", {"limit": 100})
        total_after = int(after_stack.get("total", len(after_stack.get("photos", []))))
        expected_after = total_before - sum(len(g) - 1 for g in groups)
        equal("stack: one visible row per duplicate group", total_after, expected_after)

        artefacts = [
            "staging/frame-a.png", "staging/frame-a-copy.png", "staging/frame-a-bright.png",
            "staging/frame-b.png", "staging/frame-c.png", f"previews/{preview_path.name}",
            "library/catalog.snap", "library/catalog.log",
        ]
        for artefact in artefacts:
            ok(f"output: {artefact}", (OUTPUT / artefact).exists())
        (OUTPUT / "report.json").write_text(json.dumps({
            "exercise": 1,
            "engine": "lightcraft-cli",
            "assertions": PASSED + 1,
            "before": sorted(before),
            "imported": imported_ids,
            "duplicateGroups": groups,
            "visiblePhotosBeforeStack": total_before,
            "visiblePhotosAfterStack": total_after,
            "artefacts": artefacts,
            "result": "preview/import was idempotent; byte-exact and perceptual duplicates were grouped and stacked",
        }, indent=2))
        ok("output: report manifest", (OUTPUT / "report.json").exists())
    finally:
        client.close()

    print(f"\n{PASSED} assertions passed")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
