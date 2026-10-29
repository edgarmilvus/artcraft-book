# 8. Exercise 2: Live Blend Morphing Engine for Animated Brand Marks — solution

The worked solution for Exercise 2. It aligns two paths with different
anchor counts, builds a live 24-step blend, bends its spine into a quarter
arc, and samples the morph at five positions over the authenticated loopback
control channel.

## What it does

1. Authenticates to the control channel with the mandatory 64-hex token.
2. Reads both marks with `document.node`, measures every cubic segment and
   inserts synthetic anchors through `path.insertAnchor` until the topology
   matches.
3. Builds the blend in one atomic batch: `object.blend.make` with 24 steps,
   four `object.blend.spine.moveAnchor` commands and one
   `object.blend.spine.reshapeSegment`.
4. Answers `morph.sample` from `object.blend.info`: arclength-parametrised
   spine interpolation, a unit tangent, stroke-width drift and bounds.
5. Renders five raster samples and exports the live document.
6. Runs a vision review: a clean morph is accepted; a permanent pinch adds a
   spine anchor, is re-reviewed, and escalates after three repairs.

The harness starts `stub_control_server.py`, which speaks the same auth and
`engine.execute` frames as the desktop app and forwards every command to the
real headless `vectorcraft-cli`.

## Run it

```bash
cd chapter8/solutions_and_explanations/exercise_2_live-blend-morphing-engine-for-animated-brand-marks/files
PY=$("../../../../tools/pick_python.sh")
"$PY" run_ex2.py
```

The engine CLI must be on `PATH`:

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
| `output/samples/t-0.00.png` | rendered blend at `t = 0` |
| `output/samples/t-0.25.png` | rendered blend at `t = 0.25` |
| `output/samples/t-0.50.png` | rendered blend at `t = 0.50` |
| `output/samples/t-0.75.png` | rendered blend at `t = 0.75` |
| `output/samples/t-1.00.png` | rendered blend at `t = 1` |
| `output/samples.json` | bounds, tangent, stroke drift and spine anchors for every sample |
| `output/blend-info.json` | the engine's blend record: keys, steps and bent spine |
| `output/morph.vectorcraft` | the live blend document |
| `output/morph.svg` | SVG preview of the same document |
| `output/review.json` | the accepted critique and the escalated pinch run |
| `output/report.json` | assertion count, blend summary and artifact list |
| `output/run_ex2.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/02_live_blend_morphing_engine.py` | topology alignment, spine build, TCP client, sampler math and vision review |
| `files/run_ex2.py` | the acceptance harness: auth, alignment, build, sampling, raster and review |
| `files/stub_control_server.py` | headless stand-in for the desktop control channel |

## Notes

- `vectorcraft-cli` must be on `PATH`. The stub is test infrastructure; the
  production path is the desktop application's loopback server.
- The auth frame is mandatory and must be first.
- The five PNGs are real `800×800` engine renders, one per sampled position.
- Python 3.10 or newer.
