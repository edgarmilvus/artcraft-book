# 15. Advanced Application Implementation

A headless Lottie → VP9-alpha + HEVC-alpha render farm: the pipeline
receives a Lottie JSON (from a design tool or generated), rasterizes it
frame by frame in headless Chromium (via `lottie-web` + Puppeteer),
encodes the frames as VP9 with alpha (WebM) and HEVC with alpha (MP4), and
proves the web and native paths agree frame by frame (pixel-perfect SSIM
≥ 0.999).

## What it does

The pipeline stages:

1. **Validate** — the Lottie JSON against the `lottie.contract.ts` schema
   (layers, keyframes, assets, markers).
2. **Rasterize** — headless Chromium loads `lottie-web`, renders each frame
   to a PNG with alpha (4K, 60 fps).
3. **Encode VP9** — `ffmpeg -c:v libvpx-vp9 -pix_fmt yuva420p` → WebM with
   alpha.
4. **Encode HEVC** — `ffmpeg -c:v hevc_videotoolbox -pix_fmt yuva420p`
   (macOS VideoToolbox) → MP4 with alpha.
5. **Verify** — decode both outputs, compute SSIM per frame; assert ≥ 0.999.
6. **Publish** — write deliverables to the workspace with content-addressed
   names.

## The listings

| file | what it is |
| --- | --- |
| `01_lottie-vp9-pipeline.ts` | the complete pipeline: validate → rasterize → encode → verify → publish |
| `02_typescript_implementation.json` | the TypeScript implementation (abbreviated in the book) |
| `03_lottie.contract.ts` | Zod schema for the Lottie JSON the pipeline accepts |
| `04_practical_exercises.sh` | practical exercises for the reader |
| `package.json` | npm scripts (`check`, `harness`) and dependencies |
| `tsconfig.json` | TypeScript config |

## Run it

```bash
cd chapter15/advanced_application_implementation/example/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_forge.ts
```

```
15 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `files/output/workspace/projects/hero.ecproj` | EffectCraft project used for native render |
| `files/output/workspace/store/hero/<hash>.json` | Lottie JSON (content-addressed) |
| `files/output/workspace/store/hero/<hash>.webm` | VP9-alpha WebM |
| `files/output/workspace/work/hero.lottie.json` | working copy of the Lottie JSON |
| `files/output/workspace/work/video.webm` | HEVC-alpha MP4 |
| `output/run_forge.log` | the harness log |

## Notes

- `effectcraft-cli` on `PATH` (for the native render comparison).
- `ffmpeg` with `libvpx-vp9` and `hevc_videotoolbox` (macOS) required.
- Puppeteer + Chromium for headless rasterization (installed via npm).
- The harness uses a synthetic Lottie animation (5 frames, simple shapes).
