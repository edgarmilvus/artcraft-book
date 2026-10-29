# Chapter 13 — Three-Way Color Wheels and Loudness Governance - Automated Audio Ducking and Lumetri Grading

The chapter drives FilmCraft through its MCP server and shows how an agent
grades a program with three-way color wheels, ducks a music bed under the
dialogue and governs the delivery loudness.

## The projects

Each project has its own README with the command to run it and the
artifacts it writes.

| project | what it is |
| --- | --- |
| [Advanced Application Implementation](advanced_application_implementation/example/) | A FilmCraft pipeline that authors a three-episode mini-documentary: it assembles B-roll, syncs dialogue, applies three-way color wheels per… |
| [Basic Code Example](basic_code_example/example/) | A single-file demonstration of the FilmCraft three-way color wheel + sidechain ducking + loudness governance pipeline. |
| [Solution — Exercise 1](solutions_and_explanations/exercise_1_deterministic-three-way-color-wheel-grading-with-waveform-verification/) | The worked three-way grade: LUT-first batch, four scope invariants and a verification frame. |
| [Solution — Exercise 2](solutions_and_explanations/exercise_2_sidechain-style-dialogue-ducking-via-essential-sound-automation/) | The worked ducking mix: track roles, 30/450 ms keyframes, loudness summary and master cap. |
| [Solution — Exercise 3](solutions_and_explanations/exercise_3_lufs-true-peak-loudness-governance-with-autonomous-remediation/) | The worked loudness governor: gain, repair, limiter, escalate and a compliant report. |
| [Solution — Exercise 4](solutions_and_explanations/exercise_4_multimodal-three-way-correction-loop-with-vision-model-feedback/) | The worked vision loop: scope gate, strict model JSON, oscillation halt and audit. |
| [Solution — Exercise 5](solutions_and_explanations/exercise_5_end-to-end-delivery-pipeline-integrating-three-way-grade-ducking-and-lufs-govern/) | The worked delivery normalizer: three client briefs, one spec and an idempotency manifest. |

## What you need

Node.js 22.5+, Python 3.10+ and the engine binaries — or just Docker. The
root README sets out both paths and the one-time setup:
[what you need](../README.md#what-you-need) and
[install](../README.md#install).

## Run everything

```bash
./chapter13/run_all.sh
```

The script runs every harness in the chapter, prints one line per
harness, and exits non-zero if any of them fails. Each harness leaves
its log in the `output/` directory of the project it exercises.

To run a single project, open its README: it gives the exact command
and the environment that command needs.

## Notes on the engine

The details that will bite you first:

- **The wheel is six parameters, not nine** — a color vector and a luma
  offset per band.
- **`effects.setParam` wants the effect id** (`lumetri`), while
  `effects.apply` takes the display name.
- **The Essential Sound presets have names** — `Balanced Voice`,
  `Small Room`, and no `"none"`.
- **There is no loudness scope** — the measurement comes from Essential
  Sound, and the loudness of a clip is its measurement plus its gain.
- **The undo stack is linear** — a rollback is one `edit.undo` per applied
  command.
