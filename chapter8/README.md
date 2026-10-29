# Chapter 8 — Programmatic Vector Engineering - Cubic Béziers, Live Blends, and Pathfinder Booleans in VectorCraft

The chapter drives VectorCraft through its MCP server: cubic Bézier paths
built anchor by anchor, live blends that keep interpolating, and Pathfinder
booleans applied either destructively or as live effects.

## The projects

Each project has its own README with the command to run it and the
artifacts it writes.

| project | what it is |
| --- | --- |
| [Advanced Application Implementation](advanced_application_implementation/example/) | VectorForge is the logo-synthesis worker of a multi-tenant brand-asset API. |
| [Basic Code Example](basic_code_example/example/) | A single-file introduction to programmatic vector work in VectorCraft. |
| [Solution — Exercise 1](solutions_and_explanations/exercise_1_the-b-zier-glyph-foundry-parametric-icon-system-with-explicit-anchor-math/) | The worked glyph foundry: anchor math, the atomic family batch, twelve native icons and SVG previews. |
| [Solution — Exercise 2](solutions_and_explanations/exercise_2_live-blend-morphing-engine-for-animated-brand-marks/) | The worked live blend: topology alignment, bent spine, loopback sampler, five renders and vision review. |
| [Solution — Exercise 3](solutions_and_explanations/exercise_3_non-destructive-pathfinder-composition-for-multi-resolution-logos/) | The worked tiered Pathfinder build: live effects on xl/md, a simplified sm tier and deterministic geometry hashes. |
| [Solution — Exercise 4](solutions_and_explanations/exercise_4_autonomous-multimodal-b-zier-refinement-loop-vision-guided-path-smoothing/) | The worked refinement loop: curvature spikes, scripted critique, atomic edits and before/after renders. |
| [Solution — Exercise 5](solutions_and_explanations/exercise_5_vector-store-driven-parametric-icon-synthesis-knn-governed-style-transfer-betwee/) | The worked vector-store synthesizer: KNN retrieval, style consensus, candidate export and provenance hashes. |

## What you need

Node.js 22.5+, Python 3.10+ and the engine binaries — or just Docker. The
root README sets out both paths and the one-time setup:
[what you need](../README.md#what-you-need) and
[install](../README.md#install).

## Run everything

```bash
./chapter8/run_all.sh
```

The script runs every harness in the chapter, prints one line per
harness, and exits non-zero if any of them fails. Each harness leaves
its log in the `output/` directory of the project it exercises.

To run a single project, open its README: it gives the exact command
and the environment that command needs.

## The desktop channel

Exercise 2 drives the agent over the authenticated loopback control channel
(`vectorcraft --control 7980`). That server lives in the desktop
application and needs a window, so the harness starts
`stub_control_server.py` instead: the same auth frame, the same
`engine.execute` frames, every command executed against the real headless
engine.

## Notes on the engine

The details that will bite you first:

- **There is no `path.info`.** Read the anchors with `document.node`; a
  compound path keeps its members under `kind.children`.
- **Two batch shapes.** Only the MCP `command_batch` tool can thread ids
  (`"$N.id"`, steps counted from zero); the engine's `command.batch` cannot.
- **A destructive Pathfinder consumes its operands** and answers with a new
  id.
- **There is no `object.transform`** — the geometry is in the `transform`
  tool and in `transform.set` / `transform.scale` / `transform.resize`.
