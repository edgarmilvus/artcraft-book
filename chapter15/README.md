# Chapter 15 — Cross-Platform Lottie & VP9 Pipelines - Rendering Native Video and Web Animations Headlessly

The chapter turns an EffectCraft composition into a Lottie animation,
rasterizes it frame by frame in headless Chromium, encodes it as VP9 with an
alpha channel, and proves that the web and the native path agree frame by
frame.

## The projects

Each project has its own README with the command to run it and the
artifacts it writes.

| project | what it is |
| --- | --- |
| [Advanced Application Implementation](advanced_application_implementation/example/) | A headless Lottie → VP9-alpha + HEVC-alpha render farm: the pipeline receives a Lottie JSON (from a design tool or generated), rasterizes it frame… |
| [Basic Code Example](basic_code_example/example/) | A single-file hello world for the Lottie → VP9-alpha pipeline: it loads a minimal Lottie JSON (a bouncing circle), rasterizes 5 frames in headless… |
| [Solution — Exercise 1](solutions_and_explanations/exercise_1_lottie-to-vp9-alpha-delivery-pipeline/) | The worked Lottie → VP9-alpha delivery: alpha proof, manifests and parity. |
| [Solution — Exercise 2](solutions_and_explanations/exercise_2_frame-accurate-multi-resolution-lottie-web-vp9-delivery-with-strict-type-contrac/) | The worked multi-resolution delivery: Chromium frames, VP9 round trip and parity audit. |
| [Solution — Exercise 3](solutions_and_explanations/exercise_3_autonomous-asset-recovery-mcp-driven-lottie-rehydration-in-a-ci-cd-pipeline/) | The worked bounded rehydration: detection, budget, schema and content-addressed repair. |
| [Solution — Exercise 4](solutions_and_explanations/exercise_4_audio-muxed-vp9-alpha-overlay-pipeline-with-deterministic-color-management/) | The worked audio-muxed overlay: VP9 alpha + Opus in MKV/WebM with BT.709 conformance. |
| [Solution — Exercise 5](solutions_and_explanations/exercise_5_multimodal-correction-loop-screenshot-audited-lottie-frame-sanity-checks-in-ci-c/) | The worked brand gate: deterministic proof frame, ΔE2000 and signalstats fallback. |

## What you need

Node.js 22.5+, Python 3.10+ and the engine binaries — or just Docker. The
root README sets out both paths and the one-time setup:
[what you need](../README.md#what-you-need) and
[install](../README.md#install).

## Run everything

```bash
./chapter15/run_all.sh
```

The script runs every harness in the chapter, prints one line per
harness, and exits non-zero if any of them fails. Each harness leaves
its log in the `output/` directory of the project it exercises.

To run a single project, open its README: it gives the exact command
and the environment that command needs.

## Notes on the engines

The details that will bite you first:

- **The three engines do not share one meta-tool** — EffectCraft's is
  `execute_command` (with `command` and `params`), PhotoCraft's and
  FilmCraft's is `command_run` (with `id` and `params`).
- **`effectcraft-cli mcp` takes no sandbox roots** — the other two
  engines' servers do.
- **A composition is read with `get_comp`** — there is no
  `doc_inspect` on EffectCraft, and the frame rate is `frameRate`.
- **`ui_screenshot` is PhotoCraft's tool** — EffectCraft has no
  window-screenshot.
- **There is no `render.frame` command** — a frame is rasterized by the
  headless browser that plays the Lottie.
- **The VP9 alpha is a container tag** — the decoded stream is still
  `yuv420p`.
