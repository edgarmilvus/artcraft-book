# 12. Advanced Application Implementation

CutRoom is the production-shaped version of the chapter's assembler: a
multi-tenant worker that turns a JSON job manifest into a finished H.264 cut
with no human at the timeline. It validates untrusted input, plans the edit as
a pure function, applies it as four independently rollback-able phases, audits
the result with rendered frames, and writes the export together with the plan
that produced it.

## What it does

`01_agentic-assembly.ts` is one module in thirteen sections. A manifest is
parsed by Zod before anything else happens: paths are resolved and checked
against the automation root, strings are length-capped, numbers range-clamped.
`FilmCraftSession` then launches `filmcraft-cli mcp` with `--automation-read-root`
and `--automation-write-root`, and every command goes through `command_run` or
`command_batch`.

Provisioning creates the project and a three-video/three-audio sequence,
imports the dialogue, music and B-roll in chunks, and resolves item ids from
`project.inspect`. The planner builds word stamps from the transcript, coalesces
them into beats, ranks B-roll with a small in-process BM25 index, and emits a
`CutPlan` whose silence windows and shot lengths satisfy the manifest's
constraints before a clip is touched.

The edit runs as four phases — `aroll`, `ripple`, `broll`, `audio` — each
wrapped in a `CheckpointGuard` that records the history depth and, on failure,
replays `edit.undo` back to it. The ripple phase razors both V1 and A1 at every
silence boundary, deletes the slivers with `edit.rippleDelete`, and then checks
that every `BEAT-n` marker still lands where the analytic `RippleMap` predicted.
B-roll lands on V2 post-ripple with incoming and outgoing cross dissolves; the
music bed is laid on A2, typed with `essentialSound.setType`, normalized with
`essentialSound.autoMatch` and ducked with `essentialSound.generateDucking`.

Verification renders one frame per B-roll shot plus samples across the A-roll,
six at a time, and fan-outs the PNGs to a `VisionAuditor`. A failed audit fails
the job instead of exporting. The export phase calls `file.saveAs`,
`file.exportMedia` (H.264, VBR 2-pass), and refuses to return a path whose file
is missing or smaller than 1 KiB.

## The listings

| file | what it is |
| --- | --- |
| `01_agentic-assembly.ts` | timebase, manifest schema, session, normalizers, transcript anchoring, BM25, cut planner, ripple map, checkpoint guard, vision auditor, orchestrator and job entrypoint |
| `run_forge.ts` | the harness: synthesizes media, supplies a transcript and an approving auditor, runs one job, checks the artifacts |
| `package.json` | `check` and `harness` scripts, plus the MCP SDK, Zod and pngjs |
| `tsconfig.json` | the strict TypeScript configuration |

## Run it

```bash
cd chapter12/advanced_application_implementation/example/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_forge.ts
```

The job logs one JSON event per phase, then the harness checks the result and
the audit:

```
{"phase":"ripple","message":"silence excised","data":{"slivers":2,"removedSec":1,"markerDriftSec":0}}
{"phase":"broll","message":"b-roll placed","data":{"shots":1,"transitions":2,"coverage":0.725}}
{"phase":"verification","message":"audit complete","data":{"audited":3,"failures":0}}

PASS result: the file exists
PASS result: the b-roll covers the edit
PASS result: nothing rolled back
PASS audit: the frames are PNGs

10 assertions passed
```

## What it produces

Everything lands under `files/output/`, split by sandbox role:

| artifact | what it is |
| --- | --- |
| `read/dialogue.png`, `read/music.wav` | the input media the harness writes into the read root |
| `read/broll-city.png`, `read/broll-desk.png` | the two B-roll candidates |
| `write/cutroom/acme/job-0001/assembly.mp4` | the exported H.264 assembly |
| `write/cutroom/acme/job-0001/assembly.fcproj` | the project file, so an editor can pick the job up |
| `write/cutroom/acme/job-0001/cutplan.json` | coverage, runtime, silence windows and the shots that were placed |
| `write/cutroom/acme/job-0001/manifest.json` | the validated manifest, kept for reproducibility |

## Notes

- **`filmcraft-cli` must be on `PATH`.** Both roots are passed explicitly, and
  every path in the manifest is checked against the read root.
- **The harness supplies its own transcript and auditor**, so no speech model
  and no API key are needed to run it. `OpenAiVisionAuditor` is the production
  implementation and reads `OPENAI_API_KEY` only if you construct it.
- **The timebase is exact.** `secToTicks` rounds to the nearest tick at
  254 016 000 000 ticks per second, and the worker refuses timelines longer than
  124 000 s where `Number` would lose precision.
- Type-check with `npm run check`.
