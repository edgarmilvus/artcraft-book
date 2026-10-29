# 1. Exercise 2: Autonomous Drift Correction via Multimodal Feedback — A Vision-Guided PhotoCraft TCP Session

The worked solution for Exercise 2. A strictly-authenticated client for
PhotoCraft's TCP control channel, plus the correction loop that drives one
Hue/Saturation adjustment layer until a vision model reports that the skin
tones are right.

## What it does

`CraftLiveClient` opens a socket to `photocraft-cli serve`, sends the auth
frame as the first line, and refuses to run any engine command until the server
has answered `{"ok":true}`. Every later frame is line-delimited JSON with a
monotonically increasing id.

`runDriftCorrection` opens the product document, creates one Hue/Saturation
layer, and then alternates three steps:

1. apply the accumulated correction to that same layer,
2. render the canvas to a PNG in `output/<scenario>/audit/`,
3. hand the PNG to the auditor and validate its reply against the Zod schema.

Corrections are cumulative and land on the layer created before the loop, so
the saved document ends with one live adjustment layer rather than a stack.

The loop stops on the first of: the auditor returns `ok`, two sub-epsilon
saturation corrections in a row (stall), an alternating correction of
comparable magnitude (sign flip), or the iteration budget. Malformed auditor
replies cost one unit of budget and never touch the document.

## The listings

| file | what it is |
| --- | --- |
| `02_autonomous-drift-correction-via-multimodal-feedback-a-vision-guided-photocraft-tcp-session.ts` | the authenticated client, the schema, the oscillation detector and the loop |
| `run_ex2.ts` | acceptance harness: starts the engine, scripts the vision model, asserts on the document |
| `package.json` | dependencies for the listing |
| `tsconfig.json` | TypeScript settings |

## Run it

```bash
cd chapter1/solutions_and_explanations/exercise_2_autonomous-drift-correction-via-multimodal-feedback-a-vision-guided-photocraft-t/files
npx tsx run_ex2.ts
```

The harness starts its own `photocraft-cli serve` on a free port with a fresh
64-hex token and both automation roots pointed at the exercise directory. It
then runs six scenarios: authentication, convergence, oscillation, stall,
malformed reply and budget exhaustion.

## What it produces

| artifact | what it is |
| --- | --- |
| `output/fixtures/product-42.pcraft` | the product document the loop starts from |
| `output/<scenario>/audit/step_<n>.png` | the screenshot the auditor saw at each iteration |
| `output/<scenario>/retouch/product-42-*.pcraft` | the saved document for that exit condition |
| `output/run_ex2.log` | harness log with every assertion |

## What the harness asserts

- an unauthenticated frame is refused, a wrong token cannot connect, and
  `execute()` throws before `connect()`;
- the auditor receives the rendered PNG bytes as base64, not a path;
- the applied corrections are cumulative (`-3/-6` → `-5/-15` → `-8/-26`);
- exactly one Hue/Saturation layer exists, and its values survive a save and
  re-open;
- stall, sign flip, malformed reply and budget exhaustion each produce their
  own exit status without creating a second layer.

## Notes

- Engine CLI on `PATH` (the harness falls back to `tools/craft-cli/bin`).
- Node 22.5+ with `tsx`.
- A real multimodal model can replace the scripted auditor: implement
  `Auditor.review()` and pass the base64 PNG to the model.
