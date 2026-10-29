# 9. Basic Code Example

The "hello world" of the LightCraft RAW pipeline: import a burst, score every
frame, cluster look-alikes through a vector store, pick one winner, develop
it with a 32-bit float preset and export a JPEG.

It is a complete vertical slice — ingest, cull, grade, deliver — with the two
services that need a server, the vector store and the embedding model,
injected so the run needs neither Postgres nor an API key.

## What it does

`LightCraftCuller.start()` opens one stdio MCP session against
`lightcraft-cli mcp`, with the library folder passed as `--library`.
`ingest()` calls the `import` meta-tool with `mode: "copy"`, a dated rename
template and an album, so the source volume stays untouched.

`analyse()` runs `photo.analyze` with `pickBest: false` to get sharpness and
burst grouping without letting the engine decide, then reads the metadata
through `query_photos`. `index()` builds a caption fingerprint per frame,
embeds it to 512 dimensions and upserts the row — photo id, fingerprint,
vector, capture metadata — into the store.

`burstOf()` asks the store for the nearest neighbors above a similarity
threshold, and `applyCulling()` writes the decision back in one
`command_batch`: `photo.rate` and `photo.flag` for the picks, then the same
for the rejects. `ensurePreset()` finds or creates the studio preset, and
`deliver()` applies it, nudges exposure, contrast and vibrance with
`set_develop`, renders a 1024 px preview with `render_photo` and exports the
full JPEG with `export`.

## The listings

| file | what it is |
| --- | --- |
| `01_lightcraft-culler.ts` | the whole pipeline: the env schema, the vector-store contract, `PgVectorStore`, `OpenAiEmbedder`, `LightCraftCuller` and the HTTP helpers |
| `run_basic.ts` | the harness: a local store, a deterministic embedder, six generated frames and the culling run |
| `package.json` | the project's scripts and dependencies |
| `tsconfig.json` | the TypeScript target |

## Run it

```bash
cd chapter9/basic_code_example/example/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_basic.ts
```

The harness generates a six-frame burst, imports it and checks the cull and
the deliverable:

```
# the ingest
PASS ingest: the six frames were imported
PASS ingest: the store holds every frame
PASS ingest: every row has a fingerprint
PASS ingest: every row has a 512-d vector

# the culling
PASS culling: one winner
PASS culling: the rest are rejected

# the deliverable
PASS deliver: the file exists
PASS deliver: it is a JPEG

# the engine state
PASS engine: the session tears down cleanly

13 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `files/output/input/burst-0.png` | the six synthetic frames the harness writes as the ingest source, `burst-0.png` to `burst-5.png` |
| `files/output/library/Originals/2026/2026-09-30/20260930_120000_0001.png` | the first imported original in the dated library tree (six in total) |
| `files/output/library/catalog.snap` | the catalog snapshot |
| `files/output/library/catalog.log` | the catalog journal |
| `files/output/library/view.json` | the saved library view |
| `files/output/deliverables/3.jpg` | the developed winner |

## Notes

- **`lightcraft-cli` must be on `PATH`.** The session is opened once and
  closed in the harness's teardown.
- **The store and the embedder are injected.** `PgVectorStore` and
  `OpenAiEmbedder` are the production implementations; the harness supplies
  local ones with the same interfaces.
- **`LIGHTCRAFT_BIN`, `WORK_ROOT` and `LIBRARY_DIR` are read at import
  time.** A missing work root fails at cold start, not mid-job.
- **`npx tsx`, not `node`.** The listing is TypeScript with `.js`
  specifiers.
- Type-check it with `npm run check` (which is `tsc --noEmit`).
