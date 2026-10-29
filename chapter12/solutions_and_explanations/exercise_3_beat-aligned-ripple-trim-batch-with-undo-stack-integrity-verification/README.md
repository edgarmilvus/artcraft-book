# 12. Exercise 3: Beat-Aligned Ripple-Trim Batch — solution

The worked beat-snap pass. A 122 BPM grid is built with bounded cumulative
error, V1 clips are moved and V2 clips are ripple-trimmed onto the nearest
beats, and the undo stack must restore the pre-run state exactly.

## What it does

1. `detect_beats()` reads the engine waveform and picks kick transients with a
   rising-edge detector, a local-mean threshold and a 250 ms refractory period.
2. `build_beat_grid()` takes the median inter-beat spacing as the BPM, anchors
   the first detected beat and accumulates whole ticks so the grid does not
   drift a frame every 90 seconds.
3. `nearest_beat()` snaps a clip edge to the closest grid tick.
4. V1 is moved with `timeline.move`; V2 is trimmed in/out with
   `timeline.trim`, `mode: "ripple"`; gaps under the thresholds are closed
   with `edit.rippleDelete`.
5. The pre-run sequence is snapshotted and one `edit.undo` per applied
   mutation must return every boundary to the snapshot; the first mismatch
   aborts the pass and is recorded.

## Run it

```bash
cd chapter12/solutions_and_explanations/exercise_3_beat-aligned-ripple-trim-batch-with-undo-stack-integrity-verification/files
PY=$("../../../../tools/pick_python.sh")
"$PY" run_ex3.py
```

```
24 assertions passed
```

The harness checks the pure grid and snap arithmetic; `main()` in the solution
is the live UNDO-integrity pass.

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/snap_report.json` | beat grid, two V1 snaps, ripple operations and undo verdict |
| `output/pre_run_sequence.json` | the snapshot the undo check compares against |
| `output/beats.csv` | every beat index and tick |
| `output/report.json` | BPM, cumulative error, snap count and artifact list |
| `output/run_ex3.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/02_exercise3_beat_snap.py` | MCP transport, transient detection, grid builder, snapping, ripple cleanup and undo verification |
| `files/run_ex3.py` | the acceptance harness: grid error, nearest beat and snap operations |
| `files/01_typescript.ts` | the beat grid and snap report contract |

## Notes

- The grid is built by integer accumulation; the cumulative error is reported
  against the ideal linear grid.
- The undo count is stored even when `statesMatched` is true, so a reviewer can
  replay the pass.
- Python 3.10 or newer.
