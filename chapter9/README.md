# Chapter 9 — High-Throughput RAW Photographic Development - 32-Bit Float Grading and Culling in LightCraft

The chapter drives LightCraft through its MCP server: catalog import,
sharpness culling, 32-bit float grading and multi-tier export.

## The projects

Each project has its own README with the command to run it and the
artifacts it writes.

| project | what it is |
| --- | --- |
| [Advanced Application Implementation](advanced_application_implementation/example/) | A production-shaped RAW delivery worker. |
| [Basic Code Example](basic_code_example/example/) | The "hello world" of the LightCraft RAW pipeline: import a burst, score every frame, cluster look-alikes through a vector store, pick one winner,… |
| [Solution — Exercise 1](solutions_and_explanations/exercise_1_headless-ingest-and-duplicate-gate/) | The worked ingest tier: preview/commit, idempotent snapshots, perceptual duplicate groups and stacks. |
| [Solution — Exercise 2](solutions_and_explanations/exercise_2_autonomous-culling-agent-with-geometry-aware-burst-selection/) | The worked culling agent: weighted hero score, tool loop, flag batch and rendered previews. |
| [Solution — Exercise 3](solutions_and_explanations/exercise_3_32-bit-float-linear-hdr-merge-and-gpu-accelerated-tone-mapping-chain/) | The worked HDR chain: bracket merge, 32-bit Rec.2020 proof and four display deliverables. |
| [Solution — Exercise 4](solutions_and_explanations/exercise_4_multimodal-vision-in-the-loop-grading-auditor-over-the-tcp-control-channel/) | The worked TCP auditor: numeric gate, bounded develop changes, version snapshots and XMP. |
| [Solution — Exercise 5](solutions_and_explanations/exercise_5_headless-batch-export-orchestrator-with-hnsw-accelerated-deduplication-gate/) | The worked export service: fused-vector dedup gate, real JPEG/PNG exports and JSON-RPC health. |

## What you need

Node.js 22.5+, Python 3.10+ and the engine binaries — or just Docker. The
root README sets out both paths and the one-time setup:
[what you need](../README.md#what-you-need) and
[install](../README.md#install).

## Run everything

```bash
./chapter9/run_all.sh
```

The script runs every harness in the chapter, prints one line per
harness, and exits non-zero if any of them fails. Each harness leaves
its log in the `output/` directory of the project it exercises.

To run a single project, open its README: it gives the exact command
and the environment that command needs.

## Notes on the engine

The details that will bite you first:

- **No automation roots.** The library is opened with `--library`, and the
  engine reads the files the `import` tool is given.
- **`command_batch` has no `atomic` and no `label`** — and a batch is not one
  undo step, so check `failed` on the reply.
- **A pick, a reject and a neutral are `photo.flag` with a different
  `flag` value.**
- **The white balance is `wb.temp` and `wb.tint`**; there is no
  `color.mixer.temperature`.
