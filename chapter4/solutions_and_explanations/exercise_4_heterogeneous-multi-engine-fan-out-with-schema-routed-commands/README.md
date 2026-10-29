# 4. Exercise 4: Heterogeneous Multi-Engine Fan-Out — solution

The worked solution for Exercise 4. One catalog, four engines, one saga.
The harness uses four protocol-faithful stubs so it can observe exactly what
each loopback channel received; the production code opens the same ports with
the real engine processes.

## What it does

`FanOutOrchestrator.run({ catalogId, steps })`:

1. Opens one authenticated loopback channel per engine in catalog order
   (PhotoCraft `7878`, VectorCraft `7879`, DesignCraft `7880`, PdfCraft
   `7881`). Each channel sends `auth` first and starts its own five-second
   `ping` timer.
2. Runs `preflight` for every step before writing it. The command id must be
   in that engine's `commandCatalogShape`; every top-level key in the
   pseudo-signature must be present in `params`. A failure throws
   `PreflightError` and stops the run before the command reaches the wire.
3. Dispatches through the exhaustive `runStep` switch. The per-engine
   functions call `channel.execute(step.command, step.params)`, so the wire
   sees the step and not just an internal counter.
4. Registers a compensation closure for each successful step that declares
   `compensate`; on the first step failure it walks the table in reverse and
   reports the compensated step ids.
5. Opens a second, short-lived PdfCraft channel for `doc_compare`: a fresh
   broker token, two `doc_open` calls, `doc_compare`, then close in `finally`.
6. Emits a `RunManifest` with per-engine ports, command counts and warnings,
   assets written, failures and compensated steps.

## Run it

```bash
export PATH="$PWD/tools/craft-cli/bin:$PATH"
cd chapter4/solutions_and_explanations/exercise_4_heterogeneous-multi-engine-fan-out-with-schema-routed-commands/files
npx tsx run_ex4.ts
```

The harness starts four stubs on the catalog ports with fresh per-engine
tokens, runs one step per engine, waits for the last frames to flush, then
inspects the wire.

### What the output means

- The saga manifest lists the four engines in deterministic order and one
  command issued for each.
- The wire records:
  - PhotoCraft: `layer.newAdjustmentLayer.curves`
  - VectorCraft: `shape.rectangle`
  - DesignCraft: `file.open`
  - PdfCraft: `doc_open,doc_open,doc_open,doc_compare` — one step, two
    documents on the comparison channel, then the comparison itself.
- A missing `points` parameter and an unknown command both raise
  `PreflightError`, and the total command count is unchanged. The channels may
  be open, but no command frame was sent.
- `runStep` resolves for all four engine variants, proving the switch accepts
  every member of the closed `Engine` union.

## What it produces

| artifact | what it is |
| --- | --- |
| `output/run-manifest.json` | the full `RunManifest`, check list and per-engine wire traces |
| `output/run_ex4.log` | harness log with all 17 assertions |

The run ends with `17/17 checks passed`. No engine binary is required for
this exercise: all four peers are `EngineStub`, and the manifest is checked in
process as well as written to disk.

## Notes

- **Ports 7878–7881 must be free.** The tokens are generated per run and
  exported as `PHOTOCRAFT_TOKEN`, `VECTORCRAFT_TOKEN`, `DESIGNCRAFT_TOKEN` and
  `PDFCRAFT_TOKEN` before the orchestrator reads them.
- `preflight` is schema-driven: it parses top-level keys from the chapter's
  pseudo-signature and ignores nested brackets, so `{points: [[in,out],...]}`
  requires `points` and not `in`/`out`.
- The `runStep` dispatch is deliberately exhaustive. Adding a fifth engine to
  `Engine` breaks the switch at compile time instead of falling through at
  runtime.
- `execute` waits for the socket write, not for the engine reply; the saga's
  command counts therefore mean "frames accepted by the transport". The
  harness waits 350 ms before reading the stub traces so the last parsed
  frames are visible.
- Node.js 22.5+ and `tsx` are required.
