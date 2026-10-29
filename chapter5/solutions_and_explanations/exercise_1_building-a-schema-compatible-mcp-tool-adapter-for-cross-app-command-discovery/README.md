# 5. Solutions and Explanations

The worked answer to the chapter's first exercise: one adapter that asks eight
engines eight different questions and returns one normalized tool catalog.
Every app-specific fact lives in a single spec table, every `params` string goes
through the same best-effort parser, and the result carries a content hash so a
long-lived agent can diff two discoveries instead of reloading a registry.

## What it does

`ArtCraftDiscoveryAdapter` holds `APP_SPECS`, one entry per app. Each entry
gives the binary, the launch arguments, the exact discovery meta-tool and the
exact argument casing — DesignCraft wants `list_commands` with `enabledOnly`,
PhotoCraft wants `command_list` with `enabled_only`, EffectCraft wants
`list_commands` with `schemas: true`, PdfCraft takes `--root`, DesignCraft and
LightCraft take no sandbox flags at all because they confine to their working
directory. The extractor handles the three reply shapes the registries actually
use: a bare array, a `commands` wrapper, and DesignCraft's
`engine_commands.commands` envelope.

`parseParamsDoc` turns the human-readable documentation string into JSON
Schema. It finds the balanced brace block, splits parameter pairs at top-level
commas and colons, marks a trailing `?` as optional, strips a trailing `=N` or
`="literal"` into a `default`, and expands `a|b|c` into `anyOf`. Ranges like
`0..255` become `minimum`/`maximum`, quoted literals become `const`, and known
type words (`str`, `path`, `int`, `bool`, `percent`, `px`) map to JSON types.
The rule that matters is the failure mode: if any single field cannot be
parsed, the whole tool degrades to
`{type:"object", additionalProperties:true}` with `looselyTyped: true`, rather
than dropping a required argument the model would have to guess.

Names are built as `<app>_<slug(command id)>`, so `type.create` becomes
`photocraft_type_create` and every name is a legal function name. Meta-tools
(`doc_new`, `command_run`, …) are emitted with `commandId: null`, and PdfCraft
registry entries that map onto a meta-tool through the `tool` field keep the
registry id as canonical. `registryVersion` is the SHA-256 of the discovery
payload: stable across runs, different as soon as the registry changes.

`diff` compares two catalogs by name and payload hash and returns `added`,
`removed` and `changed` without touching `prev`. `buildCapabilityIndex` inverts
the array into a map from tool name to `{app, commandId, transportRequired}`.

## The listings

| file | what it is |
| --- | --- |
| `01_solutions_and_explanations.ts` | the adapter, the parser, the app specs, `diff` and `buildCapabilityIndex` |
| `run_discovery.ts` | the acceptance harness — eight engines, eight checks, eight catalog files |

## Run it

```bash
cd chapter5/solutions_and_explanations/exercise_1_building-a-schema-compatible-mcp-tool-adapter-for-cross-app-command-discovery/files
npx tsx run_discovery.ts
```

The harness writes `output/.mcp/config.json` with a read and a write root, then
discovers every engine and prints the catalog sizes:

```
PASS meta-tools are read from the live registry, not a static table
PASS every engine's catalog is discovered with its own naming
PASS registry commands are normalized into parameters + commandId
PASS command ids are kebab-normalized into tool names
PASS registryVersion is a content hash, stable across runs
PASS diff of two identical discoveries is empty
PASS diff reports removals without mutating the previous catalog
PASS capability index maps every tool back to its app and command

8/8 checks passed
```

The sizes are the argument for the meta-adapter: PhotoCraft 914 tools,
VectorCraft 610, FilmCraft 689, EffectCraft 677, DesignCraft 363, LightCraft
583, PdfCraft 298, WordCraft 404 — several thousand commands behind one shape.

## What it produces

| artifact | what it is |
| --- | --- |
| `output/.mcp/config.json` | the read and write roots the adapter is told to use |
| `output/discovery/read`, `output/discovery/write` | the empty sandbox the engines are pinned to |
| `output/discovery/catalog/photocraft.json` … `wordcraft.json` | one complete normalized catalog per app |
| `output/discovery/capability-index.json` | tool name → `{app, commandId, transportRequired}` |
| `output/discovery/diff-identical.json` | the empty patch from comparing the catalog with itself |
| `output/discovery/summary.json` | app counts, registry hashes and the check tally |
| `output/run_discovery.log` | the harness log — eight checks and their tally |

## Notes

- **All eight engine CLIs must be on `PATH`.** Each is spawned as a child
  process; the harness closes each session before moving on.
- DesignCraft exposes no `command_run`: the harness asserts that
  `designcraft_execute` exists and `designcraft_command_run` does not, because
  the vocabulary really does differ per app.
- Discovery is read-only against the engines; the config under `output/.mcp`
  is rewritten on every run, and the discovery root is replaced so stale
  catalogs cannot be mistaken for the current one.
- Node.js 22.5+ and `npx tsx`.
