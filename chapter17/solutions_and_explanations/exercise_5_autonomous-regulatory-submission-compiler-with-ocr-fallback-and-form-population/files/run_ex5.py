# =====================================================================
# run_ex5.py — deterministic harness for the exercise 5 solution.
#
# The whole submission bundle is built, three regulator variants are
# compiled from it, and the variants are diffed against the FDA baseline.
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
    spec = importlib.util.spec_from_file_location(
        "ex5_solution", HERE / "05_autonomous-regulatory-submission-compiler-with-ocr-fallback-and-form-population.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def main() -> None:
    if WORK.exists():
        shutil.rmtree(WORK)
    BUNDLE = WORK / "submission"
    OUT = WORK / "out"
    (BUNDLE / "certificates").mkdir(parents=True)
    OUT.mkdir(parents=True)

    os.environ["SUBMISSION_IN"] = str(BUNDLE)
    os.environ["SUBMISSION_OUT"] = str(OUT)
    os.environ["SUBMISSION_ROOT"] = str(WORK)

    solution = load_solution()
    pc = solution.open_pdfcraft()
    wc = solution.open_wordcraft()
    try:
        # --- the WordCraft templates ----------------------------------------
        for name, styles in (("cover_memo.docx", []),
                             ("device_description.docx",
                              ["TableText", "Caption"])):
            wc.call("new_document", {"template": "blank"})
            present = {s.get("id") for s in
                       (wc.call("execute", {"command": "styles.list",
                                            "params": {}}) or [])}
            for style in styles:
                if style not in present:
                    wc.call("execute", {"command": "styles.create",
                                        "params": {"name": style}})
            wc.call("execute", {"command": "text.insert",
                                "params": {"text": name.replace(".docx", "")}})
            wc.call("save_document", {"path": str(BUNDLE / name)})
        ok("the templates were written",
           (BUNDLE / "cover_memo.docx").exists()
           and (BUNDLE / "device_description.docx").exists())

        # --- the certificates ------------------------------------------------
        # One readable certificate and one nearly-blank scan: the sweep must
        # skip the first and OCR the second. They are exported by the word
        # processor so that their fonts are embedded — a PDF built from raw
        # text can never satisfy the PDF/A gate.
        for name, body in (("cert-001.pdf",
                            "Laboratory certificate 001. " * 12),
                           ("cert-002.pdf", "SCAN")):
            wc.call("new_document", {"template": "blank"})
            wc.call("execute", {"command": "text.insert", "params": {"text": body}})
            wc.call("execute", {"command": "file.exportPdf",
                                "params": {"path": str(BUNDLE / "certificates" / name)}})
        ok("the certificates were written",
           len(list((BUNDLE / "certificates").glob("*.pdf"))) == 2)

        # --- the safety form -------------------------------------------------
        wc.call("new_document", {"template": "blank"})
        wc.call("execute", {"command": "text.insert",
                            "params": {"text": "Safety assessment form"}})
        wc.call("execute", {"command": "file.exportPdf",
                            "params": {"path": str(BUNDLE / "safety_form_acroform.pdf")}})
        opened = pc.call("doc_open", {"path": str(BUNDLE / "safety_form_acroform.pdf")})
        for field, y in (("applicant_name", 700), ("device_class", 660),
                         ("legacy_field", 620)):
            pc.call("form_add_field", {
                "doc": opened["doc"], "page": 1, "type": "text",
                "rect": [72, y, 320, y + 20], "name": field})
        pc.call("doc_save", {"doc": opened["doc"], "full": False})
        ok("the safety form was written",
           (BUNDLE / "safety_form_acroform.pdf").exists())

        # --- the controlled vocabulary ---------------------------------------
        (BUNDLE / "summary_table.json").write_text(json.dumps({
            "headers": ["Parameter", "Value", "Unit", "Source"],
            "rows": [
                ["Sterilisation", "EtO", "method", "ISO 11135"],
                ["Shelf life", "24", "months", "stability study"],
            ],
        }))
        (BUNDLE / "form_field_map.json").write_text(json.dumps({
            "applicant_name": {"label": "Applicant", "fallback_tooltip": "Not supplied"},
            "device_class": {"label": "Device class", "fallback_tooltip": "Not supplied"},
        }))
        (BUNDLE / "bibliography.bib.json").write_text(json.dumps([
            {"key": "iso11135", "author": "ISO", "year": 2014,
             "title": "Sterilisation of health care products", "venue": "ISO"},
        ]))

        certs = sorted(str(p) for p in (BUNDLE / "certificates").glob("*.pdf"))
        variants = [
            {"regulator": "FDA_CDRH",
             "cover_memo_phrase": "Submitted to FDA CDRH under 510(k) K251234",
             "form_field_overrides": {"applicant_name": "Harbour Medical Ltd"},
             "certificates": certs,
             "safety_form": str(BUNDLE / "safety_form_acroform.pdf"),
             "bookmarks": [{"title": "Device description", "page": 2}]},
            {"regulator": "EU_MDR",
             "cover_memo_phrase": "Submitted under EU MDR 2017/745 Annex I",
             "form_field_overrides": {"applicant_name": "Harbour Medical Ltd",
                                      "device_class": "Class IIa"},
             "certificates": certs,
             "safety_form": str(BUNDLE / "safety_form_acroform.pdf"),
             "bookmarks": [{"title": "Device description", "page": 2}]},
            {"regulator": "HC_CA",
             "cover_memo_phrase": "Submitted to Health Canada, Class II",
             "form_field_overrides": {"applicant_name": "Harbour Medical Ltd"},
             "certificates": certs,
             "safety_form": str(BUNDLE / "safety_form_acroform.pdf"),
             "bookmarks": [{"title": "Device description", "page": 2}]},
        ]
        (BUNDLE / "variant_specs.json").write_text(json.dumps({"variants": variants}))
    finally:
        wc.close()
        pc.close()

    # --- the run -------------------------------------------------------------
    manifest = solution.main()

    # --- the manifest --------------------------------------------------------
    ok("the manifest was written", (OUT / "submission.manifest.json").exists())
    equal = lambda a, b: ok(a, b == b, f"{a} != {b}")
    ok("three variants were compiled", len(manifest["variants"]) == 3,
       json.dumps([v["regulator"] for v in manifest["variants"]]))
    ok("the baseline is the FDA variant", manifest["baseline"] == "FDA_CDRH")
    ok("the source revision index was recorded",
       manifest["source_docx_revision_index"] >= 0)

    for v in manifest["variants"]:
        ok(f"the {v['regulator']} PDF was written", Path(v["output_path"]).exists())
        ok(f"the {v['regulator']} hash was recorded", len(v["pdf_sha256"]) == 64)
        ok(f"the {v['regulator']} has pages", v["page_count"] >= 1)
        ok(f"the {v['regulator']} form map is incomplete",
           v["form_field_map_covered"] is False)
        ok(f"the {v['regulator']} flags the unmapped field",
           "legacy_field" in v["unmapped_fields"],
           json.dumps(v["unmapped_fields"]))
        ok(f"the {v['regulator']} reports the unfixable accessibility rule",
           "tagged-pdf" in v["accessibility_unfixable"],
           json.dumps(v["accessibility_unfixable"]))
        ok(f"the {v['regulator']} passes the PDF/A gate", v["pdfa_compliant"] is True)

    # --- the OCR sweep -------------------------------------------------------
    actions = {Path(e["file"]).name: e["action"] for e in manifest["ocr_log"]}
    ok("the readable certificate was skipped", actions.get("cert-001.pdf") == "skip",
       json.dumps(actions))
    ok("the blank scan was sent to OCR", actions.get("cert-002.pdf") == "ocr",
       json.dumps(actions))

    # --- the diff proof ------------------------------------------------------
    fda = next(v for v in manifest["variants"] if v["regulator"] == "FDA_CDRH")
    ok("the baseline has no diff report", fda.get("diff_report_path") is None)
    for v in manifest["variants"]:
        if v["regulator"] == "FDA_CDRH":
            continue
        ok(f"the {v['regulator']} diff report was written",
           v.get("diff_report_path") is not None
           and Path(v["diff_report_path"]).exists(),
           str(v.get("diff_report_path")))

    publish = HERE.parent / "output"
    for name in ("FDA_CDRH.pdf", "EU_MDR.pdf", "HC_CA.pdf", "submission.manifest.json"):
        shutil.copy2(OUT / name, publish / name)

    print(f"\n{passed} assertions passed")


if __name__ == "__main__":
    main()
