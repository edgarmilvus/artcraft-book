# 15. Exercise 2: Frame-Accurate Multi-Resolution Lottie Web/VP9 Delivery — solution

The worked multi-resolution delivery. One Lottie is rendered in headless
Chromium at three sizes, each sequence is encoded to VP9, decoded back, and
the real `ParityAuditor` compares the browser frames against the encoded
frames.

## What it does

1. `renderWebBundle()` refuses a source that contains live expressions
   (`hasExpressions()`), exports the Lottie through EffectCraft, rasterizes it
   and writes the UMD shim (`makeUmd()`).
2. `rasteriseLottie()` drives `lottie-web` in `puppeteer-core` (the installed
   Chrome, never a downloaded browser), steps `goToAndStop(frame, true)` and
   screenshots every frame. The frame count comes from `op - ip`.
3. `encodeVp9Sequence()` is the shared encoder: single-pass VP9 with
   `yuva420p`, a frame-count gate via `ffprobe -count_frames`, then a decode
   back to PNG for the audit.
4. `ParityAuditor.sampleFrames()` uses `XorShift32` with rejection sampling;
   `perceptualHash()` builds a 64-bit dHash from a 9×8 ffmpeg gray
   downsample; `assertParity()` reports the samples, histogram and max delta.
5. A pass means `maxDelta <= 3`.

## Run it

```bash
cd chapter15/solutions_and_explanations/exercise_2_frame-accurate-multi-resolution-lottie-web-vp9-delivery-with-strict-type-contrac/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex2.ts
```

```
52 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/lottie.json` | the six-frame `ParityProbe` source |
| `output/web-485x125/`, `web-970x250/`, `web-1940x500/` | Chromium frames at each resolution |
| `output/native-*/png/` | the native source frames |
| `output/native-*/hero.webm` | VP9 encodes |
| `output/native-*/decoded/` | frames decoded back from the WebM |
| `output/parity-all.json` | per-resolution sample count, histogram and max delta |
| `output/multi-resolution.json` | the resolution matrix and results |
| `output/report.json` | assertion count and artifact list |
| `output/run_ex2.log` | shell-captured harness log |

## The listings

| file | what it is |
| --- | --- |
| `files/02_frame-accurate-multi-resolution-lottie-web-vp9-delivery-with-strict-type-contracts.ts` | types, web/native bundles, rasterizer, encoder and parity auditor |
| `files/run_ex2.ts` | the acceptance harness |
| `files/lottie-fixture.json` | the six-frame render fixture |
| `files/package.json` | npm scripts and dependencies |

## Notes

- The RNG originally computed `lim = 0` for a full 32-bit draw and spun
  forever. `uniformInt(0x100000000)` now returns the raw 32-bit value; the
  harness asserts deterministic sampling, so a regression fails fast.
- All three resolutions encode to `maxDelta = 0` in this fixture, which means
  the VP9 round trip is visually identical to the browser frames.
- Chrome must be installed at `/Applications/Google Chrome.app` or pointed to
  by `CHROME_PATH`.
- Type-check it with `npm run check`.
