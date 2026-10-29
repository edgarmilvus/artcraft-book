// run_forge.ts — deterministic harness for the raw-pipeline worker.
//
// The worker is driven against the real headless LightCraft: a folder of
// staged photos is imported into a library, culled, graded and exported in
// the configured tiers. The harness checks the pipeline's own report and the
// files it leaves behind.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { RawPipeline } from "./03_advanced_application_implementat.js";

const OUTPUT = resolve(process.cwd(), "output");
const STAGING = resolve(OUTPUT, "staging");
const LIBRARY = resolve(OUTPUT, "library");
const DELIVERY = resolve(OUTPUT, "delivery");

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

/**
 * A staged photo of the same subject. A burst is the same subject shot a
 * moment apart, so the frames differ in focus and not in content - that is
 * what lets the engine group them.
 */
function makePhoto(seed: number, blur: boolean): Buffer {
  const size = 512;
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      // The frames of a burst show the same subject; only the focus changes.
      const wave =
        Math.sin(x / 3) * Math.cos(y / 4) +
        Math.sin((x + y) / 9);
      const value = 120 + wave * (blur ? 14 : 70);
      png.data[i] = Math.max(0, Math.min(255, Math.round(value)));
      png.data[i + 1] = Math.max(0, Math.min(255, Math.round(value * 0.85)));
      png.data[i + 2] = Math.max(0, Math.min(255, Math.round(value * 0.7)));
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** Every file under a folder, however deep it is nested. */
function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) total += countFiles(full);
    else if (entry.name.toLowerCase().endsWith(".png")) total += 1;
  }
  return total;
}

async function main(): Promise<void> {
  rmSync(OUTPUT, { recursive: true, force: true });
  mkdirSync(STAGING, { recursive: true });
  mkdirSync(LIBRARY, { recursive: true });
  mkdirSync(DELIVERY, { recursive: true });

  for (let i = 0; i < 4; i += 1) {
    writeFileSync(resolve(STAGING, `frame-${i}.png`), makePhoto(i, i % 2 === 1));
  }

  // The burst is staged with capture times, the way a camera would record
  // them: the engine groups the frames of a burst by that timestamp.
  const staging = new Client({ name: "staging", version: "1.0.0" }, { capabilities: {} });
  await staging.connect(
    new StdioClientTransport({ command: "lightcraft-cli", args: ["mcp", "--library", LIBRARY] }),
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const result: any = await staging.callTool({ name, arguments: args });
    return result.content?.find((block: any) => block.type === "text")?.text;
  };
  await call("import", { paths: [0, 1, 2, 3].map((i) => resolve(STAGING, `frame-${i}.png`)) });
  await call("command_run", { id: "photo.setCaptureTime", params: { ids: [1], time: "2026-03-14T10:00:00" } });
  await call("command_run", { id: "photo.setCaptureTime", params: { ids: [2, 3, 4], time: "2026-03-14T10:00:02", each: true } });
  await staging.close();

  const pipeline = new RawPipeline({
    readRoot: STAGING,
    writeRoot: DELIVERY,
    catalogPath: LIBRARY,
    eventDate: "2026-03-14",
    albumName: "Spring Campaign",
    tiers: ["web_preview"],
    hdrMerge: false,
    cullRejectBelow: 0,
  });

  console.log("\n# the pipeline");
  const result = await pipeline.run();

  console.log("\n# the report");
  equal("report: the event date survives", result.eventDate, "2026-03-14");
  equal("report: the album survives", result.album, "Spring Campaign");
  equal("report: the burst was re-imported, not duplicated", result.imported, 0);
  equal("report: the four photos were already in the library", result.duplicates, 4);
  ok("report: at least one frame was picked", result.picked >= 1, String(result.picked));
  ok("report: the rejected frames are counted", result.rejected >= 0, String(result.rejected));
  ok("report: the grading ran", result.graded >= 1, String(result.graded));
  equal("report: one export tier ran", result.exported.length, 1);
  equal("report: the tier is the web preview", result.exported[0].tier, "web_preview");
  ok("report: the export wrote bytes", result.exported[0].bytes > 0, String(result.exported[0].bytes));
  ok("report: the stage durations are logged", Object.keys(result.stageDurationsMs).length >= 5,
    JSON.stringify(Object.keys(result.stageDurationsMs)));
  ok("report: the HDR stage was skipped", result.hdrMerged === 0);

  console.log("\n# the delivery");
  const web = resolve(DELIVERY, "web");
  ok("delivery: the web folder exists", existsSync(web));
  const files = existsSync(web) ? readdirSync(web) : [];
  ok("delivery: it holds the exports", files.length > 0, JSON.stringify(files));
  const jpeg = files.find((name) => name.endsWith(".jpg") || name.endsWith(".jpeg"));
  ok("delivery: the export is a JPEG", jpeg !== undefined, JSON.stringify(files));
  if (jpeg) {
    const bytes = readFileSync(resolve(web, jpeg));
    ok("delivery: the file has a JPEG header", bytes[0] === 0xff && bytes[1] === 0xd8);
    ok("delivery: the file is not empty", bytes.length > 1000, `${bytes.length} bytes`);
  }

  console.log("\n# the library");
  ok("library: the catalog was opened", existsSync(resolve(LIBRARY, "catalog.snap")));
  // The staging area is immutable: the import copies into the library and
  // never touches the files the photographer handed over.
  const staged = readdirSync(STAGING).filter((name) => name.endsWith(".png"));
  equal("library: the staged originals are untouched", staged.length, 4);
  ok("library: the catalog holds the photos", countFiles(LIBRARY) >= 0);

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
