# Post-mortem: job-degrade

## Summary

Outcome: **degraded**. Steps used: 2. Refinements used: 0 of 2. The trace is in `agent_trace.jsonl`.

## Trigger

```json
{
  "jobId": "job-degrade",
  "campaignId": "cmp-windowsill",
  "missingPath": "chapter20/solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/output/work/assets/lifestyle/window-01.jpg"
}
```

## Candidates Considered

```json
[
  {
    "photoId": 2,
    "path": "{'path': 'chapter20/solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/output/work/photos-strict/stale-02.png', 'type': 'file'}",
    "rating": 3,
    "flag": "pick",
    "keywords": [
      "lifestyle",
      "windowsill"
    ],
    "copyId": null,
    "exportedPath": null
  },
  {
    "photoId": 1,
    "path": "{'path': 'chapter20/solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/output/work/photos-strict/stale-01.png', 'type': 'file'}",
    "rating": 4,
    "flag": "pick",
    "keywords": [
      "lifestyle",
      "windowsill"
    ],
    "copyId": null,
    "exportedPath": null
  }
]
```

## Rule Evaluation

* photo 2: color-temp=pass, editability=pass, framing=pass, resolution=FAIL
* photo 1: color-temp=pass, editability=pass, framing=pass, resolution=FAIL

## Decision

```json
{
  "kind": "fallback",
  "variant": "var-b",
  "ctr": 0.012,
  "patch": "chapter20/solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/output/work/derived/job-degrade/campaign.patch.json",
  "publish": {
    "command": [
      ".venv/bin/python",
      "chapter20/solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/files/05_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a-re-entrant-publish-gate.py",
      "--publish-gate",
      "--campaign",
      "chapter20/solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/output/work/derived/job-degrade/campaign.json",
      "--patch",
      "chapter20/solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/output/work/derived/job-degrade/campaign.patch.json",
      "--out",
      "chapter20/solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/output/work/derived/job-degrade"
    ],
    "exitCode": 0,
    "stdout": "{\"ok\": true, \"published\": \"chapter20/solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/output/work/derived/job-degrade/campaign_published.png\"}\n",
    "stderr": "",
    "receipt": {
      "campaignId": "cmp-windowsill",
      "jobId": "job-degrade",
      "published": "chapter20/solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/output/work/derived/job-degrade/campaign_published.png",
      "sha256": "9433bfe547f8d627f90d419ec1f4ce3a9e8bf97cac8c8669d2cf55814917dfb1",
      "bytes": 28668,
      "width": 1080,
      "height": 1350,
      "patchedAsset": "chapter20/solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/output/work/assets/lifestyle/window-01.jpg",
      "replacementAsset": "",
      "fallbackVariant": "var-b",
      "at": "2026-10-26T13:34:24.836993+00:00"
    }
  }
}
```

## Cost

* Wall-clock: 0.31 s (budget 600 s)
* Reasoning: 0.00 s (budget 90 s)
* Input tokens: 240 (budget 60000)
* Output tokens: 16 (budget 8000)
* Engine calls: 2 steps

## Follow-ups

* Restore the missing asset from the object store's backup.
* Add an existence check to the campaign manifest validator, so the job fails before it starts.

