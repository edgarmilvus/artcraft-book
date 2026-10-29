# Chapter 12 — Autonomous Video Assembly - Cutting B-Roll, Syncing Dialogue, and Ripple Trimming via Agent Commands

The chapter drives FilmCraft through its MCP server and shows how an agent
cuts B-roll, syncs dialogue and ripple-trims the dead air without leaving
the timeline in an undefined state.

## The projects

Each project has its own README with the command to run it and the
artifacts it writes.

| project | what it is |
| --- | --- |
| [Advanced Application Implementation](advanced_application_implementation/example/) | CutRoom is the production-shaped version of the chapter's assembler: a multi-tenant worker that turns a JSON job manifest into a finished H.264… |
| [Basic Code Example](basic_code_example/example/) | A headless "hello world" for autonomous video assembly: one agent graph that imports a dialogue take and two B-roll stills into FilmCraft, cuts… |
| [Solution — Exercise 1](solutions_and_explanations/exercise_1_transcript-driven-b-roll-assembly-with-semantic-cut-point-discovery/) | The worked B-roll assembly: transcript matching, V2 placement, review table, contact sheet and pre-run snapshot. |
| [Solution — Exercise 2](solutions_and_explanations/exercise_2_multi-camera-interview-sync-via-audio-cross-correlation-and-angle-mapping/) | The worked multicam sync: cross-correlation, impulse rejection, least-squares offsets and pause cuts. |
| [Solution — Exercise 3](solutions_and_explanations/exercise_3_beat-aligned-ripple-trim-batch-with-undo-stack-integrity-verification/) | The worked beat snap: bounded-error grid, V1/V2 snapping and undo-integrity verification. |
| [Solution — Exercise 4](solutions_and_explanations/exercise_4_multimodal-cut-verification-with-vision-language-model-feedback-and-atomic-shot-/) | The worked cutdown verifier: clause grading, atomic opening replacement and a full attempt audit. |
| [Solution — Exercise 5](solutions_and_explanations/exercise_5_wasm-simd-accelerated-segment-classification-for-automatic-b-roll-selection/) | The worked WASM classifier: SIMD probe, RGBA transfer, softmax schema and project traversal. |

## What you need

Node.js 22.5+, Python 3.10+ and the engine binaries — or just Docker. The
root README sets out both paths and the one-time setup:
[what you need](../README.md#what-you-need) and
[install](../README.md#install).

## Run everything

```bash
./chapter12/run_all.sh
```

The script runs every harness in the chapter, prints one line per
harness, and exits non-zero if any of them fails. Each harness leaves
its log in the `output/` directory of the project it exercises.

To run a single project, open its README: it gives the exact command
and the environment that command needs.

## Notes on the engine

The details that will bite you first:

- **A marker carries its position in `start`**, exactly like a clip.
- **`history.list` answers with `{ undo: [...], redo: [...] }`** — the depth
  is the length of the undo list.
- **The undo stack is linear**: a rollback is one `edit.undo` per applied
  mutation, not one call for the whole batch.
- **`render_frame` answers with an image block**; the PNG is base64 in the
  block's `data` and has to be written to disk by the agent.
- **The inspector reports `Video 1` and `Audio 1`** while the commands
  accept `V1` and `A1`.
