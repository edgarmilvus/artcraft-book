# 4. Exercise 3: Multimodal Color-Grading Correction Loop — solution

The worked solution for Exercise 3. The loop drives the real FilmCraft engine
over MCP for renders and sequence inspection, and the chapter's authenticated
loopback socket for screenshots and heartbeat. The socket peer is the
protocol stub in `chapter4/_harness/engine-stub.ts`; FilmCraft is the real binary.

## What it does

`ColorCorrectionLoop.run(run, { port, token, filmcraftArgs })`:

1. Opens the loopback socket, sends `auth` as frame #1, and starts a
   five-second `ping` heartbeat.
2. Starts `filmcraft-cli mcp` (the harness adds `--demo` so there is an
   active sequence) and connects the MCP client.
3. For each requested target second, calls `render_frame`, writes the returned
   PNG to the audit path, asks the vision auditor for a verdict, reads the
   current effect parameters, and applies only relative deltas when the verdict
   is not `ok`.
4. Handles a `judder_detected` verdict with the batch trim + mask-blur +
   optical-flow sequence.
5. Records every cycle as a frozen `CycleRecord` with the frame path, verdict,
   parameters before the edit, applied deltas, ΔE and duration.
6. Prunes the audit directory to the three most recent frames and stops a clip
   when the verdict is `ok` and ΔE is under the target, or when three
   consecutive improvements are seen.
7. Closes the heartbeat, socket and MCP child in `finally`, even after a
   failure.

The exercise's vision auditor is a fixed `ok` verdict and the ΔE computation
is fixed at `0.5`; those are the seams where a production vision model and a
real CIELAB comparison plug in.

## Run it

```bash
export PATH="$PWD/tools/craft-cli/bin:$PATH"
cd chapter4/solutions_and_explanations/exercise_3_multimodal-color-grading-correction-loop-for-filmcraft-using-ui-screenshot-style/files
npx tsx run_ex3.ts
```

The harness changes into the solution's `output/` directory, removes the old
`audit/` tree, starts the loopback stub on port `7905`, and runs three target
seconds with `maxCyclesPerClip: 3`.

### What the output means

- The auditor returns `ok` and the fixed ΔE is `0.5`, so each target second
  converges in exactly one cycle: `[1,1,1]`.
- All three records belong to the same clip outcome (`seq-1`), so
  `clipOutcomes` has one converged entry and the final ΔE is below `1.0`.
- The stub records `auth` once and `ui.screenshot` once per rendered frame.
  The `ping` interval is five seconds, so a run this short finishes before the
  first heartbeat; the harness therefore asserts the auth and screenshot
  traffic, not a ping that would require a five-second wait.
- The audit directory ends with exactly three 512×288 PNG files (about 53 KB
  each), all real FilmCraft renders rather than stub screenshots, because
  rotation keeps the newest three frame paths.

## What it produces

| artifact | what it is |
| --- | --- |
| `output/audit/cycle-*.png` | the three retained preview frames |
| `output/run-log.json` | checks, failures, cycle records, outcomes and audit file list |
| `output/run_ex3.log` | harness log with all 13 assertions |

The run ends with `13/13 checks passed`.

## Notes

- **FilmCraft must be on `PATH`.** The loop starts `filmcraft-cli mcp`; the
  harness adds `--demo` so `render_frame` has an active sequence. The raw TCP
  peer is the only part stubbed, because FilmCraft does not ship that surface.
- The frame paths are relative to the process working directory because the
  loop's rotation and audit listing use `audit/`. The harness `chdir`s into
  `output/` before the run so the artifacts stay with the solution.
- `ui.screenshot` is answered by the stub, which writes a valid 1×1 PNG at the
  requested path. That file is immediately overwritten with the image block
  returned by the real `render_frame` call, so the audit trail contains the
  actual GPU/CPU frame the vision step saw.
- Port `7905` must be free. Override it with `RUN_PORT` when running the harness
  twice in parallel.
- Node.js 22.5+ and `tsx` are required.
