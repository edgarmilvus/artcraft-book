# 20. Exercise 3: Autonomous Trailer Assembly — solution

The worked FilmCraft trailer. A manifest supplies B-roll, a music bed and a
beat grid; the assembler cuts to the tempo, ripples graphics with the picture
and proves the result against the engine's own sequence and mixer reports.

## What it does

1. Synthesizes real B-roll and a real music bed, then detects beats and maps
   them to frame ticks (`TICKS_PER_FRAME`, `TICKS_PER_SEC`, `frameToTicks`,
   `ticksToFrames`).
2. Cuts the acts on beat boundaries, including two cross dissolves and a dip
   to black.
3. Applies a ripple edit: picture and graphics move together, while the
   ambience bed stays locked.
4. Ducks the music under the voice-over and applies one loudness correction on
   the mix bus.
5. Writes `beats.json`, `sequence_inspect.json`, `mixer_inspect.json` and a
   decision report with a SHA-256 hash.
6. Re-runs the same manifest and gets the same decisions; a short-rush case is
   clamped but still produces a contiguous row and a trailer.

## Run it

```bash
cd chapter20/solutions_and_explanations/exercise_3_autonomous-trailer-assembly-ripple-aware-tempo-synced-editing-in-filmcraft-via-m/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex3.ts
```

```
41 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/trailer_firstcut.mp4` | the rendered trailer |
| `output/trailer_report.json` | cuts, transitions, ducking, loudness and decision hash |
| `output/beats.json` | the detected beat grid in ticks |
| `output/trailer_report_clamped.json` | the short-rush clamp case |
| `output/work/runs/first-cut/`, `clamped/`, `first-cut-repeat/` | engine sequence/mixer reports and media |
| `output/run_ex3.log` | shell-captured harness log |

## The listings

| file | what it is |
| --- | --- |
| `files/03_autonomous-trailer-assembly-ripple-aware-tempo-synced-editing-in-filmcraft-via-mcp.ts` | beat detection, ripples, transitions, mixer and report |
| `files/run_ex3.ts` | the real-engine acceptance harness |

## Notes

- The engine reports are the source of truth: the harness reads back the
  sequence and mixer rather than trusting the assembler's own summary.
- Ripples move picture and graphics, but the ambience bed is on a locked
  track and must not move.
- The loudness correction is applied exactly once.
- Type-check it with `npm run check`.
