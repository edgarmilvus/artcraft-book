# 6. Solutions and Explanations

The worked answer to the chapter's first exercise: a batch assembler that turns
a list of SKU specs into layered PSDs that satisfy a versioned layer contract,
and reports — per SKU — whether the result passes. It is built around the two
facts that make PSD automation awkward. A batch cannot reference an earlier
step's reply, so the ids have to be read off the report. And a batch is not
atomic, so a failure leaves a prefix applied and the only honest recovery is to
undo exactly that prefix.

## What it does

`assembleAllSkus` validates every spec against `SkuBannerSpecSchema` before it
opens the engine. The schema pins the canvas to literal `1920` × `1080`, the
SKU to `^[A-Z0-9\-]+$`, and every color to a six-digit hex, so a malformed
webhook payload fails as a `ZodError` instead of producing a half-built banner.

Each SKU then gets a fresh document and two batches. The creation batch adds
the `Background` group, the `Gradient::<SKU>` fill with the brief's stops,
angle and style, the `Type::Headline` group and its area type, the
`Type::Price` group and its type, and the `Grade::Vibrance`
hue-saturation adjustment at saturation 12. Every reply is parsed with
`LayerCreated` or `LayerCreatedOrId` before the id is trusted — a reply of the
wrong shape fails the SKU at that step rather than three steps later as
`undefined`.

The cutout is placed with `doc_place`, which embeds it as a smart object and
creates its own layer. The wiring batch then renames the placed layer to
`Product::<SKU>`, moves the grade above `Type::Headline`, sets the type groups
to `visible`, `1`, `Normal`, and creates the clipping masks. Finally the PSD is
saved to `<writeRoot>/<sku>/banner.psd`, a non-empty `warnings` array fails the
SKU, and `doc_inspect` is audited against `BannerContract`.

`undoAppliedPrefix` is exported on its own because it is the reusable part:
`command_batch` applies one history state per successful step, so undoing
`report.completed` times restores the opening depth.

## The listings

| file | what it is |
| --- | --- |
| `01_banner-assembler.ts` | the assembler: response schemas, SKU schema, creation and wiring steps, compensation, contract audit (mirrored as `src/banner-assembler.ts`) |
| `run_banner.ts` | the harness — two good SKUs, one bad one, and a compensation proof |
| `package.json` | manifest — `npm run check` runs the harness |
| `tsconfig.json` | the strict TypeScript configuration |

## Run it

```bash
cd chapter6/solutions_and_explanations/exercise_1_e-commerce-banner-assembly-with-clipping-mask-discipline-and-contract-layer-nami/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_banner.ts
```

```
PASS both good SKUs pass the contract audit
PASS the missing cutout is a reported failure
PASS the PSD exists
PASS the PSD is layered (8BPS)
PASS the failed SKU wrote no file
PASS Background is a group with two children
PASS a lower-case SKU is refused by the schema
PASS a mid-batch failure still reports the applied prefix
PASS the compensation restores the opening history depth

9/9 checks passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/banners/AW26-HOODIE-CHARCOAL/banner.psd` | a 1920×1080 layered PSD that passed the contract audit |
| `output/banners/AW26-HOODIE-CHARCOAL/inspect.json` | the tree `photocraft-cli info` reads back from that PSD |
| `output/banners/AW26-TEE-BONE/banner.psd` | the second passing SKU, saved independently |
| `output/banners/AW26-TEE-BONE/inspect.json` | its inspection tree |
| `output/workspace/read/cutout.png` | the 512×512 cutout the engine produced for `doc_place` |
| `output/report.json` | per-SKU verdicts, check results, PSD sizes and SHA-256 hashes |
| `output/run_banner.log` | the harness log — nine checks and their tally |

The failed SKU has no directory under `output/banners/`: a placement failure is
reported and never saved. The harness clears only its own subdirectories, so
the log written by `run_all.sh` survives a rerun.

## Notes

- **`photocraft-cli` must be on `PATH`.** The harness produces its cutout with
  `photocraft-cli run` and re-reads the PSD with `photocraft-cli info --compact`.
- **Two batches, not one.** Creation steps do not need ids from earlier steps;
  the wiring steps need every id, which is why they run second.
- A save warning is a failure. The assembler checks the `warnings` array rather
  than trusting the exit status of `doc_save`.
- Node.js 22.5+ and `npx tsx`.
