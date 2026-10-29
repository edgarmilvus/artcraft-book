# Chapter 14 — Programmatic Motion Graphics - Rigging Keyframes, Value Graphs, and Shapes in EffectCraft

The chapter drives EffectCraft through its MCP server and shows how an agent
rigs a composition, lowers authored easing onto the value graph and ships
the result as Lottie and as VP9.

## The projects

Each project has its own README with the command to run it and the
artifacts it writes.

| project | what it is |
| --- | --- |
| [Advanced Application Implementation](advanced_application_implementation/example/) | The EffectCraft rig service: a production worker that receives a franchise manifest (brand colors, logo variants, aspect ratios, animation… |
| [Basic Code Example](basic_code_example/example/) | A single-file EffectCraft hello-rig: it boots effectcraft-cli mcp, creates a composition, adds a shape layer (a rounded rectangle from parametric… |
| [Solution — Exercise 1](solutions_and_explanations/exercise_1_kinetic-logo-reveal-with-type-safe-keyframe-choreography-over-mcp/) | The worked franchise rig: five-step atomic plan, TOFU font gate and write-root guard. |
| [Solution — Exercise 2](solutions_and_explanations/exercise_2_autonomous-asset-repair-decompose-an-unmapped-svg-into-a-rigged-shape-layer/) | The worked SVG repair: path parsing, unsupported-shape report, dHash and repaired SVG. |
| [Solution — Exercise 3](solutions_and_explanations/exercise_3_multimodal-value-graph-correction-loop-with-a-vision-model/) | The worked value-graph loop: strict score range, influence clamps and three rendered passes. |
| [Solution — Exercise 4](solutions_and_explanations/exercise_4_live-tcp-rigging-on-the-loopback-control-channel-repeater-trim-choreography/) | The worked live TCP rig: auth-first frames, repeater batch, stagger update and screenshot. |
| [Solution — Exercise 5](solutions_and_explanations/exercise_5_reusable-rig-preset-library-typed-null-hierarchies-and-constraint-expressions/) | The worked preset library: five descriptors, typed validation, result guard and dry-run. |

## What you need

Node.js 22.5+, Python 3.10+ and the engine binaries — or just Docker. The
root README sets out both paths and the one-time setup:
[what you need](../README.md#what-you-need) and
[install](../README.md#install).

## Run everything

```bash
./chapter14/run_all.sh
```

The script runs every harness in the chapter, prints one line per
harness, and exits non-zero if any of them fails. Each harness leaves
its log in the `output/` directory of the project it exercises.

To run a single project, open its README: it gives the exact command
and the environment that command needs.

## Notes on the engine

The details that will bite you first:

- **The batch parameter references are 1-based** — `$1` is the first step,
  while the reply array is indexed from zero.
- **EffectCraft has no `command_run`** — the meta-tool is
  `execute_command`, and the dedicated tools (`get_comp`, `get_layer`,
  `add_keyframe`, `render_frame`) are first-class.
- **`comp.new` answers with an id** — the metadata comes from `get_comp`.
- **The wheel is two parameters per band** — a color vector and a luma
  offset, and the parameter list arrives as an array.
- **The interpolation belongs to the selection** — select the key, then
  write the interpolation.
