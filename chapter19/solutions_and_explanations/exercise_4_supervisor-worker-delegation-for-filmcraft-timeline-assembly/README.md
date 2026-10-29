# 19. Exercise 4: Supervisor–Worker Delegation — solution

The worked Cathedral Post timeline. One supervisor splits a call sheet across
three real FilmCraft workers, enforces the studio policy and journals every
delegation in an HMAC chain.

## What it does

1. Validates the call sheet against the published JSON Schema and assigns each
   scene to the least-loaded worker (`assignScenes` / `planWaves`).
2. Resolves media against the sandbox and builds one delegation task per
   scene with `$N.path` / `$N.result` interpolation.
3. Authorizes every command against the role allow/deny lists before it reaches
   an engine (`authorize`). A denied or unknown command refuses the entire
   delegation.
4. Runs the workers over real FilmCraft MCP sessions; on a failed scene the
   worker rolls back the operations it applied.
5. Records every delegation in `delegations.jsonl`, HMAC-chained; tampering
   with one record is detected at that line.
6. A media path outside the sandbox fails the scene without reaching the
   engine.

## Run it

```bash
cd chapter19/solutions_and_explanations/exercise_4_supervisor-worker-delegation-for-filmcraft-timeline-assembly/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex4.ts
```

```
59 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/cathedral-manifest.json` | per-scene verdicts, workers, waves and rollbacks |
| `output/cathedral-delegations.jsonl` | the HMAC-chained delegation journal |
| `output/work/runs/2026-01-14-cathedral/` | the same files in the run directory |
| `output/work/cathedral/dailies/` | the fixture dailies |
| `output/work/tampered.jsonl` | the tamper fixture and detection proof |
| `output/run_ex4.log` | shell-captured harness log |

## The listings

| file | what it is |
| --- | --- |
| `files/04_supervisor-worker-delegation-for-filmcraft-timeline-assembly.ts` | schema, policy, assignment, transport, supervisor and journal |
| `files/run_ex4.ts` | the real-engine acceptance harness |
| `files/01_jsonc.jsonc`, `files/02_typescript.ts` | the policy and task contracts |

## Notes

- The three FilmCraft sessions are real MCP children (`filmcraft-cli --demo`),
  not mocks.
- A denied command never opens a transport to the engine.
- Rollback is tested by forcing a scene the engine cannot finish: the applied
  operations are undone and the journal records the rollback.
- Type-check it with `npm run check`.
