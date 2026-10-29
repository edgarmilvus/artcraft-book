# 20. Solutions and Explanations

The worked solution for Exercise 1: a banner factory that produces a
complete campaign banner set from a manifest. `01_banner_factory.py`
implements the full pipeline: validate manifest → render hero via
PhotoCraft → render logo variants via VectorCraft → render layout via
DesignCraft → assemble lower-third via EffectCraft → export trailer via
FilmCraft → generate PDF/A delivery sheet via PdfCraft → write DOCX brief
via WordCraft → audit all renders via vision stub → emit campaign bundle.

## The listings

| file | what it is |
| --- | --- |
| `01_banner_factory.py` | the complete banner factory (Python) |

## Run it

```bash
cd chapter20/solutions_and_explanations/exercise_1_the-banner-factory-campaign-kickoff-to-published-asset/files
PY=$("../../../../tools/pick_python.sh")
"$PY" run_ex1.py
```

```
72 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/campaign-report.json` | the factory report for every SKU (also under `work/out/`) |
| `output/nw-lamp-02-instagram.png` | the Instagram banner for one SKU |
| `output/nw-lamp-02-trace.jsonl` | the ordered tool trace for that banner |
| `output/manifest.json` | the campaign manifest (also under `work/`) |
| `work/out/<sku>/banners/`, `cutouts/` | web, Instagram and Amazon variants |
| `work/assets/` | the VectorCraft logo and PhotoCraft product shots |
| `output/run_ex1.log` | the harness log |

## Notes

- All ten engines on `PATH`.
- Python 3.10+ (repo `.venv` preferred).
- The factory is the reference implementation the capstone extends.
- Vision stub and LLM are injected deterministic functions.
