# 8. Solutions and Explanations

The worked solution for the glyph foundry. Twelve icons are specified as
anchor tokens, compiled into `path.create` batches, built in the engine, and
written out with a geometry manifest. Nothing in the family is an SVG path
string.

The solution is also the proof that the token language is expressive enough:
the wallet has a hole, the shield uses the even-odd rule, and every glyph
shares the 1/3 tangent budget.

## What it does

`buildFamily()` declares the twelve glyphs — `wallet`, `shield-check`,
`arrow-trend-up`, `bell`, `chart-bars`, `user`, `home`, `search`, `settings`,
`calendar`, `lock` and `download` — using three anchor helpers: `corner` for
a hard join, `tangent` for a smooth interior point, and `extreme` for a point
that must sit on the 8 pt grid.

`computeHandles()` applies the handle policy per anchor. `auto-tangent` uses
the 1/3 rule on both sides, `fixed-ratio` anchors to the next or previous
point, `mirrored` reflects the out-handle, and `independent` takes explicit
coordinates. `gridSnap()` only moves `extreme` anchors and reports the drift
for every other role, so a spec error is visible without being fatal.

`buildIconBatch()` turns one spec into an atomic batch: `path.create` per
subpath, `object.compoundPath.make` when a glyph has more than one, the
shared `paint.setStroke` and `paint.setFill`, and the fill rule. The batch
must be replayable from `icon-foundry.json`, because only the MCP
`command_batch` tool can thread `$N.id` references; the engine's
`command.batch` cannot.

`buildIconFamily()` builds each icon in its own document, reads the object
back to count anchors and subpaths, checks the fill rule, hashes the spec
canonical form and writes the `.vectorcraft` file plus `manifest.json`.

## The listings

| file | what it is |
| --- | --- |
| `01_solutions_and_explanations.ts` | anchor math, the twelve specs, the batch builder, the engine session, the manifest writer and the failure handlers |
| `icon-foundry.json` | the batch driver: atomic, labelled, with backward-pointing `$N.id` references |
| `manifest.json` | the geometry manifest: one entry per glyph with anchors, subpaths, fill rule, bounds, spec hash and warnings |
| `run_ex1.ts` | the harness |
| `package.json` | the project's scripts and dependencies |
| `tsconfig.json` | the TypeScript target |

## How it is verified

```bash
cd chapter8/solutions_and_explanations/exercise_1_the-b-zier-glyph-foundry-parametric-icon-system-with-explicit-anchor-math/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex1.ts
```

The harness checks the family and the manifest, then the driver payload,
then determinism:

```
PASS family: twelve icons
PASS manifest: the wallet has a hole
PASS manifest: the shield uses the even-odd rule
PASS file: wallet.vectorcraft is not empty
PASS driver: it is atomic
PASS driver: it threads ids between steps
PASS determinism: the manifest is identical

133 assertions passed
```

Build output lands in `output/build/` — twelve `.vectorcraft` files, the
matching `.svg` previews and `manifest.json` — with a second run in
`output/build-2/` for the manifest comparison. `output/icon-foundry.json`
is the replayable batch driver and `output/report.json` is the run summary.

## Notes

- **`vectorcraft-cli` must be on `PATH`.** The solution opens one stdio
  session and closes it in `finally`.
- **The manifest is a file, not a field.** The engine has no place to hang a
  custom payload on an object, so the audit lives beside the artifacts.
- **The spec hash is stable.** It is computed from the canonical spec, not
  from the document, which is what makes the determinism check meaningful.
- Type-check it with `npm run check` (which is `tsc --noEmit`).
