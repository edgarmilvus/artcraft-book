# 1. Exercise 3: The Undoable Grade — FilmCraft Timeline Ripple with Live Lumetri Layers -- solution

A three-shot skincare timeline with a live Lumetri grade on every V1 clip and a
warm adjustment layer on V2. Deleting the middle shot must ripple the downstream
clip, keep every grade live, and undo/redo cleanly.

## What it does

1. Imports two LUTs (neutral and warm) into FilmCraft's LUT library.
2. Places three linked source shots on V1 (1920×1080, 30 fps), keeping a 0.5 s
   gap before shot 3.
3. Applies the neutral LUT plus primary corrections to each V1 clip and the warm
   LUT to a V2 adjustment layer spanning the sequence.
4. Ripple-deletes shot 2. V2 is sync-locked and blocks the ripple, so the batch
   unlocks V2, ripples, and relocks it; shot 3 shifts by the *actual* deleted
   clip duration (not by a rounded 6.5 s).
5. Walks back with `edit.undo` until the pre-ripple state is restored (two
   steps: the V2 relock and the ripple), then replays with `edit.redo`.
6. Saves the project and renders before/after frames at 8 s.

## Run it

```bash
cd chapter1/solutions_and_explanations/exercise_3_the-undoable-grade-filmcraft-timeline-ripple-with-live-lumetri-layers/files
npx tsx run_ex3.ts
```

The harness starts its own `filmcraft-cli mcp` server, drives the payloads from
`03_the-undoable-grade-filmcraft-timeline-ripple-with-live-lumetri-layers.ts`,
and exits non-zero on any failed assertion.

## What it produces

| artifact | what it is |
| --- | --- |
| `output/sequence-before.json` | inspected sequence with all three shots and both LUT layers |
| `output/sequence-after.json` | sequence after the ripple delete |
| `output/sequence-undo.json` | sequence after undoing the ripple |
| `output/sequence-redo.json` | sequence after redoing it |
| `output/frames/before-8s.png`, `output/frames/after-8s.png` | rendered frames |
| `output/skincare-30s.fcproj` | saved native project |
| `output/run-log.json` | checks, failures, engine notes, per-step results |
| `output/run_ex3.log` | full harness transcript |

## What is verified

79 checks, 0 failing:

- Both LUTs are registered with distinct `lib:` references.
- Three V1 clips on the expected starts, names and durations; shot 3 keeps its
  0.5 s gap.
- Every V1 clip has `lumetri.enabled` and the neutral LUT; no V1 clip carries
  the warm LUT.
- V2 is a single `Adjustment Layer` starting at 0, covering the whole sequence,
  with live Lumetri and the warm LUT.
- After the ripple, two V1 clips remain (shots 1 and 3), shot 1 is unchanged,
  shot 3 starts at its original start minus the deleted clip's duration, both
  durations are intact, the clips do not overlap, and the surviving grades are
  still live.
- Undo restores three clips with their original starts and clip IDs; redo
  returns to the two-clip layout at the shifted start; the project file is
  non-trivial and the previews are valid PNGs.

## Engine notes

- `lut.import` resolves a relative path against the process cwd, so the harness
  changes directory to the exercise folder first.
- `timeline.place` expects numeric ticks; a stringified tick count is ignored
  and the clip falls back to its natural media duration.
- The `clip` returned by `timeline.place` is not the id later edits use; every
  edit targets a clip id read back from `sequence_inspect`.
- `sequence_inspect` reports LUT references as `Text("lib:lut1")`, so the
  harness compares against that form.
- V2 is sync-locked and blocks the ripple delete: the batch unlocks it,
  ripples, and relocks it, which is why undo needs two steps.
- The ripple uses the deleted clip's real duration, so shot 3 lands at
  `1649579904000` ticks rather than a rounded 6.5 s.
