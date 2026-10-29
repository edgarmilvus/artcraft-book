# 9. Exercise 3: 32-Bit-Float Linear HDR Merge and GPU Tone-Mapping Chain — solution

The worked HDR pipeline. It merges a three-frame bracket with automatic
settings disabled, proves the merged item is 32-bit Rec.2020, grades it as
one interaction, and writes four deliverables with distinct export contracts.

## What it does

1. `merge_bracket()` sorts the bracket by EV offset and calls `merge.hdr`
   with `autoSettings: false`, alignment on and medium deghosting. A reply
   without a merged id, or with a non-ok status, raises.
2. `assert_hdr_working_space()` exports the merged item as 32-bit Rec.2020
   and asks the engine for the profile and bit depth. A mismatch stops the
   pipeline before the grade.
3. `apply_grade()` selects the merged photo, wraps every develop mutation in
   `develop.beginInteraction` / `endInteraction`, applies the signature curve
   and the shadow grading node, then converts to Rec.2020.
4. `export_deliverables()` issues four separate `app.export` calls: a 32-bit
   Rec.2020 TIFF, an sRGB JPEG, a 10-bit AVIF and a PNG thumbnail.
5. `run_pipeline()` reports per-stage elapsed time, GPU state and warnings,
   and fails the batch when more than 20 % of the sets fail.

## Run it

```bash
cd chapter9/solutions_and_explanations/exercise_3_32-bit-float-linear-hdr-merge-and-gpu-accelerated-tone-mapping-chain/files
PY=$("../../../../tools/pick_python.sh")
"$PY" run_ex3.py
```

The engine CLI must be on `PATH`:

```bash
export PATH="/path/to/repo/tools/craft-cli/bin:$PATH"
```

```
37 assertions passed
```

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/brackets/bracket-0.png` | under-exposed bracket frame |
| `output/brackets/bracket-1.png` | normal bracket frame |
| `output/brackets/bracket-2.png` | over-exposed bracket frame |
| `output/brackets/bracket-0-HDR.dng` | the merged 32-bit float DNG |
| `output/deliver/set-a/master_hdr.tif` | 32-bit Rec.2020 master |
| `output/deliver/set-a/master_sdr.jpg` | 1000 px sRGB JPEG |
| `output/deliver/set-a/web_hero.avif` | 800 px 10-bit AVIF |
| `output/deliver/set-a/thumbnail.png` | 480 px PNG thumbnail |
| `output/hdr/merged-4.tif` | the working-space proof export |
| `output/stage-log.json` | per-stage GPU, timing and warning records |
| `output/report.json` | bracket set, exit code, produced files and artifact list |
| `output/run_ex3.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/03_32-bit-float-linear-hdr-merge-and-gpu-accelerated-tone-mapping-chain.py` | MCP transport, merge, working-space assertion, grade, exports and orchestrator |
| `files/run_ex3.py` | the acceptance harness: merged-id contract, real bracket, TIFF tag checks and deliverable assertions |

## Notes

- The harness writes a real 1200×800 bracket set, so the JPEG/thumbnail sizes
  are meaningful and the HDR master is a genuine 32-bit float TIFF. The
  harness parses tags 258 and 339 rather than trusting the extension.
- `command_batch` on LightCraft takes `stop_on_error`, not `atomic`; the
  transport maps the contract accordingly.
- `app.export` is the command id for exports; `export` is a deprecated alias
  that the shipping engine does not expose.
- Python 3.10 or newer.
