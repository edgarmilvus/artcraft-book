# Chapter 10 — E-Commerce Graphics Factory - Generating Scaled Multi-Layer Product Banners from Dynamic JSON Feeds

The chapter drives PhotoCraft through its MCP server: a validated feed
becomes a brand-locked composition, the composition is rendered, and the
finished PNGs are cached by recipe hash.

## The projects

Each project has its own README with the command to run it and the
artifacts it writes.

| project | what it is |
| --- | --- |
| [Advanced Application Implementation](advanced_application_implementation/example/) | The graphics factory of the chapter: a product feed and a brand kit are compiled into banners for every placement, with content-addressed asset… |
| [Basic Code Example](basic_code_example/example/) | A minimum viable e-commerce banner generator. |
| [Solution — Exercise 1](solutions_and_explanations/exercise_1_feed-hygiene-gate-validating-and-normalizing-dynamic-product-feeds-before-banner/) | The worked feed gate: ordered rejections, two live 1920×1080 banners and hashed artifacts. |
| [Solution — Exercise 2](solutions_and_explanations/exercise_2_brand-locked-vector-templates-enforcing-color-type-and-safe-zone-rules-via-vecto/) | The worked brand-locked composer: token rules, contrast/safe-zone checks and four vector proofs. |
| [Solution — Exercise 3](solutions_and_explanations/exercise_3_long-running-asset-resolution-agent-mcp-driven-autonomous-fallback-for-missing-h/) | The worked resolution cascade: catalog hit, loopback placeholder and a traced deferral. |
| [Solution — Exercise 4](solutions_and_explanations/exercise_4_multimodal-aesthetic-gate-vision-model-driven-loop-on-rendered-banners/) | The worked aesthetic gate: strict score schema, one correction per pass and a hashed accepted render. |
| [Solution — Exercise 5](solutions_and_explanations/exercise_5_multi-locale-multi-aspect-responsive-export-with-content-hash-cache-manifest/) | The worked responsive fan-out: source-hash cache, RTL alternate pages and three formats per variant. |

## What you need

Node.js 22.5+, Python 3.10+ and the engine binaries — or just Docker. The
root README sets out both paths and the one-time setup:
[what you need](../README.md#what-you-need) and
[install](../README.md#install).

## Run everything

```bash
./chapter10/run_all.sh
```

The script runs every harness in the chapter, prints one line per
harness, and exits non-zero if any of them fails. Each harness leaves
its log in the `output/` directory of the project it exercises.

To run a single project, open its README: it gives the exact command
and the environment that command needs.

## Notes on the engine

The details that will bite you first:

- **`file.placeEmbedded` is disabled in the automation sandbox** — use the
  `doc_place` meta-tool.
- **The read root and the write root are different folders**, and a path
  outside the root it was given is refused.
- **A refused tool call answers `isError`** — check it, or the pipeline will
  happily export a banner that is missing a layer.
