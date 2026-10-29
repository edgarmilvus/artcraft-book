# 6. Exercise 3: Autonomous Agentic Correction Loop — Screenshot, Critique, Re-Clip, Repeat -- solution

The worked answer to Exercise 3: a bounded Python loop that talks to the
authenticated loopback control channel, renders the document, sends the raster
to a vision model, parses the critique as engine commands, applies them, and
stops on convergence, deadlock or the iteration cap.

## What it does

`CraftControlClient` opens the TCP socket and sends the auth frame before any
other method. A bad token raises `ConnectionRefusedError` before a command is
dispatched, and a client that never authenticates gets `ControlError` on its
first call.

`art_director_loop` runs at most four iterations. Each iteration saves a preview
and a window frame, asks the injected `VisionModel` for a critique, validates it
against `CRITIQUE_SCHEMA`, and — when the verdict is `fix` — applies the
matching correction in decreasing severity order. The correction table covers
clipping, legibility, palette and composition, and each correction bounds its
geometry to 5 % of the canvas side.

Corrections converge rather than accumulate: a clipping fix releases and
re-creates one mask, a legibility fix confines a scrim with a marquee, a palette
fix edits one hue/saturation layer in place, and a composition fix nudges the
product group by at most 96 px. A critique that repeats verbatim is reported as
a deadlock; nothing is applied twice. On any terminal failure the loop undoes
exactly the history states its corrections added.

## The listings

| file | what it is |
| --- | --- |
| `03_autonomous-agentic-correction-loop-screenshot-critique-re-clip-repeat.py` | the client, critique schema, correction table, loop and audit trail |
| `art_director.py` | import alias for the worked module |
| `run_ex3.py` | the acceptance harness — convergence, deadlock, schema violation and auth failures |
| `stub_control_server.py` | protocol-faithful loopback stub that renders a real 320×200 frame per iteration |
| `requirements.txt` | `jsonschema` and `Pillow` |

## Run it

```bash
cd chapter6/solutions_and_explanations/exercise_3_autonomous-agentic-correction-loop-screenshot-critique-re-clip-repeat/files
PY=$("../../../../tools/pick_python.sh")
"$PY" run_ex3.py
```

`pick_python.sh` resolves the repository virtual environment, which carries the
`jsonschema` and `Pillow` this exercise needs. Any Python 3.10+ interpreter with
those two packages works the same way.

```
PASS the loop resolved on the ok verdict
PASS it took three iterations
PASS a resolved run rolls nothing back
PASS the decision tree explains every iteration
PASS one record per iteration was written, with both PNGs
PASS the loop released and re-created the clip
PASS the scrim is confined by a marquee, not a transform
PASS the palette correction edited one layer instead of stacking
PASS every audited render is a real 320x200 PNG
PASS successive renders are visibly different
PASS an unchanged critique is reported as a deadlock
PASS the deadlock stops at the second iteration
PASS every planned undo ran
PASS the document is back at its opening history depth
PASS a schema violation is reported, not swallowed
PASS nothing was applied for a rejected critique
PASS a bad token is refused before any command
PASS an unauthenticated command is refused

18/18 checks passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/audit-resolved/iter-1.png` | the first 320×200 preview, before corrections |
| `output/audit-resolved/iter-2.png` | the preview after the clipping and legibility fixes |
| `output/audit-resolved/iter-3.png` | the preview that receives the clean verdict |
| `output/audit-resolved/iter-1-window.png`, `iter-2-window.png`, `iter-3-window.png` | the matching window captures |
| `output/audit-resolved/iter-1.json`, `iter-2.json`, `iter-3.json` | critique, commands, undo cost and history depths per iteration |
| `output/audit-resolved/summary.json` | resolved flag, iteration count, undo accounting and decision tree |
| `output/audit-deadlock/` | the repeated-critique run, including both frames and the summary |
| `output/audit-schema/` | the schema-violation run: frames and summary, with no commands applied |
| `output/report.json` | every check, all three scenario summaries, server calls and artifact hashes |
| `output/run_ex3.log` | the harness log — eighteen checks and their tally |

The preview and window frames are real 320×200 PNGs drawn by the stub from the
document's layer and history state, so successive iterations differ. A resolved
run leaves its corrections in place; the deadlock run's document returns to the
history depth it opened at.

## Notes

- **Python 3.10+.** `jsonschema` validates the vision contract and `Pillow`
  draws the stub's audit frames; `tools/install_python_deps.sh` installs both.
- **No API key.** The harness injects `ScriptedVision`, which has the same
  `critique(png)` surface as `OpenAIVisionModel`. The production adapter imports
  the OpenAI SDK lazily and is never constructed by the test.
- The stub keeps a tiny document model and a real history stack, so undo
  accounting is exercised rather than mocked.
- `python3 run_ex3.py` must be run from the project's `files/` directory: the
  harness imports `art_director` from there.
