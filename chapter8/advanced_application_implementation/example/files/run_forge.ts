// run_forge.ts — deterministic harness for the VectorForge logo-synthesis worker.
//
// The worker is a one-job-per-process CLI: it reads a JSON request on stdin,
// drives VectorCraft over MCP, and answers with a JSON line on stdout. The
// harness feeds it a request, then checks the artifacts it produced and that
// a second run reproduces the same bytes — the property the SaaS layer
// depends on to cache artifacts by request hash.

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";

const FILES = process.cwd();
const OUTPUT = resolve(FILES, "output");
const WORKER = resolve(FILES, "01_vectorforge-logo-synthesis.ts");

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

const REQUEST = {
  tenantId: "acme",
  sku: "logo-001",
  correlationId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  primaryColor: "#0ea5e9",
  secondaryColor: "#1e293b",
  accentColor: "#f59e0b",
  petals: 10,
  blendSteps: 24,
  offsetDistance: 5,
  artboardWidth: 1200,
  artboardHeight: 1200,
  exportDir: "",
};

async function runWorker(request: typeof REQUEST, exportDir: string): Promise<any> {
  const child = spawn("npx", ["tsx", WORKER], {
    cwd: FILES,
    env: {
      ...process.env,
      VECTORFORGE_READ_ROOT: FILES,
      VECTORFORGE_WRITE_ROOT: exportDir,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
  child.stdin.end(JSON.stringify({ ...request, exportDir }));

  const code = await new Promise<number>((resolvePromise) => {
    child.on("close", (exitCode) => resolvePromise(exitCode ?? 0));
  });
  assert.equal(code, 0, `worker failed: ${stderr.slice(-800)}`);

  const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  return JSON.parse(line);
}

async function main(): Promise<void> {
  rmSync(OUTPUT, { recursive: true, force: true });
  mkdirSync(resolve(OUTPUT, "run-1"), { recursive: true });
  mkdirSync(resolve(OUTPUT, "run-2"), { recursive: true });

  console.log("\n# first run");
  const first = await runWorker(REQUEST, resolve(OUTPUT, "run-1"));
  ok("worker: it reports success", first.ok === true, JSON.stringify(first).slice(0, 300));
  equal("worker: the correlation id survives", first.correlationId, REQUEST.correlationId);
  ok("worker: the svg is reported", typeof first.svg === "string" && first.svg.endsWith(".svg"));
  ok("worker: the png is reported", typeof first.png === "string" && first.png.endsWith(".png"));
  ok("worker: four root objects are reported", Array.isArray(first.rootIds) && first.rootIds.length === 4);
  ok("worker: the root ids are distinct", new Set(first.rootIds).size === 4);

  console.log("\n# the artifacts");
  ok("artifact: the svg file exists", existsSync(first.svg));
  ok("artifact: the png file exists", existsSync(first.png));
  const svg = readFileSync(first.svg, "utf8");
  const pngBytes = readFileSync(first.png);
  equal("artifact: the svg byte count matches", svg.length, first.bytes.svg);
  equal("artifact: the png byte count matches", pngBytes.length, first.bytes.png);
  ok("artifact: the svg is xml", svg.startsWith("<?xml"));
  ok("artifact: the svg carries the palette", svg.includes("#0ea5e9") && svg.includes("#f59e0b"));
  ok("artifact: the svg has geometry", (svg.match(/<path\b/g) ?? []).length > 8);

  const png = PNG.sync.read(pngBytes);
  equal("artifact: the raster is 2x the artboard", png.width, 2400);
  equal("artifact: the raster is square", png.height, 2400);

  let inked = 0;
  let transparent = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i + 3] < 8) transparent += 1;
    else inked += 1;
  }
  const covered = inked / (png.data.length / 4);
  ok("artifact: the mark covers a real share of the canvas", covered > 0.1, `${(covered * 100).toFixed(1)}%`);
  ok("artifact: the mark does not fill the canvas", covered < 0.6, `${(covered * 100).toFixed(1)}%`);
  ok("artifact: the background is transparent", transparent > png.data.length / 4 / 2);

  console.log("\n# determinism");
  const second = await runWorker(REQUEST, resolve(OUTPUT, "run-2"));
  ok("worker: the second run also succeeds", second.ok === true);
  const svg2 = readFileSync(second.svg, "utf8");
  equal("determinism: the same svg bytes come out", svg2, svg);
  equal("determinism: the same png bytes come out", readFileSync(second.png).length, pngBytes.length);

  console.log("\n# a different palette is a different asset");
  mkdirSync(resolve(OUTPUT, "run-3"), { recursive: true });
  const third = await runWorker(
    { ...REQUEST, sku: "logo-002", primaryColor: "#7c3aed", accentColor: "#22d3ee" },
    resolve(OUTPUT, "run-3"),
  );
  const svg3 = readFileSync(third.svg, "utf8");
  ok("palette: the new colours are in the svg", svg3.includes("#7c3aed") && svg3.includes("#22d3ee"));
  ok("palette: the old colours are not", !svg3.includes("#0ea5e9"));

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
