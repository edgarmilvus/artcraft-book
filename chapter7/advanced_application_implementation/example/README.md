# 7. Advanced Application Implementation

The Aperture loop: a multimodal visual feedback system that drives a headless
PhotoCraft session through its MCP server, renders pixels, sends them to a
vision model, turns the critique back into engine commands, and converges on
an accepted result. It is the reference implementation of the chapter's
architecture; the multi-engine fan-out is the exercises' subject.

## What it does

The orchestrator receives a job manifest (copy, assets, brand rules,
acceptance criteria). It boots the required engines, runs a prefilter pass
to catch obvious defects, then enters the aperture loop:

1. **Render** — the current document state to a PNG via `doc_render_preview`.
2. **Audit** — send the PNG + structural digest to a vision model; the model
   returns a JSON list of `Correction` objects (engine, command, params).
3. **Compile** — validate each correction against the engine's schema,
   batch them, and execute.
4. **Converge** — `decide()` applies five ordered rules (escalate verdict,
   confidence floor, pass, `maxCycles` — default 3 — then regression/stall) and
   returns accept, iterate, rollback or escalate.

Two harnesses exercise it: `run_aperture.ts` (TypeScript orchestrator) and
`run_python_loop.py` (Python variant that uses the TCP loopback channel).

## The listings

| file | what it is |
| --- | --- |
| `src/contracts.ts` | brief and critique schemas, channel profiles |
| `src/session.ts` | one `photocraft-cli mcp` child, with batch and undo helpers |
| `src/base-edit.ts` | deterministic base edit from the brief |
| `src/prefilter.ts` | histogram and CLIP checks before the vision model sees anything |
| `src/audit.ts` | vision-model prompt construction and response parsing |
| `src/compiler.ts` | allowlist-enforced `command_batch` assembly |
| `src/convergence.ts` | the five-rule `decide()` reducer |
| `src/snapshots.ts` | `SnapshotRing(4)` for rollback |
| `src/orchestrator.ts` | the aperture loop itself |
| `src/pixels.ts` | raster helpers: decode, mean-absolute delta |
| `11_aperture_loop.py` | Python variant using the TCP loopback channel |

## Run it

```bash
cd chapter7/advanced_application_implementation/example/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_aperture.ts
PY=$("../../../../tools/pick_python.sh")
"$PY" run_python_loop.py
```

```
127 assertions passed
27 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `files/output/a-accepted.jpg` | accepted revision |
| `files/output/b-revised.jpg` | after one correction pass |
| `files/output/c-rollback.jpg` | rollback snapshot |
| `files/output/d-capped.jpg` | capped at max passes |
| `files/output/e-unsure.jpg` | low-confidence vision result |
| `files/output/f-prefilter.jpg` | prefilter catch |
| `output/run_aperture.log` | TypeScript harness log |
| `output/run_python_loop.log` | Python harness log |

## Notes

- `photocraft-cli` on `PATH` (via `tools/craft-cli/bin`).
- No provider key required: the vision model is an injected function; the
  harness uses a deterministic stub.
- The Python variant needs Python 3.10+ and the repo `.venv`.
