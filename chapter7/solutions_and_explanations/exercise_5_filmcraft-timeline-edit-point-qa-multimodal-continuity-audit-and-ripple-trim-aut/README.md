# 7. Exercise 5: FilmCraft Timeline Edit-Point QA — Multimodal Continuity Audit and Ripple-Trim Auto-Correction — solution

The worked solution for Exercise 5. It walks every hard cut on `V1`, renders
the frames that straddle the cut, asks a vision model one numeric question
about the pair, analyzes the linked audio locally, and applies guarded
FilmCraft remediations.

## What it does

1. Builds a four-clip sequence with three hard cuts and a four-clip linked
   audio track carrying a deliberate pop at the third cut.
2. Extracts every edit point with `sequence_inspect`.
3. Renders the prior, A-end and B-start frames around each cut.
4. Sends the frame pair to the vision model with a strict JSON schema:
   horizontal jump fraction, shift direction, luminance delta, and an
   explicit `is_numeric_claim` flag. A non-numeric answer is retried once and
   then marked unverifiable.
5. Measures the audio discontinuity locally from the source WAV.
6. Plans a remediation: a ripple trim for a jump cut, a one-second exposure
   ramp for a luma shift, an audio crossfade for a pop, or human review when
   the rules require it.
7. Applies the batch behind a clip-table snapshot and a downstream SSD
   guard. If the downstream frame changes too much, the batch is undone and
   the clip table must match exactly.
8. Re-inspects the sequence and writes the per-cut audit.

## The fixtures

The harness generates four `1920×1080` stills with a moving head and a
brightness step, plus an eight-second 48 kHz WAV with a sample pop exactly at
the third cut. The rendered evidence frames are `640×360` proxies.

## Run it

```bash
cd chapter7/solutions_and_explanations/exercise_5_filmcraft-timeline-edit-point-qa-multimodal-continuity-audit-and-ripple-trim-aut/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex5.ts
```

The engine CLI must be on `PATH`:

```bash
export PATH="/path/to/repo/tools/craft-cli/bin:$PATH"
```

```
107 assertions passed
```

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/audit_report.json` | per-edit-point findings, planned remediation, applied state and rollback record |
| `output/frames/cut-1-prior.png` | frame before the first cut |
| `output/frames/cut-1-a-end.png` | outgoing frame at the first cut |
| `output/frames/cut-1-b-start.png` | incoming frame at the first cut |
| `output/frames/cut-2-*.png` | the three frames around the luma-shift cut |
| `output/frames/cut-3-*.png` | the three frames around the audio-pop cut |
| `output/summary.txt` | human-readable sequence and finding counts |
| `output/report.json` | sequence, findings, assertion count and artifact list |
| `output/run_ex5.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/05_filmcraft-timeline-edit-point-qa-multimodal-continuity-audit-and-ripple-trim-auto-correction.ts` | edit-point model, numeric vision contract, audio analysis, remediation and guards |
| `files/run_ex5.ts` | the acceptance harness: generated media, live sequence, unverifiable path and rollback |
| `files/package.json` | npm scripts and dependencies |
| `files/tsconfig.json` | TypeScript config |

## Notes

- `filmcraft-cli` must be on `PATH`; the vision client is scripted and needs
  no API key.
- The harness keeps `run_ex5.log` in place when it clears old evidence, so a
  chapter run never unlinks the log the shell is writing.
- The rollback path applies a real `effects.apply` invert, confirms the
  downstream guard trips, and verifies the clip table is byte-for-byte
  equivalent afterwards.
- `npm run check` type-checks the solution module and the harness.
