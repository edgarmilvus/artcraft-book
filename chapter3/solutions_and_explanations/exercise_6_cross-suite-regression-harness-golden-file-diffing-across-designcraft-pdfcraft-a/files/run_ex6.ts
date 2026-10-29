// run_ex6.ts — acceptance harness for Chapter 3, Exercise 6.
//
// Runs the cross-suite golden-file harness against real DesignCraft, PdfCraft
// and WordCraft engines and exercises the failure paths: golden mismatch,
// tolerance windows, unknown commands, determinism, sharding, and the
// I_AM_SURE update guard.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const OUT = resolve(HERE, "..", "output");
const HARNESS = join(HERE, "03_harness.ts");
const TSX = resolve(REPO, "node_modules/.bin/tsx");
const TSC = resolve(REPO, "node_modules/.bin/tsc");
const CLIS = resolve(REPO, "tools/craft-cli/bin");

const checks: string[] = [];
const failures: string[] = [];
const quirks: string[] = [];
const lines: string[] = [];
const say = (line = ""): void => { lines.push(line); console.log(line); };
const check = (label: string, ok: boolean, detail = ""): void => {
  checks.push(label);
  if (!ok) failures.push(label);
  say(`${ok ? " ok " : "FAIL"} ${label.padEnd(62)}${detail}`);
};
const equal = (label: string, actual: unknown, expected: unknown): void =>
  check(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const readJson = (file: string): any => JSON.parse(readFileSync(file, "utf8")) as any;
const writeJson = (file: string, value: unknown): void =>
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
const sha = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const exists = (file: string): boolean => existsSync(file);
const copyTree = (src: string, dst: string): void => {
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true });
};

type HarnessRun = { status: number | null; stdout: string; stderr: string };
const runHarness = (
  fixturesDir: string, outDir: string, extra: readonly string[] = [],
  env: Readonly<Record<string, string>> = {},
): HarnessRun => {
  const r = spawnSync(TSX, [
    HARNESS, "--fixtures-dir", fixturesDir, "--out-dir", outDir, ...extra,
  ], {
    cwd: OUT, encoding: "utf8", timeout: 900_000,
    env: { ...process.env, PATH: `${CLIS}:${process.env.PATH ?? ""}`, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const summaryOf = (run: HarnessRun): any => {
  const last = run.stdout.trim().split("\n").filter((l) => l.trim().length > 0).pop() ?? "{}";
  try { return JSON.parse(last); } catch { return {}; }
};

const mutateWordText = (goldenFile: string, text: string): void => {
  const golden = readJson(goldenFile);
  golden.wordcraft.blocks[0].text = text;
  writeJson(goldenFile, golden);
};
const mutateRenderPixel = (goldenFile: string): void => {
  const golden = readJson(goldenFile);
  const page = golden.pdfcraft.perPage[0];
  const png = PNG.sync.read(Buffer.from(page.renderPngBase64, "base64"));
  png.data[0] = (png.data[0] ?? 0) ^ 1;
  const bytes = PNG.sync.write(png);
  page.renderPngBase64 = bytes.toString("base64");
  page.renderSha256 = createHash("sha256").update(bytes).digest("hex");
  writeJson(goldenFile, golden);
};

try {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  copyTree(join(HERE, "fixtures"), join(OUT, "fixtures"));
  copyTree(join(HERE, "negative-fixtures"), join(OUT, "negative-fixtures"));

  say("── positive cross-suite run ───────────────────────────────────────────");
  const positive = runHarness("fixtures", "artifacts");
  say(positive.stdout.trim());
  if (positive.stderr.trim().length > 0) say(positive.stderr.trim());
  equal("positive harness exits 0", positive.status, 0);
  const positiveSummary = summaryOf(positive);
  equal("positive run covers five fixtures", positiveSummary.fixtures, 5);
  equal("positive run has no mismatch", positiveSummary.mismatched, false);
  equal("positive run is deterministic", positiveSummary.nondeterministic, false);
  check("no diff directory is written", !exists(join(OUT, "artifacts", "diffs")));

  const fixtureIds = readdirSync(join(OUT, "fixtures")).sort();
  equal("fixture directories", fixtureIds.length, 5);
  for (const id of fixtureIds) {
    check(`${id} has a golden file`, exists(join(OUT, "fixtures", id, "golden.json")));
  }

  const cover = readJson(join(OUT, "fixtures", "designcraft-cover", "golden.json"));
  equal("DesignCraft golden page count", cover.designcraft.pages, 1);
  equal("DesignCraft golden cancels PdfCraft", cover.pdfcraft, null);
  check("DesignCraft golden records styles", Array.isArray(cover.designcraft.styles) && cover.designcraft.styles.length >= 2);

  const note = readJson(join(OUT, "fixtures", "wordcraft-note", "golden.json"));
  check("WordCraft golden keeps block text", String(note.wordcraft.blocks[0].text).includes("Golden note"));
  check("WordCraft golden records block kind", note.wordcraft.blocks[0].kind === "paragraph");
  check("WordCraft golden records the style chain", JSON.stringify(note.wordcraft.blocks[0].styleChain).includes("Normal"));

  const page = readJson(join(OUT, "fixtures", "cover-page", "golden.json"));
  check("PdfCraft golden extracts the page text", String(page.pdfcraft.perPage[0].text).includes("Quarterly"));
  equal("PdfCraft golden page count", page.pdfcraft.pages, 1);
  equal("PdfCraft render hash is sha256", String(page.pdfcraft.perPage[0].renderSha256).length, 64);
  const rendered = PNG.sync.read(Buffer.from(page.pdfcraft.perPage[0].renderPngBase64, "base64"));
  check("PdfCraft golden stores a decodable PNG", rendered.width > 0 && rendered.height > 0);
  check("PdfCraft metadata is canonical",
    typeof page.pdfcraft.metadata.producer === "string" && !("created" in page.pdfcraft.metadata));

  const cross = readJson(join(OUT, "fixtures", "cross-suite", "golden.json"));
  check("cross-suite golden spans DesignCraft", cross.designcraft !== null);
  check("cross-suite golden spans PdfCraft", cross.pdfcraft !== null);
  check("cross-suite golden spans WordCraft", cross.wordcraft !== null);

  const goldenBefore = sha(join(OUT, "fixtures", "cross-suite", "golden.json"));
  const second = runHarness("fixtures", "artifacts");
  equal("second clean run exits 0", second.status, 0);
  equal("clean run does not rewrite the golden", sha(join(OUT, "fixtures", "cross-suite", "golden.json")), goldenBefore);

  say("");
  say("── golden mismatch and tolerance ──────────────────────────────────────");
  copyTree(join(HERE, "fixtures", "wordcraft-note"), join(OUT, "mismatch-fixtures", "wordcraft-note"));
  mutateWordText(join(OUT, "mismatch-fixtures", "wordcraft-note", "golden.json"),
    "Golden noteX for the cross-suite harness.");
  const mismatchPlan = readJson(join(OUT, "mismatch-fixtures", "wordcraft-note", "plan.json"));
  mismatchPlan.tolerance.textDamerauLevenshtein = 0;
  writeJson(join(OUT, "mismatch-fixtures", "wordcraft-note", "plan.json"), mismatchPlan);
  const mismatch = runHarness("mismatch-fixtures", "artifacts-mismatch");
  equal("a changed golden fails the run", mismatch.status, 1);
  equal("mismatch summary reports the failure", summaryOf(mismatch).mismatched, true);
  check("mismatch writes diff.json", exists(join(OUT, "artifacts-mismatch", "diffs", "wordcraft-note", "diff.json")));
  check("mismatch writes summary.md", exists(join(OUT, "artifacts-mismatch", "diffs", "wordcraft-note", "summary.md")));
  const mismatchText = readFileSync(join(OUT, "artifacts-mismatch", "diffs", "wordcraft-note", "summary.md"), "utf8");
  check("summary names the text delta", mismatchText.includes("textDistance") && mismatchText.includes("Golden noteX"));

  copyTree(join(HERE, "fixtures", "wordcraft-note"), join(OUT, "tolerance-fixtures", "wordcraft-note"));
  mutateWordText(join(OUT, "tolerance-fixtures", "wordcraft-note", "golden.json"),
    "Golden noteX for the cross-suite harness.");
  const tolerancePlan = readJson(join(OUT, "tolerance-fixtures", "wordcraft-note", "plan.json"));
  tolerancePlan.tolerance.textDamerauLevenshtein = 1;
  writeJson(join(OUT, "tolerance-fixtures", "wordcraft-note", "plan.json"), tolerancePlan);
  const tolerated = runHarness("tolerance-fixtures", "artifacts-tolerance");
  equal("one-character text tolerance passes", tolerated.status, 0);
  equal("tolerated run reports no mismatch", summaryOf(tolerated).mismatched, false);

  copyTree(join(HERE, "fixtures", "cover-page"), join(OUT, "render-fixtures", "cover-page"));
  mutateRenderPixel(join(OUT, "render-fixtures", "cover-page", "golden.json"));
  const renderPlan = readJson(join(OUT, "render-fixtures", "cover-page", "plan.json"));
  renderPlan.tolerance.renderPixelLevenshtein = 1;
  writeJson(join(OUT, "render-fixtures", "cover-page", "plan.json"), renderPlan);
  const renderTolerated = runHarness("render-fixtures", "artifacts-render");
  equal("one-pixel render tolerance passes", renderTolerated.status, 0);

  const renderStrict = readJson(join(OUT, "render-fixtures", "cover-page", "plan.json"));
  renderStrict.tolerance.renderPixelLevenshtein = 0;
  writeJson(join(OUT, "render-fixtures", "cover-page", "plan.json"), renderStrict);
  const renderFailed = runHarness("render-fixtures", "artifacts-render-strict");
  equal("render mismatch beyond tolerance fails", renderFailed.status, 1);
  const renderSummary = readFileSync(join(OUT, "artifacts-render-strict", "diffs", "cover-page", "summary.md"), "utf8");
  check("summary names the render delta", renderSummary.includes("renderPixelDistance"));

  say("");
  say("── unknown command precedence ─────────────────────────────────────────");
  const unknown = runHarness("negative-fixtures", "artifacts-unknown");
  equal("unknown command exits 1", unknown.status, 1);
  check("unknown command writes error.txt", exists(join(OUT, "artifacts-unknown", "diffs", "unknown-command", "error.txt")));
  const unknownError = readFileSync(join(OUT, "artifacts-unknown", "diffs", "unknown-command", "error.txt"), "utf8");
  check("error names the unknown command", unknownError.includes("type.charZZZ"));
  check("error reports nearest live ids", unknownError.includes("Nearest live ids") && unknownError.includes("type.char"));

  say("");
  say("── update guard and sharding ──────────────────────────────────────────");
  const guarded = runHarness("fixtures", "artifacts-guard", ["--update-golden"], { I_AM_SURE: "" });
  equal("update without I_AM_SURE exits 1", guarded.status, 1);
  check("update guard names I_AM_SURE", guarded.stderr.includes("I_AM_SURE"));

  const wordGolden = join(OUT, "fixtures", "wordcraft-note", "golden.json");
  mutateWordText(wordGolden, "MUTATED");
  const updated = runHarness("fixtures", "artifacts-update", ["--update-golden"], { I_AM_SURE: "1" });
  equal("guarded update exits 0", updated.status, 0);
  const rewritten = readJson(wordGolden);
  check("guarded update rewrites the golden", !String(rewritten.wordcraft.blocks[0].text).includes("MUTATED"));

  const shard0 = runHarness("fixtures", "artifacts-shard0", ["--shard", "0/2"]);
  const shard1 = runHarness("fixtures", "artifacts-shard1", ["--shard", "1/2"]);
  equal("first shard exits 0", shard0.status, 0);
  equal("second shard exits 0", shard1.status, 0);
  const s0 = summaryOf(shard0).fixtures as number;
  const s1 = summaryOf(shard1).fixtures as number;
  equal("shards cover every fixture", s0 + s1, 5);
  check("shards split the suite", s0 === 3 && s1 === 2);

  say("");
  say("── static contracts ───────────────────────────────────────────────────");
  const harness = readFileSync(join(HERE, "03_harness.ts"), "utf8");
  check("harness implements Damerau-Levenshtein", harness.includes("function damerauLev"));
  check("harness compares rendered pixels", harness.includes("function pngPixelDistance"));
  check("harness refreshes the live registry", harness.includes("discoverCommands()"));
  check("harness honors a disabled command", harness.includes("live.enabled === false"));
  check("harness has a determinism exit code", harness.includes("return 2"));
  check("harness has a shard parser", harness.includes("--shard"));
  check("harness guards golden updates", harness.includes("I_AM_SURE"));
  check("harness resolves the MCP SDK", harness.includes("@modelcontextprotocol/sdk"));
  check("harness uses pngjs for pixel diffs", harness.includes("from \"pngjs\""));

  const planContract = readJson(join(HERE, "01_json.json"));
  check("plan contract carries tolerance", typeof planContract.tolerance?.textDamerauLevenshtein === "number");

  // A non-zero tolerance is a promise; it has to be argued for in the fixture.
  for (const id of fixtureIds) {
    const fixturePlan = readJson(join(OUT, "fixtures", id, "plan.json"));
    const tol = fixturePlan.tolerance as { textDamerauLevenshtein: number; renderPixelLevenshtein: number };
    const strict = tol.textDamerauLevenshtein === 0 && tol.renderPixelLevenshtein === 0;
    if (!strict) {
      check(`${id} justifies its tolerance`,
        exists(join(OUT, "fixtures", id, "JUSTIFICATION.md")));
    }
  }
  const types = readFileSync(join(HERE, "02_typescript.ts"), "utf8");
  check("type contract exposes PlanStep", types.includes("export interface PlanStep"));
  check("type contract exposes DriverResult", types.includes("export interface DriverResult"));
  const yaml = readFileSync(join(HERE, "04_yaml.yaml"), "utf8");
  check("CI runs a shard", yaml.includes("--shard \"$SHARD/$TOTAL\""));
  const verifyBlock = yaml.split("update-goldens:")[0] ?? "";
  check("CI keeps the shard matrix out of the resource group",
    !verifyBlock.includes("resource_group"));
  check("CI serialises golden updates in their own job",
    yaml.includes("update-goldens:") &&
    /update-goldens:[\s\S]*resource_group: golden-updates-/.test(yaml));
  check("CI collects diff artefacts", yaml.includes("artifacts/diffs/"));
  check("CI keeps diffs on failure", yaml.includes("when: on_failure"));
  const block = readFileSync(join(HERE, "05_block.txt"), "utf8");
  check("sample block lists the nearest live ids", block.includes("Nearest live ids"));

  const compile = spawnSync(TSC, ["--noEmit", "-p", "tsconfig.json"], {
    cwd: HERE, encoding: "utf8", timeout: 120_000,
  });
  equal("harness and acceptance code typecheck", compile.status, 0);
  if (compile.status !== 0) say((compile.stdout ?? "") + (compile.stderr ?? ""));

  quirks.push("WordCraft's list_commands omits the enabled flag; the harness treats a missing flag as enabled");
  quirks.push("PdfCraft render PNG bytes are compared with pngjs only when the sha256 hashes differ");
  quirks.push("goldens keep canonical text and one 150-dpi render per PDF page");

  const result = {
    checks: checks.length,
    failures,
    quirks,
    fixtures: fixtureIds,
    goldens: fixtureIds.map((id) => join("fixtures", id, "golden.json")),
  };
  writeFileSync(join(OUT, "run-log.json"), JSON.stringify(result, null, 2) + "\n");
  say("");
  say(`${checks.length} checks, ${failures.length} failing; artefacts in ${OUT}`);
} catch (error) {
  say(`FAIL harness crashed: ${error instanceof Error ? error.stack : String(error)}`);
  writeFileSync(join(OUT, "run-log.json"), JSON.stringify({ checks: checks.length, failures, crash: String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  writeFileSync(join(OUT, "run_ex6.log"), lines.join("\n") + "\n");
}
if (failures.length > 0) process.exitCode = 1;
