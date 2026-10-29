# 5. Exercise 3: An Autonomous Multimodal Correction Loop Using `ui_screenshot`, Vision Auditing, and Curves — solution

The worked answer to Exercise 3: a closed-loop tone-correction agent that
duplicates the master, renders the working document through
`doc_render_preview`, audits the PNG with a strict JSON vision contract,
validates any suggested curve, applies it, and stops on convergence, budget or
oscillation. The original master is never written.

## What it does

`CaptureRouter` deliberately does not use a window screenshot for color
auditing. The headless path calls `doc_render_preview` with the working
document index and records the returned image block; the bridge path reports
`isWindow: true` so the loop can escalate with exit code 4 instead of auditing
the wrong pixels.

`validateCurve` requires exactly four points, endpoints pinned at input 0 and
255, strictly increasing inputs, monotone non-decreasing outputs, and every
value inside `[0,255]`. A rejected curve triggers one re-query with the reason;
if the second suggestion is still invalid the loop exits with code 3.

`step()` creates `history.newSnapshot` before every edit, hashes the render,
logs the verdict and curve, and applies `layer.newAdjustmentLayer.curves` on
the first iteration or `layer.setAdjustment` afterwards. `runCorrection()` is a
fold over immutable `AuditState` values; on convergence it saves the duplicate
to `corrected.png` and closes it, leaving the read-root master byte-identical.

## The listings

| file | what it is |
| --- | --- |
| `03_an-autonomous-multimodal-correction-loop-using-ui-screenshot-vision-auditing-and-curves.ts` | the capture router, validator, step reducer and loop |
| `run_ex3.ts` | the acceptance harness — real PhotoCraft worker, scripted vision, saved assets |

## Run it

```bash
cd chapter5/solutions_and_explanations/exercise_3_an-autonomous-multimodal-correction-loop-using-ui-screenshot-vision-auditing-and/files
npx tsx run_ex3.ts
```

```
auditing…

PASS loop converged with exit code 0
PASS trajectory is the bootstrap state plus one state per audit
PASS vision model was asked twice, one render each
PASS every iteration logged a snapshot and a render hash
PASS audited renders are distinct, real PNG files
PASS corrected PNG was written and the master left untouched
PASS validator rejects malformed curves and accepts the valid one
PASS trajectory and event log were written for replay

8/8 checks passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/master.png` | the 320×200 gradient master, byte-identical before and after the run |
| `output/corrected.png` | the graded duplicate saved on convergence |
| `output/audit/iteration-1.png` | the first audited render (low contrast) |
| `output/audit/iteration-2.png` | the second audited render (converged) |
| `output/trajectory/events.jsonl` | one snapshot name, curve, verdict and render hash per iteration |
| `output/trajectory/trajectory.json` | the full immutable state trajectory and exit code |
| `output/report.json` | check results, hashes, call counts and asset list |
| `output/workspace/read`, `output/workspace/write` | the engine's pinned read/write roots |
| `output/run_ex3.log` | the harness log — eight checks and their tally |

The two audit frames are real 320×200 PhotoCraft renders (about 20 KB each),
not placeholder screenshots; the second differs from the first because the
curve was applied between audits.

## Notes

- **`photocraft-cli` must be on `PATH`.** The harness starts it with both
  automation roots pinned under `output/workspace/`.
- **No API key.** The harness injects a `ScriptedVision` object with the same
  `chat.completions.create` surface as the OpenAI client. The loop's production
  client drops in unchanged when `OPENAI_API_KEY` is set.
- The engine may read only from the read root, so the master is written under
  the write root first and copied across the capability boundary — the same
  path a tenant upload takes.
- The master hash is checked before and after the run; `corrected.png` must
  differ from it or the harness fails.
- Node.js 22.5+ and `npx tsx`.
