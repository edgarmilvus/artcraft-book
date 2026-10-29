# 11. Basic Code Example

A Next.js route that speaks FilmCraft's **integer timebase** from the
outside. The agent computes a clip position with `BigInt` arithmetic, hands
it to the engine as a decimal string, and reads the very same string back
out of `sequence_inspect`. Nothing on the timeline is ever a float, so a
position computed on one worker is bit-for-bit the position observed on the
next one.

The listing is deliberately small — two clips, one verification, one render
— but it establishes the rule the rest of the chapter follows: a tick leaves
the arithmetic as a string, and comes back as a string.

## What it does

`01_route.ts` opens one stdio MCP session against `filmcraft-cli mcp`,
pinned to the working directory with `--automation-read-root` and
`--automation-write-root`, and closes it in a `finally` so a failed call
cannot leak the child process.

The session then runs four steps. `file.newProject` and `file.newSequence`
declare the timebase — 24 fps, 48 kHz, two video and two audio tracks.
`file.importDemoFootage` pulls in two built-in scenes, and `project_inspect`
walks the project tree to find their ids. `timeline.place` puts the first
clip at tick `0` on `V1`/`A1` and the second at tick `508032000000` — frame
48 of 24 fps, exactly two seconds — on `V2`/`A2`. `sequence_inspect` reads
the timeline back and the route compares the engine's `start` string with
the string it sent. Finally `playhead.set` parks the playhead on the same
tick and `render_frame` grabs the frame there as a PNG image block.

## The listings

| file | what it is |
| --- | --- |
| `01_route.ts` | the timebase helpers, the MCP plumbing, the two-clip sequence and the `GET` handler |
| `run_basic.ts` | the harness: the arithmetic checks, the engine round trip and the artifact check |
| `package.json` | the project's scripts and dependencies |
| `tsconfig.json` | the ES2020 target the `BigInt` literals need |

## Run it

```bash
cd chapter11/basic_code_example/example/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_basic.ts
```

The harness checks the arithmetic first, then drives the engine:

```
# the arithmetic
PASS timebase: a second is 254016000000 ticks
PASS timebase: 48 frames at 24 fps is two seconds
PASS timebase: one frame at 24 fps
PASS timebase: the frame of a tick
PASS timebase: the round trip is an identity
PASS timebase: an interior tick rounds down
PASS timebase: 23.976 fps has no fractional tick
PASS timebase: 24000 frames at 23.976 fps is 1001 s

# the engine round trip
PASS engine: the second clip starts at frame 48
PASS engine: the tick is two seconds
PASS engine: the render was taken at frame 48

# the artifacts
PASS artifact: the output folder exists

12 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `files/output/` | the output folder the harness creates and clears on every run |

The rendered frame comes back from `render_frame` as a base64 PNG in the
tool's image block; the route returns it inline rather than writing it to
disk.

## Notes

- **`filmcraft-cli` must be on `PATH`.** The transport spawns it as a child
  process, so the binary has to be reachable from the shell that runs the
  harness.
- **`npx tsx`, not `node`.** The listing is TypeScript and imports its
  neighbors with `.js` specifiers; `tsx` resolves them.
- The run needs no model, no database and no network. The footage is the
  engine's own generated demo scenes.
- The arithmetic is deterministic. The engine's own ticks are too: the same
  sequence produces the same positions on every run.
- Type-check it with `npm run check` (which is `tsc --noEmit`).
