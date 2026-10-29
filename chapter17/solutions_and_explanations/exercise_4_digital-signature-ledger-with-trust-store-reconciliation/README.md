# 17. Exercise 4: Digital Signature Ledger — solution

The worked trust-store reconciliation. Two signed advisories are inspected,
the corporate root is pinned, a tampered file is flagged, and the ledger is
assembled, sealed and made idempotent by its Merkle root.

## What it does

1. `sign_id_create` makes the advisor identity; two advisories are signed
   with it.
2. `sign_verify` inspects both documents and records fingerprints, validity
   and revision numbers.
3. The pinned corporate root is extracted with `sign_trust_export`, added to
   the trust store once, and the exact fingerprint and reason are logged.
4. A deliberately tampered copy is flagged while the untouched document stays
   valid.
5. A divergence report is written for the modified document.
6. The ledger PDF is built from the manifest and sealed; the Merkle root is
   stored in `ledger_last_merkle.json`.
7. A second run with an unchanged root returns `{"status":"noop",
   "reason":"merkle_unchanged"}` and does not rewrite the ledger.

## Run it

```bash
cd chapter17/solutions_and_explanations/exercise_4_digital-signature-ledger-with-trust-store-reconciliation/files
PY=$("../../../../tools/pick_python.sh")
"$PY" run_ex4.py
```

```
19 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/signature-ledger.pdf` | the sealed trust ledger |
| `output/signature-ledger.manifest.json` | per-document status, fingerprints, trust event and ledger signature |
| `output/ledger_last_merkle.json` | the Merkle root used for the no-op check |
| `output/work/repo/` | the signed advisories |
| `output/work/out/advisory-002.diff.txt` | the tamper divergence report |
| `output/work/out/trust_inbox/pin-0000.pem` | the extracted corporate root |
| `output/run_ex4.log` | shell-captured harness log |

## The listings

| file | what it is |
| --- | --- |
| `files/04_digital-signature-ledger-with-trust-store-reconciliation.py` | signing, verification, trust reconciliation, Merkle ledger and idempotency |
| `files/run_ex4.py` | the real-engine acceptance harness |

## Notes

- The trust event is logged with the full SHA-256 fingerprint
  `C0 BB A9 … 4C 7B` and `reason: pinned_corporate_root`.
- Tampering flips one file's status while the other remains valid; the report
  is per document, not a global pass/fail.
- The no-op is driven by the Merkle root, so a changed corpus produces a new
  ledger.
- Type-check equivalent: `python3 -m py_compile` on both Python files.
