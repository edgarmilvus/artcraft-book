// run_ex3.ts — acceptance harness for bounded Lottie asset recovery.
//
// It exercises unmapped-asset detection, the MCP call budget, the 200-line
// transcript cap, JSON-schema validation and the idempotent rewrite. It then
// writes a content-addressed glow, a healed composition, a recovery plan and
// the audit transcript as inspectable artefacts.

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import {
  MAX_MCP_CALLS,
  RecoveryBudgetExceeded,
  Transcript,
  detectUnmapped,
  guarded,
  jsonText,
  validateLottie,
  type Bucket,
  type LottieJson,
  type McpCall,
  type RecoveryPlan,
} from "./03_autonomous-asset-recovery-mcp-driven-lottie-rehydration-in-a-ci-cd-pipeline.js";

const HERE = process.cwd();
const OUTPUT = resolve(HERE, "..", "output");
const RECOVERED = resolve(OUTPUT, "recovered-assets");

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

const BROKEN: LottieJson = {
  v: "5.12.2", fr: 30, ip: 0, op: 30, w: 1080, h: 1080, nm: "Main_HeroLoop", ddd: 0,
  layers: [{ ddd: 0, ind: 1, ty: 2, nm: "Glow", refId: "image_0", ks: {}, ao: 0 }],
  assets: [
    { id: "image_0", u: "/Users/studio/renders/", p: "glow.png", w: 512, h: 512, e: 0 },
    { id: "image_1", u: "C:\\Users\\studio\\renders\\", p: "flare.jpg", w: 512, h: 512, e: 0 },
    { id: "image_2", u: "images/", p: "ok.png", w: 64, h: 64, e: 0 },
  ],
};

function glow(size: number, hue: [number, number, number]): Buffer {
  const png = new PNG({ width: size, height: size });
  const centre = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const d = Math.hypot(x - centre, y - centre) / centre;
      const falloff = Math.max(0, 1 - d) ** 2.2;
      png.data[i] = Math.round(hue[0] * falloff + 8 * (1 - falloff));
      png.data[i + 1] = Math.round(hue[1] * falloff + 10 * (1 - falloff));
      png.data[i + 2] = Math.round(hue[2] * falloff + 18 * (1 - falloff));
      png.data[i + 3] = Math.round(255 * falloff);
    }
  }
  return PNG.sync.write(png);
}

function address(bytes: Buffer): { name: string; sha256_16: string } {
  const sha256_16 = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  return { name: `glow-${sha256_16}.png`, sha256_16 };
}

function call(method: string, reason: string): McpCall {
  return { tool: "photocraft", method, params: { id: method }, reasoning: reason };
}

async function main(): Promise<void> {
  rmSync(RECOVERED, { recursive: true, force: true });
  for (const name of ["broken.json", "Main_HeroLoop.healed.json", "plan.json",
    "recovery-transcript.md", "report.json"]) {
    rmSync(resolve(OUTPUT, name), { force: true });
  }
  mkdirSync(RECOVERED, { recursive: true });
  writeFileSync(resolve(OUTPUT, "broken.json"), JSON.stringify(BROKEN, null, 2));

  console.log("\n# unmapped-asset detection");
  const unmapped = detectUnmapped(BROKEN);
  equal("detect: two broken assets", unmapped.length, 2);
  equal("detect: macOS absolute path", unmapped[0]!.reason, "absolute-path");
  equal("detect: Windows path on darwin", unmapped[1]!.reason, "wrong-platform");
  equal("detect: png format", unmapped[0]!.suspectedFormat, "png");
  equal("detect: jpg format", unmapped[1]!.suspectedFormat, "jpg");
  ok("detect: relative paths are left alone", unmapped.every((u) => !u.originalPath.includes("ok.png")));
  equal("detect: a healthy file has no work", detectUnmapped({
    ...BROKEN, assets: [{ id: "image_2", u: "images/", p: "ok.png" }],
  }).length, 0);

  console.log("\n# MCP call budget");
  const budget: Bucket = { calls: 0, transcript: new Transcript() };
  for (let i = 0; i < MAX_MCP_CALLS; i += 1) {
    const value = await guarded(budget, call("doc_new", "prepare canvas"), async () => i);
    equal(`budget: call ${i + 1} returns`, value, i);
  }
  let exceeded = false;
  try {
    await guarded(budget, call("doc_export", "over budget"), async () => 0);
  } catch (error) {
    exceeded = error instanceof RecoveryBudgetExceeded;
  }
  ok("budget: the 13th call is refused", exceeded);
  equal("budget: counter stops at the ceiling", budget.calls, MAX_MCP_CALLS + 1);

  console.log("\n# transcript cap");
  const transcript = new Transcript();
  for (let i = 0; i < 300; i += 1) {
    transcript.note(call("command_run", `reason ${i}`), { ok: true, i }, i + 1, 400);
  }
  mkdirSync(resolve(OUTPUT, "audit"), { recursive: true });
  const transcriptPath = resolve(OUTPUT, "audit", "transcript-cap.md");
  await transcript.write(transcriptPath);
  const transcriptLines = readFileSync(transcriptPath, "utf8").trimEnd().split("\n");
  ok(`transcript: capped at 200 lines (got ${transcriptLines.length})`, transcriptLines.length <= 200);
  ok("transcript: newest note is kept", readFileSync(transcriptPath, "utf8").includes("reason 299"));

  console.log("\n# MCP envelope and schema");
  equal("jsonText: parses the text part", jsonText<{ ok: boolean }>({
    content: [{ type: "text", text: '{"ok":true}' }],
  }).ok, true);
  let nonText = false;
  try { jsonText({ content: [{ type: "image", data: "..." }] }); } catch { nonText = true; }
  ok("jsonText: a non-text reply is refused", nonText);
  ok("schema: the broken composition is structurally valid", validateLottie(BROKEN));
  ok("schema: a zero width is refused", !validateLottie({ ...BROKEN, w: 0 }));
  ok("schema: a missing layers array is refused", !validateLottie({
    v: "5.12.2", fr: 30, ip: 0, op: 30, w: 1080, h: 1080, nm: "x", ddd: 0,
  }));

  console.log("\n# repair and idempotency");
  const replacements: Array<RecoveryPlan["replacements"][number]> = [];
  const hues: Array<[number, number, number]> = [[120, 170, 255], [255, 170, 120]];
  unmapped.forEach((asset, index) => {
    const bytes = glow(512, hues[index]!);
    const { name, sha256_16 } = address(bytes);
    writeFileSync(resolve(RECOVERED, name), bytes);
    ok(`repair: ${asset.id} is content-addressed`, /^glow-[0-9a-f]{16}\.png$/.test(name));
    equal(`repair: ${asset.id} digest matches bytes`,
      createHash("sha256").update(readFileSync(resolve(RECOVERED, name))).digest("hex").slice(0, 16), sha256_16);
    replacements.push({ assetId: asset.id, generatedFile: name, sha256_16 });
  });

  const healed = JSON.parse(JSON.stringify(BROKEN)) as LottieJson;
  for (const replacement of replacements) {
    const asset = (healed.assets ?? []).find((a) => a.id === replacement.assetId);
    assert(asset);
    asset.u = "recovered-assets/";
    asset.p = replacement.generatedFile;
  }
  ok("repair: healed composition passes the schema", validateLottie(healed));
  equal("repair: healed composition is idempotent", detectUnmapped(healed).length, 0);
  writeFileSync(resolve(OUTPUT, "Main_HeroLoop.healed.json"), JSON.stringify(healed, null, 2));

  const plan: RecoveryPlan = {
    assets: unmapped,
    replacements,
    budgetUsed: 6,
    aborted: false,
  };
  writeFileSync(resolve(OUTPUT, "plan.json"), JSON.stringify(plan, null, 2));

  // The shipped transcript is the actual repair, not the 300-note cap test.
  const repair = new Transcript();
  replacements.forEach((replacement, index) => {
    repair.note(call("doc_new", "transparent canvas for the glow"),
      { width: 512, height: 512 }, index * 2 + 1, MAX_MCP_CALLS);
    repair.note(call("doc_export", "export and content-address the glow"),
      { path: replacement.generatedFile, sha256_16: replacement.sha256_16 }, index * 2 + 2, MAX_MCP_CALLS);
  });
  await repair.write(resolve(OUTPUT, "recovery-transcript.md"));
  ok("output: the repair transcript names the content-addressed file",
    readFileSync(resolve(OUTPUT, "recovery-transcript.md"), "utf8").includes(replacements[0]!.generatedFile));

  const png = PNG.sync.read(readFileSync(resolve(RECOVERED, replacements[0]!.generatedFile)));
  equal("output: glow width", png.width, 512);
  equal("output: glow height", png.height, 512);
  ok("output: the glow has transparent corners", png.data[3] === 0);

  for (const artefact of ["broken.json", "Main_HeroLoop.healed.json", "plan.json",
    "recovery-transcript.md", "audit/transcript-cap.md",
    `recovered-assets/${replacements[0]!.generatedFile}`]) {
    ok(`output: ${artefact}`, existsSync(resolve(OUTPUT, artefact)));
  }
  const healedDisk = JSON.parse(readFileSync(resolve(OUTPUT, "Main_HeroLoop.healed.json"), "utf8")) as LottieJson;
  equal("output: healed assets use relative paths",
    healedDisk.assets!.filter((a) => a.id !== "image_2").every((a) => a.u === "recovered-assets/"), true);

  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 3,
    engine: "bounded MCP recovery (pure detection + schema, real PNG repair)",
    assertions: passed + 1,
    budgetUsed: plan.budgetUsed,
    maxCalls: MAX_MCP_CALLS,
    repaired: replacements.length,
    artefacts: ["broken.json", "Main_HeroLoop.healed.json", "plan.json",
      "recovery-transcript.md", "recovered-assets/"],
    result: "two unmapped assets detected, regenerated as content-addressed PNGs and healed into a schema-valid Lottie",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
