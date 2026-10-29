# Post-mortem: job-repair

## Summary

Outcome: **committed**. Steps used: 4. Refinements used: 1 of 2. The trace is in `agent_trace.jsonl`.

## Trigger

```json
{
  "jobId": "job-repair",
  "campaignId": "cmp-windowsill",
  "missingPath": "chapter20/solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/output/work/assets/lifestyle/window-01.jpg"
}
```

## Candidates Considered

```json
[
  {
    "photoId": 2,
    "path": "{'path': 'chapter20/solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/output/work/photos/window-02.png', 'type': 'file'}",
    "rating": 4,
    "flag": "pick",
    "keywords": [
      "lifestyle",
      "windowsill"
    ],
    "copyId": null,
    "exportedPath": null
  },
  {
    "photoId": 4,
    "path": "{'path': 'chapter20/solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/output/work/photos/window-04.png', 'type': 'file'}",
    "rating": 4,
    "flag": "pick",
    "keywords": [
      "lifestyle",
      "windowsill"
    ],
    "copyId": null,
    "exportedPath": null
  },
  {
    "photoId": 3,
    "path": "{'path': 'chapter20/solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/output/work/photos/window-03.png', 'type': 'file'}",
    "rating": 5,
    "flag": "pick",
    "keywords": [
      "lifestyle",
      "windowsill"
    ],
    "copyId": 6,
    "exportedPath": "chapter20/solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/output/work/derived/job-repair/replacement-3.jpg"
  },
  {
    "photoId": 1,
    "path": "{'path': 'chapter20/solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/output/work/photos/window-01.png', 'type': 'file'}",
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
* photo 4: color-temp=pass, editability=pass, framing=FAIL, resolution=FAIL
* photo 3: color-temp=pass, editability=pass, framing=pass, resolution=pass
* photo 1: color-temp=FAIL, editability=pass, framing=pass, resolution=pass

## Decision

```json
{
  "kind": "replacement",
  "asset": "chapter20/solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/output/work/derived/job-repair/replacement-3.jpg",
  "patch": "chapter20/solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/output/work/derived/job-repair/campaign.patch.json",
  "publish": {
    "command": [
      ".venv/bin/python",
      "chapter20/solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/files/05_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a-re-entrant-publish-gate.py",
      "--publish-gate",
      "--campaign",
      "chapter20/solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/output/work/derived/job-repair/campaign.json",
      "--patch",
      "chapter20/solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/output/work/derived/job-repair/campaign.patch.json",
      "--out",
      "chapter20/solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/output/work/derived/job-repair"
    ],
    "exitCode": 0,
    "stdout": "{\"ok\": true, \"published\": \"chapter20/solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/output/work/derived/job-repair/campaign_published.png\"}\n",
    "stderr": "",
    "receipt": {
      "campaignId": "cmp-windowsill",
      "jobId": "job-repair",
      "published": "chapter20/solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/output/work/derived/job-repair/campaign_published.png",
      "sha256": "44740e2de0382fb7b78b6108832b05fa4472b8238911c34bcc33a356a14cb994",
      "bytes": 27666,
      "width": 1080,
      "height": 1350,
      "patchedAsset": "chapter20/solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/output/work/assets/lifestyle/window-01.jpg",
      "replacementAsset": "chapter20/solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/output/work/derived/job-repair/replacement-3.jpg",
      "fallbackVariant": null,
      "at": "2026-10-26T13:34:24.477726+00:00"
    }
  }
}
```

## Cost

* Wall-clock: 0.60 s (budget 600 s)
* Reasoning: 0.00 s (budget 90 s)
* Input tokens: 2121 (budget 60000)
* Output tokens: 180 (budget 8000)
* Engine calls: 4 steps

## Follow-ups

* Restore the missing asset from the object store's backup.
* Add an existence check to the campaign manifest validator, so the job fails before it starts.

