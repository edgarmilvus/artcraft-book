# 7. Exercise 2: Brand-Compliance Vision Auditor for VectorCraft Packaging Die-Lines — solution

The worked solution for Exercise 2. It drives `vectorcraft-cli` over MCP,
builds a compact structural digest from the live document, and sends the
rendered artboard plus that digest to a vision model. Every color number is
computed locally; the model only supplies the visual judgment.

## What it does

1. Opens a `.vectorcraft` SKU and builds a digest with `doc_inspect`,
   `document.node`, swatch data and object bounds.
2. Renders the artboard with `doc_render_preview` and sends the PNG plus the
   digest to the vision model.
3. Compiles each violation into VectorCraft commands: restore clear space,
   move an object out of the die-line, close a spot swatch to its ΔE target,
   remove an effect, or flatten a gradient.
4. Dry-runs geometry fixes inside an undo group, re-renders, and cancels the
   dry run before applying the correction for real.
5. Escalates unsafe fixes instead of applying them: a wordmark move over
   4 pt, an ink change over 8 points on a channel, or anything left when the
   round budget is exhausted.
6. Re-inspects the document and writes the before/after evidence beside the
   per-scenario reports.

The harness runs three scenarios against real documents: a clean convergence,
two escalated fixes, and a two-round budget that applies the first two fixes
and escalates the rest.

## Run it

```bash
cd chapter7/solutions_and_explanations/exercise_2_brand-compliance-vision-auditor-for-vectorcraft-packaging-die-lines/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex2.ts
```

The engine CLIs must be on `PATH`:

```bash
export PATH="/path/to/repo/tools/craft-cli/bin:$PATH"
```

```
71 assertions passed
```

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/final-main.png` | corrected 1024 px artboard after all four fixes |
| `output/report-main.json` | full report: digest, audit, applied fixes, dry runs, final digest |
| `output/final-escalation.png` | artboard after the escalation scenario (unchanged by design) |
| `output/report-escalation.json` | both rejected fixes and their escalation reasons |
| `output/final-budget.png` | artboard after the two-round budget scenario |
| `output/report-budget.json` | two applied fixes and two budget escalations |
| `output/report.json` | scenario index, assertion count and artifact list |
| `output/run_ex2.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/02_brand-compliance-vision-auditor-for-vectorcraft-packaging-die-lines.ts` | the auditor: digest, color math, dry runs, guarded batches and report envelope |
| `files/run_ex2.ts` | the acceptance harness: three real engine scenarios plus unit checks |
| `files/package.json` | npm scripts and dependencies |
| `files/tsconfig.json` | TypeScript config |

## Notes

- `vectorcraft-cli` must be on `PATH`; no API key is needed because the
  harness injects a scripted vision model.
- The harness creates its fixtures under `files/input/` and writes evidence
  to `../output/`.
- `npm run check` type-checks the solution module and the harness.
