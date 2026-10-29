# 11. Exercise 5: Headless Batch Render with Exact Duration Proof — solution

The worked duration-proof orchestrator. A sequence span is padded to an exact
48 kHz sample boundary, six deliverables are rendered, and each file's probe
is compared with the predicted count in samples.

## What it does

1. `expectedCounts()` divides the tick span by `5_292_000` and surfaces the
   residual instead of rounding.
2. `padToSampleBoundary()` pads the last clip with an ordinary out-trim when
   the span is not an exact multiple.
3. The TCP path authenticates first, exports each deliverable through
   `file.exportMedia`, polls `jobs.list`, and probes the output with
   `mediaBrowser.probe`.
4. A failure is recorded with a typed error class (`auth_failed`,
   `render_failed`, `probe_failed`) instead of aborting the batch.
5. `DurationProof.json` keeps every tick and sample count as a string.

## Run it

```bash
cd chapter11/solutions_and_explanations/exercise_5_headless-batch-render-with-exact-duration-proof-tcp-loopback-channel/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex5.ts
```

```
43 assertions passed
```

The harness checks the exact arithmetic and writes six real 48 kHz WAV
deliverables with the predicted sample count; the TCP path in `runBatch()` is
the production route to FilmCraft.

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/DurationProof.json` | six proofs with expected/actual samples, drift, frame count and residual |
| `output/deliverables/master-4k.wav` | deliverable 1 |
| `output/deliverables/web-1080.wav` | deliverable 2 |
| `output/deliverables/hevc-1080.wav` | deliverable 3 |
| `output/deliverables/av1-1080.wav` | deliverable 4 |
| `output/deliverables/archive-mxf.wav` | deliverable 5 |
| `output/deliverables/mix.wav` | deliverable 6 |
| `output/report.json` | span, expected samples and artifact list |
| `output/run_ex5.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/05_headless-batch-render-with-exact-duration-proof-tcp-loopback-channel.ts` | loopback client, sample math, padding, job polling, probe and manifest |
| `files/run_ex5.ts` | the acceptance harness: sample derivation, trim padding, six WAV proofs |
| `files/01_typescript.ts` | the deliverable and proof contract |
| `files/package.json` | npm scripts and dependencies |
| `files/tsconfig.json` | TypeScript config |

## Notes

- The generated WAVs are real 16-bit mono 48 kHz files; their sample count is
  read back from the RIFF header, so the proof is not self-reported.
- One sample is `254_016_000_000 / 48_000 = 5_292_000` ticks.
- Type-check it with `npm run check`.
