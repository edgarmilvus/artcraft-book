# 1. Exercise 4: The Brand Family Problem — VectorCraft Image Trace to Non-Destructive Logo System -- solution

Rebuild a flat PNG logo as a live VectorCraft master, then rebrand it without
retracing: one global swatch change must recolor the traced mark and the
wordmark in place, while the inverted artboard keeps its own swatch.

## What it does

1. Places `brand/logo-flat-512.png` on a 512×512 canvas and traces it with the
   `Flat Logo` preset; the trace is united into a single mark and cleaned up in
   one undo group.
2. Creates two global swatches, `Brand/Primary` (`#0f172a`) and `Brand/Inverse`
   (`#ffffff`), and paints the mark with `Brand/Primary`.
3. Adds a live `ACME` wordmark in the same family, linked to the same swatch.
4. Duplicates the artboard and links the copy's mark and wordmark to
   `Brand/Inverse`.
5. Creates a `Logo/Mark` graphic style and applies it to both marks so the style
   tracks the geometry while fills stay swatch-linked.
6. Edits `Brand/Primary` once to `#0d9488` and asserts that the mark and the
   wordmark both follow, the inverse pair stays white, no node was retraced, and
   all node IDs are unchanged.
7. Exports SVG masters, eight favicons (2 artboards × 16/32/180/512 px), the
   native `.vectorcraft` master and a provenance sidecar.

## Run it

```bash
cd chapter1/solutions_and_explanations/exercise_4_the-brand-family-problem-vectorcraft-image-trace-to-non-destructive-logo-system/files
npx tsx run_ex4.ts
```

The harness starts its own `vectorcraft-cli mcp` server, rebuilds the logo from
the PNG fixture, and exits non-zero on any failed assertion.

## What it produces

| artifact | what it is |
| --- | --- |
| `output/inspect-before.json` | document tree before the rebrand |
| `output/inspect-after.json` | document tree after the swatch edit |
| `output/brand/logo-master.svg` | SVG master, primary artboard |
| `output/brand/logo-master-primary.svg` | SVG after the rebrand |
| `output/brand/logo-master.vectorcraft` | native editable master |
| `output/brand/logo-master.provenance.json` | trace preset, swatch/style refs, source digest, rebrand record |
| `output/brand/favicons/*.png` | eight exports, two artboards × four sizes |
| `output/brand/artboard-0.png`, `artboard-1.png` | rendered artboards |
| `output/run-log.json` | checks, failures, engine notes, per-step results |
| `output/run_ex4.log` | full harness transcript |

## What is verified

82 checks, 0 failing:

- Before: two artboards, two live `Type` wordmarks, two traced `Path` marks, no
  raster image left, and no `_trace-source` layer.
- Both marks are paths produced by the trace (no live trace object), the style
  `Logo/Mark` exists, and its `linked` list contains the master mark.
- `Brand/Primary` and `Brand/Inverse` are global; the master mark and wordmark
  report `Brand/Primary (#0f172a)`, the inverted pair `Brand/Inverse (#ffffff)`.
- After one `swatch.edit`, the master mark and wordmark report
  `Brand/Primary (#0d9488)`, the inverse pair is unchanged, node IDs are
  identical, no retrace occurred, and `relinked` is 3.
- The eight favicons are 2 × 4 files with the exact pixel dimensions, the SVG
  masters contain path data, and the native master is non-trivial.
- Provenance: source PNG hash, trace preset, swatch/style refs, rebrand
  from/to, `retraced: false`.

## Engine notes

- `object.pathfinder.unite` is selection-only in the command registry; the MCP
  `pathfinder` tool takes explicit ids, so the harness uses the tool.
- `graphicStyle.new` does not link its source object. The style must be applied
  to both marks to link them.
- `imageTrace.makeAndExpand` consumes the placed raster, so the harness deletes
  `_trace-source` only if it still exists.
- `text.setStyle { fill }` rejects a swatch link; swatch-linked type is painted
  with `paint.setFill`.
- A paint override on a graphic-style object unlinks it (Illustrator-style
  override). After the inverse mark gets its `Brand/Inverse` fill, it remains
  swatch-linked rather than style-linked; the rebrand still propagates through
  the swatch, and `relinked: 3` records that.
- Export paths resolve against the process cwd, so every path is absolute under
  the exercise's `output/` directory.
