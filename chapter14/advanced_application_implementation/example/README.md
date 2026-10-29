# 14. Advanced Application Implementation

The EffectCraft rig service: a production worker that receives a franchise
manifest (brand colors, logo variants, aspect ratios, animation presets),
rigs a composition programmatically — shapes, keyframes, value-graph
easing, expressions — renders a frame sequence via `effectcraft-cli mcp`,
encodes VP9 with alpha, and publishes the deliverables to a workspace.

## What it does

The service orchestrates:

1. **Resolver** — maps the manifest row to a rig preset (logo, lower-third,
   end-card, transition).
2. **Rig** — builds the EffectCraft composition: `shape.create` for logo
   paths, `layer.new` for solids, `property.addKeyframe` for position/
   scale/opacity, `property.setTemporalEase` for the value graph,
   `expression.add` for data-driven properties (e.g. `thisComp.layer("Logo").transform.position`).
3. **Graph** — the value graph is authored as code: each animated property
   gets an ease curve (ease-in/out, bounce, elastic) via the bezier handles
   on the keyframe's temporal ease.
4. **Compiler** — validates the rig against the EffectCraft schema before
   sending to the engine.
5. **Render** — `effectcraft-cli mcp` renders the frame sequence (PNG with
   alpha), then `ffmpeg` encodes VP9 with alpha (`-c:v libvpx-vp9 -pix_fmt
   yuva420p`).
6. **Publish** — writes deliverables to the workspace with content-addressed
   names (SHA-256 of the render output).

## The listings

| file | what it is |
| --- | --- |
| `compiler.ts` | schema validation for the rig before engine submission |
| `contracts.ts` | wire types: `ManifestRow`, `RigPreset`, `Deliverable`, `PublishResult` |
| `expressions.ts` | EffectCraft expressions as strings (data-driven properties) |
| `graph.ts` | value-graph authoring: ease curves, bezier handles, hold keyframes |
| `package.json` | npm scripts (`check`, `harness`) and dependencies |
| `render.ts` | frame sequence render + VP9-alpha encode |
| `resolver.ts` | manifest row → rig preset mapping |
| `rig.ts` | the rig builder: shapes, layers, keyframes, expressions |
| `service.ts` | the worker entry point: resolve → rig → compile → render → publish |
| `session.ts` | MCP session lifecycle for `effectcraft-cli` |
| `shape.ts` | parametric shape builders (logo paths from anchor tokens) |
| `tsconfig.json` | TypeScript config |

## Run it

```bash
cd chapter14/advanced_application_implementation/example/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_forge.ts
```

```
13 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `files/output/workspace/deliverables/<hash>.preview.png` | first frame preview |
| `files/output/workspace/deliverables/<hash>_00000.png` | frame 0 (PNG, alpha) |
| `files/output/workspace/deliverables/<hash>_00001.png` | frame 1 |
| `files/output/workspace/deliverables/<hash>.webm` | VP9 with alpha |
| `output/run_forge.log` | the harness log |

## Notes

- `effectcraft-cli` on `PATH`.
- The harness uses a synthetic franchise manifest (5 rows, 3 aspect ratios).
- `ffmpeg` must be available for VP9 encoding (installed via `tools/install_python_deps.sh` deps).
