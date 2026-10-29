# 3. Advanced Application Implementation

A multi-tenant marketing-asset service: a JSON design brief arrives over
HTTP, two Craft MCP servers are already warm, a two-stage raster-then-layout
pipeline runs, and a hashed PNG artifact comes back with per-stage timings.

The invariant is warm start. Nothing is spawned per request: each worker pools
live `StdioClientTransport` sessions for `photocraft-cli` and
`designcraft-cli` and reuses them for the life of the process. Zod sits at the
boundary in both directions — every brief is parsed before a command is built,
and every tool reply is parsed against a schema before its fields are read.

## What it does

`POST /v1/render` accepts `tenantId`, `headline`, `subhead`, `price`,
`productImagePath` and an optional `canvas` (default 1920 × 1080) and
`accentColor`. The canvas is the layout size; `export_png` runs at `scale: 2`, so the default 1920 × 1080 page produces a 3840 × 2160 artifact. A malformed body is `400`, a body that fails
`DesignBriefSchema` is `422`, and a request that arrives before the pool is
warm is `503`.

Stage A, `photocraft.normalize`, opens the product image inside the read root
and applies `image.autoTone`, `image.autoContrast`,
`layer.removeBackground` and a gentle levels layer in one `command_batch`.
Because a batch is not a transaction, a reply with `failed > 0` is turned into
an error naming the failing steps. The normalized image is then written to
`out/stage-a/` with `doc_save`. Stage B, `designcraft.compose`, creates a
document at the requested canvas size, places the normalized image into a
left-hand frame, creates an accent swatch, and sets the headline, subhead and
price in three text frames before exporting to `out/banners/`.

The artifact descriptor carries the absolute path, format, pixel dimensions,
byte count, the SHA-256 of the final PNG, the total render time, and one entry
per stage with its own milliseconds and an `ok` flag. It is validated by
`ArtifactSchema` before it is serialized, so a reply that drifts from the
contract fails at the edge rather than at the caller.

Each stage times itself, and a stage that fails aborts the request with a
`500` carrying the message — a partially normalized image is never composed.

## The listings

| file | what it is |
| --- | --- |
| `01_package.json` | the manifest: `build`, `start`, `smoke`, and the dependency set (`@modelcontextprotocol/sdk`, `fastify`, `pino`, `zod`) |
| `02_tsconfig.json` | the strict build contract the whole tree compiles under |
| `03_contracts.ts` | `DesignBriefSchema`, `ArtifactSchema` and the `ToolOutcome<T>` union — the surface both the HTTP edge and the pipeline speak |
| `04_client.ts` | `CraftMCPClient`: one transport per binary, per-suite root handling, `call()` returning `ToolOutcome` instead of throwing |
| `05_helpers.ts` | `withTimeout`, `extractJson` and the content-block readers the client and pipeline share |
| `06_banner.ts` | `runBannerPipeline`: the two stages, the stage timings, the SHA-256 and the artifact descriptor |
| `07_index.ts` | the worker entry point: boot both sessions, create the output directories, route `/v1/render`, drain on `SIGTERM` |
| `08_logger.ts` | the pino logger, one structured line per event, level from `LOG_LEVEL` |
| `09_6_the_reproducible_container_con.Dockerfile` | the three-stage image: build the TypeScript, build the CLIs from a pinned tag, copy both into a slim runtime as a non-root user |
| `10_7_ci_cd_pipeline_as_a_versioned.yaml` | the GitHub Actions workflow: build the image, smoke-test it with a real MCP round trip, and push to GHCR on main and on tags |
| `11_practical_exercises.json` | the banner-factory exercise contract: aspect table, palettes, output root |
| `12_practical_exercises.ts` | the manifest row shape and the two acceptable CLI invocation targets |

The numbered files are the chapter's listings; `src/` holds the same modules
in the layout the build expects, and `dist/` is the compiled output. The
numbered copies and their `src/` counterparts are byte-identical.

## Run it

```bash
cd chapter3/advanced_application_implementation/example/files
OUT="$(cd ../output && pwd)"
npx tsc -p tsconfig.build.json
CRAFT_IN_ROOT="$OUT/in" CRAFT_OUT_ROOT="$OUT/out" PORT=8081 node dist/index.js &
curl -sS -X POST http://localhost:8081/v1/render \
  -H 'content-type: application/json' \
  -d '{"tenantId":"acme","headline":"Summer Sale","subhead":"Velvet chair, ochre",
       "price":"$1199","productImagePath":"chair.png","accentColor":"#b8751f"}'
```

The server logs both sessions coming up, then answers with the artifact:

```
{"scope":"mcp","binary":"photocraft-cli","msg":"MCP session established (warm)"}
{"scope":"bootstrap","msg":"warm pool ready"}
{"scope":"bootstrap","port":8081,"msg":"worker listening"}
{"path":".../output/out/banners/acme-1792855911629.png","format":"PNG",
 "width":3840,"height":2160,"bytes":223906,
 "sha256":"373e5bc6112e69978e892792a08629ef260a9073fa52ed7f56eb5cf8bf57d929",
 "renderMs":238,
 "stages":[{"name":"photocraft.normalize","ms":198,"ok":true},
           {"name":"designcraft.compose","ms":39,"ok":true}]}
```

## What it produces

Paths are relative to `example/`:

| artifact | what it is |
| --- | --- |
| `output/out/stage-a/acme-*.png` | the normalized product image, before composition |
| `output/out/banners/acme-*.png` | the delivered banner, and the file the artifact's `sha256` covers |
| `output/in/chair.png` | the product image the sample request names, staged in the read root |
| `output/server-dist.log` | the structured server log: session boots, the listening line, the shutdown |
| `output/artifact.json` | the third response of the shipped run, saved as the artifact contract |
| `output/responses.jsonl` | all three responses, one JSON object per line |

Filenames carry a millisecond stamp, so a run adds a pair of files per request
rather than overwriting the last one. `run_all.sh` clears `out/banners` and
`out/stage-a` first, so the folder holds the last run's three requests; the
first of them cost 343 ms and the next two 238 ms and 238 ms, and
`artifact.json` is the third response (`responses.jsonl` has all three).

## Notes

- **Both CLIs must be on `PATH`:** `photocraft-cli` and `designcraft-cli`
  (`PHOTOCRAFT_CLI` and `DESIGNCRAFT_CLI` override the paths).
- **The two suites do not share a launch contract.** `photocraft-cli mcp`
  takes `--automation-read-root` / `--automation-write-root`;
  `designcraft-cli mcp` takes neither and resolves relative paths against its
  working directory, so the client has a `rootMode` switch.
- **Output directories must exist before the first command.** No Craft engine
  creates parent directories, so `index.ts` makes `in`, `out`, `out/stage-a`
  and `out/banners` at boot; without that, `doc_save` fails after a full
  render.
- **`npx tsc -p tsconfig.build.json` first.** The server runs from `dist/`,
  and `node --enable-source-maps dist/index.js` is what `npm start` does.
