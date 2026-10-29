# Post-mortem: job-escalate

## Summary

Outcome: **escalated**. Steps used: 1. Refinements used: 0 of 2. The trace is in `agent_trace.jsonl`.

## Trigger

```json
{
  "jobId": "job-escalate",
  "campaignId": "cmp-windowsill",
  "missingPath": "chapter20/solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/output/work/assets/lifestyle/window-01.jpg"
}
```

## Candidates Considered

```json
[]
```

## Rule Evaluation

* no candidate was evaluated.

## Decision

```json
null
```

## Cost

* Wall-clock: 0.04 s (budget 600 s)
* Reasoning: 0.00 s (budget 90 s)
* Input tokens: 300 (budget 60000)
* Output tokens: 20 (budget 8000)
* Engine calls: 1 steps

## Follow-ups

* Restore the missing asset from the object store's backup.
* Add an existence check to the campaign manifest validator, so the job fails before it starts.

