/**
 * @file hello-editorial.ts
 *
 * @summary
 *   A self-contained "Hello World" for the DesignCraft MCP server. It boots
 *   `designcraft-cli mcp` over stdio, folds an A4 spread, threads a linked
 *   story across two frames, applies a paragraph style that engages the
 *   multi-line (Knuth-Plass analogue) composer, renders page 1 to PNG, and
 *   saves the document as a native `.designcraft` file.
 *
 * @usage
 *   npx tsx hello-editorial.ts
 *
 * @requires
 *   `designcraft-cli` on PATH (release binary) or a build of the Rust
 *   workspace. The headless server takes no sandbox roots of its own, so
 *   the script writes relative to the directory it is launched from.
 *
 * @produces
 *   hello-editorial-page1.png      (page render, 2× scale)
 *   hello-editorial.designcraft    (native document)
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/* ------------------------------------------------------------------ *
 *  Shape declarations — the wire contract as seen by this TypeScript. *
 * ------------------------------------------------------------------ */

/**
 * Every successful MCP tool call returns at least one content block.
 * DesignCraft's tools emit a single `{type:"text", text:"<json>"}` block
 * whose `text` we must `JSON.parse` ourselves.
 */
interface McpTextBlock {
  type: "text";
  text: string;
}

/** The subset of `CallToolResult` we touch. */
interface McpToolResult {
  content: unknown;
}

/** Response shape of the `frame.create` engine command. */
interface FrameCreateResult {
  id: number;      // The frame object id.
  story: number;   // The story that lives inside it (0 if none).
}

/** Response shape of the `story.placeAndLink` engine command. */
interface StoryLinkResult {
  id: number;      // The newly placed frame.
  story: number;   // Its (linked) child story id.
}

/** Response shape of the `render_page` MCP tool. */
interface RenderPageResult {
  path: string;
  width: number;
  height: number;
}

/* ------------------------------------------------------------------ *
 *  Helpers                                                            *
 * ------------------------------------------------------------------ */

/**
 * Unwraps MCP's `content: [ { type:"text", text:"<json>" } ]` envelope.
 *
 * MCP never hands you typed JSON directly; it hands you an array of
 * content blocks whose `text` field is *itself* a JSON string. Forgetting
 * to parse this is the single most common mistake for first-time MCP
 * client authors. This helper also gives us a place to normalise errors.
 *
 * @typeParam T - the expected decoded payload
 * @param response - the raw `CallToolResult`
 * @returns the parsed JSON payload
 * @throws if the first block is missing, not text, or not valid JSON
 */
function unwrap<T>(response: unknown): T {
  const blocks = (response as McpToolResult).content;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error(`Empty MCP content array: ${JSON.stringify(response)}`);
  }
  // A tool that returns a picture answers with the image *and* a text
  // block carrying the metadata, so the payload is the first text block.
  const first = blocks.find((b) => (b as McpTextBlock).type === "text") as McpTextBlock | undefined;
  if (!first || typeof first.text !== "string") {
    throw new Error(`No text block in the MCP reply: ${JSON.stringify(blocks[0])}`);
  }
  try {
    return JSON.parse(first.text) as T;
  } catch {
    throw new Error(`Tool returned non-JSON payload: ${first.text}`);
  }
}

/**
 * Body copy for our two-column story. Kept inline so the script is
 * self-contained (no fixture files, no fetch, no environment variables).
 */
const BODY_COPY: string = [
  "In the beginning was the frame, and the frame was the story, and the",
  "story was destined to overflow. Every editorial designer knows the",
  "feeling: a paragraph half-set, a heading orphaned at the foot of a",
  "page, a pull quote that refuses to fall where the eye expects it.",
  "",
  "DesignCraft's threaded frames turn that anxiety into arithmetic. A",
  "story is a single stream of runs; a frame is a window onto it. When",
  "the window fills, the remaining runs spill into the next frame in the",
  "thread — and if that frame also fills, the next. Reflow is merely a",
  "re-run of the line breaker against new column widths.",
  "",
  "The paragraph composer — our Knuth-Plass analogue — does not hunt",
  "greedily for the first break that fits. It solves, in a single",
  "dynamic-programming sweep, for the break set that minimises a global",
  "badness score across the paragraph: squared leftover space, a hyphen",
  "penalty, and a dislike for three or more consecutive hyphens. It is",
  "the difference between typesetting and word-wrapping.",
].join("\n");

/* ------------------------------------------------------------------ *
 *  Main routine                                                       *
 * ------------------------------------------------------------------ */

/**
 * Builds the Hello Editorial document and emits its first proof page.
 *
 * Steps mirror the numbered discussion below; each `await` is a single
 * round-trip over the MCP stdio framing (line-delimited JSON-RPC 2.0).
 */
async function buildHelloEditorial(): Promise<void> {
  // ── Step 1 — Launch `designcraft-cli mcp` as a child process ─────────
  // `StdioClientTransport` spawns the binary and wires `stdin`/`stdout`
  // to the JSON-RPC codec. The headless server takes no sandbox roots of
  // its own: the worker owns the filesystem boundary, and every `path`
  // we pass below is relative to the process's working directory.
  const transport = new StdioClientTransport({
    command: "designcraft-cli",
    // The headless server takes no sandbox roots: the worker owns
    // the filesystem boundary, and the paths below are relative to
    // the process's working directory.
    args: ["mcp"],
  });

  // ── Step 2 — Handshake with the MCP server ───────────────────────────
  // `Client` speaks the model-context-protocol: initialize, then a JSON-
  // RPC call per tool. The `capabilities: {}` object is deliberately
  // empty — we are a pure consumer, not a sampling host.
  const client = new Client(
    { name: "hello-editorial", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);

  try {
    // ── Step 3 — Create the document ───────────────────────────────────
    // `new_document` is a first-class MCP tool on DesignCraft, not an
    // engine command. It returns instantly; all subsequent work happens
    // against the newly-active document.
    //
    // The page geometry is deliberately "editorial": a large inside
    // margin for the gutter between facing pages, two columns, and a
    // bleed so any future full-page ad drops in cleanly.
    await client.callTool({
      name: "new_document",
      arguments: {
        preset: "A4",
        pages: 4,
        facingPages: true,
        margins: { top: 56, bottom: 56, inside: 64, outside: 44 },
        columns: 2,
        gutter: 18,
        bleed: 9,
        title: "Hello Editorial",
      },
    });

    // ── Step 4 — Establish the baseline grid ───────────────────────────
    // `document.preferences` is an engine command; we reach it via the
    // `execute` meta-tool. `increment: 12` means every gridline is 12 pt
    // apart — matching the leading we are about to declare on the Body
    // style, so lines snap onto the rhythm without an off-by-a-fraction
    // drift at the bottom of the page.
    await client.callTool({
      name: "execute",
      arguments: {
        command: "document.preferences",
        params: {
          baselineGrid: {
            start: 0,
            increment: 12,
            relativeTo: "topMargin",
            color: [0.55, 0.55, 1.0],
            viewThreshold: 100,
          },
        },
      },
    });

    // ── Step 5 — Declare the Body paragraph style ──────────────────────
    // This is where the Knuth-Plass discussion becomes operational: the
    // `composer: "paragraph"` setting selects the multi-line solver rather
    // than the greedy single-line one. We pair it with `hyphenate: true`
    // because Knuth-Plass's badness function is only meaningfully better
    // than greedy when the hyphenation dictionary is available as an
    // alternative source of break points.
    await client.callTool({
      name: "execute",
      arguments: {
        command: "style.paragraph.create",
        params: {
          name: "Body",
          para: {
            align: "leftJustified",
            firstLineIndent: 14,
            spaceBefore: 0,
            spaceAfter: 6,
            hyphenate: true,
            composer: "paragraph", // multi-line / Knuth-Plass analogue
          },
          chars: {
            fontFamily: "Inter",
            fontStyle: "Regular",
            size: 10,
            leading: { kind: "points", value: 12 },
          },
        },
      },
    });

    // ── Step 6 — Create the primary text frame on spread 0 ─────────────
    // `frame.create` is the engine-level primitive underneath the Type
    // tool's drag gesture. It yields both the frame `id` and the `story`
    // that lives inside it. Coordinates are *spread* points: origin at
    // the top-left of the spine, positive x to the right across both
    // facing pages.
    const frameRes = await client.callTool({
      name: "execute",
      arguments: {
        command: "frame.create",
        params: {
          spread: 0,
          rect: [56, 56, 330, 500],
          content: "text",
          text: "Hello, Editorial. ",
        },
      },
    });
    const primary = unwrap<FrameCreateResult>(frameRes);

    // ── Step 7 — Thread the story to a second frame ────────────────────
    // `story.placeAndLink` creates a linked child frame node that the
    // reflow engine will fill once the parent is overset. This is the
    // "threading" gesture expressed as data: no drag, no pointer events.
    const linkedRes = await client.callTool({
      name: "execute",
      arguments: {
        command: "story.placeAndLink",
        params: {
          story: primary.story,
          spread: 1,
          rect: [380, 56, 654, 500],
        },
      },
    });
    const linked = unwrap<StoryLinkResult>(linkedRes);

    // ── Step 8 — Stream the real body copy into the story ──────────────
    // `set_story_text` replaces the story's text wholesale while keeping
    // the first paragraph's formatting. A dedicated tool exists because
    // this is by far the most common editorial operation an LLM performs.
    await client.callTool({
      name: "set_story_text",
      arguments: {
        story: primary.story,
        text: BODY_COPY,
      },
    });

    // ── Step 9 — Select the primary frame, then apply the style ────────
    // `style.paragraph.apply` operates on the current selection. Because
    // we want to *deterministically* bind Body to the primary story (not
    // whatever is selected now), we explicitly select the frame first.
    await client.callTool({
      name: "execute",
      arguments: { command: "selection.set", params: { ids: [primary.id] } },
    });
    await client.callTool({
      name: "execute",
      arguments: {
        command: "style.paragraph.apply",
        params: { name: "Body", clearOverrides: true },
      },
    });

    // ── Step 10 — Read back the story report ───────────────────────────
    // The response includes frame count, paragraph count, line count and
    // the offset of any overset text. In an editorial SaaS you'd branch
    // on that number to autoflow further frames until overset drops to 0.
    const storyReport = await client.callTool({
      name: "get_story",
      arguments: { story: primary.story },
    });
    const block = (storyReport.content as McpTextBlock[])[0];
    console.log("── Story report ───────────────────────────────");
    console.log(block?.text ?? "(no report returned)");
    console.log("Linked child frame:", linked.id, "story:", linked.story);

    // ── Step 11 — Render page 1 at 2× for multimodal review ────────────
    // `render_page` returns PNG bytes *and* writes them when `path` is set.
    // An LLM auditor in the next stage of the pipeline can look at the
    // same file and critique widow/orphan behaviour.
    const pngRes = await client.callTool({
      name: "render_page",
      arguments: {
        page: 0,
        scale: 2,
        path: "hello-editorial-page1.png",
      },
    });
    const render = unwrap<RenderPageResult>(pngRes);
    console.log("Rendered page 1 →", render.path, `${render.width}×${render.height}`);

    // ── Step 12 — Persist the document natively ────────────────────────
    // `.designcraft` is the lossless native format: every story, style,
    // thread link and baseline-grid offset round-trips exactly. A PDF
    // proof can be produced from the same file with `export_png`/`file.exportPdf`.
    await client.callTool({
      name: "save_document",
      arguments: { path: "hello-editorial.designcraft" },
    });
    console.log("Saved hello-editorial.designcraft");
  } finally {
    // Releases the child process; without this, tsx will hang and the
    // stdio pipes will keep the event loop alive forever.
    await client.close();
  }
}

/* ------------------------------------------------------------------ *
 *  Entry point                                                        *
 * ------------------------------------------------------------------ */

buildHelloEditorial().catch((err: unknown) => {
  console.error("hello-editorial failed:", err);
  process.exitCode = 1;
});
