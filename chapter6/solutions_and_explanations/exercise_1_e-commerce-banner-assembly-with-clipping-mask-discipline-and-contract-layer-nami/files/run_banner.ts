/**
 * Harness for the banner assembler.
 *
 * Two SKUs go through the real engine: two batches, a doc_place of a real
 * PNG, a PSD on disk and the contract audit. The third SKU points at a
 * missing cutout and must be reported as a failure, not a crash.
 *
 * Everything the run proves is kept under ../output/: the cutout, the two
 * saved PSDs, their inspection trees and a machine-readable report.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { assembleAllSkus, undoAppliedPrefix } from "./src/banner-assembler.js";

const HERE = import.meta.dirname;
const OUT = join(HERE, "..", "output");
const WORK = join(OUT, "workspace");
const READ = join(WORK, "read");
const BANNERS = join(OUT, "banners");

// Clear only the directories this harness owns: the shell opens
// output/run_banner.log before the process starts, so the log must survive.
for (const directory of [WORK, BANNERS]) {
  rmSync(directory, { recursive: true, force: true });
}
mkdirSync(READ, { recursive: true });
mkdirSync(BANNERS, { recursive: true });

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

// A real 512×512 cutout, produced by the engine itself so no hand-made PNG.
const cutout = join(READ, "cutout.png");
execFileSync("photocraft-cli", [
  "run", "--new", '{"width":512,"height":512,"background":"#f97316"}',
  "--out", cutout,
], { stdio: "ignore" });

const spec = (sku: string, productCutoutPath: string) => ({
  sku,
  canvas: { width: 1920 as const, height: 1080 as const },
  productCutoutPath,
  gradient: { from: "#1d4ed8", to: "#0f172a", angle: 90, style: "linear" as const },
  headline: { text: "AW26 DROP", font: "Helvetica", size: 96, color: "#f8f5ef" },
  price: { text: "$128", font: "Helvetica", size: 64, color: "#f97316" },
  seed: 7,
});

const results = await assembleAllSkus(
  [
    spec("AW26-HOODIE-CHARCOAL", "cutout.png"),
    spec("AW26-TEE-BONE", "cutout.png"),
    spec("AW26-MISSING", "does-not-exist.png"),
  ],
  { readRoot: READ, writeRoot: BANNERS },
);

check("both good SKUs pass the contract audit",
  results.filter((r) => r.status === "pass").length === 2,
  JSON.stringify(results));
check("the missing cutout is a reported failure",
  results[2]?.status === "fail" && /placement/.test(results[2]?.detail ?? ""),
  JSON.stringify(results[2]));

const psd = join(BANNERS, "AW26-HOODIE-CHARCOAL", "banner.psd");
check("the PSD exists", existsSync(psd));
check("the PSD is layered (8BPS)", readFileSync(psd).subarray(0, 4).toString("latin1") === "8BPS");
check("the failed SKU wrote no file", !existsSync(join(BANNERS, "AW26-MISSING", "banner.psd")));

// The audit is only as good as the tree it reads: prove the tree nests.
const info = execFileSync("photocraft-cli", ["info", psd, "--compact"], { encoding: "utf8" });
const tree = JSON.parse(info) as { layers?: Array<{ name: string; children?: unknown[] }> };
const bg = tree.layers?.find((l) => l.name === "Background");
check("Background is a group with two children",
  Array.isArray(bg?.children) && bg!.children!.length === 2,
  JSON.stringify(tree.layers?.map((l) => l.name)));

// Keep the inspection tree next to the PSD it describes.
for (const sku of ["AW26-HOODIE-CHARCOAL", "AW26-TEE-BONE"]) {
  const banner = join(BANNERS, sku, "banner.psd");
  writeFileSync(
    join(BANNERS, sku, "inspect.json"),
    execFileSync("photocraft-cli", ["info", banner, "--compact"], { encoding: "utf8" }) + "\n",
  );
}

// A payload the schema cannot accept never reaches the engine.
let schemaName = "";
try {
  await assembleAllSkus([{ ...spec("lower-case", "cutout.png") }], { readRoot: READ, writeRoot: BANNERS });
} catch (err) {
  schemaName = (err as Error).name;
}
check("a lower-case SKU is refused by the schema", schemaName === "ZodError", schemaName);

// A batch that dies midway is compensated: the engine keeps the prefix, so the
// undo count is the number of successful steps.
{
  const client = new Client({ name: "banner-compensation", version: "1" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: "photocraft-cli",
    args: ["mcp", "--automation-read-root", READ, "--automation-write-root", BANNERS],
  }));
  const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const res = await client.callTool({ name, arguments: args }) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const text = res.content?.find((b) => b.type === "text")?.text;
    if (res.isError) throw new Error(text ?? "engine refused the call");
    return text ? JSON.parse(text) : null;
  };
  const depth = async (): Promise<number> => (await call("doc_inspect", {})).history.length;
  try {
    await call("doc_new", { width: 640, height: 360, background: "white" });
    const before = await depth();
    const batch = await call("command_batch", {
      steps: [
        { id: "layer.newFillLayer.solidColor", params: { color: "#ff0000" } },
        { id: "layer.newFillLayer.solidColor", params: { color: "#00ff00" } },
        { id: "no.such.command", params: {} },
      ],
      stop_on_error: true,
    });
    check("a mid-batch failure still reports the applied prefix",
      batch.failed === 1 && batch.completed === 2,
      JSON.stringify({ completed: batch.completed, failed: batch.failed }));
    const undone = await undoAppliedPrefix(client, batch.completed);
    check("the compensation restores the opening history depth",
      undone === 2 && (await depth()) === before,
      `${undone} undos, depth ${await depth()} vs ${before}`);
  } finally {
    await client.close();
  }
}

const banners = ["AW26-HOODIE-CHARCOAL", "AW26-TEE-BONE"].map((sku) => {
  const file = join(BANNERS, sku, "banner.psd");
  return { sku, file, bytes: readFileSync(file).length, sha256: sha256(file) };
});

writeFileSync(join(OUT, "report.json"), JSON.stringify({
  chapter: 6,
  exercise: 1,
  checks: { passed: pass, failed: failures.length, total: pass + failures.length },
  results,
  banners,
  cutout: { file: cutout, bytes: readFileSync(cutout).length, sha256: sha256(cutout) },
  tree: tree.layers?.map((l) => l.name),
  failures,
}, null, 2) + "\n");

console.log(`\n${pass}/${pass + failures.length} checks passed`);
if (failures.length) process.exit(1);
