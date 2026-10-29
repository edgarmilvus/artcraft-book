# Chapter 17 — Headless Office Pipelines - Programmatic DOCX Generation and PDF Governance with WordCraft & PdfCraft

The chapter drives WordCraft and PdfCraft over MCP: it authors a DOCX from
structured data, exports a PDF, and then governs that PDF — metadata,
watermark, redaction, sanitization, protection, signature — into an audited,
sealed artifact.

## The projects

Each project has its own README with the command to run it and the
artifacts it writes.

| project | what it is |
| --- | --- |
| [Advanced Application Implementation](advanced_application_implementation/example/) | A headless office pipeline that turns a vendor's structured data into a governed, watermarked, redacted and cryptographically signed PDF, with no… |
| [Basic Code Example](basic_code_example/example/) | A complete headless office pipeline behind one HTTP handler: a SaaS billing service turns a validated statement payload into a DOCX and a… |
| [Solution — Exercise 1](solutions_and_explanations/exercise_1_contract-lifecycle-compiler-nightly-crm-engagement-letter-sealing/) | The worked nightly compiler: three-tier assets, DOCX/PDF seal, revisions and signed audits. |
| [Solution — Exercise 2](solutions_and_explanations/exercise_2_agentic-pii-redaction-regulatory-compliance-audit/) | The worked PII redaction: discovered toolchain, value redaction and near-match quarantine. |
| [Solution — Exercise 3](solutions_and_explanations/exercise_3_multimodal-financial-report-assembly-with-live-chart-ingestion/) | The worked financial report: five sections, scripted vision loop, seal and PDF/A gate. |
| [Solution — Exercise 4](solutions_and_explanations/exercise_4_digital-signature-ledger-with-trust-store-reconciliation/) | The worked signature ledger: trust-store reconciliation, tamper proof and Merkle idempotency. |
| [Solution — Exercise 5](solutions_and_explanations/exercise_5_autonomous-regulatory-submission-compiler-with-ocr-fallback-and-form-population/) | The worked three-regulator compiler: forms, OCR fallback, PDF/A and diff reports. |

## What you need

Node.js 22.5+, Python 3.10+ and the engine binaries — or just Docker. The
root README sets out both paths and the one-time setup:
[what you need](../README.md#what-you-need) and
[install](../README.md#install).

## Run everything

```bash
./chapter17/run_all.sh
```

The script runs every harness in the chapter, prints one line per
harness, and exits non-zero if any of them fails. Each harness leaves
its log in the `output/` directory of the project it exercises.

To run a single project, open its README: it gives the exact command
and the environment that command needs.

## Notes on the engines

The details that will bite you first:

- **WordCraft's meta-tools are `execute`, `batch` and `list_commands`** —
  not `command_run` / `command_batch` / `command_list`.
- **Neither server takes the sandbox flags** — `--automation-read-root`
  and `--automation-write-root` are silently ignored. PdfCraft enforces
  `--root`; WordCraft has no directory flag at all, so the worker's own
  path policy is the sandbox.
- **The caret moves when a command changes story** — `insert.header` and
  `references.footnote` leave the body, and `insert.table` leaves the
  caret inside the first cell.
- **The style catalog is `styles.list`** — `inspect_document` does not
  carry one.
- **A signed PDF cannot be encrypted and an encrypted PDF cannot be
  signed** — PdfCraft refuses both orders, so the two artifacts are
  derived from a common governed intermediate.
- **A PDF built from raw text can never pass PDF/A** — the base-14
  Helvetica is not embedded, so the file has to be authored by the word
  processor and converted with `pdfa_convert` before it is verified.
