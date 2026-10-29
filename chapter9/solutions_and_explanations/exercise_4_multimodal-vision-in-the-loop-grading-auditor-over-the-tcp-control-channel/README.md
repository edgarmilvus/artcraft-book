# 9. Exercise 4: Multimodal Vision-in-the-Loop Grading Auditor — solution

The worked TCP auditor. It renders a product frame, measures the pixels
locally, asks a vision model what looks wrong, and applies at most three
bounded develop changes per iteration. The numeric pass is authoritative.

## What it does

1. Connects to the authenticated loopback channel with the mandatory 64-hex
   token; a short or wrong token is refused before any command.
2. Renders each iteration to `audit/<photo>/iter_N.jpg`.
3. `compute_pixel_stats()` converts the frame to CIELAB and measures center
   luma, shadow clipping, highlight clipping, background ΔE2000 and skin
   hue.
4. `numeric_violations()` runs first. The model critique is consulted, but
   only codes the numeric pass did not already reject.
5. `plan_adjustments()` maps issues to develop controls and clamps every
   delta to ±0.35 for light controls and ±12 for color controls, with at
   most three controls per iteration.
6. The audit creates `audit_iter_N` before mutating, wraps changes in one
   interaction, converges after two clean passes, caps at three iterations
   and writes the XMP sidecar.
7. The harness starts `stub_control_server.py`, a loopback server that maps
   `engine.execute` frames onto the real headless LightCraft, including
   `render_photo` and `command_batch`.

## Run it

```bash
cd chapter9/solutions_and_explanations/exercise_4_multimodal-vision-in-the-loop-grading-auditor-over-the-tcp-control-channel/files
PY=$("../../../../tools/pick_python.sh")
"$PY" run_ex4.py
```

The engine CLI must be on `PATH`:

```bash
export PATH="/path/to/repo/tools/craft-cli/bin:$PATH"
```

```
29 assertions passed
```

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/source/product.png` | the staged dark, warm-background product frame |
| `output/final.jpg` | the final 1024 px render after the audit |
| `output/audit/1/iter_1.jpg` | first iteration render |
| `output/audit/1/iter_2.jpg` | second iteration render |
| `output/audit/1/iter_3.jpg` | third iteration render |
| `output/source/product.xmp` | the XMP sidecar written by the audit |
| `output/report.json` | issues, deltas, final develop state, convergence and artifacts |
| `output/run_ex4.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/04_multimodal-vision-in-the-loop-grading-auditor-over-the-tcp-control-channel.py` | TCP client, pixel statistics, numeric gate, bounded planner and audit loop |
| `files/run_ex4.py` | the acceptance harness: auth failures, numeric units, live audit and output checks |
| `files/stub_control_server.py` | loopback auth/JSON-lines stand-in for the desktop control channel |

## Notes

- The vision client is scripted in the harness, so no API key is needed.
- The three-iteration cap is a property of the loop, not the model; the
  harness accepts either convergence or a human-review flag, but requires the
  two to be consistent.
- Python 3.10 or newer, with `numpy` and `Pillow` from the repository
  virtual environment.
