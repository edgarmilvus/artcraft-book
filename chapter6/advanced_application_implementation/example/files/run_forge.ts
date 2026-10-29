/**
 * Harness for the Brand Forge worker.
 *
 * A real photocraft-cli child does the rendering; only the vision model is
 * absent (no OPENAI_API_KEY), which the worker already treats as "no audit".
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PsdBrandForgeClient,
  PsdBrandForgeJobSchema,
  averageChromaTrim,
  oklchLToCielabLStar,
  oklchToneCurveToLightnessPoints,
  runBrandForgeJob,
  withRetry,
} from "./src/psd-brand-forge.js";

let pass = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`PASS ${label}`); }
  else { failures.push(label); console.log(`FAIL ${label} ${detail}`); }
}

const scratch = mkdtempSync(join(tmpdir(), "brand-forge-"));
const job = {
  jobId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  tenantId: "acme",
  canvas: { width: 800, height: 600 },
  palette: { backdrop: "#101014", matte: "#f8f5ef", base: "#1d4ed8", accent: "#f97316" },
  headline: { text: "Storytold", fontFamily: "Helvetica", sizePt: 72, color: "#f8f5ef", xPt: 64, yPt: 360 },
  oklchCurve: {
    stops: [
      { inputL: 0.0, outputL: 0.06, chromaMultiplier: 1.1 },
      { inputL: 0.5, outputL: 0.52, chromaMultiplier: 1.25 },
      { inputL: 1.0, outputL: 0.97, chromaMultiplier: 1.0 },
    ],
  },
  paths: { psd: "brand-kit.psd", preview: "brand-kit.png" },
};

try {
  // 1. Pure colour science, no engine.
  check("OkLCh 0 → L* 0", oklchLToCielabLStar(0) === 0);
  check("OkLCh 1 → L* 100", oklchLToCielabLStar(1) === 100);
  const points = oklchToneCurveToLightnessPoints(job.oklchCurve.stops);
  check("curve points are sorted and inside 0..255",
    points.length >= 2 && points.length <= 19 &&
    points.every(([i, o], idx) => i >= 0 && i <= 255 && o >= 0 && o <= 255 && (idx === 0 || i > points[idx - 1][0])),
    JSON.stringify(points));
  check("chroma trim stays inside -100..100",
    JSON.stringify(averageChromaTrim(job.oklchCurve.stops)) !== "{}" &&
    averageChromaTrim(job.oklchCurve.stops).vibrance <= 100);

  // 2. The schema refuses a malformed payload before the engine exists.
  let schemaName = "";
  try { PsdBrandForgeJobSchema.parse({ ...job, jobId: "not-a-uuid" }); }
  catch (err) { schemaName = (err as Error).name; }
  check("malformed job refused by Zod", schemaName === "ZodError", schemaName);

  // 3. Retry policy: transient errors are retried, validation errors are not.
  let attempts = 0;
  await withRetry("flaky", async () => {
    attempts++;
    if (attempts < 2) throw new Error("socket timeout");
    return "ok";
  }, 2, 5);
  check("a transient failure is retried", attempts === 2, String(attempts));
  let fastFail = 0;
  try {
    await withRetry("bad", async () => { fastFail++; throw new Error("invalid parameters"); }, 3, 5);
  } catch { /* expected */ }
  check("a validation failure is not retried", fastFail === 1, String(fastFail));

  // 4. The job itself, against the real engine.
  const client = new PsdBrandForgeClient({ readRoot: scratch, writeRoot: scratch });
  await client.connect();
  let report;
  try {
    report = await runBrandForgeJob(job, client);
    const tree = await client.docInspect();
    const layers = (tree.layers as Array<Record<string, unknown>>) ?? [];

    check("seven layer ids were tracked", Object.values(report.layerIds).every((v) => Number.isInteger(v)),
      JSON.stringify(report.layerIds));
    check("the document holds eight layers", layers.length === 8, String(layers.length));
    check("seven layers carry the job tag above the canvas layer",
      layers.filter((l) => String(l.name).startsWith("3f2504e0")).length === 7,
      JSON.stringify(layers.map((l) => l.name)));
    check("four layers are clipped", layers.filter((l) => l.clipped === true).length === 4,
      String(layers.filter((l) => l.clipped === true).length));
    const curves = layers.find((l) => l.kind === "Adjustment" && String(l.name).includes("OkLCh")) as any;
    check("the curve layer holds Lab curve data",
      !!curves && curves.adjustment?.Curves?.space === "Lab" &&
      Array.isArray(curves.adjustment.Curves.per_channel), JSON.stringify(curves?.adjustment ?? null).slice(0, 120));
    const matte = layers.find((l) => String(l.name).includes("Frame Matte")) as any;
    check("the frame matte carries the selection mask", matte?.hasMask === true);
    const vignette = layers.find((l) => String(l.name).includes("Vignette")) as any;
    check("the vignette blends multiply at 65%", vignette?.blend === "Multiply" && Math.abs(vignette.opacity - 0.65) < 0.001,
      `${vignette?.blend} ${vignette?.opacity}`);
    check("no saved-artifact warnings", report.warnings.length === 0, JSON.stringify(report.warnings));
    check("vision QA is skipped without a key", report.visionVerdict === null);
  } finally {
    await client.close();
  }

  const psd = readFileSync(join(scratch, job.paths.psd));
  check("the PSD is a layered 8BPS file", psd.subarray(0, 4).toString("latin1") === "8BPS" && psd.length > 10_000, String(psd.length));
  check("the preview is a PNG", readFileSync(join(scratch, job.paths.preview!)).subarray(1, 4).toString("latin1") === "PNG");

  // 5. The JSON-line entry point answers one envelope per line.
  const child = spawn(process.execPath, ["--import", "tsx", "01_psd-brand-forge.ts"], {
    env: { ...process.env, PHOTOCRAFT_READ_ROOT: scratch, PHOTOCRAFT_WRITE_ROOT: scratch },
  });
  const out = await new Promise<string>((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (d) => { buf += d; });
    child.stderr.on("data", (d) => { buf += d; });
    child.on("error", reject);
    child.on("close", () => resolve(buf));
    child.stdin.end(JSON.stringify({ requestId: "r1", job: { ...job, paths: { psd: "cli.psd" } } }) + "\n");
    setTimeout(() => child.kill(), 30_000);
  });
  let envelope: any = null;
  try { envelope = JSON.parse(out.trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? "null"); } catch { /* handled below */ }
  check("the CLI answers with a report", envelope?.ok === true && envelope?.requestId === "r1",
    out.slice(0, 200));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + failures.length} checks passed`);
if (failures.length) process.exit(1);
