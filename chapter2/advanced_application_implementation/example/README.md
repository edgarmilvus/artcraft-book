# 2. Advanced Application Implementation

A headless banner factory: a tenant brief goes in, a layered document is
planned by worker agents, executed as tile-delta batches, reconciled across
both compositors, exported, and upserted into a vector store under a stable
id.

Seven modules, each with one job, and a harness that runs the whole graph
against the real engine and then checks what landed on disk.

## What it does

`BrandFactory.run()` opens **two** `photocraft-cli mcp` sessions over the same
document: one unconstrained (the accelerated path) and one pinned to the
CPU-SIMD oracle with `PHOTOCRAFT_GPU=0`. Both registries are loaded from
`command_list`, both documents are created from a byte-identical spec, and
from then on the two sessions receive the same steps in lock-step.

The brief is dispatched to three workers — `GradientAgent`,
`TypeSetterAgent`, `ComplianceAgent` — which are pure: they return
`(commandId, params)` tuples and never touch the engine. `SupervisorNode`
merges their plans and resolves conflicts; `TileDeltaPlanner` validates every
step against the registry, collapses redundant consecutive mutations, and
folds the run into the fewest `command_batch` frames the phase boundaries
allow. The frames are executed on both sessions, then `DualCompositor`
compares a bounded preview of each: per-channel RMSE against a tolerance of
1.5 and a 64-bit dHash compared by Hamming distance, at most 2 bits apart.

Export is taken from the reference session (`doc_export`);
`doc_render_preview` is taken from the accelerated one. `deriveVectorId()`
hashes the brief, the engine version and the worker order, and the result is
upserted with the vision model's embedding.

## The listings

| file | what it is |
| --- | --- |
| `session.ts` | one `ArtCraftSession` = one child process = one document workspace; owns the sandbox flags, the spawn env and the close-drains-jobs lifecycle |
| `registry.ts` | runtime command discovery and schema cache; `assertValid(id, params)` runs before any step reaches the wire |
| `tile-delta.ts` | `TileDeltaPlanner`: validate, collapse, chop at phase boundaries and at 512 steps, estimate the tile cost of each frame |
| `dual-compositor.ts` | renders both paths, decodes the PNGs with `node:zlib`, computes per-channel RMSE and a perceptual hash, and reconciles |
| `supervisor.ts` | the brief type, the `Worker` contract, the three workers, and the supervisor that merges their plans |
| `asset-store.ts` | `AssetRecord`, the vector-store client contract, and `deriveVectorId()` with a key-sorted stringify that sees nested fields |
| `factory.ts` | the composition root: open both sessions, boot both registries, plan, execute, reconcile, export, embed, upsert |
| `run-factory.ts` | the harness: runs the factory, replays the workers' plan into a fresh document, and checks fifteen claims |

## Run it

```bash
cd chapter2/advanced_application_implementation/example/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run-factory.ts
```

The factory runs for real and the harness then reads its artifacts back:

```
factory result: {
  "previewUrl": "/assets/acme/FW26-hero-preview.png",
  "exportUrl": "/assets/acme/FW26-hero.png",
  "reconciliation": { "converged": true, "hashAligned": true },
  "vectorId": "ee466855df7feb6d3ada81151d546b68"
}
PASS  export written — 98369 bytes
PASS  preview written — 138573 bytes
PASS  vector record upserted — 1 record(s), id ee466855df7feb6d3ada81151d546b68
PASS  preview == export (pixel level) — 1200x628 vs 1200x628, rmse=[0.000, 0.000, 0.000]
PASS  reconciliation report — converged=true hashAligned=true
PASS  registry loaded — engine photocraft@0.8.2
PASS  registry size — >400 commands
PASS  unknown command rejected — registry.get() threw for a hallucinated id
plan: 8 step(s) in 2 frame(s) → layers: ACME | acme • FW26-hero • en-GB | Shop the drop | Merino, knitted in Porto. | Built for the long run | Curves 1 | Gradient Fill 1 | Background
...
15/15 checks passed
```

The `plan:` line is the supervisor's decision made visible: eight steps
folded into two frames, one layer per worker contribution.

## What it produces

Everything lands under `output/factory/`:

| artifact | what it is |
| --- | --- |
| `files/output/out/acme/FW26-hero.png` | the delivered export, flattened by the reference compositor |
| `files/output/out/acme/FW26-hero-preview.png` | the bounded preview the customer would see |
| `../output/run-log.json` | the brief, the factory result, all fifteen checks, the RMSE triple and the final layer order |
| `../output/run-factory.log` | the harness transcript |

The read root `output/factory/in` is created empty: this brief needs no
template.

## Notes

- **`photocraft-cli` must be on `PATH`.** Both sessions spawn the same
  binary; the reference one is distinguished only by `PHOTOCRAFT_GPU=0`.
- **The export warning is expected.** `doc_export` reports
  `8 layer(s) flattened; layers, masks and blend modes are not kept` — a flat
  PNG has no layer stack to keep.
- **The pixel comparison is a bounded check, not a full-resolution diff.**
  Both previews are rendered at `maxSide=2048`, decoded, and compared; the
  tolerance is 1.5 per channel on a 0–255 scale.
- **The vector id is stable for an unchanged brief.** Two runs of the same
  brief produce the same id, which the store reads as an upsert. Change a
  nested field — the headline — and the id changes.
- Type-check it with `npm run typecheck` (`tsc --noEmit`).
