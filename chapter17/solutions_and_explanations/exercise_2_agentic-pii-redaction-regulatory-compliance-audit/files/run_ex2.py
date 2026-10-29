# =====================================================================
# run_ex2.py — deterministic harness for the exercise 2 solution.
#
# The solution runs for real: two synthetic intake scans go through the
# redaction pipeline, the compliance dossiers are written, and the clean
# files are combined into the auditor-issuable submission.
# =====================================================================
from __future__ import annotations
import importlib.util, json, os, shutil, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORK = HERE.parent / "output" / "work"

passed = 0


def ok(label: str, condition: bool, detail: str = "") -> None:
    global passed
    if not condition:
        print(f"FAIL {label}" + (f" — {detail}" if detail else ""))
        sys.exit(1)
    passed += 1
    print(f"PASS {label}")


def load_solution():
    """Import the solution module by path (its filename is not importable)."""
    spec = importlib.util.spec_from_file_location(
        "ex2_solution", HERE / "02_agentic-pii-redaction-regulatory-compliance-audit.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def build_fixture(path: Path, text: str) -> None:
    """Write a one-page PDF through WordCraft, so the fonts are embedded.

    A PDF created from raw text with a base-14 font can never satisfy the
    PDF/A gate ("The font Helvetica isn't embedded"), so the fixture is
    exported by the word processor instead.
    """
    import subprocess
    script = (
        "import sys;"
        "sys.path.insert(0, %r);"
        "import json;"
        "from mcp_client import word_client;"
        "c = word_client();"
        "c.execute('text.insert', {'text': %r});"
        "c.execute('file.exportPdf', {'path': %r});"
        "c.close();"
    ) % (str(HERE), text, str(path))
    subprocess.run([sys.executable, "-c", script], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main() -> None:
    if WORK.exists():
        shutil.rmtree(WORK)
    IN_DIR = WORK / "in"
    OUT_DIR = WORK / "out"
    IN_DIR.mkdir(parents=True)
    OUT_DIR.mkdir(parents=True)

    os.environ["HOSPITAL_ROOT"] = str(WORK)
    os.environ["HOSPITAL_IN"] = str(IN_DIR)
    os.environ["HOSPITAL_OUT"] = str(OUT_DIR)
    os.environ["HOSPITAL_NAMES"] = str(WORK / "pii_names.json")
    WORK.joinpath("pii_names.json").write_text(json.dumps(["Alice Nguyen"]))

    solution = load_solution()

    # --- the fixtures ------------------------------------------------------
    clean_text = (
        "Patient: Alice Nguyen\n"
        "MRN: 88-2211\n"
        "SSN: 123-45-6789\n"
        "DOB: 1975-04-02\n"
        "Phone: (555) 010-0100\n"
        "Card: 4111 1111 1111 1111\n"
        "Assessment: stable."
    )
    near_text = (
        "Patient: Alicia Nguyne\n"
        "MRN: 88-2212\n"
        "SSN: 123-45-6790\n"
        "DOB: 1975-04-02\n"
        "Phone: (555) 010-0101\n"
        "Card: 4111 1111 1111 1112\n"
        "Assessment: stable."
    )
    build_fixture(IN_DIR / "scan-0001.pdf", clean_text)
    build_fixture(IN_DIR / "scan-0002.pdf", near_text)
    ok("the fixtures were written",
       (IN_DIR / "scan-0001.pdf").exists() and (IN_DIR / "scan-0002.pdf").exists())

    # --- the run ------------------------------------------------------------
    summary = solution.main()
    ok("both scans were processed", summary["processed"] == 2, json.dumps(summary))
    ok("one scan was sealed", summary["sealed"] == 1, json.dumps(summary))
    ok("one scan needs review", summary["review_required"] == 1, json.dumps(summary))

    # --- the toolchain was discovered, not hard-coded -----------------------
    toolchain = json.loads((OUT_DIR / "toolchain.json").read_text())
    ok("the toolchain was persisted", toolchain["command_count"] > 0)
    ok("the toolchain lists the redaction commands",
       any(s["id"] == "redact.apply" for s in toolchain["signatures"]))
    ok("the toolchain lists the MCP tool names",
       any(s["tool"] == "doc_open" for s in toolchain["signatures"]))

    # --- the clean dossier --------------------------------------------------
    dossier = json.loads((OUT_DIR / "scan-0001.audit.json").read_text())
    ok("the clean scan is sealed", dossier["status"] == "sealed", json.dumps(dossier["status"]))
    ok("the clean scan is audit-clean", dossier["audit_clean"] is True)
    ok("the redacted PDF was written", Path(dossier["output_path"]).exists())
    ok("the dossier records the sha256", len(dossier["pdf_sha256"]) == 64)
    ok("the dossier records the accessibility rules",
       dossier["accessibility"].get("title") == "passed",
       json.dumps(dossier["accessibility"]))
    ok("the PDF/A gate passed", dossier["pdfa"]["compliant"] is True,
       json.dumps(dossier["pdfa"]))
    ok("the dossier records the actions",
       any(a["tool"] == "redact_mark" for a in dossier["actions"]))
    ok("the dossier records the apply step",
       any(a["tool"] == "redact_apply" for a in dossier["actions"]))

    # --- the redacted text really is gone -----------------------------------
    from mcp_client import pdf_client
    pc = pdf_client(str(WORK))
    try:
        opened = pc.call("doc_open", {"path": dossier["output_path"]})
        extracted = pc.call("text_extract", {"doc": opened["doc"]})
        text = "\n".join(p["text"] for p in extracted["pages"])
    finally:
        pc.close()
    ok("the patient's name is gone", "Alice Nguyen" not in text, text[:200])
    ok("the SSN is gone", "123-45-6789" not in text, text[:200])
    ok("the phone number is gone", "010-0100" not in text, text[:200])
    ok("the clinical content survives", "Assessment" in text, text[:200])

    # --- the near-match scan is quarantined ---------------------------------
    flagged = json.loads((OUT_DIR / "scan-0002.audit.json").read_text())
    ok("the near-match scan needs review", flagged["status"] == "review_required")
    ok("the near-match was recorded", len(flagged["suspected_matches"]) > 0,
       json.dumps(flagged["suspected_matches"]))
    ok("the near-match was not sealed", flagged["audit_clean"] is False)

    # --- the batch fallback -------------------------------------------------
    ok("the exceptions PDF was produced", (OUT_DIR / "EXCEPTIONS.pdf").exists())
    ok("the run summary was written", (OUT_DIR / "_run_summary.json").exists())

    # --- publish the headline artefacts next to the harness log ------------
    publish = HERE.parent / "output"
    for name in ("AUDITOR_SUBMISSION.pdf", "EXCEPTIONS.pdf", "scan-0001.redacted.pdf", "scan-0001.audit.json", "scan-0002.audit.json", "toolchain.json", "_run_summary.json"):
        shutil.copy2(OUT_DIR / name, publish / name)

    print(f"\n{passed} assertions passed")


if __name__ == "__main__":
    main()
