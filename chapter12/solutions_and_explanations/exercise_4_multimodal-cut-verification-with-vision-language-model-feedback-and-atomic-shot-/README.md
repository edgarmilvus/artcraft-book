# 12. Exercise 4: Multimodal Cut Verification with VLM Feedback — solution

The worked cutdown verifier. Each brief opens on a rendered frame, the frame
is graded clause by clause, and a failed opening is replaced atomically while
the 15-second duration is preserved.

## What it does

1. Reads `briefs.json`, creates one 1080×1920 sequence per brief and imports
   the master film plus the B-roll pool.
2. Renders the opening frame at `max_side: 4096`, writes the base64 image
   block to disk and scores each clause of the art director's description.
3. Under `strict` severity a single clause below the threshold forces
   `match: false`.
4. A failed opening is replaced in one `command_batch`: clear the old clip,
   place the new B-roll at the same tick and duration with `insert: false`,
   and add the `VERIFIED_OPEN` marker. Captions and markers are re-timed.
5. The next candidate is a deterministic rotation through the pool, up to five
   attempts, with every attempt recorded.
6. A midpoint preview is always rendered and the audit written beside the
   explicit PNGs.

## Run it

```bash
cd chapter12/solutions_and_explanations/exercise_4_multimodal-cut-verification-with-vision-language-model-feedback-and-atomic-shot-/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_exercise4.ts
```

FilmCraft and `ffmpeg` must be on `PATH`:

```bash
export PATH="/path/to/repo/tools/craft-cli/bin:$PATH"
```

```
12 assertions passed
```

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/read/briefs.json` | the S01 brief, strict severity, threshold 75 |
| `output/read/master/brand_film.mov` | 20-second master |
| `output/write/cutdown_S01_attempt_0.png` … `_4.png` | one opening frame per attempt |
| `output/write/cutdown_S01_midpoint.png` | midpoint Program frame |
| `output/write/cutdown_S01_audit.json` | candidates, clauses, scores and decisions |
| `output/report.json` | accepted/rejected counts, call counts and artifact list |
| `output/run_exercise4.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/02_exercise4_vlm_cutdown.ts` | MCP transport, frame rendering, clause grader, atomic replacement and audit |
| `files/run_exercise4.ts` | the acceptance harness: synthetic film, one brief, real renders and audit checks |
| `files/01_typescript.ts` | the brief and audit contract |

## Notes

- The grader is a deliberate deterministic stub; no model or network is used.
- The replacement batch never ripples, so the total duration stays 15 seconds.
- Type-check it with `npm run check`.
