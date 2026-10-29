# 12. Exercise 5: WASM SIMD Segment Classification — solution

The worked classifier boundary. A WebAssembly module with a SIMD probe takes
RGBA bytes, returns a twelve-class softmax, and the agent validates the result
before it can influence a B-roll placement.

## What it does

1. `loadClassifier()` compiles `classifier.wasm` and refuses to run unless
   `simd_probe()` returns `0x5A5A5A5A`.
2. `pngToRGBA()` decodes a rendered PNG through `sharp` when present, with a
   `pngjs` fallback.
3. `classifyFrame()` copies RGBA into the module's linear memory, calls
   `classify`, and reads the twelve `f32` probabilities back.
4. `ClassificationSchema` enforces twelve probabilities, a sum within `1e-4`
   and a label from the fixed category list.
5. The full pipeline shards frames across worker threads, writes three frames
   per clip, sorts `broll_index.jsonl`, and places up to three V3 clips per
   briefed section without touching the V2 transcript pass.

## Run it

```bash
cd chapter12/solutions_and_explanations/exercise_5_wasm-simd-accelerated-segment-classification-for-automatic-b-roll-selection/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex5.ts
```

```
16 assertions passed
```

The harness ships a tiny deterministic `classifier.wasm` with the required
exports, then exercises the SIMD probe, RGBA transfer, softmax validation and
project traversal. The MCP sampling/placement path is `main()` in the solution.

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/read/classifier.wasm` | the 197-byte test module with `alloc`, `free`, `classify`, `simd_probe` |
| `output/write/sample-frame.png` | the RGBA source frame |
| `output/classification.json` | twelve probabilities, top label and probe value |
| `output/report.json` | assertion count, probe, label and artifact list |
| `output/run_ex5.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/05_wasm-simd-accelerated-segment-classification-for-automatic-b-roll-selection.ts` | module loader, SIMD gate, PNG decode, worker sharding, index and placement |
| `files/run_ex5.ts` | the acceptance harness: test module, RGBA transfer, schema and project tree |
| `files/01_typescript.ts` | the classification and batch report contract |

## Notes

- The module is import-safe: `main()` runs only when the file is the entry
  point, so the harness can load the boundary directly.
- A corrupt softmax is rejected before it can reach a placement decision.
- Type-check it with `npm run check`.
