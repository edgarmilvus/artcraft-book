# 19. Exercise 6 (Stretch): Cross-Suite Asset Provenance Ledger — solution

The worked provenance shim. Every cross-suite hop — LightCraft → PhotoCraft →
DesignCraft → PdfCraft — is recorded in an append-only, HMAC-chained SQLite
ledger, then audited by replaying the chain and reconciling the files on disk.

## What it does

1. `runStudioRun()` drives the whole pipeline through the shim: LightCraft
   renders the banner, PhotoCraft builds the mock-up, DesignCraft lays out the
   catalog and PdfCraft archives the PDF.
2. Every engine call is appended as a `ProvenanceHop` with UUIDv7 event id,
   canonical JSON, the previous hash and an HMAC.
3. `reconcileArtefacts()` asserts that every file in the workspace has a hop
   and that no hop claims a file that was never written.
4. The audit replays the hash chain, runs the query contract both through
   TypeScript (`Ledger`) and through the `sqlite3` CLI, and compares the two.
5. Adversarial fixtures prove the audit fails closed: a tampered chain, an
   orphan file written behind the shim and a dropped hop each produce a
   separate evidence database.
6. The query plan must use the index, not a table scan, and `SCHEMA_SQL` must
   match `01_sql.sql` exactly.
7. Launcher tags (`cursor`, `claude-code`, `opencode`) are normalized; an
   unknown launcher is refused. DesignCraft rejects the automation-root flags
   while PhotoCraft accepts them, and relative vs absolute paths are recorded
   as each engine actually sees them.

## Run it

```bash
cd chapter19/solutions_and_explanations/exercise_6_cross-suite-asset-provenance-ledger/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex6.ts
```

```
77 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/provenance.sqlite` | the append-only HMAC-chained ledger |
| `output/tampered.sqlite` | the evidence database for a broken chain |
| `output/orphan.sqlite` | the evidence database for a file written behind the shim |
| `output/dropped.sqlite` | the evidence database for a dropped hop |
| `output/catalogue.pdf` | the DesignCraft catalog |
| `output/archive.pdf` | the PdfCraft archive copy |
| `output/banner.tif` | the LightCraft master render |
| `output/banner-render.png` | the LightCraft preview |
| `output/work/` | raw input, PhotoCraft mock-up and all intermediate files |
| `output/run_ex6.log` | shell-captured harness log |

## The listings

| file | what it is |
| --- | --- |
| `files/06_cross-suite-asset-provenance-ledger-stretch.ts` | shim, ledger, chain, reconciliation, query contract and path policy |
| `files/run_ex6.ts` | the real-pipeline acceptance harness |
| `files/01_sql.sql` | the canonical schema |
| `files/02_typescript.ts` | the hop/query contracts |

## Notes

- The ledger is append-only: the shim never updates a row, and the audit
  recomputes every HMAC from the previous hash.
- The `sqlite3` CLI and the TypeScript query must return the same rows; the
  index is asserted through `EXPLAIN QUERY PLAN`.
- A file written without a hop is detectable even though the ledger itself is
  still intact — the two checks are independent.
- Type-check it with `npm run check`.
