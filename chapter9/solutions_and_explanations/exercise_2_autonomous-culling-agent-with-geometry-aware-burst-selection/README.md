# 9. Exercise 2: Autonomous Culling Agent with Geometry-Aware Burst Selection — solution

The worked culling agent. It clusters a staged burst, scores every candidate
from engine measurements, and commits one pick with explicit rejects. The
model drives the investigation; the score remains the authority.

## What it does

1. Stages three frames — one sharp, one soft, one middle — and imports them
   into a real LightCraft library.
2. Exposes five tools to the model: run a LightCraft command, query the
   vector store, fetch a k-nearest burst, evaluate a hero score, and commit a
   decision.
3. `evaluateHero()` combines `photo.analyze` sharpness (40 %), eye openness
   (25 %), horizon (20 %) and composition (15 %).
4. `commitDecision()` turns the decision into one `command_batch` of
   `photo.flag` writes, so the cluster is picked/rejected together.
5. The harness also unit-tests the exact weighted score and the flag batch
   against a fake engine before it runs the live agent loop.
6. It renders every staged frame to a JPEG preview and writes the catalog
   audit beside the run.

## Run it

```bash
cd chapter9/solutions_and_explanations/exercise_2_autonomous-culling-agent-with-geometry-aware-burst-selection/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex2.ts
```

The engine CLI must be on `PATH`:

```bash
export PATH="/path/to/repo/tools/craft-cli/bin:$PATH"
```

```
20 assertions passed
```

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/staging/shot-0.png` | the sharp frame |
| `output/staging/shot-1.png` | the soft frame |
| `output/staging/shot-2.png` | the middle frame |
| `output/previews/shot-0.jpg` | a 512 px render of the pick |
| `output/previews/shot-1.jpg` | a render of the first reject |
| `output/previews/shot-2.jpg` | a render of the second reject |
| `output/library/catalog.snap` | the catalog after the flag batch |
| `output/library/catalog.log` | the journal of imports and flags |
| `output/audit.json` | cluster rows, engine scores, flags and the agent report |
| `output/report.json` | assertion count, cluster members and artifact list |
| `output/run_ex2.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/02_autonomous-culling-agent-with-geometry-aware-burst-selection.ts` | MCP client, dispatcher, hero scoring, commit batch and agent loop |
| `files/01_claude_tools.ts` | the five tool schemas |
| `files/02_scoring_contract.py` | the score breakdown and hysteresis contract |
| `files/run_ex2.ts` | the acceptance harness: score units, staged burst, model loop and catalog check |

## Notes

- The model, vector store and eyes model are injectable; the harness uses
  local implementations, so no API key or database is needed.
- The MCP transport buffers complete newline-delimited replies, which matters
  for large `catalog.query` responses.
- `evaluateHero()` writes scratch crops under
  `LIGHTCRAFT_SCRATCH` (default: the system temp directory), not `/work`.
- Type-check it with `npm run check`.
