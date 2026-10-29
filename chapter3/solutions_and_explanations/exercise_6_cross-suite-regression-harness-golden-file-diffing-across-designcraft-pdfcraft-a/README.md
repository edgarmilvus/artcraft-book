# 3. Exercise 6: Cross-Suite Regression Harness — Golden-File Diffing Across DesignCraft, PdfCraft, and WordCraft -- solution

The worked solution for Exercise 6: a fixture-driven harness that runs the
same plan through DesignCraft, PdfCraft and WordCraft, canonicalizes each
engine's output, and compares it to a checked-in golden file. The acceptance
harness proves the clean path, the mismatch path, tolerances, unknown-command
precedence, determinism, sharding and the guarded golden update.

## What it does

`03_harness.ts` reads `fixtures/<id>/plan.json`. A plan is a list of steps
with a `cli`, a registry `command` and `params`, plus a tolerance window:

```json
{
  "fixtureId": "cross-suite",
  "tolerance": { "textDamerauLevenshtein": 0, "renderPixelLevenshtein": 0 },
  "steps": [
    { "cli": "designcraft", "command": "file.new", "params": { "preset": "Letter", "pages": 1 } },
    { "cli": "designcraft", "command": "file.exportPdf", "params": { "path": "out.pdf", "standard": "a2b" } },
    { "cli": "pdfcraft", "command": "doc_open", "params": { "path": "out.pdf" } }
  ]
}
```

The harness starts only the engines the plan uses. Before executing a
registry command it refreshes `list_commands` / `command_list`, because
commands such as `style.paragraph.apply` and `text.insert` start disabled and
become enabled after an earlier step creates the document or selection. A
command that is present but still disabled is an error; a command that is not
in the registry is an error that names the nearest live ids.

The canonical form is intentionally small and stable:

| suite | canonical fields |
| --- | --- |
| DesignCraft | page count, spread count, story count, sorted paragraph + character styles, sorted swatches |
| PdfCraft | page count, metadata (`title`, `author`, `creator`, `producer`, version, tagged, font names), per-page text, per-page 150-dpi PNG and its SHA-256, non-empty line count |
| WordCraft | block kind, block text, style chain, sorted style names |

Each fixture runs twice. If the two canonical objects differ the harness exits
**2** and writes `artifacts/diffs/<id>/determinism.json`; this is a flaky
engine, not a golden mismatch. A golden mismatch exits **1** and writes
`diff.json` plus `summary.md`. A clean run exits **0**.

The tolerance is applied per PDF page and per WordCraft block:

- `textDamerauLevenshtein` is a true Damerau-Levenshtein distance (insert,
  delete, substitute, adjacent transpose);
- `renderPixelLevenshtein` counts differing RGBA bytes through `pngjs`, and
  is evaluated only when the stored PNG hashes differ; a size change is
  effectively infinite distance.

`--update-golden` rewrites the golden only when `I_AM_SURE=1`; otherwise it
exits 1 before running any fixture. `--shard i/n` selects `i, i+n, i+2n, …`
from the sorted fixture list, so eight parallel CI jobs cover every fixture
exactly once.

## The listings

| file | what it is |
| --- | --- |
| `03_harness.ts` | the harness: MCP drivers, live-registry refresh, canonicalizers, Damerau/pixel diff, sharding, exit codes |
| `02_typescript.ts` | the exported `Plan`, `PlanStep` and `DriverResult` contracts |
| `01_json.json` | a sample plan with the golden schema and tolerance |
| `04_yaml.yaml` | the GitLab jobs: an 8-shard verification matrix with diff artifacts kept on failure, and a separate manual golden-refresh job behind a `resource_group` |
| `05_block.txt` | the sample unknown-command error with nearest live ids |
| `fixtures/` | five positive fixtures with checked-in goldens |
| `negative-fixtures/unknown-command/` | the deliberate `type.charZZZ` typo |
| `run_ex6.ts` | acceptance harness: positive, mismatch, tolerance, unknown, guard, shard and static checks |

Positive fixtures:

| fixture | engines | what it covers |
| --- | --- | --- |
| `fixtures/designcraft-cover/` | DesignCraft | a one-page document with a text frame and styles |
| `fixtures/cover-page/` | DesignCraft + PdfCraft | PDF export and text/render canonicalization |
| `fixtures/cover-page-monochrome/` | DesignCraft + PdfCraft | a plain web PDF (not the PDF/A preset) |
| `fixtures/wordcraft-note/` | WordCraft | document creation, text insertion and style chain |
| `fixtures/cross-suite/` | all three | one plan that produces all three canonical sections |

## Run it

```bash
cd chapter3/solutions_and_explanations/exercise_6_cross-suite-regression-harness-golden-file-diffing-across-designcraft-pdfcraft-a/files
npx tsx run_ex6.ts
```

Run `03_harness.ts` directly with `--fixtures-dir`, `--out-dir`, `--shard`
and `--update-golden`; the last one requires `I_AM_SURE=1`.

## What it produces

| artifact | what it is |
| --- | --- |
| `output/fixtures/<id>/golden.json` | the checked-in canonical output for each fixture |
| `output/artifacts/diffs/<id>/diff.json`, `summary.md` | per-field deltas, and the same diff rendered with expected/actual values |
| `output/artifacts/diffs/<id>/error.txt` | unknown-command or driver failure |
| `output/artifacts/diffs/<id>/determinism.json` | the two differing runs when exit code 2 fires |
| `output/run_ex6.log` | every acceptance check |
| `output/run-log.json` | checks, failures, fixtures, goldens and quirks |

## What the harness asserts

- the clean suite covers five fixtures, exits 0, writes no diff directory and
  is deterministic across two runs;
- every fixture has a golden; DesignCraft records page/spread/story/styles,
  WordCraft keeps block text and style chain, PdfCraft extracts `Quarterly`
  from the page and stores a decodable PNG and canonical metadata;
- the cross-suite fixture has all three non-null sections;
- a one-character golden change fails with `textDistance` when tolerance is 0,
  and passes when tolerance is 1;
- a one-pixel render change passes with tolerance 1 and fails with
  `renderPixelDistance` when tolerance is 0;
- `type.charZZZ` exits 1, writes `error.txt`, and names `type.char` in the
  nearest live ids;
- `--update-golden` without `I_AM_SURE=1` exits 1 and names the variable;
  with it, the mutated golden is rewritten to the actual output;
- the CI YAML keeps `resource_group` on the refresh job only — putting it on
  the 8-shard matrix would queue every shard behind the previous one — and a
  fixture with a non-zero tolerance ships a `JUSTIFICATION.md`;
- shards `0/2` and `1/2` cover 3 + 2 fixtures and sum to five;
- the TypeScript harness and acceptance code pass `tsc --noEmit`;
- the CI YAML runs a shard, keeps `artifacts/diffs/` on failure, and the
  sample block lists the nearest live ids.

The current run is 69 checks, 0 failing, five fixtures and a clean exit 0.

## Notes
- WordCraft's `list_commands` omits `enabled` entirely, so a missing flag means
  enabled; DesignCraft's explicit `false` still blocks execution. PdfCraft page
  text arrives as `{ pages: [{ page, text }] }`, so the harness selects the
  matching page instead of assuming a flat `{ text }` shape.
- The 150-dpi PNG is stored in the golden so a pixel tolerance can be computed
  later. The sha256 short-circuits the comparison when the image is identical.
- Canonical PDF metadata is an allow-list: `title`, `author`, `creator`,
  `producer`, `pdf_version`, `tagged` and sorted font names. Timestamps are
  never read, which is why they never need dropping.
- The `cover-page-monochrome` fixture exports without the PDF/A preset; it
  exists to prove the harness canonicalizes ordinary web PDFs too.
