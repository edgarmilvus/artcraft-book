# =====================================================================
# Exercise 2 — Agentic PII Redaction & Regulatory Compliance Audit
# The agent bootstraps against pdfcraft-cli mcp's command_list, writes
# the discovered tool signatures to toolchain.json, then executes the
# redaction pipeline. Near-matches (edit distance <= 2) cause a
# *negotiated pause*: the file is quarantined from the sealed batch.
# =====================================================================
from __future__ import annotations
import hashlib, json, os, re, subprocess, sys
from pathlib import Path
from typing import Any, Literal

IN_DIR   = Path(os.environ.get("HOSPITAL_IN",  "/work/hospital/in"))
OUT_DIR  = Path(os.environ.get("HOSPITAL_OUT", "/work/hospital/out"))
# PdfCraft's `--root` takes ONE directory, so the session is rooted at the
# job's work root — the directory that holds both the scans and the outbox.
ROOT_DIR = Path(os.environ.get("HOSPITAL_ROOT", str(OUT_DIR.parent)))
NAME_LKP = Path(os.environ.get("HOSPITAL_NAMES", "/work/hospital/pii_names.json"))
BLACKLIST = ["ssn", "social security", "credit card", "date of birth", "mrn", "dob:"]

# The values that must not survive the redaction. The field *labels* are
# not identifying, so the check is on the values themselves.
VALUE_PATTERNS = {
    "ssn": r"\b\d{3}-\d{2}-\d{4}\b",
    "phone": r"\(\d{3}\)\s*\d{3}-\d{4}",
    "credit-card": r"\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}\b",
    "mrn": r"MRN:\s*\S+",
    "dob": r"DOB:\s*\S+",
    "email": r"[\w.+-]+@[\w-]+\.[\w.]+",
}

# ---------------------------------------------------------------------
# Minimal MCP-over-stdio driver (JSON-RPC 2.0, line-delimited).
# ---------------------------------------------------------------------
class Mcp:
    """A tiny MCP client: one JSON-RPC frame per line, in and out."""

    def __init__(self, argv: list[str]):
        self.p = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
        self._id = 0

    # -- handshake ---------------------------------------------------------
    def handshake(self) -> None:
        self._rpc("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "hospital-redaction", "version": "1.0.0"},
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
        # The server may interleave notifications and log frames, so read
        # until the frame with our id shows up.
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

    # -- tools -------------------------------------------------------------
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
            self.p.stdin and self.p.stdin.close()
        except Exception:
            pass
        try:
            self.p.wait(timeout=10)
        except Exception:
            self.p.kill()


def open_pdfcraft(root: Path) -> Mcp:
    """A PdfCraft session bounded to `root` — the server enforces it."""
    client = Mcp(["pdfcraft-cli", "mcp", "--root", str(root)])
    client.handshake()
    return client

# ---------------------------------------------------------------------
# Step 1 — Bootstrap the agent's tool knowledge once, from command_list.
# ---------------------------------------------------------------------
def bootstrap_toolchain(pdfcraft: Mcp) -> dict:
    """Discover the toolchain instead of hard-coding it, and persist it."""
    tc = OUT_DIR / "toolchain.json"
    if tc.exists():
        return json.loads(tc.read_text())

    discovered = pdfcraft.call("command_list", {}) or {}
    commands = discovered.get("commands", [])
    signatures = [
        {
            "tool": c.get("tool"),
            "id": c.get("id"),
            "params": c.get("params"),
            "enabled": c.get("enabled", True),
        }
        for c in commands
    ]
    payload = {
        "source": "pdfcraft-cli mcp → command_list",
        "command_count": len(commands),
        "tool_count": sum(1 for s in signatures if s["tool"]),
        "signatures": signatures,
    }
    tc.write_text(json.dumps(payload, indent=2))
    return payload


# ---------------------------------------------------------------------
# Step 2 — Edit-distance for the *negotiated pause* rule.
# ---------------------------------------------------------------------
def edit_distance(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(cur[-1] + 1, prev[j] + 1,
                           prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


# ---------------------------------------------------------------------
# Step 3 — Process one scan; return the dossier.
# ---------------------------------------------------------------------
def page_text(pdfcraft: Mcp, doc: int) -> str:
    """Every page's text, concatenated — `text_extract` answers per page."""
    extracted = pdfcraft.call("text_extract", {"doc": doc}) or {}
    return "\n".join(p.get("text", "") for p in extracted.get("pages", []))


def hidden_counts(pdfcraft: Mcp, doc: int) -> dict[str, int]:
    """`doc_hidden_info` answers with a list of categories; flatten it."""
    info = pdfcraft.call("doc_hidden_info", {"doc": doc}) or {}
    return {c["category"]: c["count"] for c in info.get("categories", [])}


def mark_label_values(pdfcraft: Mcp, doc: int, label: str) -> list[dict]:
    """Mark the value that follows every occurrence of `label`.

    `redact_mark` has no "anchor to a label" mode, so the label is located
    with `text_find` and the rectangle that follows it — the value on the
    same line — is marked explicitly. The MRN and the date of birth are
    both read this way: the engine's pattern set covers the SSN, the phone
    number and the credit card, but it has no notion of a medical record
    number.
    """
    marks = []
    labels = pdfcraft.call("text_find", {"doc": doc, "query": label}) or {}
    for match in labels.get("matches", []):
        page = match.get("page")
        for rect in match.get("rects", []):
            x0, y0, _x1, y1 = rect
            # The value sits to the right of the label, on the same line.
            marks.append({"doc": doc, "page": page,
                          "rect": [x0, y0, x0 + 140.0, y1],
                          "fill": "#000000",
                          "author": "Nimbus PII Redactor"})
    return marks


def process_scan(pdf_in: Path, names: list[str], pdfcraft: Mcp) -> dict:
    opened = pdfcraft.call("doc_open", {"path": str(pdf_in)})
    doc, pages_total = opened["doc"], opened["pages"]

    # ---- Pre-flight inspection (order is audited) ----
    extract_0 = page_text(pdfcraft, doc)
    info_0 = pdfcraft.call("doc_info", {"doc": doc}) or {}
    hidden_0 = hidden_counts(pdfcraft, doc)

    actions: list[dict] = []
    suspected: list[str] = []

    # ---- Pattern coverage: never whole_pages:true ----
    #
    # `redact_mark` *fails* when a pattern matches nothing — "nothing
    # matched, so nothing was marked". A scan that simply has no credit
    # card on it is not an error, so the call is guarded and the audit
    # records a count of zero.
    for pattern in ("ssn", "phone", "credit-card"):
        try:
            r = pdfcraft.call("redact_mark", {"doc": doc, "pattern": pattern,
                                              "fill": "#000000",
                                              "author": "Nimbus PII Redactor"}) or {}
        except RuntimeError:
            r = {}
        actions.append({"tool": "redact_mark", "page": None,
                        "params": {"pattern": pattern},
                        "returned_count": r.get("marked", 0),
                        "pages_marked": r.get("pages_marked", [])})

    # ---- The labelled values: the MRN and the date of birth ---------------
    for label in ("MRN:", "DOB:"):
        for mark in mark_label_values(pdfcraft, doc, label):
            try:
                r = pdfcraft.call("redact_mark", mark) or {}
            except RuntimeError:
                r = {}
            actions.append({"tool": "redact_mark", "page": mark["page"],
                            "params": {"rect": mark["rect"], "anchored_to": label},
                            "returned_count": r.get("marked", 0)})

    # ---- Patient names (from lookup table) ----
    for name in names:
        hits = pdfcraft.call("text_find", {"doc": doc, "query": name}) or {}
        n = hits.get("count", 0)
        if n:
            r = pdfcraft.call("redact_mark", {"doc": doc, "find": name,
                                              "fill": "#000000",
                                              "author": "Nimbus PII Redactor"}) or {}
            actions.append({"tool": "redact_mark", "page": None,
                            "params": {"find": name},
                            "returned_count": r.get("marked", 0)})
        else:
            # Near-match path — DO NOT redact; flag for human negotiator.
            # The comparison is word against word: "Alicia" is two edits
            # away from "Alice", which is what the negotiator has to see.
            name_words = [w for w in re.split(r"\W+", name) if w]
            for tok in sorted(set(re.findall(r"\b[A-Z][A-Za-z'\-]+\b", extract_0))):
                for word in name_words:
                    if edit_distance(tok.lower(), word.lower()) <= 2:
                        suspected.append(f"{name}≈{tok}")
                        break

    # ---- Apply marks per page (one undo step per page) ----
    for pg in range(1, pages_total + 1):
        r = pdfcraft.call("redact_apply", {"doc": doc, "pages": [pg]}) or {}
        actions.append({"tool": "redact_apply", "page": pg,
                        "params": {"pages": [pg]},
                        "returned_count": r.get("applied", 0)})

    # ---- Post-verification: no targeted *value* may survive ---------------
    #
    # The field *labels* ("SSN:", "MRN:") are not identifying — they say
    # what the field is — so the residual check looks for the values, not
    # for the words.
    post_text = page_text(pdfcraft, doc).lower()
    residual = [name for name, rx in VALUE_PATTERNS.items()
                if re.search(rx, post_text, re.IGNORECASE)]

    # ---- Remove hidden remains that redaction may have *created* ----
    hidden_1 = hidden_counts(pdfcraft, doc)
    removable = [k for k in ("metadata", "hidden-text",
                             "links-actions-scripts", "private-data")
                 if hidden_1.get(k)]
    if removable:
        pdfcraft.call("doc_remove_hidden", {"doc": doc, "categories": removable})
        actions.append({"tool": "doc_remove_hidden", "page": None,
                        "params": {"categories": removable},
                        "returned_count": sum(hidden_1[k] for k in removable)})
        hidden_final = hidden_counts(pdfcraft, doc)
    else:
        hidden_final = hidden_1

    # ---- Accessibility: ensure decorative marks don't count as figures ----
    #
    # The three rules the hospital cares about are `title`,
    # `primary-language` and `tab-order`. The first two are machine-fixable,
    # so the pipeline fixes what it can and re-checks; a rule that is still
    # failing after the fixes is reported as failed, never waved through.
    a11y = pdfcraft.call("accessibility_check",
                         {"doc": doc,
                          "rules": ["title", "primary-language", "tab-order"]}) or {}
    fixes = {"title": pdf_in.stem.replace("_", " "),
             "primary-language": "en-US"}
    for rule, value in fixes.items():
        failed = [r for r in a11y.get("results", [])
                  if r.get("rule") == rule and r.get("status") == "failed"]
        if not failed:
            continue
        pdfcraft.call("accessibility_fix", {"doc": doc, "rule": rule, "value": value})
        actions.append({"tool": "accessibility_fix", "page": None,
                        "params": {"rule": rule, "value": value},
                        "returned_count": 1})
    a11y = pdfcraft.call("accessibility_check",
                         {"doc": doc,
                          "rules": ["title", "primary-language", "tab-order"]}) or {}

    figures = pdfcraft.call("accessibility_figures", {"doc": doc}) or {}
    for f in figures.get("figures", []):
        figure_id = f.get("figure", f.get("id"))
        if figure_id is None or f.get("alt"):
            continue
        pdfcraft.call("accessibility_set_alt",
                      {"doc": doc, "figure": figure_id, "decorative": True})
        actions.append({"tool": "accessibility_set_alt", "page": None,
                        "params": {"figure": figure_id, "decorative": True},
                        "returned_count": 1})

    # ---- PDF/A-2b. The conversion is what adds the output intent and the
    #      XMP identity; the verification then confirms it.
    pdfa = pdfcraft.call("pdfa_convert", {"doc": doc, "level": "2b"}) or {}
    actions.append({"tool": "pdfa_convert", "page": None,
                    "params": {"level": "2b"},
                    "returned_count": 1 if pdfa.get("compliant") else 0})
    pdfa = pdfcraft.call("pdfa_verify", {"doc": doc, "level": "2b"}) or {}

    # ---- Sealed output ----
    out_pdf = OUT_DIR / f"{pdf_in.stem}.redacted.pdf"
    pdfcraft.call("doc_save", {"doc": doc, "path": str(out_pdf), "full": True})
    pdfcraft.call("doc_close", {"doc": doc})
    digest = hashlib.sha256(out_pdf.read_bytes()).hexdigest()

    by_rule = {r["rule"]: r["status"] for r in a11y.get("results", [])}
    # A PDF/A file *must* carry an XMP identity, so the metadata category is
    # expected to be non-zero after the conversion; every other removable
    # category has to be zero.
    residual_hidden = {
        k: v for k, v in hidden_final.items()
        if k in ("hidden-text", "hidden-layers", "links-actions-scripts",
                 "private-data", "attachments") and v
    }
    audit_clean = (
        not residual
        and not residual_hidden
        and a11y.get("failed", 0) == 0
        and bool(pdfa.get("compliant"))
        and not suspected
    )
    status: Literal["sealed", "review_required", "failed"] = (
        "review_required" if suspected else ("sealed" if audit_clean else "failed"))

    dossier = {
        "input_path":  str(pdf_in),
        "output_path": str(out_pdf),
        "actions":     actions,
        "final_hidden_info": hidden_final,
        "residual_hidden_categories": residual_hidden,
        "accessibility": by_rule,
        "accessibility_summary": {"passed": a11y.get("passed", 0),
                                   "failed": a11y.get("failed", 0),
                                   "manual": a11y.get("manual", 0)},
        "pdfa": {"level": "2b",
                 "compliant": bool(pdfa.get("compliant")),
                 "issues": pdfa.get("issues", [])},
        "pdf_sha256":  digest,
        "audit_clean": audit_clean,
        "status":      status,
        "suspected_matches": suspected,
        "residual_tokens": residual,
        "page_count": pages_total,
    }
    (OUT_DIR / f"{pdf_in.stem}.audit.json").write_text(json.dumps(dossier, indent=2))
    return dossier


# ---------------------------------------------------------------------
# Step 4 — Batch fallback: combine clean PDFs, else emit EXCEPTIONS.pdf.
# ---------------------------------------------------------------------
def main() -> dict:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    pdfcraft = open_pdfcraft(ROOT_DIR)
    try:
        bootstrap_toolchain(pdfcraft)                  # ← persist once

        names = json.loads(NAME_LKP.read_text())
        clean_paths: list[str] = []
        flagged_inputs: list[str] = []
        dossiers: list[dict] = []

        for inp in sorted(IN_DIR.glob("*.pdf")):
            d = process_scan(inp, names, pdfcraft)
            dossiers.append(d)
            if d["audit_clean"]:
                clean_paths.append(d["output_path"])
            else:
                flagged_inputs.append(d["input_path"])
                for sus in d["suspected_matches"]:
                    print(json.dumps({"event": "review_required",
                                      "file": d["input_path"],
                                      "suspected": sus}))

        # Combine every clean output into the auditor-issuable submission.
        combined = None
        if clean_paths and len(clean_paths) >= 2:
            combined = OUT_DIR / "AUDITOR_SUBMISSION.pdf"
            pdfcraft.call("doc_combine", {"paths": clean_paths, "out": str(combined)})
        elif clean_paths:
            combined = OUT_DIR / "AUDITOR_SUBMISSION.pdf"
            # `doc_combine` needs at least two inputs; a single clean file
            # is submitted as-is.
            shutil_copy(clean_paths[0], combined)

        exceptions = None
        if flagged_inputs:
            exceptions = OUT_DIR / "EXCEPTIONS.pdf"
            if len(flagged_inputs) >= 2:
                pdfcraft.call("doc_combine", {"paths": flagged_inputs,
                                             "out": str(exceptions)})
            else:
                shutil_copy(flagged_inputs[0], exceptions)

        summary = {
            "processed": len(dossiers),
            "sealed": sum(1 for d in dossiers if d["status"] == "sealed"),
            "review_required": sum(1 for d in dossiers if d["status"] == "review_required"),
            "failed": sum(1 for d in dossiers if d["status"] == "failed"),
            "submission": str(combined) if combined else None,
            "exceptions": str(exceptions) if exceptions else None,
        }
        (OUT_DIR / "_run_summary.json").write_text(json.dumps(summary, indent=2))
        return summary
    finally:
        pdfcraft.close()


def shutil_copy(src: str, dst: Path) -> None:
    Path(dst).write_bytes(Path(src).read_bytes())


if __name__ == "__main__":
    main()
