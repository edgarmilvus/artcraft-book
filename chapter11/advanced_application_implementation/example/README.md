# 11. Advanced Application Implementation

A SaaS-grade **beat-cut worker** for FilmCraft. It takes a tempo, a meter, a
clip set and a music bed, plans the cuts in exact rational arithmetic, hands
the plan to the engine, reads the timeline back, and proves the engine holds
every tick the plan asked for. The same artifact can be a Next.js route, a
Kubernetes sidecar or a CI step: the moving parts are `BigInt` and the MCP
client.

The design has four properties: rounding to integer ticks happens once, at
the serialization boundary; frame durations are rationals, never decimals;
the same job produces the same sequence every time; and a drift audit
quantifies what the naive float path would have cost.

## What it does

`timebase.ts` is the exact-rational kernel: `Rational` holds an immutable
numerator and denominator in lowest terms, and `Timebase` converts between
ticks, frames, samples and seconds without ever leaving the integer
domain. `drift-audit.ts` runs the naive `t += 1/fps` accumulator alongside
the exact path and reports the divergence in seconds, ticks, frames, samples.

`filmcraft-mcp.ts` is the bridge. It owns the stdio child process, the
read and write roots, and the semantic shape of the commands the sequencer
uses — `file.newSequence`, `file.import`, `timeline.place`, `timeline.razor`,
`timeline.trim`, `effects.setParam`, `sequence_inspect`, `render_frame`,
`file.exportMedia` — plus a `batch()` that sends an ordered list of steps in
one frame.

`zero-drift-sequencer.ts` is the orchestration. `plan()` is a pure function:
it computes the beat interval as `Rational.of(TICKS_PER_SECOND).mul(60).div(bpm)`,
derives every beat as `k * beatInterval` from a closed expression rather
than by accumulation, and returns the cut ticks. `dispatch()` is the only
place a rational crosses into JSON — it creates the sequence, imports the
media, resolves the item ids, places each clip, lays the music bed on `A1`,
adds the crossfades and then reads the timeline back to verify it.

`pipeline.ts` glues the two halves into a job: it audits the drift first,
refuses to dispatch a plan whose duration is more than a second away from
the intended musical duration, exports the media and renders a QA frame.
`route.ts` is the Next.js App Router handler around it.

## The listings

| file | what it is |
| --- | --- |
| `timebase.ts` | the exact-rational kernel: `Rational`, `Timebase`, the frame-rate table |
| `drift-audit.ts` | the `DriftAuditor`: the float path against the exact path, in ticks and frames |
| `filmcraft-mcp.ts` | the typed wrapper over `filmcraft-cli mcp` — the child process, the roots, the command shapes |
| `zero-drift-sequencer.ts` | the planner and the dispatcher: plan in rationals, dispatch once, read back |
| `pipeline.ts` | the worker: `runBeatCutJob()`, the CLI entry point, the drift report |
| `route.ts` | the Next.js `POST` handler that takes a job as JSON |
| `practical_exercises.ts` | the types and the command shapes the chapter's exercises build against |
| `06_module_5_pipeline_ts_concrete_sc.json` | a concrete job: 96 bpm, 16 cuts, 29.97 fps |
| `07_module_5_pipeline_ts_concrete_sc.txt` | the beat and bar intervals that job produces, in ticks |
| `run_forge.ts` | the harness: the drift audit, the plan, the engine round trip |
| `package.json` | the project's scripts and dependencies |
| `tsconfig.json` | the ES2020 target the `BigInt` literals need |

## Run it

```bash
cd chapter11/advanced_application_implementation/example/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_forge.ts
```

The harness synthesizes two still frames and a twelve-second tone, audits
the drift, and then runs the whole job against the engine:

```
# the drift audit
PASS drift: the float path drifts
PASS drift: the exact path does not

# the plan and the sequence
PASS plan: four cuts
PASS plan: the second cut is at two seconds
PASS sequence: the clips are on the timeline

# the verification
PASS verify: the engine held every tick
PASS frame: a PNG came back

18 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `files/output/media/clip-a.png` | the first still frame, synthesized by the harness |
| `files/output/media/clip-b.png` | the second still frame |
| `files/output/media/music.wav` | the twelve-second 440 Hz tone that stands in for the music bed |

The drift report and the QA frame come back inside the job's return value
rather than on disk: `driftReport` is the audit text, `framePngBase64` the PNG.

## Notes

- **`filmcraft-cli` must be on `PATH`.** The bridge spawns it as a child
  process and passes the read and write roots the job declares.
- **The run needs no model, no database and no network.** The media is
  generated in-process and the audit is arithmetic.
- **The plan is deterministic.** The same job tuple produces the same tick
  positions on every run; nothing in the placement path is random.
- **`npx tsx`, not `node`.** The listings are TypeScript with `.js`
  specifiers; `tsx` resolves them. Type-check with `npm run check`, which is
  `tsc --noEmit`.
- The route reads `FILMCRAFT_INPUT_ROOT`, `FILMCRAFT_OUTPUT_ROOT` and
  `FILMCRAFT_JOB_TIMEOUT` (seconds, default 900).
