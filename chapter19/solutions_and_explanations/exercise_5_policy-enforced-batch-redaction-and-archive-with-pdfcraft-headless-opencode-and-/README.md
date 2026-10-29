# 19. Exercise 5: Policy-Enforced Batch Redaction — solution

The worked Harrow & Vale discovery pipeline. A folder of mismatched PDFs is
converted, redacted under a client policy, checked for accessibility, archived
and signed with a tamper-evident audit trail.

## What it does

1. Reads the client PII policy and compiles the extra patterns.
2. For each PDF, converts to a redaction-safe PDF, marks every matching value
   (SSN, phone, card, email, dates, matter numbers), applies the marks and
   verifies that none survive.
3. Signed inputs are never modified: a signed document is routed to the manual
   queue with its signature status and revision, and the original bytes stay
   untouched.
4. Runs the PDF/A gate and the accessibility report; an accessibility failure
   does not silently pass — it is recorded per item.
5. Writes per-batch manifests and run logs as read-only files, signs the
   manifest, and supports a lenient policy that produces the same redacted
   pages without a review deliverable.
6. A clean input passes with no marks; a signed input is queued; the lenient
   batch verifies.

## Run it

```bash
cd chapter19/solutions_and_explanations/exercise_5_policy-enforced-batch-redaction-and-archive-with-pdfcraft-headless-opencode-and-/files
PY=$("../../../../tools/pick_python.sh")
"$PY" run_ex5.py
```

```
71 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/0001.manifest.json` | the first batch: item verdicts, mark counts, PDF/A and accessibility |
| `output/0001-disclosure.redacted.pdf` | the redacted disclosure |
| `output/0001-review.docx` | the review deliverable for the manual queue |
| `output/0002.manifest.json` | the second batch, including the signed input |
| `output/0003-clean.pdf` | the clean, unmarked input |
| `output/work/discovery/0001/`, `0002/` | incoming PDFs, run logs and all redacted outputs |
| `output/run_ex5.log` | shell-captured harness log |

## The listings

| file | what it is |
| --- | --- |
| `files/05_policy-enforced-batch-redaction-and-archive-with-pdfcraft-headless-opencode-and-a-signed-audit-trail.py` | policy, conversion, marking, verification, manifests and signing |
| `files/run_ex5.py` | the real-engine acceptance harness |
| `files/01_jsonc.jsonc` … `04_jsonc.jsonc` | policy, accessibility and manifest contracts |

## Notes

- Redaction is checked against the values, not the labels: the output may
  still say `SSN:` but not `123-45-6789`.
- A signed file is archived, never re-signed or redacted; the manual queue
  names it and its signature revision.
- Manifests and run logs are written read-only and the HMAC is verified by the
  harness.
- Type-check equivalent: `python3 -m py_compile` on the module and harness.
