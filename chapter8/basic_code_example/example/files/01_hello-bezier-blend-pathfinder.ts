/**
 * hello-bezier-blend-pathfinder.ts
 * ------------------------------------------------------------------
 * A minimal, self-contained, runnable TypeScript example that shows
 * how to programmatically drive VectorCraft (the ArtCraft vector
 * illustration suite) over MCP to:
 *
 *   1. Construct a cubic Bézier path from explicit anchor + handle
 *      coordinates (`path.create`).
 *   2. Build a LIVE BLEND between two such paths so that editing
 *      either key path re-interpolates the intermediate artwork
 *      (`object.blend.make`).
 *   3. Fuse two primitive shapes into one Boolean node via the
 *      Pathfinder Unite operation (`object.pathfinder.unite`).
 *
 * The caller (`generateBrandMark`) is designed to be awaited from an
 * HTTP handler running on Node 20+.  Because VectorCraft commands are
 * all deterministic and idempotent-over-ids, the same script can be
 * re-run against the same input to regenerate pixel-identical output.
 * ------------------------------------------------------------------
 */

import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/* ------------------------------------------------------------------ *
 *  Public contract                                                    *
 * ------------------------------------------------------------------ */

/**
 * Input for the brand-mark generation job.  The shape of this object
 * is the wire schema for a SaaS API route (`POST /brand-marks`).
 */
export interface BrandMarkRequest {
  /** Human-readable name; used for the document title and file name. */
  brandName: string;
  /** Canvas size in CSS points (1 pt === 1 px at 72 dpi). Default 512. */
  size?: number;
  /** Optional primary colour in `#rrggbb` form. Defaults to a sky blue. */
  accent?: string;
}

/**
 * What the job produces.  The consumer (an API route, a queue worker,
 * a Vercel serverless function) can then upload `bytes` to S3, sign a
 * pre-signed URL, and hand `previewPngBase64` to GPT-4o Vision for an
 * aesthetic audit — the loop from Recipe 1 in the ArtCraft docs.
 */
export interface BrandMarkResult {
  /** The SVG as a UTF-8 string (ready to embed inline on a web page). */
  svg: string;
  /** PNG preview, base64-encoded (no `data:` prefix). */
  previewPngBase64: string;
  /** The generated document model — layers, artboards, history. */
  documentTree: unknown;
  /** VectorCraft object ids for the three primitives we created. */
  ids: {
    bezierA: number;
    bezierB: number;
    blend: number;
    unitedBadge: number;
  };
}

/* ------------------------------------------------------------------ *
 *  Internal helpers                                                   *
 * ------------------------------------------------------------------ */

/** One entry in an MCP `content` array (subset of the spec we use). */
interface McpContentBlock {
  type: "text" | "image" | "resource";
  text?: string;
  data?: string;          // base64, for type === "image"
  mimeType?: string;
}

interface McpToolResult {
  content: McpContentBlock[];
  isError?: boolean;
}

/**
 * Every ArtCraft MCP tool returns a `content` array whose first text
 * block is a JSON string.  This helper unwraps it for us so that the
 * rest of the code can stay strongly typed.  If the JSON is missing
 * (which should never happen — it would indicate a server bug), we
 * throw a descriptive error rather than silently returning `undefined`.
 */
function unwrapJson<T>(result: McpToolResult, tool: string): T {
  if (result.isError) {
    throw new Error(`VectorCraft tool "${tool}" returned an error: ${
      result.content.map((c) => c.text ?? c.data ?? "").join(" ")
    }`);
  }
  const textBlock = result.content.find((c) => c.type === "text" && c.text);
  if (!textBlock || !textBlock.text) {
    throw new Error(`VectorCraft tool "${tool}" returned no JSON payload.`);
  }
  try {
    return JSON.parse(textBlock.text) as T;
  } catch (err) {
    throw new Error(
      `VectorCraft tool "${tool}" returned malformed JSON: ${(err as Error).message}`
    );
  }
}

/**
 * Any `image` content block (e.g. `render_preview`) carries the base64
 * payload in `.data`.  Extract it, tolerating either `image` blocks or
 * a PNG value nested inside a JSON text block (some tools do this).
 */
function extractPngBase64(result: McpToolResult): string {
  for (const block of result.content) {
    if (block.type === "image" && block.data) return block.data;
  }
  for (const block of result.content) {
    if (block.type === "text" && block.text) {
      try {
        const parsed = JSON.parse(block.text) as { pngBase64?: string };
        if (parsed.pngBase64) return parsed.pngBase64;
      } catch {
        /* fall through — some tools return raw base64 text */
        if (/^[A-Za-z0-9+/=]+$/.test(block.text)) return block.text;
      }
    }
  }
  throw new Error("VectorCraft returned no PNG payload where one was expected.");
}

/* ------------------------------------------------------------------ *
 *  The twelve-line "hello world" ------------------------------------- *
 * ------------------------------------------------------------------ */

/**
 * Drive a single VectorCraft instance to build a brand mark out of
 * three primitives: two cubic Bézier paths (A → B), a live blend
 * between them, and a Pathfinder-united badge.
 *
 * This function owns the full MCP lifecycle: spawn → commands → render
 * → save → teardown.  It is safe to call concurrently because every
 * document lives in its own `vectorcraft-cli` process; no shared state
 * leaks between invocations.
 */
export async function generateBrandMark(
  request: BrandMarkRequest
): Promise<BrandMarkResult> {
  const { brandName, size = 512, accent = "#0ea5e9" } = request;

  /* ---------------------------------------------------------------- *
   * 1. Spawn the MCP server over stdio.                              *
   *    `--automation-read-root` / `--automation-write-root` confine  *
   *    file I/O to the project directory (see "Filesystem Sandbox"   *
   *    in the ArtCraft governance spec).                             *
   * ---------------------------------------------------------------- */
  const transport = new StdioClientTransport({
    command: "vectorcraft-cli",
    args: [
      "mcp",
      "--automation-read-root", process.cwd(),
      "--automation-write-root", process.cwd(),
    ],
  });

  const client = new Client(
    { name: "brand-mark-service", version: "1.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);

  try {
    /* -------------------------------------------------------------- *
     * 2. Create the document.                                         *
     *    The cross-suite alias for this is `doc_new`; VectorCraft     *
     *    exposes it as the engine command `file.new` which we call    *
     *    via the `command_run` meta-tool.                             *
     * -------------------------------------------------------------- */
    await client.callTool({
      name: "command_run",
      arguments: {
        id: "file.new",
        params: {
          width: size,
          height: size,
          units: "Pixels",
          name: `${brandName}-Mark`,
          backgroundContents: "white",
          colorMode: "rgb",
        },
      },
    }) as McpToolResult;

    /* -------------------------------------------------------------- *
     * 3. Cubic Bézier path A — the top half of a stylised "eye".      *
     *    Four things define every cubic segment:                      *
     *      • the anchor we are leaving (`A0`)                         *
     *      • its out-handle       (`out:[Ax, Ay]`)                    *
     *      • the next anchor's in-handle (`in:[Bx, By]`)              *
     *      • the next anchor itself (`A1`)                            *
     *    In VectorCraft's `path.create` schema, handles attach to     *
     *    the ANCHOR they control — not to the adjacent segment — so   *
     *    an interior anchor carries both `in` and `out`.              *
     * -------------------------------------------------------------- */
    const pathA = unwrapJson<{ id: number }>(
      await client.callTool({
        name: "command_run",
        arguments: {
          id: "path.create",
          params: {
            closed: false,
            anchors: [
              // Left anchor: horizontal tangent leaving to the right.
              { x: 80, y: 380, in: [80, 380], out: [170, 300] },
              // Apex anchor: horizontal tangent at the top of the arc.
              { x: 256, y: 256, in: [196, 256], out: [316, 256] },
              // Right anchor: horizontal tangent arriving from the left.
              { x: 432, y: 380, in: [342, 300], out: [432, 380] },
            ],
          },
        },
      }) as McpToolResult,
      "path.create (A)"
    );

    /* -------------------------------------------------------------- *
     * 4. Cubic Bézier path B — the bottom half; a vertical mirror     *
     *    of path A.  Reusing the SAME apex coordinates (256, 256)     *
     *    makes the two curves share a cusp, which the blend below     *
     *    will swivel around.                                          *
     * -------------------------------------------------------------- */
    const pathB = unwrapJson<{ id: number }>(
      await client.callTool({
        name: "command_run",
        arguments: {
          id: "path.create",
          params: {
            closed: false,
            anchors: [
              { x: 80, y: 132, in: [80, 132], out: [170, 212] },
              { x: 256, y: 256, in: [196, 256], out: [316, 256] },
              { x: 432, y: 132, in: [342, 212], out: [432, 132] },
            ],
          },
        },
      }) as McpToolResult,
      "path.create (B)"
    );

    /* -------------------------------------------------------------- *
     * 5. Paint both paths.  `draw_path`-style defaults might give a   *
     *    white fill; we want pure strokes so the blend between the    *
     *    two curves is visually legible as a fan of lines.            *
     *    `set_paint` is a first-class MCP tool that also updates      *
     *    the "current defaults" for any art drawn later.              *
     * -------------------------------------------------------------- */
    await client.callTool({
      name: "set_paint",
      arguments: {
        ids: [pathA.id, pathB.id],
        fill: "none",
        stroke: accent,
        strokeWidth: 6,
      },
    }) as McpToolResult;

    /* -------------------------------------------------------------- *
     * 6. Select both paths, then create a LIVE BLEND.                 *
     *    The result is a single blend node that owns both key paths;  *
     *    drag `pathA.name`'s handles tomorrow and the eight           *
     *    intermediate traces re-interpolate automatically.            *
     *                                                                 *
     *    • `steps: 9`      → 9 shapes strictly between A and B        *
     *                        (the two keys themselves count as ends)  *
     *    • `orientation`   → `page` or `path`; we want straight-line  *
     *                        interpolation, not a curved spine.       *
     *    • `smooth: false` → keep the default colour ramp linear      *
     *                        instead of using the Blend Options       *
     *                        "smooth color" mode.                     *
     * -------------------------------------------------------------- */
    await client.callTool({
      name: "command_run",
      arguments: {
        id: "select.set",
        params: { ids: [pathA.id, pathB.id] },
      },
    }) as McpToolResult;

    const blend = unwrapJson<{ id: number }>(
      await client.callTool({
        name: "command_run",
        arguments: {
          id: "object.blend.make",
          params: {
            steps: 9,
            orientation: "page",
            smooth: false,
          },
        },
      }) as McpToolResult,
      "object.blend.make"
    );

    /* -------------------------------------------------------------- *
     * 7. Build a badge out of a rounded rectangle and a circle,       *
     *    then fuse them with Pathfinder Unite.                        *
     *    `object.pathfinder.unite` operates on the current selection  *
     *    back-to-front and returns one object id.  Internally the     *
     *    engine runs a planar-subdivision + winding-number test; the  *
     *    result is a single Path node that remains editable.          *
     * -------------------------------------------------------------- */
    const badgeRect = unwrapJson<{ id: number }>(
      await client.callTool({
        name: "draw_shape",
        arguments: {
          shape: "rectangle",
          x: 176, y: 176, width: 160, height: 160,
          radius: 32,                       // live corner radius
          fill: accent,
          stroke: "none",
        },
      }) as McpToolResult,
      "draw_shape (rect)"
    );

    const badgeDot = unwrapJson<{ id: number }>(
      await client.callTool({
        name: "draw_shape",
        arguments: {
          shape: "ellipse",
          x: 216, y: 216, width: 80, height: 80,
          fill: "#1e293b",
          stroke: "none",
        },
      }) as McpToolResult,
      "draw_shape (dot)"
    );

    await client.callTool({
      name: "command_run",
      arguments: {
        id: "select.set",
        params: { ids: [badgeRect.id, badgeDot.id] },
      },
    }) as McpToolResult;

    // A destructive Pathfinder command consumes its operands: both the
    // rectangle and the dot are gone afterwards, and the engine returns the
    // id of the new shape it built from them.
    const united = unwrapJson<{ ids: number[] }>(
      await client.callTool({
        name: "command_run",
        arguments: {
          id: "object.pathfinder.unite",
          params: {},
        },
      }) as McpToolResult,
      "object.pathfinder.unite"
    );
    const unitedId = united.ids[0]!;

    // The united shape takes the fill of the front-most operand, which is
    // the dot. The badge is meant to read as the accent-filled plate, so the
    // fill is set explicitly after the boolean.
    await client.callTool({
      name: "set_paint",
      arguments: {
        ids: [unitedId],
        fill: accent,
        stroke: "none",
      },
    }) as McpToolResult;

    /* -------------------------------------------------------------- *
     * 8. Look at what we made: a rasterised preview for vision-model  *
     *    review, and the full document tree for downstream auditing.  *
     * -------------------------------------------------------------- */
    const previewResult = (await client.callTool({
      name: "render_preview",
      arguments: { artboard: 0, max_side: 512 },
    })) as McpToolResult;

    const documentTree = unwrapJson<unknown>(
      await client.callTool({
        name: "doc_inspect",
        arguments: {},
      }) as McpToolResult,
      "doc_inspect"
    );

    /* -------------------------------------------------------------- *
     * 9. Persist.  `save_file` is VectorCraft's alias of `doc_save`;  *
     *    it writes the native `.vectorcraft` archive.  We then run    *
     *    a separate export command for the SVG — the file the         *
     *    front-end will actually serve.                               *
     * -------------------------------------------------------------- */
    await client.callTool({
      name: "save_file",
      arguments: { path: `${brandName}-Mark.vectorcraft` },
    }) as McpToolResult;

    const svgResult = unwrapJson<{ bytes: number; warnings: string[] }>(
      await client.callTool({
        name: "command_run",
        arguments: {
          id: "document.export",
          params: {
            path: `${brandName}-Mark.svg`,
            format: "svg",
            artboard: 0,
          },
        },
      }) as McpToolResult,
      "document.export (svg)"
    );
    if (svgResult.warnings.length > 0) {
      console.warn("[vectorcraft] SVG export warnings:", svgResult.warnings);
    }

    return {
      svg: await readFile(`${brandName}-Mark.svg`, "utf8"),
      previewPngBase64: extractPngBase64(previewResult),
      documentTree,
      ids: {
        bezierA: pathA.id,
        bezierB: pathB.id,
        blend: blend.id,
        unitedBadge: unitedId,
      },
    };
  } finally {
    /* -------------------------------------------------------------- *
     * 10. Always close the stdio transport.  If we returned early     *
     *     inside the try block we still need the child process reaped *
     *     or we will leak a `vectorcraft-cli` per request, and the    *
     *     OS will eventually refuse to fork any more.                 *
     * -------------------------------------------------------------- */
    await client.close();
  }
}

/* ------------------------------------------------------------------ *
 *  Smoke test — run with:  npx tsx hello-bezier-blend-pathfinder.ts   *
 * ------------------------------------------------------------------ */
if (process.argv[1]?.endsWith("hello-bezier-blend-pathfinder.ts")) {
  generateBrandMark({ brandName: "acme", size: 512, accent: "#0ea5e9" })
    .then((result) => {
      console.log("Generated mark.");
      console.log("  Bezier A id:", result.ids.bezierA);
      console.log("  Bezier B id:", result.ids.bezierB);
      console.log("  Blend id   :", result.ids.blend);
      console.log("  United id  :", result.ids.unitedBadge);
      console.log("  Preview    :", result.previewPngBase64.length, "chars PNG");
    })
    .catch((err) => {
      console.error("Brand mark generation failed:", err);
      process.exitCode = 1;
    });
}
