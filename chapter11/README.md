# Chapter 11 — Inside the Integer Timebase - How FilmCraft Manages Sample-Accurate Timelines and Zero Drift

The chapter drives FilmCraft through its MCP server and shows why every
position that crosses the wire has to be an integer tick: 254 016 000 000 of
them to the second, exactly divisible by every standard frame rate and
sample rate.

## The projects

Each project has its own README with the command to run it and the
artifacts it writes.

| project | what it is |
| --- | --- |
| [Advanced Application Implementation](advanced_application_implementation/example/) | A SaaS-grade beat-cut worker for FilmCraft. |
| [Basic Code Example](basic_code_example/example/) | A Next.js route that speaks FilmCraft's integer timebase from the outside. |
| [Solution — Exercise 1](solutions_and_explanations/exercise_1_dialogue-ducking-on-the-integer-timebase/) | The worked ducking tier: exact ms→tick lift, coalesced dialogue groups and sample-count audit rows. |
| [Solution — Exercise 2](solutions_and_explanations/exercise_2_zero-drift-ripple-trim-agentic-loop-claude-code-via-mcp/) | The worked ripple pass: banker's rounding, frame snapping and a zero-drift post-batch invariant. |
| [Solution — Exercise 3](solutions_and_explanations/exercise_3_frame-rate-rational-conversion-harness-23-976-25-29-97df/) | The worked rational conversion: 25→23.976 residuals and 29.97 drop-frame round trips. |
| [Solution — Exercise 4](solutions_and_explanations/exercise_4_deterministic-multimodal-qc-loop-with-ui-screenshot-and-vision-model/) | The worked sync QC: integer pixel→tick mapping, transients and a two-sample verdict. |
| [Solution — Exercise 5](solutions_and_explanations/exercise_5_headless-batch-render-with-exact-duration-proof-tcp-loopback-channel/) | The worked duration proof: sample-boundary padding, six deliverables and a string-safe manifest. |

## What you need

Node.js 22.5+, Python 3.10+ and the engine binaries — or just Docker. The
root README sets out both paths and the one-time setup:
[what you need](../README.md#what-you-need) and
[install](../README.md#install).

## Run everything

```bash
./chapter11/run_all.sh
```

The script runs every harness in the chapter, prints one line per
harness, and exits non-zero if any of them fails. Each harness leaves
its log in the `output/` directory of the project it exercises.

To run a single project, open its README: it gives the exact command
and the environment that command needs.

## Notes on the engine

The details that will bite you first:

- **The payload shapes are not what you would guess** — the project tree
  hangs under `root.children`, and the sequence has `video` / `audio` arrays
  of `items`.
- **A destructive command consumes its operands** — the Pathfinder booleans
  delete what they operate on and answer with a new id.
- **`timeline.place` answers with a list** of clip ids.
- **There is no `duration.probe` and no `sequence.trimToWorkArea`** — the
  probe is `mediaBrowser.probe`, and a sequence is padded with an out-trim.
