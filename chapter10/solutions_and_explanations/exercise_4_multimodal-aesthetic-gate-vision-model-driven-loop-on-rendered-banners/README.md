# 10. Exercise 4: Multimodal Aesthetic Gate — solution

The worked aesthetic gate. It renders a banner, asks a vision model for a
strict score, applies exactly one correction per failed pass and stops on
pass, no-progress, the iteration cap or the time budget.

## What it does

1. The renderer is an injectable runtime with `context`, `render`, `apply`
   and `finish`.
2. The model response is validated against the exact six-key schema; a
   malformed answer becomes `score: null` and does not drive an edit.
3. `select_correction()` uses severity order: text clipping, contrast, hue
   drift, hero centring.
4. Each iteration records a 200-character preview, the score, the single
   correction and elapsed time.
5. The loop normalizes the rationale to detect oscillation and declares
   `no-progress`.
6. The accepted render is saved as a real PNG and hashed; the audit sidecar
   sits beside it.

## Run it

```bash
cd chapter10/solutions_and_explanations/exercise_4_multimodal-aesthetic-gate-vision-model-driven-loop-on-rendered-banners/files
PY=$("../../../../tools/pick_python.sh")
"$PY" run_ex4.py
```

```
29 assertions passed
```

This gate does not need a database or an API key: the model is scripted and
the renderer is injected. A production caller passes the PhotoCraft or
DesignCraft renderer behind the same four methods.

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/graded/SKU-200_4:5-en-US.png` | accepted 1080×1350 4:5 render |
| `output/graded/SKU-200_4:5-en-US_audit.json` | iteration history, scores and corrections |
| `output/graded/SKU-BAD_1:1-en-US.png` | render from the malformed-response run |
| `output/graded/SKU-BAD_1:1-en-US_audit.json` | malformed-response audit |
| `output/report.json` | status, corrections, final hash and artifact list |
| `output/run_ex4.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/04_multimodal-aesthetic-gate-vision-model-driven-loop-on-rendered-banners.py` | schema validation, correction priority, bounded loop, runtime boundary and sidecar |
| `files/run_ex4.py` | the acceptance harness: unit rules, three-iteration pass and malformed-response cap |
| `files/01_typescript.ts` | the `AestheticAudit` contract |

## Notes

- The runtime example draws with Pillow; the loop itself is renderer-
  agnostic and records the same fields for a real MCP render.
- Malformed responses count against the iteration budget but never apply an
  edit.
- Python 3.10 or newer, with `Pillow` from the repository environment.
