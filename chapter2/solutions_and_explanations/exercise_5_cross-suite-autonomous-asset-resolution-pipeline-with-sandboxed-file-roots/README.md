# 1. Exercise 5: Cross-Suite Autonomous Asset Resolution Pipeline with Sandboxed File Roots -- solution

The worked solution for Exercise 5: one brief, four Craft suites. LightCraft
resolves the photo, PhotoCraft conditions it, DesignCraft composes two hero
formats, and PdfCraft fills and saves the spec sheet — every mutating step
written to a reversible transaction log.

## What it does

`01_json.json` is data, not code: product, variant, price, CTA, keywords, the
read/write roots, and a two-tier resolution policy. `make-photos.mjs` builds
three 2400 × 1600 source photos; `make-bundle-fixtures.mjs` writes their XMP
sidecars (ratings 4/3/2), a 1920 × 1080 DesignCraft template with a graphic
frame, and a PdfCraft boilerplate with `Product`, `CTA` and `Price` fields.

`PathGuard` is the only code that touches a path string. It rejects absolute
paths, drive letters and `..`, and returns a normalized relative path; every
engine write is checked to stay inside the write root.

The pipeline then runs four steps:

1. **LightCraft** queries by rating plus keyword. The primary tier wants
   rating ≥ 4, the brief's keyword and the `pick` flag; the fallback lowers
   only the rating bar. The chosen photo is exported into `work/`.
2. **PhotoCraft** opens the staged JPEG, resizes it non-destructively and
   applies the conditioning batch, then saves a `.pcraft` working master.
3. **DesignCraft** opens the template, sets up the page, places the
   conditioned image, adds the CTA frame and text, and exports the wide and
   square PNGs.
4. **PdfCraft** fills the form fields, sets the Title, and saves
   `spec/FW26_VelvetChair_spec.pdf`.

Every command is appended to `logs/bundle-2607_txn.jsonl` with its suite,
doc id and reversibility. On failure the pipeline closes documents without
saving and removes the staged `work/` files.

## The listings

| file | what it is |
| --- | --- |
| `05_cross-suite-autonomous-asset-resolution-pipeline-with-sandboxed-file-roots.ts` | the four-suite pipeline, the PathGuard and the transaction log |
| `01_json.json` | the bundle request, roots, outputs and resolution policy |
| `make-photos.mjs` | builds the three source photos |
| `make-bundle-fixtures.mjs` | builds the XMP sidecars, DesignCraft template and PDF boilerplate |
| `run_ex5.ts` | acceptance harness: rebuilds the fixtures, runs the pipeline and reopens every artifact |
| `package.json` | dependencies for the listing |
| `tsconfig.json` | TypeScript settings |

## Run it

```bash
cd chapter2/solutions_and_explanations/exercise_5_cross-suite-autonomous-asset-resolution-pipeline-with-sandboxed-file-roots/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex5.ts
```

The harness wipes `output/roots`, rebuilds every fixture, runs the pipeline
with both roots pointed at that directory, then opens the PNGs with PhotoCraft
and the PDF with PdfCraft. It exits non-zero on a failed check.

## What it produces

| artifact | what it is |
| --- | --- |
| `output/roots/imports/velvet_ochre.jpg` | the highest-rated source photo plus its XMP sidecar |
| `output/roots/imports/velvet_walnut.jpg` | the walnut variant |
| `output/roots/imports/velvet_sage.jpg` | the sage variant |
| `output/roots/templates/hero_furniture.designcraft` | the 1920 × 1080 layout template |
| `output/roots/spec/FW26_spec_boilerplate.pdf` | the three-field PDF boilerplate |
| `output/roots/work/hero_source_1.jpg` | the LightCraft export staged for conditioning |
| `output/roots/hero/hero_1920x1080.png` | the wide hero |
| `output/roots/hero/hero_1080x1080.png` | the square hero |
| `output/roots/spec/FW26_VelvetChair_spec.pdf` | the filled spec sheet |
| `output/roots/logs/bundle-2607_txn.jsonl` | the 14-step reversible transaction log |
| `output/fixtures.log` | both fixture builders' output |
| `output/pipeline.log` | the pipeline's stdout and stderr |
| `output/run_ex5.log` | every acceptance check |
| `output/run-log.json` | check count, failures and engine quirks |

## What the harness asserts

- all three JPEGs, their sidecars, the template and the boilerplate exist; the
  ochre photo is rated 4 and carries the brief's keywords;
- the pipeline exits cleanly, prints its four self-checks, and reports
  `ok`, photo 1, `used_fallback: true` and document 0;
- every reported path is relative, contains no `..`, and resolves under the
  write root;
- the wide PNG is 1920 × 1080, the square is 1080 × 1080, and the spec sheet
  has a `%PDF-` header;
- the transaction log has exactly 14 records in the expected order, covers all
  four suites (1 LightCraft, 2 PhotoCraft, 8 DesignCraft, 3 PdfCraft), and
  carries `suite`, `command`, `doc_id` and `reversible` on every record;
- the irreversible steps are exactly the ones that write final files: the
  template open, the two PNG exports and the PDF save;
- reopening both heroes in PhotoCraft yields the right dimensions and one
  flat composite layer;
- reopening the spec sheet in PdfCraft yields one page, three filled form
  fields (`Velvet Chair`, `Save 25% This Week`, `USD 1199`) and matching
  extracted text.

## Notes

- None of the four engines creates output directories: the fixture builders
  and the pipeline create `imports/`, `templates/`, `spec/`, `hero/`, `work/`
  and `logs/` before the first write.
- The suites do not share a launch contract. PhotoCraft takes automation
  roots; PdfCraft takes `--root`; DesignCraft takes neither and resolves
  relative paths against its cwd; LightCraft imports the folder named on its
  command line.
- The primary tier requires the `pick` flag, which the source XMP does not
  set, so the run resolves through the fallback tier by design.
- The spec sheet form fields start at different y coordinates from the hero
  frames; `form_fields` is the ground truth for the filled values.
