# 19. Exercise 3: Multimodal Colour-Grading Loop — solution

The worked Apex Frame grade. LightCraft is driven over authenticated TCP, a
vision model scores each rendered photo, and bounded nudges converge on the
house look.

## What it does

1. Opens the LightCraft control channel and sends the `auth` frame first; any
   other first frame is rejected.
2. Imports the three bracketed DNGs into a persistent catalog and develops
   each photo with the house baseline.
3. Renders a preview, asks the vision reviewer for a score, and applies one
   bounded nudge per iteration to the named control (`light.exposure`,
   `light.shadows`, `light.temperature`, …).
4. Stops on convergence, the iteration ceiling or a timeout; the journal
   records the photo, the control, the before/after values and the engine's
   own history.
5. Survives a restart: delivered photos are skipped, the unconverged photo is
   retried, and the audit trail is appended, never truncated.
6. Runs a tight-budget pass and trims the output files to that budget; a path
   guard refuses anything outside the Apex tree.

## Run it

```bash
cd chapter19/solutions_and_explanations/exercise_3_multimodal-colour-grading-loop-with-lightcraft-tcp-auth-and-a-vision-llm/files
PY=$("../../../../tools/pick_python.sh")
"$PY" run_ex3.py
```

```
59 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/grade-summary.json` | per-photo iterations, scores, final controls and verdict |
| `output/grade-summary-restart.json` | the restart pass: skipped/retried photos |
| `output/grade-summary-trim.json` | the tight-budget result |
| `output/photo-2-01.jpg` | one delivered render |
| `output/grade-audit.jsonl` | the append-only engine-side audit trail |
| `output/work/renders/` | every rendered preview |
| `output/work/library/` | the persistent LightCraft catalog |
| `output/run_ex3.log` | shell-captured harness log |

## The listings

| file | what it is |
| --- | --- |
| `files/03_multimodal-colour-grading-loop-with-lightcraft-tcp-auth-and-a-vision-llm.py` | TCP client, catalog, develop loop, bounded nudges and trim guard |
| `files/run_ex3.py` | the real-engine acceptance harness with a scripted reviewer |
| `files/02_jsonc.jsonc`, `files/03_jsonc.jsonc` | the reviewer and audit contracts |

## Notes

- The TCP auth frame is mandatory and first, and the harness asserts the
  engine never saw a pre-auth command.
- The restart test proves the catalog and audit trail are persistent: a
  delivered photo is not nudged again and the log grows.
- The tight-budget pass proves the rendered files respect the byte budget, and
  the path guard raises on an escape.
- Type-check equivalent: `python3 -m py_compile` on the module and harness.
