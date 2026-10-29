# 8. Advanced Application Implementation

VectorForge is the logo-synthesis worker of a multi-tenant brand-asset API.
It takes one tenant request, builds a parametric mark out of cubic Béziers,
a live blend, three Pathfinder booleans, a radial gradient and an offset
outline, and exports an SVG and a 2× PNG into the tenant's workspace.

The worker is deterministic on purpose: the same request produces the same
bytes, so the SaaS layer can cache artifacts by request hash and reproduce an
asset months later during a brand audit.

## What it does

`VectorForgeService.connect()` opens a stdio MCP session against
`vectorcraft-cli mcp` with a read root and a write root, and every command
goes through `command_run`. `synthesize()` then runs twelve ordered steps:

1. `file.new` — a 1200 pt RGB artboard with a transparent background.
2. Two `layer.new` calls, so the petals sit above the background shield and
   the blend sits below both.
3. A nine-sided rounded shield from `path.create`, filled with a two-stop
   **linear** gradient by `paint.setFill`.
4. Ten petals, each from `path.create` and each placed by `object.transform`:
   rotate by its polar angle, then translate to the artboard center.
5. A live `object.blend.make` between a five-point and a seven-point accent
   star, set to `steps` spacing with the tenant's `blendSteps` (24 in the
   harness), so the aura stays editable.
6. `object.pathfinder.unite` fuses the petals; `minusFront` punches a
   circular well through the center; `intersect` trims the result to a
   circular mask.
7. `object.path.offsetPath` grows the outline ornament, which is left
   unfilled and stroked.
8. A three-stop **radial** gradient is applied to the composite.
9. One atomic `command_batch` renames the composite and the ornament,
   sets opacity and centers both on the artboard, so the cosmetic pass is a
   single undo step.
10. `document.export` writes the SVG and the PNG at `scale: 2`.
11. `inspect_document` returns the tree the service logs as a digest.

The request and every engine response are validated with Zod at the
boundary, so a malformed tenant payload never reaches the engine.

## The listings

| file | what it is |
| --- | --- |
| `01_vectorforge-logo-synthesis.ts` | the worker: schemas, the `VectorForgeService`, all twelve synthesis steps and the stdin/stdout CLI entry point |
| `02_4_polar_distribution_via_affine.ts` | the placement stage in isolation: rotate to the polar angle, then translate to the center |
| `03_wasm_simd_accelerates_the_tessel.txt` | the tessellation inner loop, written as the eight-wide SIMD version |
| `04_hnsw_inside_pgvector_for_asset_s.sql` | the `vectorforge_assets` table and its cosine HNSW index |
| `05_hnsw_inside_pgvector_for_asset_s.sql` | the tenant-scoped k-nearest-neighbor query that feeds a "more like this" rail |
| `06_pinecone_namespaces_for_cross_te.txt` | the namespace layout of the shared Pinecone index |
| `07_pinecone_namespaces_for_cross_te.ts` | the persistence stage: one namespace per tenant, correlation id as the vector id |
| `run_forge.ts` | the harness: two identical runs and one different palette |
| `package.json` | the project's scripts and dependencies |
| `tsconfig.json` | the TypeScript target |

## Run it

```bash
cd chapter8/advanced_application_implementation/example/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_forge.ts
```

The harness feeds the worker a request on stdin, reads the JSON line it
prints on stdout, and checks both the report and the files:

```
# the artifacts
PASS artifact: the svg file exists
PASS artifact: the png file exists
PASS artifact: the raster is 2x the artboard
PASS artifact: the mark covers a real share of the canvas
PASS artifact: the background is transparent

# determinism
PASS determinism: the same svg bytes come out
PASS determinism: the same png bytes come out

# a different palette is a different asset
PASS palette: the new colours are in the svg
PASS palette: the old colours are not

23 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `files/output/run-1/logo-001.svg` | the first run's SVG |
| `files/output/run-1/logo-001.png` | the first run's 2400 px PNG |
| `files/output/run-2/logo-001.svg` | the second, byte-identical run |
| `files/output/run-2/logo-001.png` | the second PNG |
| `files/output/run-3/logo-002.svg` | a different SKU and palette |
| `files/output/run-3/logo-002.png` | its raster |

## Notes

- **`vectorcraft-cli` must be on `PATH`.** The worker spawns it per job and
  closes the session in `finally`.
- **The harness sets the roots.** It passes `VECTORFORGE_READ_ROOT` and
  `VECTORFORGE_WRITE_ROOT` in the child's environment; the worker defaults to
  `/work/vectorforge` and `/work/vectorforge/out` when they are absent.
- **The worker is a filter.** It reads one JSON request from stdin and writes
  one JSON line to stdout, which is the shape a queue worker needs.
- **No model and no network.** Every step is an engine command; the
  `vector(512)` embeddings in the SQL and Pinecone listings are the
  downstream contract, not part of the render.
- Type-check it with `npm run check` (which is `tsc --noEmit`).
