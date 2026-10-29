# 8. Exercise 4: Autonomous Multimodal Bézier Refinement Loop — solution

The worked solution for Exercise 4. It reduces a jittery 120-anchor CAD
silhouette to the 48-anchor budget, renders it, asks a scripted vision model
for a structured critique, and applies only edits that a numeric curvature
spike supports.

## What it does

1. Reads the path with `document.node`, canonicalizes the anchors and hashes
   them.
2. Reduces the fixture to the anchor budget, then starts the loop.
3. Each iteration computes Menger curvature at every anchor, takes the three
   sharpest spikes, renders a preview and asks the vision model for strict
   JSON: kinks, self-intersections, flatness errors and a `looksBroken` flag.
4. `plan_edits()` is a decision table: a kink becomes `path.setHandle` or
   `path.convertAnchor` only when curvature supports it, and an unsupported
   flag is re-checked on a cropped render.
5. Edits go out as one atomic batch labelled `refine-iter-N`.
6. The loop stops on `converged`, `fixed-point` or `iteration-cap`, writes a
   JSONL audit line, and exports the refined document.

## Run it

```bash
cd chapter8/solutions_and_explanations/exercise_4_autonomous-multimodal-b-zier-refinement-loop-vision-guided-path-smoothing/files
PY=$("../../../../tools/pick_python.sh")
"$PY" run_ex4.py
```

The engine CLI must be on `PATH`:

```bash
export PATH="/path/to/repo/tools/craft-cli/bin:$PATH"
```

```
29 assertions passed
```

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/sofa-before.png` | the 120-anchor silhouette before refinement |
| `output/sofa-after.png` | the refined silhouette after the loop |
| `output/sofa-refined.vectorcraft` | the refined native document |
| `output/sofa-refined.svg` | SVG preview of the refined path |
| `output/refinement-log.jsonl` | the per-run audit line: iterations, spikes, critique, edits, hashes and termination reason |
| `output/report.json` | assertion count, anchor counts, iteration summaries and artifact list |
| `output/run_ex4.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/04_bezier_refinement_loop.py` | the MCP session, curvature, critique parsing, decision table, atomic edits and log |
| `files/run_ex4.py` | the acceptance harness: 120-anchor fixture, scripted vision and engine assertions |

## Notes

- `vectorcraft-cli` must be on `PATH`.
- The model is injectable; the harness uses a scripted client, so no API key
  is needed.
- The before/after PNG assertions decode the engine rasters and require the
  two images to differ.
- Python 3.10 or newer.
