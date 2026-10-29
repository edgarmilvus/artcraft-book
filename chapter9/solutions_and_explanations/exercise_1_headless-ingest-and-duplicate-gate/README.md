# 9. Exercise 1: Headless Ingest and Duplicate Gate — solution

The worked ingest tier. It stages a RAW-like corpus, enumerates candidates
with `library.importPreview`, imports them into a real LightCraft library,
computes a library snapshot before and after, groups byte-exact and
perceptual duplicates, and stacks each duplicate group.

## What it does

1. `library_fingerprint()` reads the catalog ids before and after the
   import, so a second pass can prove that nothing new was added.
2. `enumerate_candidates()` runs `library.importPreview`; nothing is added
   by the dry run.
3. `library.import` commits the corpus. LightCraft itself refuses the
   byte-exact copy, which leaves four imported frames.
4. `sha256_header()` hashes the first MiB of each source; `dhash64_from_png()`
   reduces a 64 px render to a 64-bit difference hash; `hamming()` groups
   perceptual neighbors at a threshold of six bits.
5. `stack_duplicate_groups()` writes each group through `stack.group`, so a
   duplicate costs one catalog row instead of several.
6. The face pipeline is represented by its pure pieces: `FaceRow`,
   `_crop_face()` and the embedding row contract. The live face download and
   Postgres/OpenAI phases need external services and are not part of this
   offline harness.

## Run it

```bash
cd chapter9/solutions_and_explanations/exercise_1_headless-ingest-and-duplicate-gate/files
PY=$("../../../../tools/pick_python.sh")
"$PY" run_ex1.py
```

The engine CLI must be on `PATH`:

```bash
export PATH="/path/to/repo/tools/craft-cli/bin:$PATH"
```

```
27 assertions passed
```

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/staging/frame-a.png` | the source frame |
| `output/staging/frame-a-copy.png` | byte-exact copy refused by the import gate |
| `output/staging/frame-a-bright.png` | perceptual near-duplicate |
| `output/staging/frame-b.png` | a distinct frame |
| `output/staging/frame-c.png` | another distinct frame |
| `output/previews/photo-1.png` | a 160 px render used for the perceptual hash |
| `output/library/catalog.snap` | the library catalog after the run |
| `output/library/catalog.log` | the import / stack journal |
| `output/report.json` | snapshot ids, imported ids, duplicate groups and stack counts |
| `output/run_ex1.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/01_ingest.py` | MCP transport, preview/commit, face bootstrap, duplicate detection, DDL and the orchestrator |
| `files/run_ex1.py` | the acceptance harness: staging, idempotency, hashing, grouping and stacking |

## Notes

- LightCraft has no automation roots: the library is opened with
  `--library`, and the engine reads the paths it is given.
- The byte-exact copy is deliberately kept in the staging folder to show the
  import gate refusing it; the perceptual duplicate is the one that reaches
  the stack.
- Python 3.10 or newer. The harness uses the repository virtual environment
  for `Pillow`, `numpy`, `asyncpg` and `openai`.
