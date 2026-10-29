# 10. Basic Code Example

A minimum viable e-commerce banner generator. One product record goes in, a
1200×628 PNG comes out: background, hero image, product name, price and an
optional badge, laid out on a fixed grid and exported through PhotoCraft.

The second listing is the batch loop, and the three ways it usually goes
wrong: process churn, colliding output names and one bad row killing the run.

## What it does

`renderBanner()` validates the product with `ProductSchema` — name, price in
minor units, ISO-4217 currency, hero path, badge, background and foreground —
then spawns `photocraft-cli mcp` with a read root and a write root. The two
roots are separate, so a malicious `imagePath` cannot escape the staging
area.

`doc_new` creates the canvas with the product's background as its own layer,
and `doc_place` embeds the hero on the right half at 100 % scale. Three
`type.create` calls draw the name, the formatted price and the badge; the
formatters are pure functions, so `formatPrice(12900, "USD")` is `$129.00`
and JPY never gets a decimal part. `doc_render_preview` produces an audit
frame at 512 px, and `doc_save` writes the PNG into the write root.

`renderBatch()` runs the loop and catches per record: a malformed product is
recorded with its error and the next product still renders. The slug is
derived from the name, so two products with the same name would collide —
the batch contract makes the caller responsible for a unique suffix.

## The listings

| file | what it is |
| --- | --- |
| `01_banner-factory.ts` | the wire schema, the price formatter, the MCP bootstrap, `renderBanner()` and its one example invocation |
| `02_common_pitfalls.ts` | `BatchResult` and `renderBatch()`: per-record failure handling over the same renderer |
| `run_basic.ts` | the harness: one banner, three batch records including a broken one, and the pixel checks |
| `package.json` | the project's scripts and dependencies |
| `tsconfig.json` | the TypeScript target |

## Run it

```bash
cd chapter10/basic_code_example/example/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_basic.ts
```

The harness writes its own sample photo, renders a banner and then runs a
three-record batch whose middle record is invalid:

```
# the formatters
PASS price: dollars
PASS price: euros
PASS price: yen has no decimals

# one banner
PASS banner: the canvas is 1200 wide
PASS banner: the background is the product's colour
PASS banner: the hero image is on the right

# the batch
PASS batch: the first rendered
PASS batch: the broken one failed
PASS batch: the third still rendered

15 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `files/output/samples/aurora-keyboard.png` | the generated hero image |
| `files/output/banners/aurora-mechanical-keyboard.png` | the single rendered banner |
| `files/output/banners/second-product.png` | the first batch record |
| `files/output/banners/third-product.png` | the record after the broken one |

## Notes

- **`photocraft-cli` must be on `PATH`.** The renderer spawns it per job and
  closes it in `finally`, so a CI run does not leak processes.
- **The engine enforces the sandbox.** A path outside the read or write root
  is refused server-side, independently of the slug sanitization.
- **No model and no network.** The harness generates its own image and the
  price formatting is hand-rolled for determinism.
- **`npx tsx`, not `node`.** The listings are TypeScript with `.js`
  specifiers.
- Type-check it with `npm run check` (which is `tsc --noEmit`).
