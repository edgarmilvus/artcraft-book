/**
 * Acceptance harness for Chapter 6 Exercise 2.
 *
 * The same spec is graded twice from the same source photo: the two preview
 * hashes must match, which is the reproducibility claim the exercise makes.
 * The source photo, both renders, the graded PSDs and a JSON report stay under
 * ../output/ so the run can be inspected after the fact.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  gradePhoto,
  translateChroma,
  translateContrast,
  translateLightness,
  undoAppliedPrefix,
} from "./src/oklch.js";

const HERE = import.meta.dirname;
const OUT = join(HERE, "..", "output");
const WORK = join(OUT, "workspace");
const READ = join(WORK, "read");
const PREVIEWS = join(OUT, "previews");
const GRADED = join(OUT, "graded");

for (const directory of [WORK, PREVIEWS, GRADED]) {
  rmSync(directory, { recursive: true, force: true });
}
mkdirSync(READ, { recursive: true });
mkdirSync(PREVIEWS, { recursive: true });
mkdirSync(GRADED, { recursive: true });

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

const photo = join(READ, "photo.png");
// A real gradient photo, not a flat swatch: the grade has to be visible in
// the preview and every run has to reach the same pixels.
execFileSync("photocraft-cli", [
  "run", "--new", '{"width":320,"height":240,"background":"#808080"}',
  "--cmd", "layer.newFillLayer.gradient",
  "--params", '{"from":"#101010","to":"#f0f0f0","angle":90,"style":"linear"}',
  "--out", photo,
], { stdio: "ignore" });

const spec = {
  photoId: "essay-014",
  lightnessOffset: 0.05,
  contrastPivot: 0.45,
  contrastAmount: 0.6,
  chromaGain: 1.15,
  coolHighlights: true,
  warmShadows: true,
  schemaVersion: 1 as const,
};

const base = { readRoot: READ, writeRoot: GRADED, photoPath: "photo.png" };

const first = await gradePhoto(spec, {
  ...base,
  previewPath: join(PREVIEWS, "pass-1.png"),
  savePath: join(GRADED, "graded-1.psd"),
});
const second = await gradePhoto(spec, {
  ...base,
  previewPath: join(PREVIEWS, "pass-2.png"),
  savePath: join(GRADED, "graded-2.psd"),
});

check("two runs render the same bytes", first.sha256 === second.sha256,
  `${first.sha256.slice(0, 12)} vs ${second.sha256.slice(0, 12)}`);
check("the report carries the applied gamma",
  Math.abs(first.report.levels.gamma - Math.pow(2, -0.2)) < 1e-9);
check("nothing was clamped inside the schema's range",
  !first.report.levels.clamped && !first.report.curves.clamped && !first.report.saturation.clamped);
check("the curve passes through the pivot unchanged",
  first.report.curves.points.some(([i, o]) => Math.abs(i - o) < 1e-9 && i > 0 && i < 255));
check("the curve has five anchors",
  first.report.curves.points.length === 5, String(first.report.curves.points.length));
check("the document reports one base layer plus four adjustments",
  first.report.document.layers === 5, JSON.stringify(first.report.document));
check("both colour-balance intents ride on one layer",
  JSON.stringify(first.report.colorBalance) === '{"highlights":[0,0,8],"shadows":[0,0,-8]}',
  JSON.stringify(first.report.colorBalance));
check("the unsupported list is non-empty", first.report.unsupported.length === 2);

// Without the two booleans there is no colour-balance layer at all.
const plain = await gradePhoto({ ...spec, coolHighlights: false, warmShadows: false }, {
  ...base,
  previewPath: join(PREVIEWS, "plain.png"),
  savePath: join(GRADED, "plain.psd"),
});
check("no colour work means no colour-balance layer",
  plain.report.document.layers === 4 && !plain.report.colorBalance.highlights,
  JSON.stringify(plain.report.document));

// The clamps are guards for callers that bypass the schema.
check("gamma clamps at the engine floor",
  translateLightness(2).clamped && translateLightness(2).params.gamma === 0.01);
check("saturation clamps at +100",
  translateChroma(3).clamped && translateChroma(3).saturation === 100);
check("a brutal S-curve reports its clamp", translateContrast(0.7, 1).clamped,
  JSON.stringify(translateContrast(0.7, 1).points));

let schemaName = "";
try { await gradePhoto({ ...spec, contrastPivot: 0.9 }, base); }
catch (err) { schemaName = (err as Error).name; }
check("a pivot outside the contract never reaches the engine",
  schemaName === "ZodError", schemaName);

// A batch that fails midway is compensated, not left half-applied.
{
  const client = new Client({ name: "grade-compensation", version: "1" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: "photocraft-cli",
    args: ["mcp", "--automation-read-root", READ, "--automation-write-root", GRADED],
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
    await call("doc_open", { path: "photo.png" });
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

// Keep the tree of the graded document next to the PSDs.
const tree = execFileSync("photocraft-cli", [
  "info", join(GRADED, "graded-1.psd"), "--compact",
], { encoding: "utf8" });
writeFileSync(join(GRADED, "inspect.json"), tree + "\n");

const assets = [
  "graded/graded-1.psd", "graded/graded-2.psd", "graded/plain.psd",
  "previews/pass-1.png", "previews/pass-2.png", "previews/plain.png",
].map((rel) => {
  const file = join(OUT, rel);
  return { file: rel, bytes: readFileSync(file).length, sha256: sha256(file) };
});

// Sanity: both graded PSDs and both previews are byte-identical.
check("the two saved PSDs are byte-identical",
  sha256(join(GRADED, "graded-1.psd")) === sha256(join(GRADED, "graded-2.psd")));

writeFileSync(join(OUT, "report.json"), JSON.stringify({
  chapter: 6,
  exercise: 2,
  checks: { passed: pass, failed: failures.length, total: pass + failures.length },
  source: { file: "workspace/read/photo.png", bytes: readFileSync(photo).length, sha256: sha256(photo) },
  spec,
  reproducibleSha256: first.sha256,
  plainSha256: plain.sha256,
  grade: first.report,
  documentTree: JSON.parse(tree).layers?.map((layer: { name: string }) => layer.name),
  assets,
  failures,
}, null, 2) + "\n");

console.log(`\n${pass}/${pass + failures.length} checks passed`);
if (failures.length) process.exit(1);
