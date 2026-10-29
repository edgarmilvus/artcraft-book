/**
 * Harness for the chapter's smoke test.
 *
 * Exercises the listing exactly as published: a real photocraft-cli child, a
 * real command_batch, a real PSD on disk. No engine call is stubbed.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeLayeredPsd } from "./src/psd-smoke-test.js";

let pass = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`PASS ${label}`); }
  else { failures.push(label); console.log(`FAIL ${label} ${detail}`); }
}

const workRoot = mkdtempSync(join(tmpdir(), "psd-smoke-"));
try {
  // 1. The contract rejects a bad canvas before any child process exists.
  let rejected = "";
  try {
    await composeLayeredPsd({ canvas: { width: 0, height: 10 }, title: "x", outputPath: "x.psd", workRoot });
  } catch (err) {
    rejected = (err as Error).name;
  }
  check("bad canvas rejected by the schema", rejected === "ZodError", rejected);

  // 2. The pipeline itself.
  const out = await composeLayeredPsd({
    canvas: { width: 640, height: 360 },
    title: "Smoke Test",
    outputPath: "smoke.psd",
    workRoot,
  });
  check("document index is the one doc_new returned", out.documentIndex === 0, String(out.documentIndex));
  check("four top-level layers (background, fill, clip, curves)", out.topLevelLayers === 4, String(out.topLevelLayers));
  check("the PSD was written", out.bytes > 1000, String(out.bytes));
  check("the file carries the PSD signature", readFileSync(join(workRoot, "smoke.psd")).subarray(0, 4).toString("latin1") === "8BPS");
  check("no save warnings", Array.isArray(out.warnings) && out.warnings.length === 0, JSON.stringify(out.warnings));

  // 3. The capability root is enforced by the engine, not by our schema.
  let escape = "";
  try {
    await composeLayeredPsd({
      canvas: { width: 32, height: 32 }, title: "escape",
      outputPath: "../escape.psd", workRoot,
    });
  } catch (err) {
    escape = (err as Error).message;
  }
  check("a parent-traversal path is refused", /parent traversal is not allowed/.test(escape), escape.slice(0, 80));
} finally {
  rmSync(workRoot, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + failures.length} checks passed`);
if (failures.length) process.exit(1);
