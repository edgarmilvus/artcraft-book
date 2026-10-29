#!/usr/bin/env python3
"""
Exercise 2 harness — Autonomous Asset Remediation in DesignCraft.

Builds a legacy DesignCraft magazine that really has a missing link, an
overset story, an unresolved font and a deleted colour swatch, runs the
reference solution (04_remediate.py) against the real designcraft-cli over
MCP stdio, and then checks the artefacts it shipped and the engine's own
reports of the remediated document.

    $ export PATH="<repo>/tools/craft-cli/bin:$PATH"
    $ python3 run_ex2.py

No API key and no network: the engine is the local designcraft-cli binary and
every input is generated here.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import zlib
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

HERE = Path(__file__).resolve().parent
WORK = HERE.parent / "output" / "work"
SOLUTION = HERE / "02_autonomous-asset-remediation-in-designcraft-with-claude-code-and-command-batch.py"
DESIGNCRAFT = shutil.which("designcraft-cli") or str(
    HERE.parents[3] / "tools" / "craft-cli" / "bin" / "designcraft-cli"
)

PASSED = 0
FAILURES: List[str] = []


def check(label: str, condition: bool, detail: str = "") -> bool:
    global PASSED
    if condition:
        PASSED += 1
        print("PASS %s" % label)
    else:
        FAILURES.append(label)
        print("FAIL %s%s" % (label, (" — " + detail) if detail else ""))
    return bool(condition)


def solid_png(rgb: Tuple[int, int, int], size: int = 8) -> bytes:
    raw = b"".join(b"\x00" + bytes(rgb) * size for _ in range(size))

    def chunk(tag: bytes, data: bytes) -> bytes:
        payload = tag + data
        return (
            struct.pack(">I", len(data))
            + payload
            + struct.pack(">I", zlib.crc32(payload) & 0xFFFFFFFF)
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


def run_engine(args: List[str]) -> str:
    result = subprocess.run(
        [DESIGNCRAFT, *args], capture_output=True, text=True
    )
    if result.returncode != 0:
        raise SystemExit(
            "designcraft-cli %s failed:\n%s" % (" ".join(args), result.stderr)
        )
    return result.stdout.strip()


def engine_query(document: Path, command: str, params: Optional[Dict[str, Any]] = None) -> Any:
    """Ask the engine about a saved document, through its own CLI."""
    spec = command if params is None else "%s=%s" % (command, json.dumps(params))
    out = run_engine(["run", "--in", str(document), "--cmd", spec])
    return json.loads(out) if out else None


# ─────────────────────────────────────────────────────────────────────────────
# The fixture
# ─────────────────────────────────────────────────────────────────────────────
IMAGE_NAMES = ["hero-%d.png" % index for index in range(1, 8)]
RECOVERABLE = IMAGE_NAMES[:4]
UNRECOVERABLE = IMAGE_NAMES[4:]

HEADLINE = "Northwind catalogue headline"
BODY = (
    "The Q3 catalogue is a legacy magazine document that has crossed three "
    "studio storage mounts in eighteen months, and the layout engine still "
    "refuses to reflow the body copy that nobody reconciled when the artwork "
    "was re-linked from the old mount. "
) * 6


def build_fixture(root: Path) -> Path:
    """Write a document that really is broken, and return its path."""
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    old_mount = root / "mounts" / "old"
    new_mount = root / "mounts" / "new"
    old_mount.mkdir(parents=True)
    new_mount.mkdir(parents=True)

    for index, name in enumerate(IMAGE_NAMES):
        payload = solid_png((40 + index * 20, 90, 160))
        (old_mount / name).write_bytes(payload)
        if name in RECOVERABLE:
            (new_mount / name).write_bytes(payload)

    script: List[str] = []
    step = 0

    def add(command: str, params: Dict[str, Any]) -> None:
        nonlocal step
        script.append("%s %s" % (command, json.dumps(params)))
        step += 1

    add("file.new", {"width": 612, "height": 792, "title": "q3-catalog"})
    # the studio ships a composite font definition: "Inter-SemiBold" is the
    # committed substitute for the missing "Inter-Bold" family.
    add(
        "style.compositeFont.set",
        {
            "name": "Inter-SemiBold",
            "entries": [{"family": "Source Sans 3", "style": "Semibold"}],
        },
    )
    # the headline, set in a family this machine does not have
    add(
        "frame.create",
        {"rect": [36, 210, 400, 280], "content": "text", "text": HEADLINE},
    )
    add("text.select", {"story": "$%d.story" % (step - 1), "anchor": 0, "focus": len(HEADLINE)})
    add("type.char", {"attrs": {"fontFamily": "Inter-Bold", "fontStyle": "Bold"}})
    # the body copy that has been overset since the first relink
    add("frame.create", {"rect": [36, 300, 400, 420], "content": "text", "text": BODY})
    # a rectangle filled with a swatch that is about to be deleted
    add("swatch.create", {"name": "Northwind Teal (legacy)", "color": "#0F6E6E"})
    add("frame.create", {"rect": [450, 560, 576, 650], "content": "graphic"})
    add("object.fill", {"swatch": "Northwind Teal (legacy)", "ids": ["$%d.id" % (step - 1)]})
    add("swatch.delete", {"name": "Northwind Teal (legacy)"})
    # seven picture frames, each holding an image from the old mount
    boxes = [
        [36, 450, 162, 540],
        [174, 450, 300, 540],
        [312, 450, 438, 540],
        [450, 450, 576, 540],
        [36, 560, 162, 650],
        [174, 560, 300, 650],
        [312, 560, 438, 650],
    ]
    for name, box in zip(IMAGE_NAMES, boxes):
        add("frame.create", {"rect": box, "content": "graphic"})
        add("file.place", {"path": str(old_mount / name), "frame": "$%d.id" % (step - 1)})

    script_path = root / "fixture.dc"
    script_path.write_text("\n".join(script) + "\n", encoding="utf-8")
    document = root / "q3-catalog.designcraft"
    run_engine(["script", str(script_path), "--save", str(document)])

    # the old mount goes away: the seven links are now missing
    shutil.rmtree(old_mount)
    return document


def write_alias_tables(root: Path, font_aliases: Dict[str, Any], swatch_aliases: Dict[str, Any]) -> None:
    (root / "font-aliases.json").write_text(json.dumps(font_aliases, indent=2), encoding="utf-8")
    (root / "swatch-aliases.json").write_text(json.dumps(swatch_aliases, indent=2), encoding="utf-8")


def read_starter_contract(path: Path) -> Dict[str, Any]:
    """Read one of the committed jsonc contracts (comments are stripped)."""
    text = path.read_text(encoding="utf-8")
    cleaned = []
    for line in text.splitlines():
        stripped = line.split("//", 1)[0] if not line.strip().startswith("//") else ""
        cleaned.append(stripped)
    return json.loads("\n".join(cleaned))


def run_solution(
    document: Path,
    workdir: Path,
    relink_dir: Path,
    font_aliases: Path,
    swatch_aliases: Path,
    manifest: Path,
    workspace_root: Optional[Path] = None,
) -> subprocess.CompletedProcess:
    command = [
        sys.executable,
        str(SOLUTION),
        "--document",
        str(document),
        "--workdir",
        str(workdir),
        "--font-aliases",
        str(font_aliases),
        "--swatch-aliases",
        str(swatch_aliases),
        "--relink-dir",
        str(relink_dir),
        "--designcraft-bin",
        DESIGNCRAFT,
        "--manifest",
        str(manifest),
    ]
    if workspace_root is not None:
        command += ["--workspace-root", str(workspace_root)]
    return subprocess.run(command, capture_output=True, text=True)


# ─────────────────────────────────────────────────────────────────────────────
# The checks
# ─────────────────────────────────────────────────────────────────────────────
def check_fixture(document: Path) -> None:
    links = engine_query(document, "links.list")
    missing = [link for link in links if link.get("status") == "missing"]
    check("fixture has seven missing links", len(missing) == 7, "got %d" % len(missing))

    fonts = engine_query(document, "font.list")
    unresolved = [entry for entry in fonts if entry.get("source") is None]
    check(
        "fixture has an unresolved font family",
        [entry.get("family") for entry in unresolved] == ["Inter-Bold"],
        str([entry.get("family") for entry in unresolved]),
    )

    summary = engine_query(document, "document.inspect")
    overset = [story for story in summary.get("stories", []) if story.get("overset")]
    check("fixture has an overset story", len(overset) == 1, "got %d" % len(overset))

    panel = set(summary.get("swatches", []))
    used = {
        item.get("fill")
        for spread in summary.get("spreads", [])
        for item in spread.get("items", [])
        if item.get("fill")
    }
    orphans = sorted(used - panel)
    check(
        "fixture has a deleted colour swatch",
        orphans == ["Northwind Teal (legacy)"],
        str(orphans),
    )


def check_success_run(root: Path, document: Path, result: subprocess.CompletedProcess) -> Dict[str, Any]:
    check("the solution exits cleanly", result.returncode == 0, result.stderr[-400:])
    try:
        printed = json.loads(result.stdout)
    except ValueError:
        printed = {}
    check("the solution prints the manifest on stdout", bool(printed.get("remediated")))
    manifest_path = root / "remediation-manifest.json"
    check("the manifest is written", manifest_path.is_file())
    if not manifest_path.is_file():
        return {}
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    remediated = manifest.get("remediated", {})

    check("the manifest names the document", manifest.get("documentId") == str(document))
    check(
        "four links are relinked",
        sorted(remediated.get("linksRelinked", [])) == sorted(RECOVERABLE),
        str(remediated.get("linksRelinked")),
    )
    check(
        "three links are placeholdered",
        sorted(remediated.get("linksPlaceholdered", [])) == sorted(UNRECOVERABLE),
        str(remediated.get("linksPlaceholdered")),
    )
    check(
        "the missing font is substituted from the committed table",
        remediated.get("fontsReplaced") == [{"from": "Inter-Bold", "to": "Inter-SemiBold"}],
        str(remediated.get("fontsReplaced")),
    )
    check("the overset story is resolved", remediated.get("oversetResolved") is True)
    check(
        "the deleted swatch is restored",
        remediated.get("swatchesRestored") == ["Northwind Teal (legacy)"],
        str(remediated.get("swatchesRestored")),
    )
    check("nothing is halted on the happy path", manifest.get("halted") == [], str(manifest.get("halted")))

    pdf = root / "cert-q3-catalog.pdf"
    check("the certificate PDF exists", pdf.is_file())
    if pdf.is_file():
        head = pdf.read_bytes()[:5]
        check("the certificate is a PDF", head == b"%PDF-", repr(head))
        check("the certificate is not empty", pdf.stat().st_size > 1024, str(pdf.stat().st_size))
    sidecar = root / "cert-q3-catalog.sha256"
    check("the SHA-256 sidecar exists", sidecar.is_file())
    if sidecar.is_file() and pdf.is_file():
        digest = hashlib.sha256(pdf.read_bytes()).hexdigest()
        check(
            "the sidecar carries the certificate digest",
            sidecar.read_text(encoding="utf-8").split()[:1] == [digest],
            sidecar.read_text(encoding="utf-8").strip(),
        )
    proof = root / "cert-q3-catalog.page-0.png"
    check("the raster proof of the cover exists", proof.is_file() and proof.stat().st_size > 0)

    audit_path = root / "cert-q3-catalog.audit.json"
    check("the audit trail exists", audit_path.is_file())
    audit: Dict[str, Any] = {}
    if audit_path.is_file():
        audit = json.loads(audit_path.read_text(encoding="utf-8"))
        events = audit.get("events", [])
        check("the audit trail lists the calls", len(events) > 10, str(len(events)))
        shape_ok = all(
            set(("command", "params", "result", "timestamp")).issubset(event)
            for event in events
        )
        check("every audit entry has command, params, result and timestamp", shape_ok)
        commands = audit.get("commands", [])
        for needed in (
            "links.list",
            "links.relinkFolder",
            "links.relink",
            "font.list",
            "font.replace",
            "story.get",
            "object.primaryTextFrame",
            "layout.pages.insert",
            "swatch.create",
            "swatch.addToSwatches",
            "note.new",
            "place_image",
            "file.exportPdf",
            "render_page",
        ):
            check("the audit records %s" % needed, needed in commands)
        batch_events = [event for event in events if event.get("command") == "batch"]
        interpolated = any(
            "$0.story" in json.dumps(event.get("params", {})) for event in batch_events
        )
        check("the audit records the $N.path interpolation", interpolated)
        check("the audit records the compliance flags", isinstance(audit.get("flags"), list))
        check(
            "the audit records the assets that could not be relinked",
            len(audit.get("unrecoverable", [])) == 3,
            str(audit.get("unrecoverable")),
        )
    return manifest


def check_engine_reports(remediated_document: Path) -> None:
    links = engine_query(remediated_document, "links.list")
    still_placed = [
        link for link in links
        if link.get("status") == "missing" and link.get("uses")
    ]
    check("no frame still renders from a missing file", not still_placed, str(still_placed))
    embedded = [link for link in links if link.get("status") == "embedded"]
    check("the placeholders are embedded in the document", len(embedded) == 3, str(len(embedded)))
    ok = [link for link in links if link.get("status") == "ok"]
    check("the recovered links are live", len(ok) == 4, str(len(ok)))

    fonts = engine_query(remediated_document, "font.list")
    unresolved = [entry for entry in fonts if entry.get("source") is None]
    check("the engine reports no unresolved font", not unresolved, str(unresolved))

    summary = engine_query(remediated_document, "document.inspect")
    overset = [story for story in summary.get("stories", []) if story.get("overset")]
    check("the engine reports no overset story", not overset, str(overset))
    check(
        "the reflow added the page the text needed",
        summary.get("pageCount", 0) > 1,
        str(summary.get("pageCount")),
    )
    check(
        "the swatch is back in the Swatches panel",
        "Northwind Teal (legacy)" in summary.get("swatches", []),
    )

    notes = engine_query(remediated_document, "note.list")
    check(
        "the certificate cover carries the note",
        any("PARTIAL REMEDIATION" in (note.get("text") or "") for note in notes),
        str(notes),
    )

    found = engine_query(remediated_document, "find.find", {"find": "REMEDIATION CERTIFICATE"})
    check("the certificate text is in the document", bool(found), str(found))

    audit_path = remediated_document.parent / "cert-q3-catalog.audit.json"
    if audit_path.is_file():
        audit = json.loads(audit_path.read_text(encoding="utf-8"))
        check(
            "the certificate holds every page of the repaired document",
            audit.get("certificate", {}).get("pageCount") == summary.get("pageCount"),
            "%s != %s" % (audit.get("certificate", {}).get("pageCount"), summary.get("pageCount")),
        )


def check_halt_run(root: Path) -> None:
    """The committed table does not cover the family: the agent must refuse."""
    scenario = root / "scenarios" / "halt"
    scenario.mkdir(parents=True, exist_ok=True)
    document = build_fixture(scenario)
    write_alias_tables(
        scenario,
        {"Inter-Bold": None, "Futura-PT-Italic": None,
         "AdobeGaramondPro-Regular": "Source Serif 4"},
        {"Northwind Teal (legacy)": "#0F6E6E"},
    )
    result = run_solution(
        document,
        scenario,
        scenario / "mounts" / "new",
        scenario / "font-aliases.json",
        scenario / "swatch-aliases.json",
        scenario / "remediation-manifest.json",
    )
    check("the halt run still ships a certificate", result.returncode == 0, result.stderr[-300:])
    manifest_path = scenario / "remediation-manifest.json"
    if not check("the halt run writes a manifest", manifest_path.is_file()):
        return
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    check(
        "the halt names the uncovered font",
        any(entry.get("family") == "Inter-Bold" for entry in manifest.get("halted", [])),
        str(manifest.get("halted")),
    )
    check(
        "the agent substitutes nothing when the table is incomplete",
        manifest.get("remediated", {}).get("fontsReplaced") == [],
        str(manifest.get("remediated", {}).get("fontsReplaced")),
    )
    fonts = engine_query(scenario / "q3-catalog.remediated.designcraft", "font.list")
    unresolved = [entry for entry in fonts if entry.get("source") is None]
    check("the font is still unresolved after the halt", len(unresolved) == 1, str(unresolved))


def check_sandbox_run(root: Path) -> None:
    """A document outside the workspace root must be refused."""
    scenario = root / "scenarios" / "sandbox"
    if scenario.exists():
        shutil.rmtree(scenario)
    workspace = scenario / "workspace"
    outside = scenario / "outside"
    workspace.mkdir(parents=True)
    outside.mkdir(parents=True)
    document = build_fixture(outside)
    write_alias_tables(
        outside,
        {"Inter-Bold": "Inter-SemiBold"},
        {"Northwind Teal (legacy)": "#0F6E6E"},
    )
    result = run_solution(
        document,
        outside,
        outside / "mounts" / "new",
        outside / "font-aliases.json",
        outside / "swatch-aliases.json",
        outside / "remediation-manifest.json",
        workspace_root=workspace,
    )
    check("the agent refuses a document outside the workspace", result.returncode == 2,
          "exit %d" % result.returncode)
    check(
        "the refusal explains the workspace guard",
        "outside the workspace root" in result.stderr,
        result.stderr[-200:],
    )
    check(
        "no certificate is written when the agent refuses",
        not (outside / "cert-q3-catalog.pdf").exists(),
    )


def check_determinism(root: Path, manifest: Dict[str, Any]) -> None:
    """The same fixture must remediate to the same manifest."""
    scenario = root / "scenarios" / "repeat"
    scenario.mkdir(parents=True, exist_ok=True)
    document = build_fixture(scenario)
    write_alias_tables(
        scenario,
        {"Inter-Bold": "Inter-SemiBold", "Futura-PT-Italic": None,
         "AdobeGaramondPro-Regular": "Source Serif 4"},
        {"Northwind Teal (legacy)": "#0F6E6E"},
    )
    result = run_solution(
        document,
        scenario,
        scenario / "mounts" / "new",
        scenario / "font-aliases.json",
        scenario / "swatch-aliases.json",
        scenario / "remediation-manifest.json",
    )
    if not check("the repeat run exits cleanly", result.returncode == 0, result.stderr[-300:]):
        return
    repeated = json.loads((scenario / "remediation-manifest.json").read_text(encoding="utf-8"))
    left = dict(manifest.get("remediated", {}))
    right = dict(repeated.get("remediated", {}))
    check("the remediation is deterministic", left == right, "%s != %s" % (left, right))

    def normalise(entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        # the detail carries an absolute path, which differs per scenario
        return [{k: v for k, v in entry.items() if k != "detail"} for entry in entries]

    check(
        "the halted list is deterministic",
        normalise(manifest.get("halted", [])) == normalise(repeated.get("halted", [])),
    )


def main() -> int:
    if not Path(DESIGNCRAFT).exists():
        raise SystemExit("designcraft-cli is not on PATH")

    root = WORK
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)

    document = build_fixture(root)
    check_fixture(document)

    font_aliases = read_starter_contract(HERE / "01_jsonc.jsonc")
    swatch_aliases = read_starter_contract(HERE / "02_jsonc.jsonc")
    check("the committed font table covers the missing family",
          "Inter-Bold" in font_aliases)
    check("the committed swatch table covers the deleted swatch",
          "Northwind Teal (legacy)" in swatch_aliases)
    write_alias_tables(root, font_aliases, swatch_aliases)

    result = run_solution(
        document,
        root,
        root / "mounts" / "new",
        root / "font-aliases.json",
        root / "swatch-aliases.json",
        root / "remediation-manifest.json",
    )
    manifest = check_success_run(root, document, result)
    if manifest:
        remediated_document = root / "q3-catalog.remediated.designcraft"
        check("the remediated document is saved", remediated_document.is_file())
        if remediated_document.is_file():
            check_engine_reports(remediated_document)
    check_halt_run(root)
    check_sandbox_run(root)
    if manifest:
        check_determinism(root, manifest)


    # --- publish the headline artefacts next to the harness log ------------
    publish = WORK.parent
    shutil.copy2(WORK / "cert-q3-catalog.pdf", publish / "cert-q3-catalog.pdf")
    shutil.copy2(WORK / "cert-q3-catalog.audit.json", publish / "cert-q3-catalog.audit.json")
    shutil.copy2(WORK / "q3-catalog.remediated.designcraft", publish / "q3-catalog.remediated.designcraft")
    shutil.copy2(WORK / "remediation-manifest.json", publish / "remediation-manifest.json")

    print("%d assertions passed" % PASSED)
    if FAILURES:
        print("%d assertion(s) failed: %s" % (len(FAILURES), ", ".join(FAILURES)))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
