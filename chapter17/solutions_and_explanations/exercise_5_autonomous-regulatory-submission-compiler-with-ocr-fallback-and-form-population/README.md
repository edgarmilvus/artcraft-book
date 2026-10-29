# 17. Exercise 5: Autonomous Regulatory Submission Compiler — solution

The worked three-regulator compiler. One dossier is assembled from WordCraft
templates and certificates, then compiled into FDA CDRH, EU MDR and Health
Canada variants with form maps, OCR fallback and diff reports.

## What it does

1. The submission bundle is built from `cover_memo.docx`,
   `device_description.docx`, two certificate PDFs and the AcroForm safety
   sheet.
2. `open_wordcraft()` / `open_pdfcraft()` drive the two engines over MCP.
3. Each variant is compiled from the same source: regulator cover, device
   description, certificates, form population and a safety form.
4. The form map reports every mapped field and flags the intentionally
   unmapped field as incomplete rather than silently dropping it.
5. Certificate ingestion tries text extraction first; a readable certificate
   is skipped, a blank scan falls back to OCR (`cert-002.pdf → "ocr"`).
6. Every variant passes the PDF/A gate and carries a SHA-256.
7. The FDA variant is the baseline; EU MDR and Health Canada get
   `diff` reports whose observed change counts match the intended counts.

## Run it

```bash
cd chapter17/solutions_and_explanations/exercise_5_autonomous-regulatory-submission-compiler-with-ocr-fallback-and-form-population/files
PY=$("../../../../tools/pick_python.sh")
"$PY" run_ex5.py
```

```
33 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/FDA_CDRH.pdf` | the FDA submission |
| `output/EU_MDR.pdf` | the EU MDR submission |
| `output/HC_CA.pdf` | the Health Canada submission |
| `output/submission.manifest.json` | three variants, hashes, form maps, OCR actions and diff paths |
| `output/work/out/EU_MDR.diff.pdf`, `HC_CA.diff.pdf` | the variant comparisons |
| `output/work/submission/` | templates, certificates, form field map and variant specs |
| `output/run_ex5.log` | shell-captured harness log |

## The listings

| file | what it is |
| --- | --- |
| `files/05_autonomous-regulatory-submission-compiler-with-ocr-fallback-and-form-population.py` | bundle assembly, variant compiler, form population, OCR fallback and diffs |
| `files/run_ex5.py` | the real-engine acceptance harness |

## Notes

- The unmapped field is surfaced in the form map and in every variant's audit;
  it is not treated as a silent success.
- OCR is a fallback, not a blanket pass: the readable certificate is skipped
  and only the blank scan goes to OCR.
- The diff counts are compared with the variant spec, so a formatting-only or
  missed change fails the run.
- Type-check equivalent: `python3 -m py_compile` on both Python files.
