# 12. Basic Code Example

A headless "hello world" for autonomous video assembly: one agent graph that
imports a dialogue take and two B-roll stills into FilmCraft, cuts the dead
air out of the A-roll, lays B-roll on a second video track and renders a frame
to prove the timeline is coherent. Nothing mutates the filesystem directly —
every edit is an engine command over MCP.

## What it does

`01_autonomousVideoAssembler.ts` compiles a LangGraph `StateGraph` with one
supervisor and four workers. `dialogueSync` creates the project and imports the
media (`file.newProject`, `file.import`); `brollIndex` scores each candidate
with ONNX Runtime Web, WebGPU first and WASM as fallback, and sorts them;
`assemble` creates a sequence with `file.newSequence`, places the dialogue on
V1, razors at each word boundary with `timeline.razor`, ripple-trims 2.5 s of
silence with `timeline.trim` and drops the best still on V2; `verify` calls
`render_frame` at 3 s and checks that an image block came back.

The supervisor is a deterministic decision tree over the shared state — which
field is still empty decides the next hop — so the run is reproducible with no
LLM in the loop. All engine traffic goes through `FilmCraftClient`, a thin
façade over `command_run`, `command_batch` and `render_frame`; the
`filmcraft-cli mcp` child process is closed in a `finally`.

## The listings

| file | what it is |
| --- | --- |
| `01_autonomousVideoAssembler.ts` | tick arithmetic, the MCP client, the ONNX scorer, the four worker nodes and the graph wiring |
| `run_basic.ts` | the harness: synthesizes the media, drives the graph, inspects the resulting sequence |
| `package.json` | `check` (`tsc --noEmit`) and `harness` (`tsx run_basic.ts`) |
| `tsconfig.json` | the strict TypeScript configuration |

## Run it

```bash
cd chapter12/basic_code_example/example/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_basic.ts
```

The harness generates three PNGs with `pngjs`, runs the graph against the real
engine, then reads the sequence back. The three sections report as:

```
# the arithmetic
PASS ticks: a second is 254016000000 ticks
PASS ticks: a quarter second

# the graph
PASS graph: the supervisor ran
PASS graph: the b-roll was ranked
PASS graph: the verification passed

# the sequence
PASS sequence: the dialogue is on V1

13 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `files/output/media/dialogue.png` | the A-roll still the harness generates for the bin |
| `files/output/media/broll-a.png` | first B-roll candidate, seed 1 |
| `files/output/media/broll-b.png` | second B-roll candidate, seed 2 |

## Notes

- **`filmcraft-cli` must be on `PATH`** — the module spawns `filmcraft-cli mcp` itself.
- **No ONNX model is needed.** `BrollScorer.score()` returns `0.5` when no
  session was loaded, so ranking works without `onnxruntime-web` or
  `models/broll-score.onnx`.
- `npx tsx`, not `node`: the listings are TypeScript with `.js` specifiers.
- Type-check with `npm run check`.
