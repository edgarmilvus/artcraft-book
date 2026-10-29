# 10. Advanced Application Implementation

The graphics factory of the chapter: a product feed and a brand kit are
compiled into banners for every placement, with content-addressed asset
caching, recipe hashing and a bounded multimodal QA pass. It is the
production version of the basic renderer — same canvas, but the pipeline is
data-driven and idempotent.

Two products, two variants and two placements are enough to show the shape:
every unit of work has a hash, and every hash is either a cache hit or a
render.

## What it does

`GraphicsFactory.run()` reads the feed, validates it with
`ProductFeedSchema`, validates the brand kit and the placements, then
iterates placements outer and products inner. For each variant it:

1. resolves the hero and the logo through `AssetResolver`, which downloads
   into `<cacheRoot>/ab/<sha256>-<basename>` — the two-character prefix
   shards the directory;
2. compiles a `Composition` with `compileRecipe()`, which turns brand tokens,
   placement geometry and localized price formatting into absolute pixel
   positions;
3. hashes the composition with `recipeHash()` and uses the digest as the
   output path, `<outRoot>/ab/<digest>.png`, so a cache hit is a file that
   already exists;
4. on a miss, calls `composeBanner()`, which drives PhotoCraft through
   `doc_new`, `layer.new.layer`, `edit.fill`, `doc_place`,
   `layer.layerStyle.dropShadow`, the `type.create` calls for name, price,
   call to action and badge, and a final batch of layer properties;
5. optionally renders a preview and asks `qaBanner()` for a structured
   verdict — headline overflow, price legibility, hero clipping, contrast,
   safe zone and brand mismatch — before saving with `doc_save`.

A failed product is recorded in `failed` and does not abort the shard. A QA
failure is recorded in `qaFailures` with its issues, so a banner can be
delivered and still be flagged.

## The listings

| file | what it is |
| --- | --- |
| `schemas.ts` | the feed contract: locale, money, product, variant and feed version |
| `brand.ts` | the brand kit and placement contracts: palette roles, fonts, safe zone, contrast and logo clearspace |
| `recipe.ts` | the compiler from brand + placement + product + variant to a `Composition`, and the recipe hash |
| `assets.ts` | the content-addressed `AssetResolver` and its stub-able `fetch` |
| `mcp-client.ts` | the one-session PhotoCraft façade: `run`, `batch`, `newDoc`, `place`, `save`, `preview` |
| `compose.ts` | the fixed command sequence that turns a `Composition` into a document |
| `qa.ts` | the vision QA rubric, the strict JSON schema and the verdict |
| `factory.ts` | the orchestrator: validation, the placement loop, the cache and the `RenderReport` |
| `run_forge.ts` | the harness: two products, a local fetcher, the artifacts and the cache |
| `package.json` | the project's scripts and dependencies |
| `tsconfig.json` | the TypeScript target |

## Run it

```bash
cd chapter10/advanced_application_implementation/example/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_forge.ts
```

The harness serves the photos from memory, renders every variant, then runs
the factory again to prove the cache is hit:

```
# the contracts
PASS brand: it validates
PASS placement: the canvas is 1200 wide
PASS feed: one product
PASS feed: two variants

# the run
PASS run: two banners were generated
PASS run: nothing failed

# the cache
PASS cache: nothing was generated
PASS cache: both banners were reused

16 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `files/output/work/feed.json` | the validated feed the factory read |
| `files/output/work/assets/1c/1c4dbfc123552e0809664d88f151766df94d38d6e66ddde40967241df201bf2f-pack-teal.png` | the cached hero for the teal variant |
| `files/output/work/assets/a0/a029b23f1a4b739c49eed17142d227f394bf3ad2e9397e1f125c9e6fa96aa2dd-pack-sand.png` | the cached hero for the sand variant |
| `files/output/work/assets/5f/5f3c32d433d91cb7a24240c2eef6bcebda50d99e92aef15436cfe7d37719cd5c-acme-logo.png` | the cached brand logo |
| `files/output/work/out/banners/31/3122d106cc7baab78f78db2180c6ea2edb72571abf0f51d2259f5998c9c63825.png` | the first banner, named by its recipe digest |
| `files/output/work/out/banners/5b/5b56cd481a26f8abe2b60774e3d50e12ac2fa3599088a0fbf22660366dad6b48.png` | the second banner |

## Notes

- **`photocraft-cli` must be on `PATH`.** `PhotoCraftMcpClient` keeps one
  long-lived child per process and reconnects if it exits.
- **The cache is the output namespace.** Two different recipes cannot share
  a path, and the same recipe cannot produce two files.
- **Assets are content-addressed by URL digest.** The harness supplies a
  stub fetcher, so no network is used; a production run passes the real
  `fetch`.
- **QA is optional and bounded.** Without an OpenAI client the render still
  completes; with one, `qaBanner()` gets a preview and at most two rounds of
  corrections before it returns the last verdict.
- Type-check it with `npm run check` (which is `tsc --noEmit`).
