# 20. Exercise 5: Self-Healing Campaign — solution

The worked re-entrant campaign agent. It plans a render, audits the result,
recovers an unmapped asset, and either publishes or escalates with a signed
decision.

## What it does

1. Reads the campaign, analytics and page outbox; detects the unmapped asset
   and computes edit distance for candidate replacements.
2. Repairs on a virtual copy of the photograph: the corrected temperature is
   inside the envelope, the source is untouched and at least three candidates
   are considered.
3. Publishes the repaired campaign and records a patch, receipt and
   post-mortem; the repair trace is not world-readable.
4. Degrades gracefully when no suitable asset exists: writes a patch naming
   the fallback variant and a receipt, exits 0, publishes no replacement.
5. Escalates with exit code 7 when the repair is not safe, with the trace in
   the artifact and nothing published.
6. Stops on budget (exit 8) and on a security-policy violation (exit 9),
   writing the escalation artifact and paging the right channel.
7. A re-run of the repair job is re-entrant and keeps the earlier receipts.

## Run it

```bash
cd chapter20/solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/files
PY=$("../../../../tools/pick_python.sh")
"$PY" run_ex5.py
```

```
52 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/repair-published.png` | the repaired campaign render |
| `output/repair-patch.json` | the asset substitution patch |
| `output/repair-postmortem.md` | the repair decision and candidates |
| `output/degrade-receipt.json` | the no-replacement fallback receipt |
| `output/escalate.json`, `security-escalation.json` | the escalation artifacts |
| `output/work/derived/job-*` | every job’s trace, patch, receipt and post-mortem |
| `output/run_ex5.log` | shell-captured harness log |

## The listings

| file | what it is |
| --- | --- |
| `files/05_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a-re-entrant-publish-gate.py` | planner, repair, degrade, escalation, budget and security gates |
| `files/run_ex5.py` | the real-engine acceptance harness |

## Notes

- The repair edits a virtual copy, so the source photograph is byte-identical
  after the run.
- Exit codes are part of the contract: `0` degraded, `7` escalation, `8`
  budget, `9` security.
- The escalation artifact carries the trace summary, so a human can replay
  why the agent stopped.
- Type-check equivalent: `python3 -m py_compile` on the module and harness.
