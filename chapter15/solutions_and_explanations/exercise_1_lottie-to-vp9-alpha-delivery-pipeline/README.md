# 15. Exercise 1: Lottie → VP9-Alpha Delivery — solution

The worked delivery proof. It writes a real Lottie JSON and a 12-frame PNG
sequence, encodes the sequence to VP9 with an alpha plane, probes the plane
back out of the container, hashes every deliverable and writes the manifest.

## What it does

1. `sha256Bytes()` and `sha256File()` produce the content digests used by the
   manifest.
2. `assertYuva420p()` accepts either FFmpeg's reported `yuva420p` pixel format
   or the WebM `alpha_mode=1` tag, then decodes one RGBA frame and requires at
   least one transparent pixel. That catches an encoder that drops the plane
   even when the tag is present.
3. `writeManifest()` serializes the delivery record; the harness also writes it
   directly so the two paths can be compared.
4. The engine path in `main()` activates `Main_HeroLoop`, exports the Lottie,
   captures the browser frames, encodes both VP9-alpha and HEVC-alpha and
   records parity (`lottieFrames === encodedFrames`).

## Run it

```bash
cd chapter15/solutions_and_explanations/exercise_1_lottie-to-vp9-alpha-delivery-pipeline/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex1.ts
```

```
18 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/lottie.json` | a 12-frame, 320×180 Lottie document |
| `output/frames/f_00000.png` … `f_00011.png` | the RGBA source frames |
| `output/hero-vp9.webm` | VP9 with an alpha plane |
| `output/delivery.json` | composition, Lottie and WebM hashes + parity |
| `output/delivery-copy.json` | the same record written by `writeManifest()` |
| `output/report.json` | assertion count and artifact list |
| `output/run_ex1.log` | shell-captured harness log |

## The listings

| file | what it is |
| --- | --- |
| `files/01_pipeline.ts` | the rasterize → VP9/HEVC → manifest pipeline and alpha probe |
| `files/run_ex1.ts` | the acceptance harness |
| `files/package.json` | npm scripts and dependencies |
| `files/tsconfig.json` | TypeScript config |

## Notes

- FFmpeg 9 reports a WebM alpha stream as `yuv420p`; the alpha is side data
  signalled by `alpha_mode=1`. The assertion checks the decoded pixels as well,
  so it does not trust the tag alone.
- The harness clears only the files it regenerates, so the shell-captured
  `run_ex1.log` survives a rerun.
- Type-check it with `npm run check`.
