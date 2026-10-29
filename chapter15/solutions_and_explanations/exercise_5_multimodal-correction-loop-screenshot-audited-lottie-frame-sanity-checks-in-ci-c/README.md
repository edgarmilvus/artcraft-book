# 15. Exercise 5: Screenshot-Audited Brand Gate — solution

The worked multimodal gate. It renders a 1080×1080 proof frame in headless
Chromium, samples the brand panel, compares it with the expected hex through a
self-contained CIE ΔE2000 chain, and falls back to `signalstats` when the
vision model is unavailable.

## What it does

1. `srgbToLinear()`, `hexToRgb()`, `rgbToXYZ()`, `hexToLab()` and
   `deltaE2000()` implement the D65 sRGB → Lab → CIE ΔE2000 chain with no
   external color library.
2. `VisionResponseSchema` (zod) accepts only `#RRGGBB`, confidence in `[0,1]`
   and notes up to 240 characters.
3. `captureProofFrame()` loads `lottie-web` into `puppeteer-core`, steps to an
   exact frame, pins `--force-color-profile=srgb` and disables GPU compositing
   so the capture is deterministic.
4. The gate requires three agreeing samples and `ΔE2000 <= 4`.
5. `numericFallback()` reads one frame's `signalstats` YAVG and accepts a
   limited-range frame (`16 < YAVG < 235`).
6. `parse()` handles the `--lottie/--brand/--out/--dry-run/--bridge-port`
   surface.

## Run it

```bash
cd chapter15/solutions_and_explanations/exercise_5_multimodal-correction-loop-screenshot-audited-lottie-frame-sanity-checks-in-ci-c/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex5.ts
```

```
45 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/onboarding.json` | the 1080×1080 Lottie source |
| `output/proof-frame-30.png` | the rendered proof frame at frame 30 |
| `output/proof-frame-30-repeat.png` | a second render; pixel-identical to the first |
| `output/onboarding.webm` | a 30-frame VP9 encode of the proof frame |
| `output/signalstats-fallback.txt` | the luma measurement used by the numeric fallback |
| `output/audit/vision-gate.json` | expected/observed hex, samples, ΔE and pass |
| `output/report.json` | assertion count and artifact list |
| `output/run_ex5.log` | shell-captured harness log |

## The listings

| file | what it is |
| --- | --- |
| `files/05_multimodal-correction-loop-screenshot-audited-lottie-frame-sanity-checks-in-ci-cd.ts` | color math, schema, capture, client, fallback and driver |
| `files/run_ex5.ts` | the acceptance harness |
| `files/proof-lottie.json` | the brand-panel Lottie fixture |
| `files/01_vision-gate.contract.ts` | the gate contract |

## Notes

- The OpenAI client is created lazily: loading the module with no
  `OPENAI_API_KEY` used to throw before `--dry-run` could run. The key is now
  required only when a real vision sample is requested.
- Capturing the same frame twice produces byte-identical PNGs on this
  Chromium, which is what makes the gate safe to run in CI.
- The fallback accepts a dark overlay instead of demanding a mid-gray frame;
  it only rejects a crushed (`<=16`) or clipped (`>=235`) signal.
- Type-check it with `npm run check`.
