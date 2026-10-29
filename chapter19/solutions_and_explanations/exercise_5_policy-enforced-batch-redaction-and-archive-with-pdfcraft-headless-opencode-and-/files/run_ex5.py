#!/usr/bin/env python3
"""
Exercise 5 harness: Policy-Enforced Batch Redaction and Archive with PdfCraft.

The harness builds the discovery fixtures with the engine itself, runs
05_redact_pipeline.py for real, and then checks the sealed artefacts and the
engine's own reports.  Every check prints one `PASS <label>` line; the run
ends with the number of assertions that passed.

It needs no API key and no network: PdfCraft is driven over MCP stdio and
every artefact is produced locally.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

sys.dont_write_bytecode = True

FILES = Path(__file__).resolve().parent
ROOT = FILES.parent / "output" / "work"
DISCOVERY = ROOT / "discovery"
INCOMING = DISCOVERY / "incoming"
WORKDIR = DISCOVERY / "work"
SOLUTION = FILES / "05_policy-enforced-batch-redaction-and-archive-with-pdfcraft-headless-opencode-and-a-signed-audit-trail.py"
PATTERNS_CONTRACT = FILES / "03_jsonc.jsonc"

HMAC_KEY = "9d1f4c0b7a6e2d8351c40f7b6a2e9d04c5b7e1a3f6c8d2059e4b3a1c7d6f8e20"
HMAC_KEY_REF = "harrow-vale-2026"

PASSED: List[str] = []
FAILED: List[Tuple[str, str]] = []


def check(label: str, condition: bool, detail: str = "") -> bool:
    if condition:
        PASSED.append(label)
        print("PASS %s" % label)
    else:
        FAILED.append((label, detail))
        print("FAIL %s %s" % (label, detail))
    return bool(condition)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ---------------------------------------------------------------------------
# The pipeline's own MCP client, loaded from the reference solution
# ---------------------------------------------------------------------------

def load_solution_module():
    spec = importlib.util.spec_from_file_location("redact_pipeline", str(SOLUTION))
    if spec is None or spec.loader is None:
        raise SystemExit("cannot load %s" % SOLUTION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def resolve_engine() -> str:
    found = shutil.which("pdfcraft-cli")
    if found:
        return found
    for base in FILES.parents:
        candidate = base / "tools" / "craft-cli" / "bin" / "pdfcraft-cli"
        if candidate.is_file():
            return str(candidate)
    raise SystemExit("pdfcraft-cli is not on PATH")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

DISCLOSURE_PAGES = [
    "Harrow & Vale LLP - Matter 4421-AB",
    "Client contact: phone (555) 013-4567 and email a.chen@example.com",
    "Payment card 4111 1111 1111 1111 exp 03/29",
    "SSN 123-45-6789 date of birth 1979-04-02",
    "ACME-CONF-9912 is the confidential annex reference",
    "Unrelated closing paragraph with no personal data",
]
SIGNED_PAGES = [
    "Harrow & Vale LLP - Executed engagement letter",
    "Client contact: phone (555) 987-6543 and email j.doe@example.com",
    "This copy has been signed by the partner and must not be rewritten",
]
CLEAN_PAGES = [
    "Harrow & Vale LLP - closure of engagement",
    "The file is closed and no further work remains",
    "All obligations have been discharged in full",
]

PII_STRINGS = ["(555) 013-4567", "a.chen@example.com", "4111 1111 1111 1111",
               "123-45-6789", "1979-04-02", "Matter 4421-AB", "ACME-CONF-9912"]
BENIGN_STRING = "Unrelated closing paragraph with no personal data"


def client_patterns() -> List[str]:
    """The client-supplied patterns, taken from the 03_jsonc.jsonc contract."""
    patterns = []
    for line in PATTERNS_CONTRACT.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if not text or text.startswith("//") or text.startswith("#"):
            continue
        patterns.append(text)
    return patterns


def build_pdf(client, module, rel_path: str, pages: List[str]) -> None:
    created = client.call_sync("doc_create", {"from": "blank", "pages": len(pages),
                                               "name": Path(rel_path).stem})
    doc = int(created["doc"])
    for number, text in enumerate(pages, start=1):
        client.call_sync("page_add_text", {
            "doc": doc, "page": number, "text": text,
            "at": [72, 100], "size": 11, "width": 460})
    client.call_sync("doc_save", {"doc": doc, "path": rel_path})
    client.call_sync("doc_close", {"doc": doc})


def build_signed_pdf(client, module, rel_path: str, pages: List[str]) -> None:
    staged = "discovery/work/%s.source.pdf" % Path(rel_path).stem
    build_pdf(client, module, staged, pages)
    identity = client.call_sync("sign_id_create", {
        "name": "Harrow Vale Test Signer", "organization": "Harrow & Vale",
        "email": "compliance@harrowvale.test", "password": "harrow-vale-test",
        "path": "discovery/work/harrow-vale-test.p12", "years": 1})
    check("fixture_identity_created", bool(identity.get("certificate")), str(identity)[:200])
    opened = client.call_sync("doc_open", {"path": staged})
    doc = int(opened["doc"])
    client.call_sync("sign_document", {
        "doc": doc, "id": "discovery/work/harrow-vale-test.p12",
        "password": "harrow-vale-test", "out": rel_path, "page": 1,
        "rect": [72, 700, 240, 740], "reason": "Executed copy"})
    client.call_sync("doc_close", {"doc": doc})


# ---------------------------------------------------------------------------
# A synchronous wrapper around the solution's asynchronous MCP client
# ---------------------------------------------------------------------------

class SyncClient:
    """Drives the solution's MCP client from synchronous test code."""

    def __init__(self, module, command: List[str], cwd: Path) -> None:
        self.module = module
        self.command = command
        self.cwd = cwd
        self._loop = None
        self._client = None

    def __enter__(self) -> "SyncClient":
        self._loop = asyncio.new_event_loop()
        self._client = self._loop.run_until_complete(
            self.module.McpStdioClient(self.command, cwd=self.cwd).__aenter__())
        return self

    def __exit__(self, *exc: Any) -> None:
        if self._loop is not None:
            self._loop.run_until_complete(self._client.__aexit__(None, None, None))
            self._loop.close()
            self._loop = None

    def call_sync(self, name: str, arguments: Dict[str, Any]) -> Any:
        return self._loop.run_until_complete(self._client.call(name, arguments))

    def refused(self, name: str, arguments: Dict[str, Any]) -> str:
        """The engine's own refusal message for a call it rejects."""
        try:
            self._loop.run_until_complete(self._client.call(name, arguments))
        except self.module.McpError as exc:
            return str(exc)
        return ""


# ---------------------------------------------------------------------------
# The pipeline run
# ---------------------------------------------------------------------------

def run_pipeline(engine: str, batch_id: str, policy: Path) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["HARROW_ROOT"] = str(ROOT)
    env["BATCH_ID"] = batch_id
    env["HARROW_POLICY"] = str(policy)
    env["HARROW_HMAC_KEY"] = HMAC_KEY
    env["HARROW_HMAC_KEY_REF"] = HMAC_KEY_REF
    env["PDFCRAFT_BIN"] = engine
    env["PATH"] = str(Path(engine).parent) + os.pathsep + env.get("PATH", "")
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return subprocess.run([sys.executable, str(SOLUTION)], env=env,
                          capture_output=True, text=True)


def read_manifest(batch_id: str) -> Dict[str, Any]:
    return json.loads((DISCOVERY / batch_id / "manifest.json").read_text(encoding="utf-8"))


def read_runlog(batch_id: str) -> List[Dict[str, Any]]:
    text = (DISCOVERY / batch_id / "run.log").read_text(encoding="utf-8")
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def seal_ok(manifest: Dict[str, Any]) -> bool:
    body = {k: v for k, v in manifest.items() if k != "signature"}
    envelope = manifest.get("signature") or {}
    expected = hmac.new(bytes.fromhex(HMAC_KEY), canonical(body).encode("utf-8"),
                        hashlib.sha256).hexdigest()
    return hmac.compare_digest(str(envelope.get("value", "")), expected)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    module = load_solution_module()
    engine = resolve_engine()

    # A clean slate, so the run is reproducible.
    if ROOT.exists():
        shutil.rmtree(str(ROOT))
    for folder in (INCOMING, WORKDIR, DISCOVERY / "0001", DISCOVERY / "0002"):
        folder.mkdir(parents=True, exist_ok=True)

    patterns = client_patterns()
    (DISCOVERY / "pii-extra.txt").write_text(
        "\n".join(["# Client-supplied PII patterns, one regular expression per line."]
                  + patterns) + "\n", encoding="utf-8")

    strict_policy = DISCOVERY / "policy.json"
    lenient_policy = DISCOVERY / "policy-lenient.json"
    base_policy = {
        "tenant": "harrow-vale",
        "pdfaLevel": "2b",
        "builtInPatterns": ["phone", "email", "credit-card", "ssn", "date"],
        "clientPatternFile": "discovery/pii-extra.txt",
        "signedPolicy": "manual_queue",
        "sandboxAttestation": True,
    }
    strict_policy.write_text(json.dumps(dict(base_policy, requireEmbeddedFonts=True),
                                        indent=2) + "\n", encoding="utf-8")
    lenient_policy.write_text(json.dumps(dict(base_policy, requireEmbeddedFonts=False),
                                         indent=2) + "\n", encoding="utf-8")

    # -- fixtures ---------------------------------------------------------
    command = [engine, "mcp", "--root", str(ROOT)]
    with SyncClient(module, command, ROOT) as client:
        build_pdf(client, module, "discovery/incoming/0001-disclosure.pdf", DISCLOSURE_PAGES)
        build_pdf(client, module, "discovery/incoming/0003-clean.pdf", CLEAN_PAGES)
        build_signed_pdf(client, module, "discovery/incoming/0002-signed.pdf", SIGNED_PAGES)

        outside = str((ROOT.parent / "__harness_probe__.pdf"))
        refusal = client.refused("doc_open", {"path": outside})
        check("engine_refuses_path_outside_root",
              "outside the allowed directory" in refusal, refusal)

    check("fixture_disclosure_exists", (INCOMING / "0001-disclosure.pdf").is_file())
    check("fixture_signed_exists", (INCOMING / "0002-signed.pdf").is_file())
    check("fixture_clean_exists", (INCOMING / "0003-clean.pdf").is_file())
    signed_before = sha256_file(INCOMING / "0002-signed.pdf")

    # -- the boundary itself ------------------------------------------------
    # PdfCraft's `mcp` only confines paths when it is given `--root`; the
    # `--automation-read-root` / `--automation-write-root` flags of the other
    # engines are silently ignored, so a server started without `--root` will
    # happily open a file outside the batch root.
    outsider = ROOT.parent / "outside-the-root.pdf"
    shutil.copyfile(str(INCOMING / "0001-disclosure.pdf"), str(outsider))
    with SyncClient(module, command, ROOT) as client:
        refused = client.refused("doc_open", {"path": str(outsider)})
        check("engine_with_root_refuses_outside_file",
              "outside the allowed directory" in refused, refused)
    with SyncClient(module, [engine, "mcp"], ROOT) as client:
        opened = client.call_sync("doc_open", {"path": str(outsider)})
        check("engine_without_root_is_not_confined",
              not opened.get("isError") and "outside the allowed directory" not in str(opened),
              str(opened)[:200])
    outsider.unlink()

    # -- the pipeline, twice: a strict batch and a lenient one ------------
    strict = run_pipeline(engine, "0001", strict_policy)
    check("strict_batch_exit_code", strict.returncode == 0,
          "rc=%s stderr=%s" % (strict.returncode, strict.stderr[-600:]))
    lenient = run_pipeline(engine, "0002", lenient_policy)
    check("lenient_batch_exit_code", lenient.returncode == 0,
          "rc=%s stderr=%s" % (lenient.returncode, lenient.stderr[-600:]))

    manifest = read_manifest("0001")
    runlog = read_runlog("0001")
    manifest_path = DISCOVERY / "0001" / "manifest.json"
    runlog_path = DISCOVERY / "0001" / "run.log"

    # -- the manifest ------------------------------------------------------
    required_keys = {"batchId", "startedAt", "finishedAt", "tenant", "pdfcraftVersion",
                     "items", "failures", "signature", "runLogSha256"}
    check("manifest_has_required_keys", required_keys.issubset(set(manifest)),
          str(sorted(required_keys - set(manifest))))
    check("manifest_batch_id", manifest.get("batchId") == "0001", str(manifest.get("batchId")))
    check("manifest_tenant", manifest.get("tenant") == "harrow-vale", str(manifest.get("tenant")))
    check("manifest_reports_engine_version",
          manifest.get("pdfcraftVersion", "").startswith("0."), str(manifest.get("pdfcraftVersion")))
    check("manifest_signature_alg",
          (manifest.get("signature") or {}).get("alg") == "HMAC-SHA256")
    check("manifest_signature_key_id",
          (manifest.get("signature") or {}).get("keyId") == HMAC_KEY_REF)
    check("manifest_signature_verifies", seal_ok(manifest))

    tampered = json.loads(json.dumps(manifest))
    tampered["items"][0]["sha256Output"] = ("0" if not tampered["items"][0]["sha256Output"].startswith("0")
                                            else "1") + tampered["items"][0]["sha256Output"][1:]
    check("manifest_tamper_is_detected", not seal_ok(tampered))

    reordered = json.loads(json.dumps(manifest))
    reordered["items"] = [dict(reversed(list(reordered["items"][0].items())))] + reordered["items"][1:]
    check("manifest_key_reordering_is_tolerated", seal_ok(reordered))

    check("runlog_digest_chained_into_manifest",
          manifest.get("runLogSha256") == sha256_file(runlog_path))

    # -- the run log -------------------------------------------------------
    log_fields = {"step", "metaTool", "args", "resultSummary", "timestamp"}
    check("runlog_entries_are_complete",
          bool(runlog) and all(log_fields.issubset(set(e)) for e in runlog),
          "%d entries" % len(runlog))
    check("runlog_timestamps_are_non_decreasing",
          all(runlog[i]["timestamp"] <= runlog[i + 1]["timestamp"] for i in range(len(runlog) - 1)))
    check("runlog_records_redact_mark",
          any(e["metaTool"] == "redact_mark" for e in runlog))
    apply_entries = [e for e in runlog if e["metaTool"] == "redact_apply"]
    check("runlog_records_redact_apply", bool(apply_entries))
    if apply_entries:
        applied_pages = apply_entries[0]["args"].get("pages")
        item = next(i for i in manifest["items"] if i["input"].endswith("0001-disclosure.pdf"))
        check("runlog_apply_is_scoped_to_marked_pages",
              applied_pages == item["redactedPages"], "%s vs %s" % (applied_pages, item["redactedPages"]))
    check("runlog_records_pdfa_verify", any(e["metaTool"] == "pdfa_verify" for e in runlog))
    check("runlog_records_pdfa_convert", any(e["metaTool"] == "pdfa_convert" for e in runlog))
    check("runlog_records_accessibility_report",
          any(e["metaTool"] == "accessibility_report" for e in runlog))
    check("runlog_records_sign_list", any(e["metaTool"] == "sign_list" for e in runlog))
    check("runlog_records_command_run",
          any(e["metaTool"] == "command_run" for e in runlog))
    sandbox_entries = [e for e in runlog if e["step"] == "sandbox_attestation"]
    check("runlog_records_sandbox_refusal",
          bool(sandbox_entries) and "outside the allowed directory" in
          json.dumps(sandbox_entries[0]["resultSummary"]),
          json.dumps(sandbox_entries[0])[:300] if sandbox_entries else "none")

    # -- the items ---------------------------------------------------------
    check("manifest_has_no_failures", manifest["failures"] == [], json.dumps(manifest["failures"])[:300])
    items = {item["input"].split("/")[-1]: item for item in manifest["items"]}
    check("manifest_item_count", len(manifest["items"]) == 2, str(sorted(items)))
    check("manifest_has_manual_queue", len(manifest["manualQueue"]) == 1,
          json.dumps(manifest["manualQueue"])[:300])

    disclosure = items.get("0001-disclosure.pdf")
    if disclosure is not None:
        check("item_lists_every_pattern",
              set(["phone", "email", "credit-card", "ssn", "date"]).issubset(
                  set(disclosure["piiPatternsApplied"])),
              str(disclosure["piiPatternsApplied"]))
        check("item_lists_client_patterns",
              set(patterns).issubset(set(disclosure["piiPatternsApplied"])),
              str(disclosure["piiPatternsApplied"]))
        check("item_redacted_pages", disclosure["redactedPages"] == [1, 2, 3, 4, 5],
              str(disclosure["redactedPages"]))
        check("item_mark_pages_match_engine_annotation",
              disclosure.get("markPagesMatch") is True,
              str(disclosure.get("markedPagesObserved")))
        check("item_engine_saw_a_mark_on_every_redacted_page",
              disclosure.get("markedPagesObserved") == [1, 2, 3, 4, 5],
              str(disclosure.get("markedPagesObserved")))
        check("item_counts_applied_marks",
              int(disclosure.get("appliedMarks") or 0) >= 7, str(disclosure.get("appliedMarks")))
        check("item_pdfa_pending", disclosure["pdfa"] == "PDFA_PENDING", str(disclosure["pdfa"]))
        check("item_records_font_issue",
              any("not embedded" in str(i.get("message", "")) for i in disclosure["pdfaVerify"]["issues"]),
              json.dumps(disclosure["pdfaVerify"]["issues"])[:300])
        check("item_review_deliverable_exists",
              (ROOT / disclosure["reviewDeliverable"]).is_file()
              if disclosure.get("reviewDeliverable") else False)
        check("item_accessibility_report_exists",
              (ROOT / disclosure["accessibilityReport"]).is_file())
        check("item_accessibility_report_is_html",
              (ROOT / disclosure["accessibilityReport"]).stat().st_size > 0)
        check("item_output_sha256_matches_disk",
              disclosure["sha256Output"] == sha256_file(ROOT / disclosure["converted"]))
        check("item_output_exists", (ROOT / disclosure["converted"]).is_file())

    clean = items.get("0003-clean.pdf")
    if clean is not None:
        check("clean_item_has_no_marks", clean["redactedPages"] == [], str(clean["redactedPages"]))
        check("clean_item_records_no_match",
              len(clean.get("patternNotes") or []) == 5, str(clean.get("patternNotes"))[:300])

    manual = manifest["manualQueue"][0] if manifest["manualQueue"] else {}
    check("manual_queue_names_the_signed_file",
          manual.get("input", "").endswith("0002-signed.pdf"), str(manual.get("input")))
    signatures = manual.get("signatures") or []
    check("manual_queue_reports_signature_status",
          bool(signatures) and signatures[0].get("status") in ("valid", "unknown", "invalid"),
          json.dumps(signatures)[:300])
    check("manual_queue_reports_signature_revision",
          bool(signatures) and isinstance(signatures[0].get("revision"), int),
          json.dumps(signatures)[:300])
    check("manual_queue_reports_signature_modification",
          bool(signatures) and signatures[0].get("modification") in ("none", "allowed", "disallowed"),
          json.dumps(signatures)[:300])
    check("signed_input_is_untouched",
          sha256_file(INCOMING / "0002-signed.pdf") == signed_before)

    # -- the artefacts, read back through the engine -----------------------
    with SyncClient(module, command, ROOT) as client:
        if disclosure is not None:
            opened = client.call_sync("doc_open", {"path": disclosure["converted"]})
            doc = int(opened["doc"])
            extracted = client.call_sync("text_extract", {"doc": doc})
            text = "\n".join(p.get("text", "") for p in extracted.get("pages") or [])
            for secret in PII_STRINGS:
                check("redacted_output_hides_%s" % re.sub(r"[^a-z0-9]+", "_", secret.lower()).strip("_"),
                      secret not in text, repr(text[:200]))
            check("redacted_output_keeps_benign_text", BENIGN_STRING in text, repr(text[:300]))
            verify = client.call_sync("pdfa_verify", {"doc": doc, "level": "2b"})
            check("engine_verifies_output_pdfa", bool(verify.get("compliant")),
                  json.dumps(verify)[:300])
            a11y = client.call_sync("accessibility_check", {"doc": doc})
            check("engine_reports_accessibility", "results" in a11y, json.dumps(a11y)[:200])
            client.call_sync("doc_close", {"doc": doc})

        signed_opened = client.call_sync("doc_open", {"path": "discovery/incoming/0002-signed.pdf"})
        signed_doc = int(signed_opened["doc"])
        signed_list = client.call_sync("sign_list", {"doc": signed_doc})
        check("engine_still_sees_the_signature", int(signed_list.get("count") or 0) == 1,
              json.dumps(signed_list)[:300])
        signed_text = client.call_sync("text_extract", {"doc": signed_doc})
        signed_body = "\n".join(p.get("text", "") for p in signed_text.get("pages") or [])
        check("signed_input_was_not_redacted", "(555) 987-6543" in signed_body, repr(signed_body[:200]))
        client.call_sync("doc_close", {"doc": signed_doc})

    # -- sealing ------------------------------------------------------------
    check("manifest_is_read_only", (manifest_path.stat().st_mode & 0o777) == 0o444,
          oct(manifest_path.stat().st_mode & 0o777))
    check("runlog_is_read_only", (runlog_path.stat().st_mode & 0o777) == 0o444,
          oct(runlog_path.stat().st_mode & 0o777))

    # -- the lenient batch --------------------------------------------------
    lenient_manifest = read_manifest("0002")
    lenient_items = {i["input"].split("/")[-1]: i for i in lenient_manifest["items"]}
    check("lenient_manifest_signature_verifies", seal_ok(lenient_manifest))
    lenient_disclosure = lenient_items.get("0001-disclosure.pdf")
    if lenient_disclosure is not None:
        check("lenient_item_is_verified", lenient_disclosure["pdfa"] == "VERIFIED",
              str(lenient_disclosure["pdfa"]))
        check("lenient_item_has_no_review_deliverable",
              not lenient_disclosure.get("reviewDeliverable"),
              str(lenient_disclosure.get("reviewDeliverable")))
    check("lenient_batch_has_same_redacted_pages",
          lenient_disclosure is not None and
          lenient_disclosure["redactedPages"] == [1, 2, 3, 4, 5],
          str(lenient_disclosure.get("redactedPages")) if lenient_disclosure else "missing")

    # -- no bytecode caches left behind -------------------------------------
    for cache in FILES.rglob("__pycache__"):
        shutil.rmtree(str(cache), ignore_errors=True)


    # --- publish the headline artefacts next to the harness log ------------
    publish = ROOT.parent
    for source, name in (
        (ROOT / "discovery" / "0001" / "manifest.json", "0001.manifest.json"),
        (ROOT / "discovery" / "0001" / "work" / "0001-disclosure.pdf", "0001-disclosure.redacted.pdf"),
        (ROOT / "discovery" / "0002" / "manifest.json", "0002.manifest.json"),
        (ROOT / "discovery" / "0002" / "work" / "0003-clean.pdf", "0003-clean.pdf"),
        (ROOT / "discovery" / "0001" / "work" / "0001-disclosure.review.docx", "0001-review.docx"),
    ):
        target = publish / name
        if target.exists():
            target.chmod(0o644)
            target.unlink()
        shutil.copy2(source, target)

    print("%d assertions passed" % len(PASSED))
    if FAILED:
        for label, detail in FAILED:
            print("FAILED %s %s" % (label, detail))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
