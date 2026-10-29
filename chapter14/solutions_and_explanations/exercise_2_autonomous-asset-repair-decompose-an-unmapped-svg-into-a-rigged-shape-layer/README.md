# 14. Exercise 2: Autonomous Asset Repair — solution

The worked SVG repair. An unmapped logo is parsed into anchor handles,
unsupported shapes are named instead of silently dropped, and the repaired
mark is written back as editable paths.

## What it does

1. `parseSvgPaths()` extracts every `<path d="…">` into subpaths with cubic
   handles; `M/L/H/V/C` are supported and arcs are reported.
2. Basic shapes (`circle`, `rect`, `polygon`, `polyline`, `ellipse`) are
   reported as unsupported so the caller knows what still needs conversion.
3. `dHash()` produces a 64-bit perceptual fingerprint and `hamming()` measures
   the distance between two renders.
4. `hexToHue()` / `dominantFillHue()` recover the brand hue from a fill token.
5. The repair loop can insert the parsed paths through a native path command
   or the `run_script` fallback, preserving modifiers and checking idempotency.

## Run it

```bash
cd chapter14/solutions_and_explanations/exercise_2_autonomous-asset-repair-decompose-an-unmapped-svg-into-a-rigged-shape-layer/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex2.ts
```

```
17 assertions passed
```

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/parsed-paths.json` | subpaths, handles, warnings and the source dHash |
| `output/repaired-logo.svg` | the SVG with the unsupported circle decomposed to a path |
| `output/report.json` | assertion count, subpath/warning counts and artifact list |
| `output/run_ex2.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/02_autonomous-asset-repair-decompose-an-unmapped-svg-into-a-rigged-shape-layer.ts` | SVG parser, dHash, repair script, native path insertion and idempotency |
| `files/run_ex2.ts` | the acceptance harness: parsing, unsupported-shape report, dHash and hue |
| `files/01_typescript.ts` | the repair plan and report contract |

## Notes

- The parser is hostile-input tolerant: it names unsupported commands instead
  of producing a partial path without a warning.
- The dHash fixture uses two different gradients because a uniform fill has no
  horizontal edge to hash.
- Type-check it with `npm run check`.
