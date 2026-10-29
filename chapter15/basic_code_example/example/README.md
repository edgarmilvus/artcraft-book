# 15. Basic Code Example

A single-file hello world for the Lottie → VP9-alpha pipeline: it loads a
minimal Lottie JSON (a bouncing circle), rasterizes 5 frames in headless
Chromium via `lottie-web` + Puppeteer, encodes VP9-alpha WebM, and asserts
the output exists and has the correct frame count.

## What it does

`01_hello-lottie-vp9.ts` demonstrates the minimal pipeline: validate
Lottie JSON → launch Puppeteer → render frames to PNG → `ffmpeg` encode
VP9-alpha → verify frame count. No design tool output; the Lottie JSON is
hand-authored in the file.

## The listings

| file | what it is |
| --- | --- |
| `01_hello-lottie-vp9.ts` | the complete minimal pipeline |
| `package.json` | npm scripts (`check`, `harness`) and dependencies |
| `tsconfig.json` | TypeScript config |

## Run it

```bash
cd chapter15/basic_code_example/example/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_basic.ts
```

```
22 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `files/output/work/frames/frame-00000.png` | frame 0 (PNG, alpha) |
| `files/output/work/frames/frame-00001.png` | frame 1 |
| `files/output/work/frames/frame-00002.png` | frame 2 |
| `files/output/work/frames/frame-00003.png` | frame 3 |
| `files/output/work/frames/frame-00004.png` | frame 4 |
| `output/run_basic.log` | the harness log |

## Notes

- `effectcraft-cli` on `PATH` (not used directly but listed for consistency).
- Puppeteer downloads Chromium on first run; `npm install` handles it.
- `ffmpeg` with `libvpx-vp9` required.
