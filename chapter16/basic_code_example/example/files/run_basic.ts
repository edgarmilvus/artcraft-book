// run_basic.ts — deterministic harness for the "Hello Editorial" listing.
//
// The listing runs for real: DesignCraft builds a four-page A4 document,
// folds a spread, threads a linked story across two frames, applies the
// multi-line composer, renders page 1 to PNG and saves the native
// document. The harness then reads the artefacts back and checks them.

import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const run = promisify(execFile);

const FILES = resolve(process.cwd());
const OUTPUT = resolve(FILES, "output");
const WORK = resolve(OUTPUT, "work");

let passed = 0;
function ok(label: string, condition: boolean, detail = ""): void {
  if (!condition) {
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    process.exit(1);
  }
  passed += 1;
  console.log(`PASS ${label}`);
}

function equal<T>(label: string, actual: T, expected: T): void {
  ok(label, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

/** The PNG signature. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface InspectDocument {
  pageCount: number;
  spreads: Array<{
    items: Array<{ id: number; kind: string; story?: number }>;
  }>;
  stories: Array<{
    id: number;
    preview?: string;
    overset?: number | boolean;
    paragraphs?: number;
    frames?: number[];
  }>;
  paragraphStyles: string[];
}

async function main(): Promise<void> {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });

  // --- 1. run the listing ------------------------------------------------
  const listing = await run(
    "npx",
    ["tsx", resolve(FILES, "03_hello-editorial.ts")],
    { cwd: WORK },
  );
  ok("the listing ran", listing.stdout.includes("Saved hello-editorial.designcraft"), listing.stderr.slice(-400));

  // --- 2. the page render ------------------------------------------------
  const pngPath = resolve(WORK, "hello-editorial-page1.png");
  ok("the page render was written", existsSync(pngPath));
  const png = readFileSync(pngPath);
  ok("the page render is a PNG", png.subarray(0, 8).equals(PNG_MAGIC));
  ok("the page render is not empty", png.length > 10_000, `${png.length} bytes`);
  // The IHDR chunk carries the dimensions: 8 bytes of signature, then the
  // chunk length and type, then the width and the height.
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  equal("the page render is twice the A4 width", width, 1191);
  equal("the page render is twice the A4 height", height, 1684);

  // --- 3. the native document -------------------------------------------
  const docPath = resolve(WORK, "hello-editorial.designcraft");
  ok("the native document was written", existsSync(docPath));
  ok("the native document is not empty", statSync(docPath).size > 1_000);

  // --- 4. the document's structure ---------------------------------------
  const client = new Client({ name: "cap16-harness", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command: "designcraft-cli", args: ["mcp"] }));
  try {
    await client.callTool({ name: "open_document", arguments: { path: docPath } });
    const reply = await client.callTool({ name: "inspect_document", arguments: {} });
    const text = (reply as { content?: Array<{ type: string; text?: string }> }).content?.[0]?.text ?? "{}";
    const doc = JSON.parse(text) as InspectDocument;

    ok("the document has a spread", doc.spreads.length >= 1, `${doc.spreads.length} spreads`);
    equal("the document has four pages", doc.pageCount, 4);
    const items = doc.spreads.flatMap((s) => s.items);
    ok("the spread carries frames", items.length >= 2, `${items.length} items`);
    ok(
      "the document carries the Body style",
      doc.paragraphStyles.includes("Body"),
      doc.paragraphStyles.join(", "),
    );
    ok(
      "the body copy was streamed into a story",
      doc.stories.some((s) => (s.preview ?? "").includes("In the beginning was the frame")),
      doc.stories.map((s) => (s.preview ?? "").slice(0, 24)).join(" | "),
    );
    ok(
      "the body story is overset",
      doc.stories.some((s) => s.overset === true),
      doc.stories.map((s) => `${s.id}:${s.overset}`).join(" "),
    );
    ok(
      "the story is threaded into a second frame",
      doc.stories.length >= 2,
      doc.stories.map((s) => `${s.id}:${s.frames?.length ?? 0}`).join(" "),
    );
  } finally {
    await client.close();
  }

  console.log(`\n${passed} assertions passed`);
}

await main();
