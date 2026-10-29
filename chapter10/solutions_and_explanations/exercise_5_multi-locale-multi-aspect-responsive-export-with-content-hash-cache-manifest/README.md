# 10. Exercise 5: Multi-Locale, Multi-Aspect Responsive Export — solution

The worked responsive fan-out. A source hash decides whether a variant is
rendered, a lock serializes manifest writers, and the manifest is merged
rather than overwritten.

## What it does

1. Canonicalizes the row, brand-kit version, locale, aspect, template and
   formats, then hashes that tuple into a per-variant `sourceHash`.
2. Takes a lock file around the manifest read/merge/write.
3. Builds a real DesignCraft template with one text frame and a paragraph
   style per locale.
4. Renders a miss: open the template, set the localized story, apply the
   locale style, set RTL for `ar-SA`, create the aspect alternate, validate
   the safe zone, export the PDF proof and raster PNG/JPEG/WebP deliverables.
5. Records each entry's artifact bytes and SHA-256 and the ordered command
   trace.
6. A second dry-run resolves the two cached variants as hits and the other
   28 as misses, without starting an engine session.
7. `mergeManifest()` keeps entries the current run did not touch.

## Run it

```bash
cd chapter10/solutions_and_explanations/exercise_5_multi-locale-multi-aspect-responsive-export-with-content-hash-cache-manifest/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex5.ts
```

DesignCraft and PhotoCraft must be on `PATH`:

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
| `output/work/template.designcraft` | the fan-out template |
| `output/work/TEE-001-enUS-1x1.png` | square 1:1 PNG |
| `output/work/TEE-001-enUS-1x1.webp` | square WebP |
| `output/work/TEE-001-enUS-1x1.jpg` | square JPEG |
| `output/work/TEE-001-enUS-1x1-proof.pdf` | vector proof |
| `output/work/TEE-001-arSA-9x16.png` | RTL 9:16 PNG |
| `output/work/TEE-001-arSA-9x16.webp` | RTL 9:16 WebP |
| `output/work/TEE-001-arSA-9x16.jpg` | RTL 9:16 JPEG |
| `output/work/TEE-001-arSA-9x16-proof.pdf` | RTL proof |
| `output/work/cache-manifest.json` | entries with source hashes, artifact hashes and command traces |
| `output/report.json` | hits, misses, variants and artifact list |
| `output/run_ex5.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/05_multi-locale-multi-aspect-responsive-export-with-content-hash-cache-manifest.ts` | hashing, lock, manifest merge, variant pipeline, safe-zone check and driver |
| `files/run_ex5.ts` | the acceptance harness: real template, two live variants, cache dry-run and lock |
| `files/01_typescript.ts` | the cache and run-log contract |

## Notes

- DesignCraft has no automation-root flags; its paths are resolved against
  the working directories, while PhotoCraft keeps its explicit roots.
- The alternate page is appended, so exports target `pageCount - 1`; page 0
  remains the square master.
- Type-check it with `npm run check`.
