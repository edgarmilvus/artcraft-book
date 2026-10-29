# 8. Exercise 3: Non-Destructive Pathfinder Composition for Multi-Resolution Logos — solution

The worked solution for Exercise 3. A JSON Boolean tree builds three logo
tiers — `xl`, `md` and `sm` — while keeping live Pathfinder effects live and
escalating unsafe flattening instead of baking an editable ancestor.

## What it does

1. Parses the composition spec and resolves every leaf through
   `path.create`.
2. Walks the Boolean tree bottom-up. A `nonDestructive` node becomes
   `object.group` plus an `effect.apply` Pathfinder effect; a destructive
   node becomes the matching `object.pathfinder.*` command.
3. Promotes a destructive node under a live ancestor to a live effect and
   records a warning; if the operation has no live equivalent (`minusBack`)
   it falls back to destructive and warns.
4. Builds each tier in one atomic batch labelled `logo-tier-<tier>`.
5. Applies the `sm` simplification pass: drop the caduceus subtree, replace
   the shield with an ellipse fitted to its bounds, and clip the “H” with a
   rectangle plus an intersect.
6. Measures the returned geometry: anchor count, path count, fill rule,
   self-intersections and a content hash. Writes `diff.json`, the native
   `.vectorcraft` files and the SVG previews.
7. Rebuilds the tiers into `build-2/` and compares the geometry hashes.

## Run it

```bash
cd chapter8/solutions_and_explanations/exercise_3_non-destructive-pathfinder-composition-for-multi-resolution-logos/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex3.ts
```

The engine CLI must be on `PATH`:

```bash
export PATH="/path/to/repo/tools/craft-cli/bin:$PATH"
```

```
75 assertions passed
```

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/build/caduceus-h-xl.vectorcraft` | the 512 pt tier with two live Pathfinder effects |
| `output/build/caduceus-h-xl.svg` | SVG preview of the large tier |
| `output/build/caduceus-h-md.vectorcraft` | the 128 pt tier |
| `output/build/caduceus-h-md.svg` | SVG preview of the medium tier |
| `output/build/caduceus-h-sm.vectorcraft` | the 32 pt tier after the simplification pass |
| `output/build/caduceus-h-sm.svg` | SVG preview of the small tier |
| `output/build/diff.json` | per-tier Boolean counts, live operations, path count, fill rule, self-intersections, warnings and hashes |
| `output/build-2/` | the second build used for the determinism comparison |
| `output/composition-spec.json` | the Boolean tree and simplification rules used by the build |
| `output/report.json` | assertion count, tier summary and artifact list |
| `output/run_ex3.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/03_non-destructive-pathfinder-composition-for-multi-resolution-logos.ts` | flatten-safety, the tree walk, tier batches, simplification and diff report |
| `files/run_ex3.ts` | the acceptance harness: geometry units, three live builds and determinism |
| `files/01_json.json` | the composition spec |
| `files/package.json` | npm scripts and dependencies |
| `files/tsconfig.json` | TypeScript config |

## Notes

- `vectorcraft-cli` must be on `PATH`; the pipeline owns one stdio session and
  closes it in `finally`.
- Each tier is one batch, so `edit.undo` reverts a tier cleanly.
- The SVG previews are derived artifacts; the `.vectorcraft` archive remains
  the editable source.
- Type-check it with `npm run check`.
