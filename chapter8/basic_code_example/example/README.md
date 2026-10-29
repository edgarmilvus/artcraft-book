# 8. Basic Code Example

A single-file introduction to programmatic vector work in VectorCraft. It
builds two cubic Bézier curves from anchors and handles, puts a live blend
between them, fuses a rounded rectangle and an ellipse with Pathfinder
Unite, and exports both the native document and an SVG.

The point of the listing is the shape of the API: every visual decision is a
command, the blend remains an editable node, and the whole mark is
reproducible from the same request.

## What it does

`generateBrandMark()` opens one stdio session against `vectorcraft-cli mcp`,
with `--automation-read-root` and `--automation-write-root` both pinned to
the working directory, and closes it in a `finally`.

`file.new` creates a square RGB artboard. Two `path.create` calls supply the
anchors and their in/out handles for the upper and lower half of the mark;
`set_paint` strokes both with the accent color. `select.set` then
`object.blend.make` with `steps: 9` and `orientation: "page"` inserts the
intermediate shapes as a live blend — editing either key re-interpolates the
fan.

The badge is a `draw_shape` rectangle and a `draw_shape` ellipse, united by
`object.pathfinder.unite`, which consumes both operands and returns one new
id. `render_preview` rasterizes the artboard at 512 px, `doc_inspect`
returns the document tree, `save_file` writes the `.vectorcraft` archive and
`document.export` writes the SVG.

## The listings

| file | what it is |
| --- | --- |
| `01_hello-bezier-blend-pathfinder.ts` | the whole example: the wire schema, the MCP helpers, `generateBrandMark()` and the three primitives it builds |
| `run_basic.ts` | the harness: two runs of the same request, the SVG and PNG checks, and the determinism comparison |
| `acme-Mark.svg` | the SVG the example produces, kept beside the listing |
| `acme-Mark.vectorcraft` | the native document the example produces |
| `package.json` | the project's scripts and dependencies |
| `tsconfig.json` | the TypeScript target |

## Run it

```bash
cd chapter8/basic_code_example/example/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_basic.ts
```

The harness renders the mark twice, then compares the two SVG strings byte
for byte:

```
# identities
PASS ids: the two key paths are distinct
PASS ids: the blend is its own object
PASS ids: the united badge is a new object

# the svg
PASS svg: nine blend steps, two keys and the badge
PASS svg: eleven blend paths are stroked
PASS svg: the badge is a rounded plate

# the preview raster
PASS preview: the mark actually drew something

# determinism
PASS determinism: the same svg comes out
PASS determinism: the file matches the returned svg

19 assertions passed
```

## What it produces

Everything lands in `files/output/`:

| artifact | what it is |
| --- | --- |
| `acme-Mark.svg` | the exported mark: two key paths, nine blend steps and the united badge |
| `acme-Mark.vectorcraft` | the native archive, with the blend still live |

The harness writes into `output/` because the engine confines file I/O to
the read and write roots it was given, and the harness sets those to its own
working directory.

## Notes

- **`vectorcraft-cli` must be on `PATH`.** The transport spawns it as a child
  process.
- **No model, no network, no license server.** The whole run is geometry and
  the engine's own renderer.
- **The SVG is byte-stable.** Both runs produce the same string, which is
  what makes the artifact cacheable by request hash.
- **`npx tsx`, not `node`.** The listing is TypeScript with `.js`
  specifiers; `tsx` resolves them.
- Type-check it with `npm run check` (which is `tsc --noEmit`).
