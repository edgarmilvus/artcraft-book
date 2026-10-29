# 13. Exercise 2: Sidechain-Style Dialogue Ducking — solution

The worked ducking mix. Dialogue, music and effects are tagged by track role,
the music bed is ducked to −14 dB under speech, and the master bus is nudged
only when the integrated loudness leaves the acceptance window.

## What it does

1. Buckets clips by track alias: A1/A2 dialogue, A3/A4 music, A5 SFX.
2. Tags each family with `essentialSound.setType`, reads the pre-duck loudness
   and reference-matches dialogue to −23 and music to −28.
3. Generates the Essential Sound ducking curve, then overrides it with four
   explicit keyframes per speech interval: 0 dB 30 ms before the onset,
   −14 dB at the onset, hold, and a 450 ms release.
4. Checks the dialogue-over-music separation is at least 12 LU.
5. Applies a capped master-bus correction when the integrated loudness leaves
   the −26…−22 LU window and reports the residual.

## Run it

```bash
cd chapter13/solutions_and_explanations/exercise_2_sidechain-style-dialogue-ducking-via-essential-sound-automation/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex2.ts
```

```
25 assertions passed
```

The harness drives the pure mix math with a fake command client; `runDucking()`
is the live FilmCraft path.

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/mix_report.json` | pre/post loudness, true peak, duck depth and master correction |
| `output/keyframes.csv` | every attack/hold/release keyframe with its tick |
| `output/report.json` | assertion count, duck depth and artifact list |
| `output/run_ex2.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/02_sidechain-style-dialogue-ducking-via-essential-sound-automation.ts` | track bucketing, loudness summary, keyframe writer, master correction and ducking loop |
| `files/run_ex2.ts` | the acceptance harness: aliases, attack/release timing, loudness and master cap |
| `files/01_typescript.ts` | the mix report contract |

## Notes

- The attack is 30 ms and the release 450 ms; both are exact integer tick
  values, not rounded seconds.
- The correction is capped at ±3 dB, so a very loud program escalates in
  the report instead of being crushed.
- Type-check it with `npm run check`.
