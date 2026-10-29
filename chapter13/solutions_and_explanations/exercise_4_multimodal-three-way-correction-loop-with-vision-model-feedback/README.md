# 13. Exercise 4: Multimodal Three-Way Correction Loop — solution

The worked vision-guided grade loop. A rendered frame is measured numerically,
graded by a vision model, corrected one band at a time, and stopped when both
signals agree or the loop starts oscillating.

## What it does

1. Converts the luma waveform bins to min/max/mean-Y IRE and applies the
   numeric gate: 0 ≤ min, max ≤ 100, midtone mean in 25–75.
2. Sends the frame to the model with a strict JSON contract; a malformed
   response gets one retry, then a deterministic fallback.
3. Applies the three shadow/midtone/highlight adjustments in one
   `command_batch` and reads the scopes again.
4. Converges only when the numeric gate and `status: "ok"` both pass.
5. `is_oscillation()` detects opposite hue/balance signs across recent
   corrections and halts rather than ping-ponging.
6. Records every iteration with the frame hash, parsed model answer, applied
   steps, scope readout and pass flags.

## Run it

```bash
cd chapter13/solutions_and_explanations/exercise_4_multimodal-three-way-correction-loop-with-vision-model-feedback/files
PY=$("../../../../tools/pick_python.sh")
"$PY" run_ex4.py
```

```
20 assertions passed
```

The harness checks the scope gate and oscillation core and writes a real
verification frame; `run_agentic_grade()` is the TCP + OpenAI path.

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/verification.png` | a 960×540 graded Program-monitor frame |
| `output/scopes.json` | clean, crushed and clipped scope readouts |
| `output/agentic_grade_report.json` | two iterations, corrections, hashes and final grade state |
| `output/report.json` | assertion count, verdict and artifact list |
| `output/run_ex4.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/04_multimodal-three-way-correction-loop-with-vision-model-feedback.py` | TCP auth client, scope parser, numeric gate, oscillation detector and loop |
| `files/run_ex4.py` | the acceptance harness: scope metrics, oscillation, fallback and report |
| `files/01_typescript.ts` | the audit contract |

## Notes

- The oscillation detector compares the actual Lumetri wheel writes, not the
  model's prose.
- A malformed model answer can never become a pass.
- Python 3.10 or newer, with `Pillow` and `openai` from the repository
  environment.
