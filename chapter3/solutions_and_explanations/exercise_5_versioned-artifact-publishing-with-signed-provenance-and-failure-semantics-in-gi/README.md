# 3. Exercise 5: Versioned Artifact Publishing with Signed Provenance and Failure Semantics in GitLab CI -- solution

The worked solution for Exercise 5: a local publisher that runs the same
fail-closed order as the GitLab `publish_catalog` job — collect provenance,
audit, export, verify PDF/A, sign, build the manifest, upload to staging,
promote — plus a CI definition with the equivalent shell steps. The acceptance
harness drives every success and failure path against the real DesignCraft and
PdfCraft engines.

## What it does

`05_publish.ts` opens the layout in DesignCraft and collects three kinds of
provenance:

- **links** — `links.list` reports `ok`, `modified`, `missing` or `embedded`;
- **fonts** — `font.list` reports the family, style, source and whether the
  font or style is missing;
- **color** — every placed PNG/JPEG/WebP is authored in sRGB but the export
  intent is Coated FOGRA39, so it is a mismatch unless an explicit conversion
  exists.

Any non-`ok` link, missing font or color mismatch writes a blocker and exits
1 before a PDF is exported. A stable version that already exists is also
rejected before export.

On the success path the publisher:

1. exports the print PDF and the web PDF (the web export uses the `a2b`
   PDF/A preset);
2. verifies the web PDF with PdfCraft `pdfa_verify`, writing
   `pdfa-verify.json`; any non-fixable issue is a blocker;
3. signs both PDFs with a detached SHA-256 signature, writes `.asc` armor and
   verifies it immediately;
4. builds `release-manifest.json` with the release version, channel, layout
   ref, commit, audit summary, per-artifact SHA-256, byte size, page count and
   armored signature;
5. signs the manifest, copies all six files to `catalog-staging/<version>/`,
   copies them to `catalog/<version>/`, and deletes staging.

`03_yaml.yaml` mirrors the same order in GitLab: collect, three `jq` audits,
export, PDF/A verify, blocker gate, `gpg` signing, manifest, stable-version
check, staging upload, catalog promotion, staging delete. It passes
`--root "$(pwd)"` to every Node helper and keeps `out/`, `blockers/` and
`staging/` as artifacts even on failure.

## The listings

| file | what it is |
| --- | --- |
| `05_publish.ts` | local publisher: audit, export, PDF/A, OpenSSL signatures, manifest and promotion |
| `04_collect-inputs.ts` | DesignCraft provenance collector for links, fonts and color |
| `export-pdfs.ts` | DesignCraft print/web exporter; accepts a PDF/A or plain web standard |
| `pdfa-verify.ts` | PdfCraft `pdfa_verify` wrapper and report writer |
| `build-manifest.ts` | manifest schema, hashes, page counts, audit summary and signatures |
| `03_yaml.yaml` | the GitLab job with the same order and the same blocker names |
| `make-clean-layout.mjs` | clean text-only layout |
| `make-layout.mjs` | layout with a placed sRGB image |
| `make-missing-font.mjs` | layout with an uninstalled font |
| `run_ex5.ts` | acceptance harness: positive release plus five fail-closed paths |

## Run it

```bash
cd chapter3/solutions_and_explanations/exercise_5_versioned-artifact-publishing-with-signed-provenance-and-failure-semantics-in-gi/files
npx tsx run_ex5.ts
```

The harness generates a local RSA key pair with OpenSSL, compiles the helpers,
runs one positive beta release, then exercises the modified-link,
color-mismatch, missing-font, non-PDF/A and duplicate-stable-version paths.
It exits non-zero on the first failed assertion.

## What it produces

| artifact | what it is |
| --- | --- |
| `output/positive/` | a complete beta release: both PDFs, `.asc` armor, manifest, reports and registry |
| `output/positive/release-manifest.json` | the signed manifest with artifact hashes, bytes, pages and commit |
| `output/positive/registry/catalog/2026.10.0/` | the promoted six-file catalog version |
| `output/modified/` | modified-link blocker run |
| `output/color/` | sRGB → FOGRA39 blocker run |
| `output/missing/` | missing-font blocker run |
| `output/pdfa/` | non-PDF/A web export blocker run |
| `output/stable/` | first stable release and the refused duplicate |
| `output/helper-build/` | the compiled `.js` helpers the CI image ships |
| `output/keys/` | the generated signing key and public key |
| `output/run_ex5.log` | every acceptance check |
| `output/run-log.json` | check count, failures, release, manifest hash and quirks |

## What the harness asserts

- the helper sources compile and emit `04_collect-inputs.js`,
  `export-pdfs.js`, `pdfa-verify.js` and `build-manifest.js`;
- the positive release exits 0, reports `published`, verifies all three
  signatures and removes staging;
- both PDFs exist and start with `%PDF-`; the web PDF is PDF/A-2b compliant;
  PdfCraft extracts the expected catalog text;
- the print artifact is `none`, the web artifact is `pdfa2b`, and each
  manifest hash and byte count matches the file on disk;
- each armored signature decodes to a real DER signature and
  `openssl dgst -verify` accepts it; the manifest signature verifies too;
- the registry catalog version contains six files and staging is gone;
- a modified link writes `modified-links.json`, exits 1, exports no PDF and
  creates no catalog or staging version;
- an sRGB image into Coated FOGRA39 writes `color-space-mismatch.json` with
  `from: "sRGB"` / `to: "Coated FOGRA39"`;
- a missing font writes `missing-fonts.json` with `missing: true`;
- a web export without the PDF/A preset writes `pdfa-verify.json` with
  `compliant: false` and non-fixable issues, and creates no catalog version;
- the first stable release publishes; the second is refused with
  `version-exists.json`, keeps the first manifest's `commit-a`, leaves no
  staging version and does not export a new PDF;
- the YAML passes `--root` to every helper, imports the key, signs with
  `--detach-sign --armor`, verifies every signature, checks blockers before
  signing, uploads staging before catalog, deletes staging, checks stable
  versions through the Generic Package Registry, keeps artifacts with
  `when: always` and reads `.issues[]` rather than a non-existent `.rules[]`.

## Notes

- `gpg` is not installed on this machine. The local publisher uses OpenSSL to
  produce the same ASCII-armored PGP-shaped signature and verifies it with the
  public key; the GitLab YAML keeps the real `gpg` commands.
- The local publisher resolves `--signingKey` and `--publicKey` relative to
  `--root`. The harness copies the generated key pair into every scenario.
- `pdfa_convert` edits the in-memory PdfCraft document; the publisher saves
  after conversion, and `pdfa_verify` reads the saved file.
- `doc_save`, `export_png` and PDF saves do not create missing parent
  directories. The publisher creates `blockers/` and the scenario root; the
  helper scripts create their own asset folders.
- A failed run removes `catalog-staging/<version>/` and must not leave an
  empty `catalog/<version>/` behind.
