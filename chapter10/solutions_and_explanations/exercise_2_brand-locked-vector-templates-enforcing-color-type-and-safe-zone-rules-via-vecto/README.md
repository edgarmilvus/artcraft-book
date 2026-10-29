# 10. Exercise 2: Brand-Locked Vector Templates — solution

The worked brand-locked composer. It resolves colors and fonts by token,
checks contrast and the safe zone before sending a batch, and exports a
native master plus PDF, SVG and 2× PNG proofs.

## What it does

1. Reads the brand kit on every run; swatches are resolved by role and fonts
   by an allow-list.
2. Computes WCAG relative luminance and contrast for every text/background
   pair.
3. Runs the safe-zone pre-check on content elements. The background plate is
   intentionally full-bleed and exempt.
4. Builds one deterministic sequence of MCP tool calls — `draw_shape`,
   `draw_path`, `add_text` — because those are tools, not registry commands.
5. Reads the document back and checks the stacking order.
6. Exports `.vectorcraft`, PDF, SVG with live text and a 2× PNG.
7. Rejects with `brand-color`, `brand-font`, `safe-zone`, `contrast`,
   `z-order` or `missing-field`; the dry-run path exercises the rule engine
   without an engine session.

## Run it

```bash
cd chapter10/solutions_and_explanations/exercise_2_brand-locked-vector-templates-enforcing-color-type-and-safe-zone-rules-via-vecto/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex2.ts
```

VectorCraft must be on `PATH`:

```bash
export PATH="/path/to/repo/tools/craft-cli/bin:$PATH"
```

```
33 assertions passed
```

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/read/hero.png` | staged hero asset |
| `output/read/logo.svg` | staged logo token |
| `output/write/LOCKED-1.vectorcraft` | editable native master |
| `output/write/LOCKED-1.pdf` | print proof |
| `output/write/LOCKED-1.svg` | SVG with live text |
| `output/write/LOCKED-1@2x.png` | 2× raster proof |
| `output/write/brand-template-audit.json` | per-row rule result and artifacts |
| `output/report.json` | harness summary and artifact list |
| `output/run_ex2.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/02_brand-locked-vector-templates-enforcing-color-type-and-safe-zone-rules-via-vectorcraft-mcp.ts` | rule engine, composition plan, tool batch, z-order check and exports |
| `files/run_ex2.ts` | the acceptance harness: contrast/safe-zone units, dry-run rejections and live export |
| `files/01_typescript.ts` | the brand-kit and result contract |
| `files/package.json` | npm scripts and dependencies |
| `files/tsconfig.json` | TypeScript config |

## Notes

- The CTA uses `Brand White` on the accent token; the original example
  accidentally checked the background color against the accent and failed
  its own contrast rule.
- The logo mark is drawn from the accent token rather than a second image
  placement, because this engine build has no `file.place` tool.
- Type-check it with `npm run check`.
