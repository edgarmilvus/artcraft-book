/**
 * Acceptance harness for Chapter 6 Exercise 4.
 *
 * Builds a real archive with the engine — one pristine baseline, one identical
 * copy, one rename, one flat document, one top-level clip and one corrupt file
 * — then audits it in parallel and checks every verdict.
 *
 * The archive, the baseline, both audit reports and a run summary stay under
 * ../output/; the audit never writes into the archive it reads.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import {
  mkdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { assertReadOnlyRefusal, auditArchive } from "./src/audit-archive.js";

const HERE = import.meta.dirname;
const OUT = join(HERE, "..", "output");
const ARCHIVE = join(OUT, "archive");
const BASELINE = join(OUT, "baseline", "aw26-hoodie-charcoal");
const AUDIT = join(OUT, "audit");
const AUDIT_SECOND = join(OUT, "audit-second");

for (const directory of [ARCHIVE, join(OUT, "baseline"), AUDIT, AUDIT_SECOND]) {
  rmSync(directory, { recursive: true, force: true });
}
mkdirSync(ARCHIVE, { recursive: true });
mkdirSync(BASELINE, { recursive: true });

let pass = 0;
const failures: string[] = [];
const checks: { label: string; ok: boolean; detail?: string }[] = [];
function check(label: string, cond: boolean, detail = "") {
  checks.push({ label, ok: cond, detail });
  if (cond) { pass++; console.log(`PASS ${label}`); }
  else { failures.push(label); console.log(`FAIL ${label} ${detail}`); }
}

const sha256 = (file: string): string =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

type Call = (name: string, args?: Record<string, unknown>) => Promise<any>;
let call: Call;

async function openEngine(): Promise<{ client: Client; call: Call }> {
  const client = new Client({ name: "fixture-builder", version: "1" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: "photocraft-cli",
    args: ["mcp", "--automation-read-root", OUT, "--automation-write-root", OUT],
  }));
  const fn: Call = async (name, args = {}) => {
    const reply = await client.callTool({ name, arguments: args });
    const text = (reply as any).content?.find((b: any) => b.type === "text")?.text;
    if ((reply as any).isError) throw new Error(text);
    return text ? JSON.parse(text) : null;
  };
  return { client, call: fn };
}

async function command(id: string, params: Record<string, unknown>): Promise<any> {
  return call("command_run", { id, params });
}

/** The contract-shaped document: Background group, clipped product, type group. */
async function buildGood(): Promise<void> {
  await call("doc_new", { width: 200, height: 100, background: "white" });
  const group = (await command("layer.new.group", { name: "Background" })).layer;
  const fill = (await command("layer.newFillLayer.solidColor", { color: "#cccccc" })).layer;
  await command("layer.moveTo", { layer: fill, target: group, position: "into" });
  const product = (await command("layer.new.layer", { name: "Product" })).layer;
  await command("layer.moveTo", { layer: product, target: group, position: "into" });
  await command("layer.createClippingMask", { layer: product });
  const headlineGroup = (await command("layer.new.group", { name: "Type::Headline" })).layer;
  const type = (await command("type.create", {
    box: [10, 10, 180, 60], text: "AW26", font: "Helvetica", size: 32, color: "#111111",
  })).layer;
  await command("layer.moveTo", { layer: type, target: headlineGroup, position: "into" });
  await command("layer.renameLayer", { layer: type, name: "Type::Headline" });
}

const engine = await openEngine();
call = engine.call;

// Baseline and an identical copy.
await buildGood();
await call("doc_save", { path: join(BASELINE, "banner.psd"), format: "psd" });
writeFileSync(join(BASELINE, "inspect.json"),
  JSON.stringify(await call("doc_inspect", {}), null, 2) + "\n");
await buildGood();
await call("doc_save", { path: join(ARCHIVE, "a-good.psd"), format: "psd" });

// Same tree, one renamed layer: a warn, not a fail.
await buildGood();
const insp = await call("doc_inspect", {});
const product = insp.layers
  .find((l: any) => l.name === "Background")?.children
  ?.find((l: any) => l.name === "Product");
await command("layer.renameLayer", { layer: product.id, name: "Product-X" });
await call("doc_save", { path: join(ARCHIVE, "b-renamed.psd"), format: "psd" });

// A flat document: no Background group at all.
await call("doc_new", { width: 200, height: 100, background: "white" });
await call("doc_save", { path: join(ARCHIVE, "c-flat.psd"), format: "psd" });

// A clipped layer at the top level: the mask has no base inside a group.
await call("doc_new", { width: 200, height: 100, background: "white" });
const loose = (await command("layer.new.layer", { name: "Loose" })).layer;
await command("layer.createClippingMask", { layer: loose });
await call("doc_save", { path: join(ARCHIVE, "d-topclip.psd"), format: "psd" });

// A file that is not a PSD at all.
writeFileSync(join(ARCHIVE, "e-broken.psd"), "this is not a photoshop file");

await engine.client.close();

const entries = await auditArchive(ARCHIVE, AUDIT, {
  readRoot: OUT,
  writeRoot: AUDIT,
  baselinePath: "baseline/aw26-hoodie-charcoal/banner.psd",
  concurrency: 3,
});
const byName = Object.fromEntries(entries.map((e) => [e.file.split("/").pop(), e]));

check("the audit found all five files", entries.length === 5,
  JSON.stringify(entries.map((e) => e.file)));
check("the report is sorted by path",
  entries.every((e, i) => i === 0 || entries[i - 1].file <= e.file));

check("the identical copy passes", byName["a-good.psd"]?.verdict === "pass",
  JSON.stringify(byName["a-good.psd"]));
check("the rename is a warn, not a fail",
  byName["b-renamed.psd"]?.verdict === "warn"
  && byName["b-renamed.psd"].reasons.includes("tree-differs-from-baseline"),
  JSON.stringify(byName["b-renamed.psd"]));
check("the flat document fails on the missing group",
  byName["c-flat.psd"]?.verdict === "fail"
  && byName["c-flat.psd"].reasons.includes("missing-background-group"),
  JSON.stringify(byName["c-flat.psd"]));
check("the top-level clip fails",
  byName["d-topclip.psd"]?.verdict === "fail"
  && byName["d-topclip.psd"].reasons.some((r: string) => r.startsWith("top-level-clipped")),
  JSON.stringify(byName["d-topclip.psd"]));
check("the corrupt file fails as unreadable",
  byName["e-broken.psd"]?.verdict === "fail"
  && byName["e-broken.psd"].reasons.some((r: string) => r.startsWith("unreadable")),
  JSON.stringify(byName["e-broken.psd"]));

check("every entry carries a 64-hex tree hash",
  entries.every((e) => /^[0-9a-f]{64}$/.test(e.treeHash)));
check("the same tree hashes to the same value",
  byName["a-good.psd"].treeHash !== byName["b-renamed.psd"].treeHash
  && byName["a-good.psd"].treeHash !== byName["c-flat.psd"].treeHash);
check("the layer counts describe real trees",
  byName["a-good.psd"].layerCount === 6 && byName["a-good.psd"].deepestNesting === 2,
  JSON.stringify(byName["a-good.psd"]));

const report = JSON.parse(readFileSync(join(AUDIT, "report.json"), "utf8"));
check("the report repeats the baseline hash",
  report.baselineHash === byName["a-good.psd"].treeHash, report.baselineHash);

// Determinism: a second pass over the same archive produces the same map.
const again = await auditArchive(ARCHIVE, AUDIT_SECOND, {
  readRoot: OUT,
  writeRoot: AUDIT_SECOND,
  baselinePath: "baseline/aw26-hoodie-charcoal/banner.psd",
  concurrency: 2,
});
check("two passes agree bit for bit",
  JSON.stringify(again.map((e) => [e.file, e.treeHash, e.verdict]))
    === JSON.stringify(entries.map((e) => [e.file, e.treeHash, e.verdict])));

let refusal = "";
try { await assertReadOnlyRefusal({ readRoot: OUT, writeRoot: AUDIT }); }
catch (err) { refusal = (err as Error).message; }
check("a write into the read root is refused", refusal === "", refusal);

const verdicts = entries.reduce<Record<string, number>>((counts, entry) => {
  counts[entry.verdict] = (counts[entry.verdict] ?? 0) + 1;
  return counts;
}, {});

const archive = entries.map((entry) => {
  const rel = entry.file.slice(OUT.length + 1);
  const file = join(OUT, rel);
  return {
    file: rel,
    bytes: statSync(file).size,
    sha256: sha256(file),
    verdict: entry.verdict,
    reasons: entry.reasons,
    treeHash: entry.treeHash,
  };
});

writeFileSync(join(OUT, "report.json"), JSON.stringify({
  chapter: 6,
  exercise: 4,
  checks: { passed: pass, failed: failures.length, total: pass + failures.length },
  baselineHash: report.baselineHash,
  verdicts,
  entries: entries.map((entry) => ({
    file: entry.file.slice(OUT.length + 1),
    verdict: entry.verdict,
    reasons: entry.reasons,
    treeHash: entry.treeHash,
    layerCount: entry.layerCount,
    deepestNesting: entry.deepestNesting,
  })),
  archive,
  reports: ["audit/report.json", "audit-second/report.json"],
  failures,
}, null, 2) + "\n");

console.log(`\n${pass}/${pass + failures.length} checks passed`);
if (failures.length) process.exit(1);
