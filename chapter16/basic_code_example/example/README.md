# 16. Basic Code Example

A self-contained "Hello World" for the DesignCraft MCP server. One file of
TypeScript boots `designcraft-cli mcp` over stdio, folds a four-page A4
spread, threads a linked story across two frames, applies a paragraph style
whose composer is the multi-line (Knuth-Plass analog) solver, renders the
first page to PNG and saves the native document. There is no database, no
cloud storage and no framework, so every line of the listing can be blamed
for something.

## What it does

The script opens an MCP stdio session against `designcraft-cli` and walks the
engine's own tool surface in order: `new_document` for the page geometry,
`execute` with `document.preferences` for the 12 pt baseline grid,
`style.paragraph.create` for the `Body` style with `composer: "paragraph"`,
`frame.create` for the primary text frame, `story.placeAndLink` for the
threaded second frame, `set_story_text` for the body copy, then
`style.paragraph.apply` after an explicit `selection.set` so the style binds
to the primary story and not to whatever happened to be selected.

It then reads the story back with `get_story` — the reply carries the frame
count, the paragraph count and the overset offset — and finishes with
`render_page` at scale 2 for the page-1 PNG and `save_document` for the
lossless `.designcraft` file. The client is closed in a `finally` block,
because a live child process keeps the Node event loop alive.

## The listings

| file | what it is |
| --- | --- |
| `01_basic_code_example.txt` | the project layout of the three-file `hello-editorial` project |
| `02_basic_code_example.json` | the `package.json` skeleton the layout refers to |
| `03_hello-editorial.ts` | the listing: the MCP client, the twelve numbered steps, the body copy and the `unwrap` helper that parses MCP's text envelope |
| `fragments/04_common_pitfalls.ts` | the anti-pattern the closing section warns about — twelve concurrent mutations of one document |

## Run it

```bash
cd chapter16/basic_code_example/example/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_basic.ts
```

The harness runs the listing for real and then reads the artifacts back:

```
PASS the listing ran
PASS the page render was written
PASS the page render is a PNG
PASS the page render is not empty
PASS the page render is twice the A4 width
PASS the page render is twice the A4 height
PASS the native document was written
PASS the native document is not empty
PASS the document has a spread
PASS the document has four pages
PASS the spread carries frames
PASS the document carries the Body style
PASS the body copy was streamed into a story
PASS the body story is overset
PASS the story is threaded into a second frame

15 assertions passed
```

## What it produces

Everything lands under `files/output/work/`:

| artifact | what it is |
| --- | --- |
| `hello-editorial-page1.png` | the page-1 render at 2× scale — 1191 × 1684 px, twice the A4 size |
| `hello-editorial.designcraft` | the native document, with every story, style, thread link and grid offset intact |

## Notes

- **`designcraft-cli` must be on `PATH`.** The harness launches it a second
  time to inspect the saved document.
- **The headless server takes no sandbox roots.** `designcraft-cli mcp`
  accepts only `--connect PORT` and `--sample`, so the worker's own path
  policy is the boundary; every path in the listing is relative to the
  process's working directory.
- **The body story is deliberately overset.** The copy is longer than one
  frame holds, and the harness asserts the overset rather than a clean fit.
- **`npx tsx`, not `node`.** The listings are TypeScript with `.js`
  specifiers; `tsx` resolves them.
- Type-check it with `npm run check` (which is `tsc --noEmit`).
