# 7. Basic Code Example

A single-file hello world for the multimodal feedback pattern: a bounded
critique → render → correct loop over a real headless PhotoCraft session,
with the vision model replaced by a scripted auditor so it runs offline.

## What it does

`01_multimodal-qa-hello-world.ts` exports `runQaLoop`. A call opens nothing
itself — it receives a connected MCP `Client` — creates a 1024×768 document,
seeds it with a deliberately over-brightened composite curves layer, then
loops: `doc_render_preview` (768 px long edge), audit the PNG, filter the
proposed corrections by an allow-list and a 0.6 confidence floor, and apply
what survives with one `command_batch`.

The loop has four exits, and they are the four outcomes worth testing: the
critic says `ok`, nothing survives the filter (`confidence_floor`), the batch
fails partway (`batch_failed`), or the hard cap of three iterations is
reached (`max_iterations`). On a partial batch the loop measures how many
steps landed, issues one `edit.undo` per completed step, and stops — because
a batch is not a transaction. The document is saved to `.pcraft` in every
outcome, including the failed one.

## The listings

| file | what it is |
| --- | --- |
| `01_multimodal-qa-hello-world.ts` | the complete module: schemas, prompt, helpers, `runQaLoop` |
| `package.json` | npm scripts (`check`) and dependencies |
| `tsconfig.json` | TypeScript config |

## Run it

```bash
cd chapter7/basic_code_example/example/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_basic.ts
```

```
50 assertions passed
```

The harness runs four engine scenarios with a scripted auditor:

| scenario | iterations | outcome |
| --- | --- | --- |
| happy | 2 | one correction landed, critic said `ok` |
| batch | 1 | `completed=1 failed=1`, prefix undone, `batch_failed` |
| floor | 1 | nothing applied, `confidence_floor`, document at seed |
| cap | 3 | three corrections landed, `max_iterations`, five layers |

## What it produces

| artifact | what it is |
| --- | --- |
| `files/output/basic/a-happy.pcraft` | document after the correction |
| `files/output/basic/b-failed.pcraft` | document saved after the failed batch was unwound |
| `files/output/basic/c-floor.pcraft` | document untouched beyond the seed |
| `files/output/basic/d-cap.pcraft` | document with all three capped corrections |
| `output/run_basic.log` | the harness log |

Each `.pcraft` is a zip container; the harness checks the `PK` magic bytes.

## Notes

- `photocraft-cli` must be on `PATH` (via `tools/craft-cli/bin`).
- No API key is needed: the auditor is a scripted function with the same
  `VisionAuditor` signature the OpenAI implementation uses.
- The preview cap is asserted twice — payload is a PNG, and the long edge is
  768 with the source aspect ratio preserved.
