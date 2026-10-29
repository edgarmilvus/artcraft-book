# =====================================================================
# Exercise 4 — Digital Signature Ledger with Trust-Store Reconciliation
#
# The pipeline discovers the signing identities, reconciles the trust
# store, re-verifies every signed PDF in the repository, and assembles a
# sealed ledger. A Merkle root over the repository makes a rerun a no-op.
# =====================================================================
from __future__ import annotations
import hashlib, json, os, platform, subprocess
from pathlib import Path
from typing import Any

REPO     = Path(os.environ.get("LEDGER_REPO",  "/work/repo"))
OUT      = Path(os.environ.get("LEDGER_OUT",   "/work/ledger-out"))
# PdfCraft's `--root` takes one directory, so the session is rooted at the
# job's work root and the pipeline's own policy keeps the writes in `out`.
ROOT     = Path(os.environ.get("LEDGER_ROOT",  str(OUT.parent)))
PIN_FILE = Path(os.environ.get("LEDGER_PINS",  "/etc/studio/trust-pins.pem"))
VAULT    = Path(os.environ.get("LEDGER_VAULT", "/etc/studio/vault"))
LEDGER   = OUT / "signature-ledger.pdf"
MANIFEST = OUT / "signature-ledger.manifest.json"
MERKLE   = OUT / "ledger_last_merkle.json"

# ---- minimal MCP driver -------------------------------------------------
class Mcp:
    """MCP over stdio: JSON-RPC 2.0, one frame per line."""

    def __init__(self, argv: list[str]):
        self.p = subprocess.Popen(argv, stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL,
                                  text=True, bufsize=1)
        self._id = 0

    def handshake(self) -> None:
        self._rpc("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "signature-ledger", "version": "1.0.0"},
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


# ---- hashing / merkle ---------------------------------------------------
def sha256_of(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()

def merkle_root(leaves: dict[str, str]) -> str:
    """Deterministic Merkle root over {path → sha256} pairs, sorted by path."""
    if not leaves:
        return hashlib.sha256(b"empty").hexdigest()
    layer = [hashlib.sha256(f"{p}\x00{h}".encode()).hexdigest()
             for p, h in sorted(leaves.items())]
    while len(layer) > 1:
        if len(layer) % 2:
            layer.append(layer[-1])
        layer = [hashlib.sha256((layer[i] + layer[i + 1]).encode()).hexdigest()
                 for i in range(0, len(layer), 2)]
    return layer[0]

# ---- 1) Identity discovery ---------------------------------------------
def discover_identities(pc: Mcp) -> dict:
    """Find every signing identity the machine can offer."""
    sysname = platform.system()
    if sysname == "Darwin":
        # `sign_keychain_ids` answers with `{"count": n, "ids": [...]}`.
        ids = pc.call("sign_keychain_ids", {}) or {}
        found = ids.get("ids", []) or []
        return {"platform": "darwin", "identity_source": "keychain",
                "count": ids.get("count", len(found)),
                "identities": found}
    if sysname == "Windows":
        ids = pc.call("sign_windows_ids", {}) or {}
        found = ids.get("ids", []) or []
        return {"platform": "windows", "identity_source": "windows_store",
                "count": ids.get("count", len(found)),
                "identities": found}
    # Linux / CI: fall back to a well-known p12 vault.
    p12s = sorted(list(VAULT.glob("*.p12")) + list(VAULT.glob("*.pfx")))
    return {"platform": "linux", "identity_source": "p12_vault",
            "count": len(p12s), "paths": [str(p) for p in p12s]}

# ---- 2) Trust reconciliation -------------------------------------------
def fingerprint_set(trust_result: Any) -> set[str]:
    items = trust_result.get("trusted", []) if isinstance(trust_result, dict) else []
    out = set()
    for i in items:
        if isinstance(i, dict):
            out.add(i.get("fingerprint") or i.get("sha256") or json.dumps(i, sort_keys=True))
        else:
            out.add(str(i))
    return out

def trust_reconcile(pc: Mcp, repo_pdfs: list[Path]) -> tuple[set[str], set[str], list[dict]]:
    """Reconcile the trust store with the pinned corporate roots.

    The certificates seen on the repository's signatures are recorded by
    fingerprint — `sign_list` reports a certificate *descriptor*, not a
    PEM, so it cannot be re-imported. Only the pinned roots, which are
    real PEM files, can be added to the store.
    """
    observed: set[str] = set()
    for pdf in repo_pdfs:
        opened = pc.call("doc_open", {"path": str(pdf)})
        sigs = (pc.call("sign_list", {"doc": opened["doc"]}) or {}).get("signatures", [])
        for s in sigs:
            cert = s.get("certificate") or {}
            fp = cert.get("sha256") if isinstance(cert, dict) else None
            if fp:
                observed.add(fp)
        pc.call("doc_close", {"doc": opened["doc"], "discard_changes": True})

    pins = _split_pem_certs(PIN_FILE.read_text()) if PIN_FILE.exists() else []

    # Snapshot the pre-state.
    before = fingerprint_set(pc.call("sign_trust", {}))

    # Materialise the pinned roots as individual PEM files and add them.
    inbox = OUT / "trust_inbox"
    inbox.mkdir(parents=True, exist_ok=True)
    paths: list[str] = []
    for i, pem in enumerate(pins):
        p = inbox / f"pin-{i:04d}.pem"
        p.write_text(pem)
        paths.append(str(p))
    if paths:
        pc.call("sign_trust", {"paths": paths})     # never `clear: true`!

    after = fingerprint_set(pc.call("sign_trust", {}))
    events = [{"event": "trust_added", "fingerprint": fp,
               "reason": "pinned_corporate_root"}
              for fp in sorted(after - before)]
    return before, after, events, observed

def _split_pem_certs(pem_text: str) -> list[str]:
    """Extract the individual PEM blocks from a bundle file."""
    out, cur, inside = [], [], False
    for line in pem_text.splitlines(keepends=True):
        if "-----BEGIN CERTIFICATE-----" in line:
            inside = True
        if inside:
            cur.append(line)
        if "-----END CERTIFICATE-----" in line:
            inside = False
            out.append("".join(cur))
            cur = []
    return out

# ---- 3) Verification loop ----------------------------------------------
def classify(sig: dict, trust_ready: bool) -> str:
    """`status` and `modification` are the two fields that decide.

    `modification` is the engine's name for what the exercise calls
    `changes_after_signing`: "none", "allowed" or "disallowed".
    """
    st = sig.get("status")
    ch = sig.get("modification")
    if st == "invalid" or ch == "disallowed":
        return "invalid"
    if st == "valid" and ch in ("none", "allowed"):
        return "valid"
    if st == "unknown":
        return "verified_untrusted" if trust_ready else "unknown_pending"
    return "verified_untrusted"

def page_text(pc: Mcp, doc_id: int) -> str:
    extracted = pc.call("text_extract", {"doc": doc_id}) or {}
    return "\n".join(p.get("text", "") for p in extracted.get("pages", []))

def divergence_for(pc: Mcp, doc_id: int, pdf_path: Path) -> dict | None:
    """Replay the divergence: last revision, byte length, text diff."""
    revs = (pc.call("doc_revisions", {"doc": doc_id}) or {}).get("revisions", [])
    if not revs:
        return None
    last = revs[-1]
    snapshot = pc.call("doc_open_revision", {"doc": doc_id, "revision": last["revision"]})
    snapshot_doc = (snapshot or {}).get("doc")
    text_snapshot = page_text(pc, snapshot_doc) if snapshot_doc else ""
    text_head = page_text(pc, doc_id)
    diff_path = OUT / f"{pdf_path.stem}.diff.txt"
    diff_path.write_text(
        f"===(revision {last['revision']})===\n{text_head}\n---\n{text_snapshot}")
    if snapshot_doc:
        pc.call("doc_close", {"doc": snapshot_doc, "discard_changes": True})
    return {"revision_number": last["revision"],
            "bytes_added": last.get("bytes", 0),
            "text_diff_report_path": str(diff_path)}

def verify_all(pc: Mcp, repo_pdfs: list[Path], trust_ready: bool) -> list[dict]:
    results: list[dict] = []
    for pdf in repo_pdfs:
        opened = pc.call("doc_open", {"path": str(pdf)})
        doc_id = opened["doc"]
        sigs = (pc.call("sign_list", {"doc": doc_id}) or {}).get("signatures", [])
        for sig in sigs:
            cls = classify(sig, trust_ready=trust_ready)
            div = divergence_for(pc, doc_id, pdf) if cls == "invalid" else None
            results.append({"path": str(pdf), "signature": sig,
                            "verification_status": cls, "divergence": div})
        pc.call("doc_close", {"doc": doc_id, "discard_changes": True})
    return results

# ---- 4) Ledger assembly -------------------------------------------------
def build_ledger(pc: Mcp, entries: list[dict], signing_id: str,
                 signing_password: str) -> dict:
    created = pc.call("doc_create", {"from": "blank", "pages": 1}) or {}
    doc_id = created.get("doc")
    page = 1
    y = 72
    for e in entries:
        # The standard fonts cannot draw an arrow, so the window is written
        # with ASCII.
        hdr = (f"{e['subject_cn']}  |  {e['certificate_fingerprint'][:16]}...  |  "
               f"{e['valid_from']} to {e['valid_to']}")
        pc.call("page_add_text", {"doc": doc_id, "page": page, "text": hdr,
                                  "at": [72, y], "size": 10})
        y += 16
        for sd in e["signed_documents"]:
            row = f"    {sd['path']}  [{sd['verification_status']}]"
            pc.call("page_add_text", {"doc": doc_id, "page": page, "text": row,
                                      "at": [90, y], "size": 9})
            # A sticky note carries the fingerprint. The `Graph` icon
            # belongs to the *attachment* type, so a note uses `Note`.
            pc.call("comment_add", {"doc": doc_id, "page": page, "type": "note",
                                    "at": [540, y], "icon": "Note",
                                    "contents": f"Certificate fingerprint: {e['certificate_fingerprint']}"})
            y += 14
            if y > 720:
                page += 1
                pc.call("page_insert_blank", {"doc": doc_id, "at": page})
                y = 72

    pc.call("pdfa_convert", {"doc": doc_id, "level": "3b"})
    sealed = pc.call("sign_document", {
        "doc": doc_id,
        "id": signing_id,
        "password": signing_password,
        "out": str(LEDGER),
        "certify": "form_fill",            # auditor can annotate, not modify
        "reason": "Quarterly Signature Ledger",
    })
    pc.call("doc_close", {"doc": doc_id, "discard_changes": True})
    return sealed or {}

# ---- 5) Driver ----------------------------------------------------------
def main() -> dict:
    OUT.mkdir(parents=True, exist_ok=True)
    repo_pdfs = sorted(REPO.rglob("*.pdf"))

    # Idempotency: Merkle root over {path → sha256}.
    digests = {str(p): sha256_of(p) for p in repo_pdfs}
    root = merkle_root(digests)
    if MERKLE.exists() and json.loads(MERKLE.read_text()).get("merkle") == root:
        print(json.dumps({"status": "noop", "reason": "merkle_unchanged", "root": root}))
        return {"status": "noop", "merkle": root}

    signing_id = os.environ.get("LEDGER_SIGNING_ID", "")
    signing_password = os.environ.get("LEDGER_SIGNING_PASSWORD", "")

    pc = open_pdfcraft()
    try:
        identity_disc = discover_identities(pc)
        before, after, events, observed = trust_reconcile(pc, repo_pdfs)
        for e in events:
            print(json.dumps(e))

        raw_results = verify_all(pc, repo_pdfs, trust_ready=True)

        # Assemble ledger entries grouped by certificate fingerprint.
        by_cert: dict[str, dict] = {}
        for r in raw_results:
            sig = r["signature"]
            cert = sig.get("certificate") or {}
            fingerprint = (cert.get("sha256") if isinstance(cert, dict) else None) or "unknown"
            entry = by_cert.setdefault(fingerprint, {
                "certificate_fingerprint": fingerprint,
                "subject_cn": sig.get("signer") or cert.get("name", "unknown"),
                "issuer_cn": cert.get("issuer", "unknown"),
                "valid_from": cert.get("valid_from", ""),
                "valid_to": cert.get("valid_to", ""),
                "signed_documents": [],
            })
            entry["signed_documents"].append({
                "path": r["path"],
                "sha256_at_signature": fingerprint,
                "sha256_current": sha256_of(Path(r["path"])),
                "revisions_since_signature": sig.get("revision", 0),
                "verification_status": r["verification_status"],
                "divergence": r["divergence"],
            })

        sealed = build_ledger(pc, list(by_cert.values()), signing_id, signing_password)

        manifest = {
            "platform": identity_disc["platform"],
            "identity_source": identity_disc["identity_source"],
            "identity_count": identity_disc["count"],
            "repository_merkle": root,
            "observed_fingerprints": sorted(observed),
            "trust_before": sorted(before),
            "trust_after": sorted(after),
            "trust_events": events,
            "inspected_files": [str(p) for p in repo_pdfs],
            "verification": [
                {"path": r["path"],
                 "status": r["verification_status"],
                 "revision": r["signature"].get("revision"),
                 "modification": r["signature"].get("modification")}
                for r in raw_results
            ],
            "ledger_signature": sealed,
        }
        MANIFEST.write_text(json.dumps(manifest, indent=2))
        MERKLE.write_text(json.dumps({"merkle": root}))
        return manifest
    finally:
        pc.close()

if __name__ == "__main__":
    main()
