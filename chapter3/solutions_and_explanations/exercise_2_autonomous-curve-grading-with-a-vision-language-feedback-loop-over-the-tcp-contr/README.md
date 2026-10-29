# 3. Exercise 2: Autonomous Curve Grading with a Vision-Language Feedback Loop over the TCP Control Channel -- solution

The worked solution for Exercise 2: a Python agent that connects to the
PhotoCraft TCP control channel, audits a render, proposes one bounded
correction at a time, and stops only when the measured luma clears the target
band. The harness starts a real `photocraft-cli serve`, feeds it a dark
fixture, and verifies every step of the loop.

## What it does

`03_agent_grade.py` opens a token-authenticated TCP control channel, opens
`in/dark.png` through `doc.open`, and renders an audit frame with `doc.render`
(the channel has no `ui.screenshot`). The vision model is replaced by a
deterministic stub in the harness, so the loop is reproducible and spends no
tokens.

Each iteration:

1. renders the document at a bounded side (`maxSide: 768`);
2. hashes the prompt text and the PNG bytes before asking for a decision;
3. accepts only JSON in one of three shapes — `ok`, a `levels` gamma,
   `curves` points, or `exposure`;
4. checks the proposed command against a whitelist and applies exactly one
   correction through `engine.execute`;
5. records the render hash, prompt hash, decision and applied command in
   `grade/audit_trail.jsonl`.

The fixture starts at mean luma 74.4. Two corrections take it to 99 and then
115.3, inside the accepted 110–150 band. The loop stops after three
iterations with `convergedAt: 2`.

Failure paths are part of the contract:

- a wrong control token exits non-zero and the error names authentication;
- three malformed model replies in a row roll the document back and abort
  instead of applying a guessed correction;
- `MAX_VISION_TOKENS=1` stops the loop before the second model call;
- a missing prompt file is a real error, not a silently empty prompt.

## The listings

| file | what it is |
| --- | --- |
| `03_agent_grade.py` | the agent: TCP client, prompt versioning, audit loop, correction whitelist and rollback — also the listing printed in the book |
| `run_ex2.py` | acceptance harness: starts the server, creates the fixture, runs the agent and reopens the audit trail |

## Run it

```bash
cd chapter3/solutions_and_explanations/exercise_2_autonomous-curve-grading-with-a-vision-language-feedback-loop-over-the-tcp-contr/files
"$(git rev-parse --show-toplevel)/tools/pick_python.sh" run_ex2.py
```

The harness puts `tools/craft-cli/bin` on `PATH` itself. It exits non-zero on
the first failed assertion and writes every check to `output/run_ex2.log`.

## What it produces

| artifact | what it is |
| --- | --- |
| `output/in/dark.png` | the 600 × 400 dark fixture the agent grades |
| `output/grade/audit_00.png` … `audit_02.png` | the three audit renders of the converged run |
| `output/grade/audit_trail.jsonl` | one record per iteration: prompt hash, image hash, decision, applied command |
| `output/prompt_v3.txt` | the alternate prompt used to prove the hash is versioned |
| `output/serve.log` | the PhotoCraft server transcript |
| `output/agent.stderr.log` | the agent's stderr |
| `output/run_ex2.log` | every acceptance check |
| `output/run-log.json` | check count, failures, port, initial luma and quirks |

## What the harness asserts

- the server becomes ready on a free port and the agent prints exactly one
  summary line per photograph;
- the summary reports `status: ok`, `iterations: 3`, `convergedAt: 2` and the
  final document `dark.png`;
- the audit trail has one photograph and three iterations, and every record
  has a 64-hex prompt hash and image hash;
- the three audit renders are distinct, bounded to 768 px, and their measured
  mean luma rises `74.4 → 99 → 115.3`;
- exactly two corrections are applied: `image.adjustments.levels` then
  `image.adjustments.exposure`, both on the whitelist;
- `PROMPT_PATH` changes the recorded prompt hash without changing the code;
- a wrong token is rejected, three malformed replies roll back, an unknown
  verb is never read as approval, and the token budget aborts cleanly;
- the server is still alive after every failed run.

## Notes

- The control channel answers `engine.execute`, `jobs.list`, `doc.open` and
  `doc.render`; it does **not** answer `ui.screenshot` or `command_run`. The
  audit render is the real `doc.render` path.
- The model client is a local deterministic stub in the harness. It returns
  the same JSON shapes a vision model would, so no API key or network call is
  required.
- The audit render is written relative to `CRAFT_WRITE_ROOT`; the harness sets
  it to the exercise `output/` directory.
- The prompt is a versioned artifact: changing the prompt changes the hash
  recorded beside every decision.
- The agent reads `PHOTOCRAFT_CONTROL_TOKEN`, the same variable
  `photocraft-cli serve` understands, so one secret configures both ends;
  `PHOTOCRAFT_TOKEN` still works as an alias.
- The failure-path probes at the end of the harness overwrite `grade/`, so it
  re-writes the converged run's three renders and its trail before exiting.
  What is on disk is the run the log describes.
