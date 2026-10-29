# 10. Exercise 1: Feed Hygiene Gate — solution

The worked feed gate. It validates every row in a fixed order, renders the
usable rows through PhotoCraft and writes an atomic audit with artifact byte
counts and SHA-256 hashes.

## What it does

1. Reads `feed.json` and checks each row in this order: control characters,
   SKU, title, title length, price, sale price, currency, hero path, path
   escape and mojibake. The first failure wins, so a row has one reason.
2. Rejected rows never touch the engine.
3. A usable row becomes: `doc_new`, `layer.new.layer`, `doc_place` (a
   meta-tool, not a registry command), the title and price type layers, the
   brand curve and `doc_export`.
4. The gate reads the PNG back, records its byte count and SHA-256, and
   counts it as accepted only if the file exists.
5. A batch failure is counted as `deferred`, not silently rejected.
6. The report is written to a `.tmp` file and renamed into place, so readers
   never see a partial audit.

## Run it

```bash
cd chapter10/solutions_and_explanations/exercise_1_feed-hygiene-gate-validating-and-normalizing-dynamic-product-feeds-before-banner/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex1.ts
```

PhotoCraft must be on `PATH`:

```bash
export PATH="/path/to/repo/tools/craft-cli/bin:$PATH"
```

```
35 assertions passed
```

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/feed.json` | two usable rows and five rejected rows |
| `output/feeds/hero-a.png` | hero for the first accepted row |
| `output/feeds/hero-b.png` | hero for the second accepted row |
| `output/banners/SKU-1.png` | rendered 1920×1080 banner |
| `output/banners/SKU-2.png` | second rendered banner |
| `output/banners/feed-audit.json` | accepted/deferred counts, ordered rejections and artifact hashes |
| `output/report.json` | harness summary and artifact list |
| `output/run_ex1.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/01_solutions_and_explanations.ts` | ordered rejection rules, batch builder, PhotoCraft session and `runGate()` |
| `files/run_ex1.ts` | the acceptance harness: rule units, seven-row feed, two live renders and hash checks |
| `files/package.json` | npm scripts and dependencies |
| `files/tsconfig.json` | TypeScript config |

## Notes

- `doc_new`, `doc_place` and `doc_export` are MCP tools, not registry
  commands; the gate calls them directly and batches only the registry
  commands.
- The read root and write root are separate; the hero paths are relative to
  the read root and the exported PNGs land under the write root.
- Type-check it with `npm run check`.
