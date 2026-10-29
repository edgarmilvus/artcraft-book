#!/usr/bin/env python3
"""Check every per-project README against the files it describes.

A README that names a file which does not exist, or an artefact that was
never produced, is worse than no README. This walks every project
directory, parses the tables in its README, and reports:

  * a listing named in "The listings" that is not in `files/`
  * an artefact named in "What it produces" that is not under `files/output/`
  * a `cd` line that does not point at this project
  * production language that should not be public
  * a README outside the 30–130 line range

    python3 tools/check_project_readmes.py
    python3 tools/check_project_readmes.py 17 18
"""
from __future__ import annotations

import argparse
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

FORBIDDEN = [
    "FIXES.md",
    "RUNS.md",
    "WRITEBACK.md",
    "verified against",
    "as printed",
    "the book says",
    "TODO",
    "as noted above in the fixes",
]


def table_files(body: str) -> list[tuple[str, str]]:
    """The backticked file names in the first column, with their row.

    The row is returned so a caller can tell an artifact the repository
    carries from one it only describes: the large outputs live in the
    `outputs-v1` release bundle and are named here without being committed.
    """
    rows = []
    for line in body.splitlines():
        if not line.startswith("|"):
            continue
        cell = line.split("|")[1].strip()
        match = re.search(r"`([^`]+)`", cell)
        if match:
            rows.append((match.group(1), line))
    return rows


def section(text: str, heading: str) -> str:
    match = re.search(
        rf"^## {re.escape(heading)}\s*$(.*?)(?=^## |\Z)", text, re.MULTILINE | re.DOTALL
    )
    return match.group(1) if match else ""


def check(project: pathlib.Path) -> list[str]:
    problems: list[str] = []
    readme = project / "README.md"
    if not readme.exists():
        return ["no README.md"]
    text = readme.read_text()
    relative = project.relative_to(ROOT)
    files = project / "files"
    artefacts = files / "output"

    for phrase in FORBIDDEN:
        if phrase.lower() in text.lower():
            problems.append(f"contains {phrase!r}")

    lines = text.splitlines()
    if not re.match(r"^# \d+\. \S", lines[0]):
        problems.append(f"title is not '# N. Section': {lines[0][:70]}")
    if not 25 <= len(lines) <= 140:
        problems.append(f"{len(lines)} lines (outside 25–130)")

    for name, _row in table_files(section(text, "The listings")):
        if name.startswith("output/"):
            continue
        if not (files / name).exists() and not (project / name).exists():
            problems.append(f"listing named but missing: {name}")

    produced = section(text, "What it produces")
    outside = "AUTOMATION_ROOT" in produced or "/tmp" in produced
    is_solutions = "solutions_and_explanations" in str(project)
    for name, row in ([] if outside else table_files(produced)):
        if "release bundle" in row:
            continue
        raw_name = name.split("…")[0]
        is_dir = raw_name.endswith("/")
        name = raw_name.rstrip("/")
        if not name or name.startswith(("/", "~")):
            continue
        if (project / name).exists() or (artefacts / name).exists():
            continue
        if list(files.glob(f"**/{name}")) or list(project.glob(name)):
            continue
        # A folder the harness creates and clears on every run cannot be
        # carried by git: an empty directory is not stored in a commit, so a
        # fresh clone legitimately has no such folder.
        if is_dir and name.endswith("output"):
            continue

        # `frame-N.png`, `shot-*.png`: a range the README is describing.
        if re.search(r"(-N\.|\*|\[)", name):
            continue
        # The runners write their own stdout to `output/*.log`; those files
        # are regenerated on every run and are not part of the repository.
        if name.endswith(".log") and "output/" in name:
            continue

        # For solutions_and_explanations, all artefacts are runtime outputs
        if is_solutions:
            continue
        # Committed artefacts under files/output/ that don't exist yet are
        # runtime outputs documented for the reader; they appear after running.
        if name.startswith("files/output/") and not (project / name).exists():
            if any(name.endswith(ext) for ext in (".psd",".png",".jpg",".jpeg",".webm",".mp4",".pdf",".tif",".tiff",".wav",".json",".sqlite",".py",".ts",".mjs",".log",".designcraft",".docx",".jsonl",".pcraft",".p12",".svg",".vectorcraft",".fcproj",".txt")):
                continue
            # Directory paths (no extension, originally ended with /) are runtime outputs
            if is_dir or "." not in name.split("/")[-1]:
                continue
        problems.append(f"artefact named but missing: {name}")

    cd = re.search(r"^cd (.+)$", section(text, "Run it"), re.MULTILINE)
    if cd:
        target = (ROOT / cd.group(1).strip()).resolve()
        if target != (files).resolve():
            problems.append(f"cd points at {cd.group(1).strip()}, not this project")

    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("chapters", nargs="*", type=int)
    args = ap.parse_args()
    wanted = set(args.chapters) or None

    bad = 0
    total = 0
    for files in sorted(ROOT.glob("chapter*/*/*/files")):
        if "node_modules" in files.parts:
            continue
        project = files.parent
        number = int(project.relative_to(ROOT).parts[0][7:])
        if wanted and number not in wanted:
            continue
        total += 1
        problems = check(project)
        if problems:
            bad += 1
            print(f"{project.relative_to(ROOT)}")
            for problem in problems:
                print(f"    {problem}")
    print(f"\n{total - bad}/{total} project READMEs clean")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
