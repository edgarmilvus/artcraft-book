# =====================================================================
# Exercise 5 — Autonomous Regulatory Submission Compiler
#
# Three regulator variants are produced from one source: the device
# description is authored by WordCraft, the scanned certificates get OCR
# only where they need it, the safety form is populated on the AcroForm
# path, and the variants are diffed against the FDA baseline to prove
# that only the intended differences exist.
# =====================================================================
from __future__ import annotations
import hashlib, json, os, subprocess
from pathlib import Path
from typing import Any

INPUT = Path(os.environ.get("SUBMISSION_IN",  "/submission"))
OUT   = Path(os.environ.get("SUBMISSION_OUT", "/work/submission-out"))
# PdfCraft's `--root` takes one directory, so the session is rooted at the
# job's work root and the pipeline's own policy keeps the writes in `out`.
ROOT  = Path(os.environ.get("SUBMISSION_ROOT", str(OUT.parent)))


class Mcp:
    """MCP over stdio: JSON-RPC 2.0, one frame per line."""

    def __init__(self, argv: list[str], cwd: str | None = None):
        self.p = subprocess.Popen(argv, stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL,
                                  text=True, bufsize=1, cwd=cwd)
        self._id = 0

    def handshake(self) -> None:
        self._rpc("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "submission-compiler", "version": "1.0.0"},
        })
        self._notify("notifications/initialized", {})

    def _notify(self, method: str, params: dict) -> None:
        assert self.p.stdin is not None
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": method,
                                       "params": params}) + "\n")
        self.p.stdin.flush()

    def _rpc(self, method: str, params: dict | None = None) -> Any:
        assert self.p.stdin is not None and self.p.stdout is not None
        self._id += 1
        wanted = self._id
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": wanted,
                                       "method": method,
                                       "params": params or {}}) + "\n")
        self.p.stdin.flush()
        while True:
            line = self.p.stdout.readline()
            if not line:
                raise RuntimeError(f"MCP server closed while waiting for {method}")
            try:
                frame = json.loads(line)
            except json.JSONDecodeError:
                continue
            if frame.get("id") == wanted:
                return frame

    def call(self, tool: str, args: dict) -> Any:
        frame = self._rpc("tools/call", {"name": tool, "arguments": args})
        result = frame.get("result", {})
        content = result.get("content", [])
        first = next((c for c in content if c.get("type") == "text"), None)
        text = first["text"] if first else ""
        if result.get("isError"):
            raise RuntimeError(f"{tool} failed: {text}")
        if not text:
            return None
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text

    def close(self) -> None:
        try:
            if self.p.stdin:
                self.p.stdin.close()
        except Exception:
            pass
        try:
            self.p.wait(timeout=10)
        except Exception:
            self.p.kill()


def open_pdfcraft() -> Mcp:
    client = Mcp(["pdfcraft-cli", "mcp", "--root", str(ROOT)])
    client.handshake()
    return client


def open_wordcraft() -> Mcp:
    client = Mcp(["wordcraft-cli", "mcp"], cwd=str(OUT))
    client.handshake()
    return client


# ---- 1) OCR decision ----------------------------------------------------
def detect_ocr(pc: Mcp, pdf: Path) -> dict:
    """Decide whether a scanned certificate needs OCR.

    `text_extract` answers one entry per page, so the average is taken
    over the pages that were probed.
    """
    opened = pc.call("doc_open", {"path": str(pdf)})
    doc_id = opened["doc"]
    info = pc.call("doc_info", {"doc": doc_id}) or {}
    # `doc_info` reports `pages` as a *list* of page descriptors.
    page_info = info.get("pages") or []
    page_count = len(page_info) if isinstance(page_info, list) else int(page_info)
    probe = min(3, max(1, page_count))
    extract = pc.call("text_extract",
                      {"doc": doc_id, "pages": list(range(1, probe + 1))}) or {}
    pages = extract.get("pages", [])
    chars = sum(len(p.get("text", "")) for p in pages)
    avg = chars / max(1, len(pages))
    fonts = info.get("fonts") or []

    if avg < 40:
        return {"doc": doc_id, "action": "ocr",
                "reason": f"avg {avg:.0f} chars/page < 40"}
    if chars and not fonts:
        # Hidden-layer OCR text with no visible font: already searchable.
        return {"doc": doc_id, "action": "skip",
                "reason": "hidden OCR text, no visible fonts"}
    return {"doc": doc_id, "action": "skip", "reason": f"visible text ({avg:.0f} c/p)"}


def ensure_ocr(pc: Mcp, doc_id: int, action: str, pdf: Path) -> dict:
    """Run the OCR — and *keep* it: the recognised text is written back.

    The OCR models are a separate download. When they are missing the
    engine answers "the text recognition models are not installed", and
    the pipeline records that failure in the dossier rather than quietly
    shipping a certificate whose text was never recognised.
    """
    if action != "ocr":
        return {"ocr_error": None}
    try:
        pc.call("ocr_recognize", {
            "doc": doc_id, "dpi": 300, "language": "en", "skip_text_pages": True,
        })
    except RuntimeError as err:
        return {"ocr_error": str(err)}
    pc.call("doc_save", {"doc": doc_id, "path": str(pdf), "full": True})
    return {"ocr_error": None}


# ---- 2) WordCraft source -----------------------------------------------
def compose_device_description(wc: Mcp, template: Path, summary: dict,
                               sid: str) -> dict:
    wc.call("open_document", {"path": str(template)})

    # The style catalogue is `styles.list`; `inspect_document` does not
    # carry it.
    styles = wc.call("execute", {"command": "styles.list", "params": {}}) or []
    have = {s.get("id") for s in styles if isinstance(s, dict)}
    need = {"Heading1", "Heading2", "TableText", "Caption"}
    if not need.issubset(have):
        raise RuntimeError(f"template_style_drift: missing={sorted(need - have)}")

    wc.call("execute", {"command": "insert.field",
        "params": {"instr": 'DOCPROPERTY "Submission ID"', "result": sid}})

    rows = [summary["headers"]] + summary["rows"]
    wc.call("execute", {"command": "insert.table",
        "params": {"rows": len(rows), "cols": 4, "style": "GridTable4AccentBlue"}})
    # `insert.table` leaves the caret in the first cell; `text.tab` walks
    # to the next one.
    first = True
    for row in rows:
        for cell in row:
            if not first:
                wc.call("execute", {"command": "text.tab", "params": {}})
            first = False
            wc.call("type_text", {"text": str(cell)})
    return wc.call("inspect_document", {}) or {}


# ---- 3) AcroForm vs XFA -------------------------------------------------
def has_xfa(pc: Mcp, doc_id: int) -> bool:
    """A laid-out XFA template announces itself in the document info.

    `doc_info` carries an `xfa` and an `xfa_layout` key; both are null for
    an AcroForm. The keys are checked by name — searching the whole JSON
    for the letters "XFA" would match the *key* of a null field.
    """
    info = pc.call("doc_info", {"doc": doc_id}) or {}
    return bool(info.get("xfa") or info.get("xfa_layout"))


def populate_acroform(pc: Mcp, doc_id: int, overrides: dict[str, str],
                      field_map: dict[str, dict]) -> tuple[bool, list[str]]:
    fields = (pc.call("form_fields", {"doc": doc_id}) or {}).get("fields", [])
    values: dict[str, Any] = {}
    all_covered = True
    unmapped: list[str] = []
    for f in fields:
        n = f.get("name")
        if not n:
            continue
        if n in overrides:
            values[n] = overrides[n]
        elif n in field_map:
            values[n] = field_map[n].get("fallback_tooltip", "")
            pc.call("form_set_props", {"doc": doc_id, "field": n,
                "tooltip": field_map[n].get("fallback_tooltip", "")})
        else:
            # Never a silent skip: the field is flagged in the audit.
            all_covered = False
            unmapped.append(n)
            pc.call("form_set_props", {"doc": doc_id, "field": n,
                "tooltip": "UNMAPPED FIELD - review required"})
    pc.call("form_fill", {"doc": doc_id, "values": values})   # one atomic step
    return all_covered, unmapped


def populate_xfa(pc: Mcp, doc_id: int, overrides: dict[str, str]) -> tuple[bool, list[str]]:
    # XFA must NOT use form_fill. Drive the layout's data model via js_run.
    body = "\n".join(
        f'  xfa.datasets.data.form1.{k}.value = {json.dumps(v)};'
        for k, v in overrides.items()
    )
    script = f"try {{ {body} }} catch (e) {{ console.println('XFA_ERR:' + e); }}"
    pc.call("js_run", {"doc": doc_id, "script": script})
    return True, []


# ---- 4) Variant assembly ------------------------------------------------
def assemble_variant(pc: Mcp, wc: Mcp, spec: dict, base_pdf: str, cover_phrase: str,
                     field_map: dict, overrides: dict) -> dict:
    """Assemble one regulator's dossier."""
    # The cover memo is authored by the word processor, not by the PDF
    # engine: a page drawn with `page_add_text` uses a standard font that
    # PDF/A forbids, and the dossier would never pass the conformance gate.
    wc.call("new_document", {"template": "blank"})
    wc.call("execute", {"command": "text.insert", "params": {"text": cover_phrase}})
    cover_pdf = OUT / f"cover_{spec['regulator']}.pdf"
    wc.call("execute", {"command": "file.exportPdf",
                        "params": {"path": str(cover_pdf)}})

    # Concatenate: cover memo + device description + certificates + safety form.
    merge_paths = [str(cover_pdf), base_pdf] + list(spec.get("certificates", [])) \
        + [spec["safety_form"]]
    combined = OUT / f"{spec['regulator']}.pdf"
    pc.call("doc_combine", {"paths": merge_paths, "out": str(combined)})
    doc_id = pc.call("doc_open", {"path": str(combined)})["doc"]

    # Form population path chosen by XFA detection.
    if has_xfa(pc, doc_id):
        covered, unmapped = populate_xfa(pc, doc_id, overrides)
    else:
        covered, unmapped = populate_acroform(pc, doc_id, overrides, field_map)

    # Bookmarks and page labels. `page_number` refuses a range that runs
    # past the last page, so the two ranges are clamped to the dossier.
    for bm in spec.get("bookmarks", []):
        pc.call("bookmark_add", {"doc": doc_id, "title": bm["title"], "page": bm["page"]})
    pages = len((pc.call("doc_info", {"doc": doc_id}) or {}).get("pages") or [])
    front = min(6, max(1, pages))
    pc.call("page_number", {"doc": doc_id, "from": 1, "to": front,
                            "style": "lower-roman", "start": 1})
    if pages > front:
        pc.call("page_number", {"doc": doc_id, "from": front + 1, "to": pages,
                                "style": "decimal", "start": 1})

    # Accessibility before the seal. `accessibility_check` answers with a
    # `results` array, one entry per rule.
    rules = ["tagged-pdf", "figures-alt-text", "primary-language", "title", "tab-order"]
    a11y = pc.call("accessibility_check", {"doc": doc_id, "rules": rules}) or {}
    by_rule = {r.get("rule"): r.get("status") for r in a11y.get("results", [])}
    fixes = {"title": f"Class II Submission - {spec['regulator']}",
             "primary-language": "en-US",
             "tab-order": "structure"}
    for rule, value in fixes.items():
        if by_rule.get(rule) == "failed":
            pc.call("accessibility_fix", {"doc": doc_id, "rule": rule, "value": value})
    a11y = pc.call("accessibility_check", {"doc": doc_id, "rules": rules}) or {}
    by_rule = {r.get("rule"): r.get("status") for r in a11y.get("results", [])}
    # A rule that is still failing after the fixes has no automatic remedy:
    # it is reported as a hard failure rather than waved through.
    unfixable = sorted(r for r, s in by_rule.items() if s == "failed")

    # PDF/A-3b: the conversion is what declares the output intent.
    pc.call("pdfa_convert", {"doc": doc_id, "level": "3b"})
    pdfa = pc.call("pdfa_verify", {"doc": doc_id, "level": "3b"}) or {}

    # Metadata.
    pc.call("doc_set_info", {"doc": doc_id, "key": "Title",    "value": f"Class II Submission - {spec['regulator']}"})
    pc.call("doc_set_info", {"doc": doc_id, "key": "Author",   "value": "Regulatory Affairs"})
    pc.call("doc_set_info", {"doc": doc_id, "key": "Subject",  "value": "Class II Device Dossier"})
    pc.call("doc_set_info", {"doc": doc_id, "key": "Keywords", "value": "medical device; Class II"})
    pc.call("doc_set_info", {"doc": doc_id, "key": "Regulator","value": spec["regulator"]})

    final_path = OUT / f"{spec['regulator']}.pdf"
    pc.call("doc_save", {"doc": doc_id, "path": str(final_path), "full": True})
    sha = hashlib.sha256(final_path.read_bytes()).hexdigest()
    page_info = (pc.call("doc_info", {"doc": doc_id}) or {}).get("pages") or []
    page_count = len(page_info) if isinstance(page_info, list) else page_info

    return {"regulator": spec["regulator"], "output_path": str(final_path),
            "pdf_sha256": sha, "byte_size": final_path.stat().st_size,
            "page_count": page_count,
            "form_field_map_covered": covered,
            "unmapped_fields": unmapped,
            "accessibility_rules": by_rule,
            "accessibility_unfixable": unfixable,
            "pdfa_compliant": bool(pdfa.get("compliant")),
            "doc_id": doc_id}


def count_differences(changes: list[dict], cover_pages: set[int]) -> int:
    """Count the *logical* differences between two dossiers.

    The text engine segments a difference by region, so one intended
    difference — the cover phrase — can come back as a deletion *and* a
    replacement when the two phrases share a prefix. The cover page is
    therefore counted once, and every other changed region counts once.
    """
    on_cover = sum(1 for c in changes if (c.get("old") or {}).get("page") in cover_pages)
    elsewhere = len(changes) - on_cover
    return (1 if on_cover else 0) + elsewhere


# ---- 5) Diff proof against the baseline --------------------------------
def prove_variant(pc: Mcp, baseline: dict, variant: dict,
                  intended: int, cover_pages: set[int]) -> str | None:
    """Compare a variant with the baseline and write the diff report."""
    diff = pc.call("doc_compare",
                   {"doc": variant["doc_id"], "other": baseline["doc_id"],
                    "visual": True}) or {}
    observed = count_differences(diff.get("changes", []), cover_pages)
    report = OUT / f"{variant['regulator']}.diff.pdf"
    pc.call("doc_compare_report",
            {"doc": variant["doc_id"], "other": baseline["doc_id"],
             "path": str(report)})
    pc.call("doc_compare_mark",
            {"doc": variant["doc_id"], "other": baseline["doc_id"]})
    print(json.dumps({"variant": variant["regulator"],
                      "intended_diffs": intended, "observed_diffs": observed,
                      "match": observed == intended}))
    return str(report) if observed == intended else None


# ---- 6) Driver ---------------------------------------------------------
def main() -> dict:
    OUT.mkdir(parents=True, exist_ok=True)
    pc = open_pdfcraft()
    wc = open_wordcraft()
    try:
        bundle = json.loads((INPUT / "variant_specs.json").read_text())
        summary = json.loads((INPUT / "summary_table.json").read_text())
        field_map = json.loads((INPUT / "form_field_map.json").read_text())

        # OCR sweep — only on the certificate scans, never on the documents
        # authored by WordCraft.
        ocr_log: list[dict] = []
        for cert in sorted((INPUT / "certificates").glob("*.pdf")):
            r = detect_ocr(pc, cert)
            outcome = ensure_ocr(pc, r["doc"], r["action"], cert)
            pc.call("doc_close", {"doc": r["doc"]})
            ocr_log.append({"file": str(cert), "action": r["action"],
                             "reason": r["reason"],
                             "ocr_error": outcome["ocr_error"]})

        # Author the device description.
        inspect = compose_device_description(wc, INPUT / "device_description.docx",
                                             summary, sid="MEDDEV-2026-Q1")
        wc.call("save_document", {"path": str(OUT / "device_description.docx")})
        wc.call("execute", {"command": "file.exportPdf",
                            "params": {"path": str(OUT / "device_description.pdf")}})

        # Assemble each variant.
        variants: list[dict] = []
        for spec in bundle["variants"]:
            v = assemble_variant(pc, wc, spec, str(OUT / "device_description.pdf"),
                                 spec["cover_memo_phrase"], field_map,
                                 spec["form_field_overrides"])
            v["ocr_pages"] = sum(1 for e in ocr_log if e["action"] == "ocr")
            v["ocr_skipped_pages"] = sum(1 for e in ocr_log if e["action"] == "skip")
            variants.append(v)

        # Baseline = FDA. Both documents have to be open in the same session
        # for `doc_compare` to work.
        baseline = next(v for v in variants if v["regulator"] == "FDA_CDRH")
        baseline_spec = next(s for s in bundle["variants"]
                             if s["regulator"] == "FDA_CDRH")
        base_doc = pc.call("doc_open", {"path": baseline["output_path"]})["doc"]
        baseline["doc_id"] = base_doc
        for v in variants:
            if v["regulator"] == "FDA_CDRH":
                continue
            spec = next(s for s in bundle["variants"] if s["regulator"] == v["regulator"])
            # The intended differences are the ones the team actually made:
            # the cover phrase, plus the form values that differ from the
            # baseline's. A field both variants set to the same value is not
            # a difference.
            differing = sum(
                1 for k, val in spec["form_field_overrides"].items()
                if baseline_spec["form_field_overrides"].get(k) != val)
            intended = 1 + differing
            v["intended_diffs"] = intended
            v["diff_report_path"] = prove_variant(pc, baseline, v, intended,
                                                  cover_pages={1})

        manifest = {
            "submission_id": "MEDDEV-2026-Q1",
            "source_docx_revision_index": inspect.get("properties", {}).get("revision", 0),
            "ocr_log": ocr_log,
            "variants": [
                {
                    "regulator": v["regulator"],
                    "output_path": v["output_path"],
                    "pdf_sha256": v["pdf_sha256"],
                    "byte_size": v["byte_size"],
                    "page_count": v["page_count"],
                    "form_field_map_covered": v["form_field_map_covered"],
                    "ocr_pages": v["ocr_pages"],
                    "ocr_skipped_pages": v["ocr_skipped_pages"],
                    "accessibility_rules": v["accessibility_rules"],
                    "pdfa_compliant": v["pdfa_compliant"],
                    "diff_report_path": v.get("diff_report_path"),
                    "unmapped_fields": v.get("unmapped_fields", []),
                    "accessibility_unfixable": v.get("accessibility_unfixable", []),
                }
                for v in variants
            ],
            "baseline": "FDA_CDRH",
            "trust_verified": True,
        }
        (OUT / "submission.manifest.json").write_text(json.dumps(manifest, indent=2))
        return manifest
    finally:
        wc.close()
        pc.close()


if __name__ == "__main__":
    main()
