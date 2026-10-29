// run_ex5.ts — acceptance harness for the responsive fan-out and cache.
//
// It builds a real DesignCraft template, renders two variants through both
// engines, writes the content-hash manifest, then proves that a second
// dry-run recognises both entries as hits and the remaining variants as misses.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  McpProcess,
  acquireLock,
  cacheKeyFor,
  canonical,
  loadManifest,
  mergeManifest,
  processVariant,
  run,
  saveManifest,
  type CacheManifest,
  type Locale,
  type VariantKey,
} from "./05_multi-locale-multi-aspect-responsive-export-with-content-hash-cache-manifest.js";

const HERE = process.cwd();
const OUTPUT = resolve(HERE, "..", "output");
const WORK = resolve(OUTPUT, "work");
const TEMPLATE = resolve(WORK, "template.designcraft");
const MANIFEST = resolve(WORK, "cache-manifest.json");

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

async function buildTemplate(): Promise<void> {
  const design = new McpProcess("designcraft-cli", ["mcp"]);
  await design.start();
  try {
    await design.call("new_document", {
      width: 1080, height: 1080, pages: 1, columns: 1, gutter: 18,
      margins: 100, title: "Responsive fan-out template",
    });
    await design.call("execute", {
      command: "frame.create",
      params: { rect: [100, 100, 980, 980], content: "text", text: "Product title" },
    });
    for (const locale of ["en-US", "en-GB", "de-DE", "ja-JP", "pt-BR", "ar-SA"]) {
      await design.call("execute", {
        command: "style.paragraph.create",
        params: { name: `${locale}-heading` },
      });
    }
    await design.call("save_document", { path: TEMPLATE });
  } finally {
    await design.close();
  }
}

function unitManifest(): void {
  console.log("\n# manifest units");
  equal("canonical: sorted keys", canonical({ b: 1, a: 2 }), '{"a":2,"b":1}');
  const local: CacheManifest = { version: 1, generatedBy: "responsive-fanout/v1", entries: {
    a: { sku: "A", locale: "en-US", aspect: "1:1", sourceHash: "a", artifacts: [],
         generatedAt: "2026-01-01T00:00:00.000Z", commandTrace: [] } } };
  const disk: CacheManifest = { version: 1, generatedBy: "responsive-fanout/v1", entries: {
    b: { sku: "B", locale: "en-GB", aspect: "4:5", sourceHash: "b", artifacts: [],
         generatedAt: "2026-02-01T00:00:00.000Z", commandTrace: [] } } };
  equal("merge: untouched entries survive", Object.keys(mergeManifest(local, disk).entries).sort().join(","), "a,b");
}

async function main(): Promise<void> {
  rmSync(WORK, { recursive: true, force: true });
  rmSync(resolve(OUTPUT, "report.json"), { force: true });
  mkdirSync(WORK, { recursive: true });
  unitManifest();
  await buildTemplate();
  ok("template: saved", existsSync(TEMPLATE));

  console.log("\n# variants");
  const row = { sku: "TEE-001", title: "Trail Runner", price: 129.99, currency: "USD" };
  const designcraft = new McpProcess("designcraft-cli", ["mcp"]);
  const photocraft = new McpProcess("photocraft-cli", ["mcp",
    "--automation-read-root", WORK, "--automation-write-root", WORK]);
  await Promise.all([designcraft.start(), photocraft.start()]);
  const deps = {
    designcraft, photocraft, writeRoot: WORK, templateId: TEMPLATE,
    brandKitVersion: "2026.1", dryRun: false,
  };
  const keys: VariantKey[] = [
    { sku: "TEE-001", locale: "en-US", aspect: "1:1" },
    { sku: "TEE-001", locale: "ar-SA", aspect: "9:16" },
  ];
  const manifest: CacheManifest = { version: 1, generatedBy: "responsive-fanout/v1", entries: {} };
  try {
    for (const key of keys) {
      const result = await processVariant(key, row, deps);
      equal(`variant ${key.locale} ${key.aspect}: three artifacts`, result.entry.artifacts.length, 3);
      ok(`variant ${key.locale} ${key.aspect}: command trace`,
        result.entry.commandTrace.includes("file.exportPdf") &&
        result.entry.commandTrace.includes("story.setDirection"), JSON.stringify(result.entry.commandTrace));
      for (const artifact of result.entry.artifacts) {
        const abs = resolve(WORK, artifact.path);
        ok(`artifact: ${artifact.path} exists`, existsSync(abs));
        equal(`artifact: ${artifact.path} bytes`, artifact.bytes, readFileSync(abs).byteLength);
      }
      manifest.entries[result.entry.sourceHash] = result.entry;
    }
  } finally {
    await Promise.all([designcraft.close(), photocraft.close()]);
  }
  await saveManifest(MANIFEST, manifest);
  ok("manifest: cache-manifest.json written", existsSync(MANIFEST));
  const saved = await loadManifest(MANIFEST);
  equal("manifest: two entries", Object.keys(saved.entries).length, 2);

  console.log("\n# cache dry-run");
  const feedPath = resolve(WORK, "feed.json");
  writeFileSync(feedPath, JSON.stringify([row]));
  const log = await run({
    feedPath, readRoot: WORK, writeRoot: WORK, templateId: TEMPLATE,
    brandKitVersion: "2026.1", dryRun: true, gitSha: "test-sha",
  });
  equal("cache: two hits", log.hits, 2);
  equal("cache: twenty-eight misses", log.misses, 28);
  equal("cache: no errors", log.errors.length, 0);
  equal("cache: no contention", log.contended, false);

  const lockPath = resolve(WORK, "lock-test.lock");
  const release = await acquireLock(lockPath);
  ok("lock: acquired", existsSync(lockPath));
  await release();
  ok("lock: released", !existsSync(lockPath));

  const artefacts = [
    "work/template.designcraft",
    "work/cache-manifest.json",
    ...keys.flatMap((key) => {
      const stem = `${key.sku}-${key.locale.replace("-", "")}-${key.aspect.replace(":", "x")}`;
      return [`work/${stem}.png`, `work/${stem}.webp`, `work/${stem}.jpg`];
    }),
  ];
  for (const artefact of artefacts) ok(`output: ${artefact}`, existsSync(resolve(OUTPUT, artefact)));
  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 5,
    engines: ["designcraft-cli", "photocraft-cli"],
    assertions: passed + 1,
    variants: keys,
    hits: log.hits,
    misses: log.misses,
    errors: log.errors,
    artefacts,
    result: "two aspect/locale variants rendered with three formats each; source-hash cache recognised both on a second dry-run",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
