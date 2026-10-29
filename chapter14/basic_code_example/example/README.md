# 14. Basic Code Example

A single-file EffectCraft hello-rig: it boots `effectcraft-cli mcp`, creates
a composition, adds a shape layer (a rounded rectangle from parametric
anchors), keyframes its position and scale with an ease-out curve on the
value graph, renders a 5-frame PNG sequence, and saves the project.

## What it does

`01_effectcraft-hello-rig.ts` demonstrates the minimal rig: session →
`comp_new` → `shape.create` (rounded rect from 4 anchors) →
`property.addKeyframe` at t=0 and t=1s → `property.setTemporalEase` with
`out: [0.4, 0.0, 0.2, 1.0]` → `comp_render` → `comp_save`. The harness
asserts the PNG sequence exists, each frame has an alpha channel, and the
position values match the keyframes.

## The listings

| file | what it is |
| --- | --- |
| `01_effectcraft-hello-rig.ts` | the complete rig in ~80 lines |
| `package.json` | npm scripts (`check`, `harness`) and dependencies |
| `tsconfig.json` | TypeScript config |

## Run it

```bash
cd chapter14/basic_code_example/example/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_basic.ts
```

```
13 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `files/output/hello-rig-preview.png` | first frame of the render |
| `output/run_basic.log` | the harness log |

## Notes

- `effectcraft-cli` on `PATH`.
- No external assets; the shape is parametric.
