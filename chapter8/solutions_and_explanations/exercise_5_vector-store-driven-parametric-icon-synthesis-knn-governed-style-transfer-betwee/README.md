# 8. Exercise 5: Vector Store-Driven Parametric Icon Synthesis — solution

The worked solution for Exercise 5. A natural-language description is
embedded, eight approved icons are retrieved from the vector store, a style
consensus is derived, and a new icon is synthesized in VectorCraft and
validated against the same store.

## What it does

1. Seeds a local vector store with eight approved icons built by the same
   shape grammar.
2. Embeds the request and retrieves the eight nearest neighbors with cosine
   distance.
3. Builds a weighted style consensus: stroke width, cap, fill opacity and
   corner class.
4. Maps description tokens to subpaths and synthesizes the candidate in one
   atomic batch of `path.create` calls plus fill and stroke.
5. Re-embeds the candidate and validates it against the store. A candidate
   above the 0.94 similarity threshold is perturbed along local normals and
   then shrunk until it is accepted or the budget runs out.
6. Writes a nested hash chain — spec, retrieval, geometry, validation and
   composite — plus one provenance row per neighbor.
7. Re-runs the pipeline against a store containing the candidate's twin to
   exercise the rejection path.

## Run it

```bash
cd chapter8/solutions_and_explanations/exercise_5_vector-store-driven-parametric-icon-synthesis-knn-governed-style-transfer-betwee/files
PY=$("../../../../tools/pick_python.sh")
"$PY" run_ex5.py
```

The engine CLI must be on `PATH`:

```bash
export PATH="/path/to/repo/tools/craft-cli/bin:$PATH"
```

```
36 assertions passed
```

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/candidate.vectorcraft` | the synthesized icon as a native document |
| `output/candidate.svg` | SVG preview of the candidate |
| `output/candidate.png` | a rendered `1024×1024` preview |
| `output/style-provenance.json` | one entry per retrieved neighbor with similarity and weight |
| `output/validation.json` | the spec, retrieval, geometry, validation and composite hashes |
| `output/store.json` | the eight approved rows without their embedding vectors |
| `output/report.json` | assertion count, request, accepted/rejected paths and artifact list |
| `output/run_ex5.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/05_vector_store_icon_synthesis.py` | the vector store, embedder, consensus, grammar, synthesis, perturbation and hashing |
| `files/run_ex5.py` | the acceptance harness: store seed, retrieval, synthesis, package and rejection path |

## Notes

- `vectorcraft-cli` must be on `PATH`; no Postgres or API key is required
  because `LocalVectorStore` implements the same JSON-RPC bus in memory.
- The embedder is deterministic, which makes the composite hash meaningful.
- The PNG preview is rendered by the engine after the accepted synthesis.
- Python 3.10 or newer.
