# Chapter 20 — the engines' real surfaces, and the two remote dependencies

Verified against the binaries in `tools/craft-cli/bin`. Nothing here is
inferred from documentation.

## The engines do *not* share a meta-tool surface

The chapter's `craft-client.ts` assumes they do. They do not.

| | PhotoCraft | VectorCraft | DesignCraft | FilmCraft | LightCraft | PdfCraft | EffectCraft |
| --- | --- | --- | --- | --- | --- | --- | --- |
| run one | `command_run { id, params }` | `command_run { id, params }` | `execute { command, params }` | `command_run { id, params }` | `command_run { id, params }` | `command_run { id, params }` | `execute_command { command, params }` |
| run many | `command_batch { steps }` | `command_batch { steps }` | `batch { commands }` | `command_batch { steps }` | `command_batch { steps }` | `command_batch { steps }` | `batch { steps }` |
| discover | `command_list { filter }` | `command_list { filter }` | `list_commands { filter, enabledOnly }` | `command_list { filter }` | `command_list { filter, enabled_only }` | `command_list { filter }` | `list_commands { filter, enabled_only }` |
| new | `doc_new { … }` | *(no meta-tool)* | `new_document { … }` | — | — | — | — |
| save | `doc_save { path, format }` | `save_file { path }` | `save_document { path }` | `file.save` (command) | — | `doc_save { path }` | `save_project` |
| render | `doc_render_preview` | `render_preview` | `render_page { page, path, scale }` | `render_frame` | `render_photo { id, path, size, format }` | `page_render { doc, page, dpi }` | `render_frame` |

PhotoCraft's `doc_new` answers `{ document: 0 }`; `doc_save`'s `format`
is a lower-case extension (`pcraft, psd, png, jpg, tif, webp, exr`);
`ui_screenshot { max_side }` answers with an **image** content block.

## The chapter's two remote dependencies

The basic example reaches for Supabase (Postgres + pgvector) and the
OpenAI embeddings API. Neither can run in a headless verification, and
neither *should* be a hard dependency of a listing that has to be
executable.

The honest adaptation, and the one the chapter should teach:

- **The vector store keeps the pgvector schema and drops the server.** The
  SQL migration stays as the production schema — `vector(1536)`, an HNSW
  index, and a `match_brand_assets` RPC. The runtime store is a local
  adapter over `node:sqlite` (built into Node 22+; the `sqlite3` CLI is
  also present) that stores the same rows and answers the same
  "nearest neighbors by cosine distance" query with a brute-force scan.
  The interface is the contract; the adapter is an implementation detail.
- **The embedding model is injected.** The production path is
  `text-embedding-3-small` (1536 dimensions, and the dimension must match
  the column exactly). The reference implementation takes an
  `EmbeddingModel` closure — a caller-provided `() => Promise<number[]>`
  — so the harness can supply a deterministic local embedder and the
  pipeline needs no API key.

Node 26 is installed, so `node:sqlite` is available with no dependency
at all.

## The SQL that ships with the chapter

The `0001_brand_assets.sql` migration is *production* DDL and is not
executed by the harness. It is correct as written: `create extension if
not exists vector`, a `vector(1536)` column, an HNSW index with
`vector_cosine_ops`, and a `match_brand_assets` RPC.

## The other chapter-20 surfaces

- **The PhotoCraft bridge** (`photocraftBridge.ts`) drives
  `photocraft-cli mcp` over stdio: `doc_new` → `command_run` per drawing
  step → `doc_save`. The renderer is real, so the harness can check the
  PNG it produced.
- **The campaign store** (`store.ts`) is already an in-memory store with a
  durable JSON journal — no server needed.
- **The budget guardrail** (`budget.ts`) is pure arithmetic — no server
  needed.
- **The copywriter** (`copywriter.ts`) already takes an injected
  `draftCopy` closure, so it needs no model.
- **The live bridge** (`live_bridge.py`) speaks the authenticated
  JSON-lines control protocol. The *token* is minted by the desktop app
  (`<app> --control PORT`), not by the CLI, and the CLI cannot open that
  channel itself — `gridcraft-cli --control 7999` answers "unknown
  subcommand". A harness therefore exercises the framing against a stub
  server it hosts itself.

## FilmCraft, in detail

The meta-tools are `command_run`, `command_batch`, `command_list`,
`media_import`, `doc_inspect`, `project_inspect`, `sequence_inspect`,
`render_frame`, `render_preview`, and the `ui_*` family.

### The tick base

FilmCraft declares `254_016_000_000` ticks per second. At 23.976 fps the
*real* rate is `24000/1001`, so

```
ticks per frame = 254_016_000_000 × 1001 / 24_000
                = 10_584_000 × 1_001
                = 10_594_584_000      ← exact
```

(`254_016_000_000 = 2^12 · 3^4 · 5^6 · 7^2` and `24_000 = 2^6 · 3 · 5^3`,
so the division is exact in integers.)

The decimal literal `23.976` is short of `24000/1001` by `2.4 × 10^-5` fps
— a relative error of exactly `10^-6`. That is 30 µs over thirty seconds
and about 7 ms over two hours, which is roughly a sixth of a frame.

### Export presets are display names

`file.exportMedia` takes `preset: str?` — and the built-ins are
*display names*, not slugs: "High Quality 1080p HD", "YouTube 1080p
Full HD", "Vimeo 1080p Full HD", "Match Source – Adaptive High
Bitrate", "Apple ProRes 422 HQ", "PNG Sequence", "Waveform Audio 48 kHz
16-bit", … List them with `export.presets.list`. There is no
`h264_hq_1080p`. The machine-readable field is `format`
(`h264|hevc|prores|dnxhr|apv|mjpeg|mxf-op1a|mxf-opatom|png|tiff|bmp|gif|wav|aiff`).

### The mixer

There is no effect called *Gain*. The gain effect is **`amplify`**, whose
parameter is `gain`, in dB, where 0 is unity — so the lane format
`fx.<slot>.<param>` gives `fx.0.gain` for the first insert.
`mixer.addInsert { effect: "gain" }` is rejected with "`gain` is not an
audio effect".

Opacity is an effect of its own: `effects.setParam { effect: "motion",
param: "opacity" }` fails with "no param `opacity`". The working
sequence is `effects.addKeyframe { clip, effect: "opacity", param:
"opacity", time }` **then** `effects.setParam { …, value, time }` — a
`setParam` with a `time` alone creates no keyframe.

### The sync lock

FilmCraft keeps a group's tracks sync-locked and *refuses* an edit that
would break the sync: "edit failed: this edit would break sync: V2 is
sync-locked and has a clip in the way (turn off its sync lock, or lock
the track, to make this edit)". A ripple across the group therefore has
to release the lock with `timeline.setTrack { track, syncLock: false }`
and restore it afterwards.

`edit.rippleDelete` with an empty `clips` array fails ("nothing
selected"), and a ripple *pulls* the following material earlier — so the
row it lands on has to be trimmed and rippled again to sit exactly on the
act boundary.

## The PhotoCraft control channel

The *desktop app* hosts the channel (`photocraft-cli --control 7978`
answers "unknown command `--control`"), and the methods on it are the
app's, not the MCP tool names:

| on the control channel | the MCP tool of the same job |
| --- | --- |
| `doc.render` | `doc_render_preview` |
| `doc.inspect` | `doc_inspect` |
| `ui.screenshot` | `ui_screenshot` (bridge mode only) |
| `engine.execute` | `command_run` |
| `engine.commands` | `command_list` |

The sandbox refusal comes from the *file* methods (`doc.open`,
`doc.save`), not from `engine.execute`, and it reads "automation path
rejected: absolute paths must be inside the automation root: `<path>`".
The engine says *automation root*, not *sandbox*.

`edit.undo` restores exactly **one** history step, and a single change
can span several — the grain plate alone is five commands. To restore an
exact pre-change composite, take a snapshot with `history.newSnapshot`
and come back to it with `history.selectSnapshot`.

## The adjustment layers

`image.adjustments.*` exists in the registry, and every id the book
names is real — but those commands are *destructive* on the composite,
and `colorBalance` takes a three-vector tone rather than a scalar, so
`highlights`/`whites` cannot both map to `levels.inWhite` and
`temperature`/`tint` cannot both map to `colorBalance`. The
non-destructive family is `layer.newAdjustmentLayer.{levels,
colorBalance, vibrance, hueSaturation, brightnessContrast}` plus
`layer.setAdjustment`, and each layer is re-sent as a whole parameter
set, so the values are absolute and idempotent.
