# 1. Exercise 3: Authenticated TCP Loopback Agent with Vision-In-The-Loop Curve Correction -- solution

The worked solution for Exercise 3: a Python agent that authenticates on the
first frame of PhotoCraft's loopback control channel, renders the document
after every pass, judges the PNG, and stops only after three refinements.

## What it does

`CraftLiveClient` opens a TCP socket to `photocraft-cli serve`, sends
`{"method":"auth","params":{"token":...}}` as the very first line, and refuses
to run an engine command until the server answers `{"ok":true}`. The token
must be exactly 64 lowercase hex characters; the client rejects anything else
before a byte leaves the process.

`main()` creates a 640 × 400 document with a dark-to-light gradient if the
headless session has no document, applies the initial four-point curve, and
then loops:

1. render the document to `audit/vision_curve_pass_<n>.png`;
2. compute a decision from the PNG;
3. translate the decision into `levels`, `curves` or `vibrance`, or accept
   `ok` after the minimum of three passes.

The screenshot path tries `ui.screenshot` first and falls back to
`doc.render`. The headless server has no window, so every render in this run
goes through `doc.render`, which is recorded in the JSONL exchange log.

Without an API key the agent uses a deterministic mean-luma heuristic; with
`OPENROUTER_API_KEY` or `OPENAI_API_KEY` it posts the PNG to an
OpenAI-compatible endpoint and whitelists the reply against a discriminated
union, so an off-schema answer becomes a no-op instead of a mutation.

If the loop cannot converge in six passes it unwinds every edit with
`edit.undo` and exits 2 rather than leaving a half-graded document behind.

## The listings

| file | what it is |
| --- | --- |
| `03_authenticated-tcp-loopback-agent-with-vision-in-the-loop-curve-correction.py` | the authenticated client, the PNG luma reader, the vision call and the convergence loop |
| `run_ex3.py` | acceptance harness: starts the server, runs the agent, checks auth, the log, the renders and the live session |

## Run it

```bash
cd chapter2/solutions_and_explanations/exercise_3_authenticated-tcp-loopback-agent-with-vision-in-the-loop-curve-correction/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
../../../../.venv/bin/python run_ex3.py
```

The `PATH` export puts the `*-cli` binaries in front of any system install;
the repository venv is the interpreter the harness is tested with.

The harness picks a free loopback port, generates a fresh 64-hex token, starts
its own `photocraft-cli serve`, runs the agent, and kills the server in a
`finally` block. It exits non-zero if any check fails.

## What it produces

| artifact | what it is |
| --- | --- |
| `output/logs/vision_curve_exchange.jsonl` | the auth, command, render, decision and final events |
| `output/audit/vision_curve_pass_0.png` | the snapshot before the initial curve |
| `output/audit/vision_curve_pass_1.png` | the render judged on pass 1 |
| `output/audit/vision_curve_pass_2.png` | the render judged on pass 2 |
| `output/audit/vision_curve_pass_3.png` | the render that satisfies the three-pass minimum |
| `output/serve.out` | the server's stdout |
| `output/serve.err` | the server's startup line and diagnostics |
| `output/agent.log` | the agent's stdout and stderr |
| `output/run_ex3.log` | every acceptance check |
| `output/run-log.json` | check count, failures and engine quirks |

## What the harness asserts

- the server accepts TCP connections and announces the exact loopback port it
  was given;
- the agent exits cleanly and the JSONL log has one auth event, two engine
  commands (gradient base and initial curve), four renders and three decisions;
- every render uses `doc.render`; `ui.screenshot` is never recorded;
- all three decisions stay inside the contract union, the agent converges in
  exactly three passes, applies exactly one edit, and keeps the initial curve;
- the four PNGs are valid 8-bit 640 × 400 images and are non-trivial;
- a different 64-hex token is refused with `authentication required`, the
  server survives the refusal, and the correct token can still list the live
  session, inspect the document and close it;
- malformed tokens (short, uppercase, wrong alphabet, non-string) are rejected
  before the client connects;
- every log and render path stays under the write root.

## Notes

- The server prints its listening line on stderr, not stdout.
- `doc.render` writes the file named by `path` relative to the write root; the
  agent also accepts an inline base64 payload if a build returns one.
- The deterministic luma stand-in needs no key; the harness removes any API
  key from the child environment so the run is offline and reproducible.
- A refused auth frame does not shut the server down, which is what lets the
  harness test the wrong token and then reconnect with the right one.
