# 17. Exercise 2: Agentic PII Redaction & Compliance Audit — solution

The worked PII pipeline. The agent bootstraps its command surface from
`command_list`, redacts every identifying value from the intake scans, and
quarantines near-matches for a human instead of sealing a guess.

## What it does

1. `bootstrap_toolchain()` discovers PdfCraft's commands and writes
   `toolchain.json` once; reruns reuse it.
2. `process_scan()` extracts text, records `doc_info` and `doc_hidden_info`,
   then marks SSN, phone and credit-card patterns without `whole_pages`.
3. MRN and DOB values are anchored to their labels with `text_find` and
   `redact_mark` rectangles.
4. Patient names are found from the lookup table. A token within Levenshtein
   distance 2 of a name (`Alice ≈ Alicia`) is **not** redacted: the scan is
   marked `review_required`, recorded in `suspected_matches`, and kept out of
   the sealed batch.
5. Marks are applied page by page, residual value regexes are re-run, hidden
   categories are removed and the PDF is checked against the PDF/A gate.
6. Clean scans are combined into `AUDITOR_SUBMISSION.pdf`; quarantined scans
   are combined into `EXCEPTIONS.pdf`.

## Run it

```bash
cd chapter17/solutions_and_explanations/exercise_2_agentic-pii-redaction-regulatory-compliance-audit/files
PY=$("../../../../tools/pick_python.sh")
"$PY" run_ex2.py
```

```
24 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/AUDITOR_SUBMISSION.pdf` | the sealed, redacted, PDF/A-clean submission |
| `output/EXCEPTIONS.pdf` | the quarantine bundle for human review |
| `output/scan-0001.redacted.pdf` | the clean redacted scan |
| `output/scan-0001.audit.json`, `scan-0002.audit.json` | per-scan compliance dossiers |
| `output/toolchain.json` | the discovered command signatures |
| `output/_run_summary.json` | sealed/review totals |
| `output/work/in/`, `output/work/out/` | source scans and all intermediate files |
| `output/run_ex2.log` | shell-captured harness log |

## The listings

| file | what it is |
| --- | --- |
| `files/02_agentic-pii-redaction-regulatory-compliance-audit.py` | MCP client, bootstrap, redaction, near-match rule, verification and batch |
| `files/run_ex2.py` | the real-engine acceptance harness |
| `files/mcp_client.py` | the small MCP-over-stdio helper used to author the fixtures |

## Notes

- The near-match rule deliberately compares **words**: `Alice`→`Alicia` and
  `Nguyen`→`Nguyne` are flagged, not redacted.
- The residual check looks for values (`123-45-6789`, `(010) 010-0100`), not
  for the non-identifying labels `SSN:` or `MRN:`.
- The fixtures are authored by WordCraft so the fonts are embedded; a
  base-14 Helvetica PDF cannot pass the PDF/A gate.
- Type-check equivalent: `python3 -m py_compile` on both Python files.
