// run_ex1.ts — acceptance harness for the feed hygiene gate.
//
// It stages two usable rows and five bad ones, runs the gate against a real
// PhotoCraft session, and verifies the ordered rejection report, the rendered
// PNGs and the SHA-256 evidence.

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import {
  canonicalJson,
  rejection,
  formatPrice,
  runGate,
  type FeedAuditReport,
  type ProductFeedRow,
} from "./01_solutions_and_explanations.js";

const HERE = process.cwd();
const OUTPUT = resolve(HERE, "..", "output");
const FEEDS = resolve(OUTPUT, "feeds");
const WRITE = resolve(OUTPUT, "banners");
const FEED_PATH = resolve(OUTPUT, "feed.json");

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

function makeHero(seed: number): Buffer {
  const png = new PNG({ width: 1200, height: 1200 });
  for (let y = 0; y < 1200; y += 1) {
    for (let x = 0; x < 1200; x += 1) {
      const i = (y * 1200 + x) * 4;
      const wave = Math.sin((x + seed) / 31) * Math.cos((y + seed) / 27);
      const value = 95 + wave * 45;
      png.data[i] = Math.max(0, Math.min(255, Math.round(value)));
      png.data[i + 1] = Math.max(0, Math.min(255, Math.round(value * 0.82)));
      png.data[i + 2] = Math.max(0, Math.min(255, Math.round(value * 0.64)));
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function unitRules(): void {
  console.log("\n# rule engine");
  equal("rule: control characters win first",
    rejection({ sku: "A\u0001", title: "x", price: 1, currency: "USD", heroImage: "h.png" })?.reason,
    "control-chars");
  equal("rule: whitespace sku", rejection({ sku: "A B", title: "x", price: 1, currency: "USD", heroImage: "h.png" })?.reason,
    "missing-sku");
  equal("rule: 121 UTF-8 bytes is too long",
    rejection({ sku: "A", title: "x".repeat(121), price: 1, currency: "USD", heroImage: "h.png" })?.reason,
    "title-too-long");
  equal("rule: sale price must be below price",
    rejection({ sku: "A", title: "x", price: 10, salePrice: 10, currency: "USD", heroImage: "h.png" })?.reason,
    "invalid-sale-price");
  equal("rule: path escape", rejection({ sku: "A", title: "x", price: 1, currency: "USD", heroImage: "../h.png" })?.reason,
    "path-escape");
  equal("rule: a valid row passes",
    rejection({ sku: "A", title: "x", price: 1, currency: "USD", heroImage: "h.png" }), null);
  equal("canonical: keys sort before values",
    canonicalJson({ b: 1, a: [true, null] }), '{"a":[true,null],"b":1}');
  equal("price: formats the locale currency", formatPrice(129.99, "en-US", "USD"), "$129.99");
}

async function main(): Promise<void> {
  rmSync(FEEDS, { recursive: true, force: true });
  rmSync(WRITE, { recursive: true, force: true });
  rmSync(FEED_PATH, { force: true });
  rmSync(resolve(OUTPUT, "report.json"), { force: true });
  mkdirSync(FEEDS, { recursive: true });
  mkdirSync(WRITE, { recursive: true });
  writeFileSync(resolve(FEEDS, "hero-a.png"), makeHero(2));
  writeFileSync(resolve(FEEDS, "hero-b.png"), makeHero(9));

  const rows: ProductFeedRow[] = [
    { sku: "SKU-1", title: "Trail Runner", price: 129.99, currency: "USD", heroImage: "hero-a.png", locale: "en-US" },
    { sku: "SKU-2", title: "City Pack", price: 89, salePrice: 69, currency: "EUR", heroImage: "hero-b.png", locale: "de-DE" },
    { sku: "NO-TITLE", title: "  ", price: 10, currency: "USD", heroImage: "hero-a.png" },
    { sku: "BAD-CURRENCY", title: "Ok", price: 10, currency: "usd", heroImage: "hero-a.png" },
    { sku: "ESCAPE", title: "Ok", price: 10, currency: "USD", heroImage: "../secret.png" },
    { sku: "BAD-SALE", title: "Ok", price: 10, salePrice: 12, currency: "USD", heroImage: "hero-a.png" },
    { sku: "MOJIBAKE", title: "Caf\uFFFD", price: 10, currency: "USD", heroImage: "hero-a.png" },
  ];
  writeFileSync(FEED_PATH, JSON.stringify(rows, null, 2));
  unitRules();

  console.log("\n# the gate");
  const report: FeedAuditReport = await runGate({ feedPath: FEED_PATH, readRoot: FEEDS, writeRoot: WRITE });
  equal("gate: two rows accepted", report.accepted, 2);
  equal("gate: no rows deferred", report.deferred, 0);
  equal("gate: five rows rejected", report.rejected.length, 5);
  equal("gate: deterministic order", report.rejected.map((row) => row.rowIndex).join(","), "2,3,4,5,6");
  equal("gate: first reason", report.rejected[0].reason, "missing-title");
  equal("gate: currency reason", report.rejected[1].reason, "invalid-currency");
  equal("gate: escape reason", report.rejected[2].reason, "path-escape");
  equal("gate: sale reason", report.rejected[3].reason, "invalid-sale-price");
  equal("gate: mojibake reason", report.rejected[4].reason, "mojibake-title");
  equal("gate: two artifacts", report.artifacts.length, 2);
  for (const artifact of report.artifacts) {
    const abs = resolve(WRITE, artifact.path);
    ok(`artifact: ${artifact.path} exists`, existsSync(abs));
    const bytes = readFileSync(abs);
    equal(`artifact: ${artifact.path} byte count`, artifact.bytes, bytes.byteLength);
    equal(`artifact: ${artifact.path} sha256`,
      artifact.sha256, createHash("sha256").update(bytes).digest("hex"));
    ok(`artifact: ${artifact.path} is a PNG`, bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
  }

  console.log("\n# the audit file");
  const auditPath = resolve(WRITE, "feed-audit.json");
  ok("audit: written under the write root", existsSync(auditPath));
  const audit = JSON.parse(readFileSync(auditPath, "utf8"));
  equal("audit: generator id", audit.generatedBy, "feed-hygiene-gate/v1");
  equal("audit: accepted count", audit.accepted, 2);
  equal("audit: artifacts preserved", audit.artifacts.length, 2);
  assert.deepEqual(audit.rejected.map((row: any) => row.rowIndex), [2, 3, 4, 5, 6]);

  for (const file of ["banners/SKU-1.png", "banners/SKU-2.png", "banners/feed-audit.json", "feed.json"]) {
    ok(`output: ${file}`, existsSync(resolve(OUTPUT, file)));
  }
  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 1,
    engine: "photocraft-cli",
    assertions: passed + 1,
    feedRows: rows.length,
    accepted: report.accepted,
    deferred: report.deferred,
    rejected: report.rejected,
    artifacts: report.artifacts,
    artefacts: ["feed.json", "feeds/hero-a.png", "feeds/hero-b.png",
      "banners/SKU-1.png", "banners/SKU-2.png", "banners/feed-audit.json"],
    result: "two usable rows rendered and hashed; five rows rejected in feed order with one reason each",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
