# 16. Exercise 1: Nightly Magazine Build — solution

The worked nightly CMS-to-print build. Articles resolve their heroes and inline
figures through three tiers (live CDN, verified ledger, visible placeholder),
the style set is installed in one batch, and the result is signed with a
recursive HMAC sidecar.

## What it does

1. `assertCanonicalParams()` refuses anything but the exact Letter skeleton
   with four articles.
2. `installStyleSet()` creates the six frozen styles and the `assetPending`
   swatch in one batch: `BODY-3COL`, `HEADLINE-KICKER`, `HEADLINE-LEAD`,
   `CAPTION-8PT`, `BYLINE-LIGHT`.
3. `resolveAsset()`:
   - tier 1 fetches the CDN URL with an eight-second timeout and caches the
     bytes;
   - tier 2 checks the ledger entry's existence, byte count **and** SHA-256;
   - tier 3 records a placeholder with the reason
     (`ledger-hash-mismatch` or `url-404-and-no-ledger`).
4. `placeHero()` / `placeInlineFigure()` place resolved images or draw a
   labelled amber frame.
5. `threadBody()` requires exactly three linked frames and no overset.
6. `applyDegradedLayout()` is one undo-first batch with a tinted panel and
   caption callout per missing figure.
7. `signSidecar()` uses recursive canonical JSON, so nested resolution and
   vision fields are covered by the signature.
8. `runNightlyBuild()` orchestrates all nine stages, including the vision gate
   and the PDF export.

## Run it

```bash
cd chapter16/solutions_and_explanations/exercise_1_nightly-magazine-build-with-autonomous-unmapped-asset-recovery/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex1.ts
```

```
49 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/issue-001.pdf` | a real twelve-page PDF for issue 001 |
| `output/sidecar.json` | resolution log, vision verdict, degraded flag and HMAC |
| `output/resolution-log.json` | the four tier decisions (direct, ledger, two placeholders) |
| `output/placeholder.png` | a 612×792 amber hatch tile |
| `output/cache/hero-direct.img` | bytes fetched from the live local HTTP server |
| `output/assets/hero.png`, `figure.png` | source images and the ledger fixture |
| `output/report.json` | assertion count and artifact list |
| `output/run_ex1.log` | shell-captured harness log |

## The listings

| file | what it is |
| --- | --- |
| `files/01_solutions_and_explanations.ts` | contracts, MCP session, resolver, threading, degraded batch, HMAC |
| `files/run_ex1.ts` | the acceptance harness |
| `files/package.json` | npm scripts and dependencies |

## Notes

- The original sidecar used `JSON.stringify(obj, Object.keys(obj).sort())`,
  which drops every nested key from the signature. The harness mutates a
  nested tier and proves the signature now changes.
- The direct tier is exercised against a real loopback HTTP server, not a
  mocked `fetch`.
- Type-check it with `npm run check`.
