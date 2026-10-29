# =====================================================================
# run_ex4.py — deterministic harness for the exercise 4 solution.
#
# The solution runs for real: two signed documents are inspected, the
# trust store is reconciled with the pinned corporate root, the ledger is
# assembled and sealed, and the manifest is written.
# =====================================================================
from __future__ import annotations
import importlib.util, json, os, shutil, subprocess, sys
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
        "ex4_solution", HERE / "04_digital-signature-ledger-with-trust-store-reconciliation.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def main() -> None:
    if WORK.exists():
        shutil.rmtree(WORK)
    REPO = WORK / "repo"
    OUT = WORK / "out"
    REPO.mkdir(parents=True)
    OUT.mkdir(parents=True)

    os.environ["LEDGER_REPO"] = str(REPO)
    os.environ["LEDGER_OUT"] = str(OUT)
    os.environ["LEDGER_ROOT"] = str(WORK)
    os.environ["LEDGER_PINS"] = str(WORK / "trust-pins.pem")
    os.environ["LEDGER_VAULT"] = str(WORK / "vault")

    solution = load_solution()

    # --- the signing identity ---------------------------------------------
    identity = WORK / "advisor.p12"
    password = "harness-ledger-password"
    pc = solution.open_pdfcraft()
    try:
        pc.call("sign_id_create", {
            "name": "Advisor Signing Authority",
            "password": password,
            "path": str(identity),
            "organization": "Harbour Trust",
            "country": "US",
            "email": "advisor@harbourtrust.example",
        })
        ok("the advisor identity was created", identity.exists())

        # --- the signed repository ----------------------------------------
        for stem, body in (("advisory-001", "Advisory note one."),
                           ("advisory-002", "Advisory note two.")):
            pc.call("doc_create", {"from": "text", "text": body, "name": stem})
            pc.call("doc_save", {"doc": 1, "path": str(REPO / f"{stem}.pdf"),
                                 "full": True})
            pc.call("doc_open", {"path": str(REPO / f"{stem}.pdf")})
            pc.call("sign_document", {
                "doc": 2, "id": str(identity), "password": password,
                "out": str(REPO / f"{stem}.pdf"),
                "reason": "Advisory signature",
            })
    finally:
        pc.close()
    ok("two signed documents exist",
       (REPO / "advisory-001.pdf").exists() and (REPO / "advisory-002.pdf").exists())

    # --- the pinned corporate root -----------------------------------------
    pem = subprocess.run(
        ["openssl", "pkcs12", "-in", str(identity), "-nokeys",
         "-passin", f"pass:{password}", "-out", str(WORK / "trust-pins.pem")],
        capture_output=True, text=True, check=True)
    ok("the trust pin was extracted", (WORK / "trust-pins.pem").exists())

    # --- one document is modified after its signature -----------------------
    pc = solution.open_pdfcraft()
    try:
        pc.call("doc_open", {"path": str(REPO / "advisory-002.pdf")})
        pc.call("page_add_text", {"doc": 1, "page": 1, "text": "TAMPERED",
                                  "at": [72, 700], "size": 12})
        pc.call("doc_save", {"doc": 1, "full": False})
    finally:
        pc.close()

    os.environ["LEDGER_SIGNING_ID"] = str(identity)
    os.environ["LEDGER_SIGNING_PASSWORD"] = password

    # --- the run ------------------------------------------------------------
    manifest = solution.main()

    # --- the manifest -------------------------------------------------------
    ok("the manifest was written", (OUT / "signature-ledger.manifest.json").exists())
    ok("the platform was recorded", manifest["platform"] in ("darwin", "linux", "windows"))
    ok("the identity source was recorded", bool(manifest["identity_source"]))
    ok("both files were inspected", len(manifest["inspected_files"]) == 2,
       json.dumps(manifest["inspected_files"]))
    ok("the merkle root was recorded", len(manifest["repository_merkle"]) == 64)
    ok("the observed fingerprints were recorded",
       len(manifest["observed_fingerprints"]) >= 1)
    ok("the trust store grew by the pinned root",
       len(manifest["trust_after"]) > len(manifest["trust_before"]),
       json.dumps([manifest["trust_before"], manifest["trust_after"]]))
    ok("the trust event was logged",
       any(e["event"] == "trust_added" for e in manifest["trust_events"]))

    # --- the verification verdicts ------------------------------------------
    statuses = {v["path"]: v["status"] for v in manifest["verification"]}
    tampered = str(REPO / "advisory-002.pdf")
    untouched = str(REPO / "advisory-001.pdf")
    ok("the tampered document is flagged", statuses.get(tampered) == "invalid",
       json.dumps(statuses))
    ok("the untouched document is valid", statuses.get(untouched) == "valid",
       json.dumps(statuses))
    diffs = list(OUT.glob("advisory-002.diff.txt"))
    ok("a divergence report was written", len(diffs) == 1, str(diffs))

    # --- the ledger ---------------------------------------------------------
    ledger = OUT / "signature-ledger.pdf"
    ok("the ledger was written", ledger.exists())
    ok("the ledger is a PDF", ledger.read_bytes()[:5] == b"%PDF-")

    # --- the tampered document is flagged -----------------------------------
    pc = solution.open_pdfcraft()
    try:
        opened = pc.call("doc_open", {"path": str(ledger)})
        sigs = pc.call("sign_list", {"doc": opened["doc"]})
        ok("the ledger is sealed", sigs.get("count", 0) == 1, json.dumps(sigs)[:200])
    finally:
        pc.close()

    # --- the idempotency rule ----------------------------------------------
    before = (OUT / "signature-ledger.pdf").read_bytes()
    second = solution.main()
    ok("the second run is a no-op", second.get("status") == "noop", json.dumps(second)[:200])
    after = (OUT / "signature-ledger.pdf").read_bytes()
    ok("the ledger was not rewritten", before == after)

    publish = HERE.parent / "output"
    for name in ("signature-ledger.pdf", "signature-ledger.manifest.json", "ledger_last_merkle.json"):
        shutil.copy2(OUT / name, publish / name)

    print(f"\n{passed} assertions passed")


if __name__ == "__main__":
    main()
