# 1. Solutions and Explanations

The chapter's worked answer to Exercise 1: the `command_batch` payloads that
rebuild the flat flash-sale banner as a fully separable PhotoCraft document,
and the `doc_inspect` assertions that prove nothing was destructively
rasterized. `run_photocraft.mjs` executes that answer against the real engine,
so every claim in it is checked against a live document.

## What it does

The runner opens one MCP stdio session against `photocraft-cli` and walks the
assembly. It creates the 1920×1080 canvas with `doc_new` and places the flat
PNG with `doc_place`, which produces a real Smart Object rather than a pixel
layer.

The first `command_batch` creates the Curves adjustment, moves it above the
Smart Object using `$0.layer` — the id returned by the previous step — then
creates the Hue/Saturation adjustment and the tagline type layer. The price
type layer is created with a follow-up `command_run`, as the contract says.
New layers land in the required order, so the stack ends as
`Background → Smart Object → Curves → Hue/Saturation → Tagline → Price`.

The runner then asserts on the `doc_inspect` tree: six layers with exactly one
Smart Object, two adjustments and two type layers; the exact bottom-to-top
order; the contract's Curves points, stored normalized; a neutral
Hue/Saturation; the tagline and price text, font and size; and a history that
shows `Place Embedded` but no destructive pixel operation.

The second `command_batch` mutates the document rather than rebuilding it:
`type.edit` retypes the price and `layer.setAdjustment` moves the hue and
saturation to `-8 / 15`. The runner checks that no layer was added, that the
tagline and Curves are untouched, and that the embedded source blob in the
saved `.pcraft` is byte-identical between the base and warm documents.

## The listings

| file | what it is |
| --- | --- |
| `01_solutions_and_explanations.ts` | the batch payloads and the `doc_inspect` assertions the exercise asks for |
| `assets/hero-flat-v3.png` | the flat generated banner the assembly starts from |
| `run_photocraft.mjs` | the MCP runner that executes the design against the real engine |

## Run it

```bash
cd chapter1/solutions_and_explanations/exercise_1_the-disposable-banner-autopsy-rebuilding-a-flat-generation-as-a-layered-pcraft-a/files
node run_photocraft.mjs
```

Every check prints as it runs; the last line counts them:

```
 ok  batch #1: completed steps               expected 4, got 4
 ok  batch #1: the $0.layer move ran
 ok  base: z-order bottom → top              expected "Pixel | Smart Object | Adjustment | Adjustment | Type | Type", ...
 ok  base: curves point 2 output             expected 0.8431372549019608, got 0.843137264251709
 ok  base: history shows Place Embedded      ["Open","Place Embedded","New Curves Layer",...]
 ok  warm: hue -8                            expected -8, got -8
 ok  warm file: same embedded source blob    e50b4249...f7651
 ok  warm file: smart object bytes identical 262 bytes

73 checks, 0 failing; artifacts in .../exercise/output
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/banners/flash-sale-base.pcraft` | the base assembly: Smart Object, two adjustments, two type layers |
| `output/banners/flash-sale-warm.pcraft` | the warm-market variant, mutated in place |
| `output/banner-base.png` | a preview of the base assembly |
| `output/banner-warm.png` | a preview of the warm variant |
| `output/inspect-base.json` | the `doc_inspect` tree of the base document |
| `output/inspect-warm.json` | the `doc_inspect` tree after the mutation |
| `output/run-log.json` | check count and any failures |

## Notes

- `photocraft-cli` must be on `PATH`; `PHOTOCRAFT_BIN` overrides the binary name.
- A fresh `doc_new` already owns a `Background` pixel layer, so five content
  layers means six layers in the tree.
- `$N.layer` expands in a command's own `layer` field but not in
  `layer.moveTo.target`, so the Smart Object id is resolved before the batch
  and `$0.layer` is used only for the layer being moved.
- The engine does not create missing directories: the runner makes
  `output/banners/` before `doc_save` writes into it.
- `doc_inspect` lists layers top to bottom, and a type layer exposes
  `text: { font, sizePt, text }` while an adjustment layer exposes
  `adjustment: { Curves: {...} }`.
- `doc_save` warns that `Inter-Bold` and `Inter-SemiBold` are not installed; the
  text layers stay editable and the warning is asserted to be font-only.
- The `.pcraft` container is a zip: the embedded Smart Object is a
  content-addressed blob, and both documents reference the same blob hash.
