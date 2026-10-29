# 20. Exercise 2: Multimodal Aesthetic Feedback Loop — solution

The worked colorist loop. A customer photo is developed, rendered, judged by
a vision model and nudged until the aesthetic score converges or the loop
stops for a reason.

## What it does

1. Starts a stub of PhotoCraft's authenticated control channel and proxies the
   calls to a real headless PhotoCraft session, so the composites the loop
   judges are real.
2. Requires the `auth` frame first; a missing or malformed token is a fatal
   startup error and the refused connection never reaches the engine.
3. Renders an iteration, asks the injected vision model for exposure,
   contrast, color harmony and the enumerated targets, then applies one
   bounded develop change.
4. Rolls a regression back to the pre-change composite and proves the restore.
5. Stops on convergence, a repeated verdict, an oscillation or the budget.
6. Delivers the best snapshot, the iteration log and the delivery report
   without ever writing the token.

## Run it

```bash
cd chapter20/solutions_and_explanations/exercise_2_the-multimodal-aesthetic-feedback-loop-closing-the-loop-between-tcp-auth-ui-scre/files
PY=$("../../../../tools/pick_python.sh")
"$PY" run_ex2.py
```

```
57 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/P-001-final.png` | the delivered composite for P-001 |
| `output/P-001-delivery.json` | score, decision, cost and the chosen snapshot |
| `output/P-001-iterations.json` | every iteration and develop change |
| `output/P-002-final.png`, `P-002-delivery.json` | the rollback/oscillation case |
| `output/work/out/P-001/` … `P-004/` | every render, after-image and restore |
| `output/work/in/customer.png` | the source photograph |
| `output/run_ex2.log` | shell-captured harness log |

## The listings

| file | what it is |
| --- | --- |
| `files/02_the-multimodal-aesthetic-feedback-loop-closing-the-loop-between-tcp-auth-ui-screenshot-and-a-vision-model.py` | control channel, render/audit loop, rollback and delivery |
| `files/run_ex2.py` | the real-engine acceptance harness with a stub control channel |

## Notes

- The token never appears in the delivery report or the iteration log.
- The stub rejects a first frame that is not `auth`, and the harness counts
  the refusals.
- A repeated or oscillating verdict stops the loop instead of spending the
  whole budget.
- Type-check equivalent: `python3 -m py_compile` on the module and harness.
