/**
 * Acceptance harness for the Chapter 6 Supervisor/Executor capstone.
 *
 * One successful run (assertions, four requirements, a single doc_save), a
 * second run that must be byte-identical, and every failure path the contract
 * promises: an unresolved reference, an unknown step kind, a clip whose base is
 * not directly below, a failing assertion, and a missing font. Each failure must
 * roll the document back to the history depth it had before the order.
 *
 * The two composites, their inspection trees, the failure reports and a run
 * summary stay under ../output/.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  Engine, Executor, planBanner, runWorkOrder, validatePlan,
  type VerificationReport, type WorkOrder, type WorkOrderStep,
} from "./src/work-order.js";

const HERE = import.meta.dirname;
const OUT = join(HERE, "..", "output");
const RUNS = join(OUT, "composites");
const FAILURES = join(OUT, "failures");

for (const directory of [RUNS, FAILURES]) {
  rmSync(directory, { recursive: true, force: true });
}
mkdirSync(RUNS, { recursive: true });
mkdirSync(FAILURES, { recursive: true });

let pass = 0;
const failures: string[] = [];
const checks: { label: string; ok: boolean; detail?: string }[] = [];
function check(label: string, cond: boolean, detail = "") {
  checks.push({ label, ok: cond, detail });
  if (cond) { pass++; console.log(`PASS ${label}`); }
  else { failures.push(label); console.log(`FAIL ${label} ${detail}`); }
}

const BRIEF =
  "three-tier banner: ribbon behind a product clipped to a gradient, a sale " +
  "badge in front of the ribbon and behind the price, the price inside a " +
  "rounded scrim with a drop shadow, graded typography only";

interface Session { client: Client; engine: Engine; executor: Executor; }

async function session(): Promise<Session> {
  const client = new Client({ name: "work-order-harness", version: "1" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: "photocraft-cli",
    args: ["mcp", "--automation-read-root", OUT, "--automation-write-root", OUT],
  }));
  await client.callTool({
    name: "doc_new",
    arguments: { width: 1920, height: 1080, background: "white" },
  });
  const engine = new Engine(client);
  return { client, engine, executor: new Executor(engine) };
}

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function clone(order: WorkOrder): WorkOrder {
  return JSON.parse(JSON.stringify(order)) as WorkOrder;
}

async function expectRollback(
  label: string, report: VerificationReport, s: Session, expectedStatus: string,
  expected: number,
) {
  check(`${label}: status is ${expectedStatus}`, report.status === expectedStatus,
    JSON.stringify({ status: report.status, reason: report.reason, error: report.error }));
  check(`${label}: nothing was saved`, !report.outputPath, String(report.outputPath));
  check(`${label}: the document is back at its opening depth`,
    (await s.engine.depth()) === expected, String(await s.engine.depth()));
  check(`${label}: only the applied steps were undone`,
    report.rolledBack > 0, String(report.rolledBack));
}

function names(nodes: { name: string; children?: unknown[] }[]): string[] {
  return nodes.flatMap((n) => [n.name, ...names((n.children ?? []) as typeof nodes)]);
}

function persistReport(name: string, report: VerificationReport, extra: Record<string, unknown> = {}) {
  writeFileSync(join(FAILURES, `${name}.json`),
    JSON.stringify({ ...report, ...extra }, null, 2) + "\n");
}

const order = planBanner(BRIEF, 7);
check("the planned order passes validation", validatePlan(order).length === 0,
  validatePlan(order).join("; "));
const asserted = order.steps.filter((s) => s.kind === "assert").length;
check("the plan asserts every structural invariant", asserted >= 12, String(asserted));

const first = await session();
const report = await runWorkOrder(
  first.engine, order, join(RUNS, "run-a", "composite.psd"));

check("the work order completes", report.status === "ok",
  JSON.stringify({ status: report.status, reason: report.reason, error: report.error }));
check("every assertion passed",
  report.assertions.length === asserted && report.assertions.every((a) => a.passed),
  JSON.stringify(report.assertions.filter((a) => !a.passed)));
check("all four requirements are satisfied",
  Object.values(report.requirements).every(Boolean),
  JSON.stringify(report.requirements));
check("the run saved exactly one document",
  first.engine.commandLog.filter((id) => id === "doc_save").length === 1,
  String(first.engine.commandLog.filter((id) => id === "doc_save").length));
check("the save landed on composites/run-a/composite.psd",
  (report.outputPath ?? "").endsWith("composites/run-a/composite.psd"), String(report.outputPath));
check("the PSD exists and hashes",
  existsSync(join(RUNS, "run-a", "composite.psd"))
  && /^[0-9a-f]{64}$/.test(report.outputHash ?? ""),
  String(report.outputHash));
check("the successful report carries the applied command log",
  report.applied.length > 0
  && report.applied.every((step) => step.commands.length > 0),
  String(report.applied.length));

// The tree must be readable by the auditor: groups, not one flat layer.
const inspected = await first.engine.inspect();
const treeNames = names(inspected.layers);
check("the saved tree keeps the contract names",
  ["Product::Stack", "Product::Cutout", "Gradient::Product", "Sale",
    "Type::Stack", "Type::Headline", "Type::Price", "Type::Scrim", "Type::Grade"]
    .every((n) => treeNames.includes(n)),
  treeNames.join(", "));

writeFileSync(join(RUNS, "run-a", "inspect.json"),
  JSON.stringify(inspected, null, 2) + "\n");
writeFileSync(join(RUNS, "run-a", "report.json"),
  JSON.stringify(report, null, 2) + "\n");

// ---------------------------------------------------------------------------
// 2. Byte-identical re-run, in a separate session and output directory.
// ---------------------------------------------------------------------------
const second = await session();
const again = await runWorkOrder(
  second.engine, planBanner(BRIEF, 7), join(RUNS, "run-b", "composite.psd"));
check("the re-run also completes", again.status === "ok", String(again.error));
check("two runs are byte-identical",
  again.outputHash === report.outputHash,
  `${report.outputHash} vs ${again.outputHash}`);
writeFileSync(join(RUNS, "run-b", "report.json"),
  JSON.stringify(again, null, 2) + "\n");

// ---------------------------------------------------------------------------
// 3. Unresolved symbolic reference: impossible, and no command is issued.
// ---------------------------------------------------------------------------
{
  const broken = clone(order);
  broken.steps.splice(4, 0, {
    kind: "move", id: "ghost", target: "product-stack", position: "into",
  } as WorkOrderStep);
  const s = await session();
  const before = s.engine.commandLog.length;
  const out = await s.executor.execute(broken);
  check("an unresolved reference is impossible", out.status === "impossible"
    && (out.reason ?? "").includes("ghost"), String(out.reason));
  check("an impossible plan issues no command",
    s.engine.commandLog.length === before && out.rolledBack === 0,
    `${s.engine.commandLog.length - before} commands, ${out.rolledBack} undos`);
  check("the document was never touched", (await s.engine.depth()) === 1);
  persistReport("unresolved-reference", out);
  await s.client.close();
}

// ---------------------------------------------------------------------------
// 4. Unknown step kind: impossible before the engine is touched.
// ---------------------------------------------------------------------------
{
  const broken = clone(order);
  (broken.steps as unknown[]).push({
    kind: "apply-warp", id: "ribbon", mesh: [],
  });
  const s = await session();
  const out = await s.executor.execute(broken);
  check("an unknown step kind is impossible", out.status === "impossible"
    && (out.reason ?? "").includes("unknown kind"), String(out.reason));
  check("the dispatch table never ran", s.engine.commandLog.length === 0,
    s.engine.commandLog.join(","));
  persistReport("unknown-step", out);
  await s.client.close();
}

// ---------------------------------------------------------------------------
// 5. A clip whose base is not directly below: refused, then rolled back.
// ---------------------------------------------------------------------------
{
  const s = await session();
  const bad: WorkOrder = {
    brief: "clip with the wrong base", seed: 1,
    steps: [
      { kind: "create-layer", id: "a", name: "A" },
      { kind: "create-layer", id: "b", name: "B" },
      // A must be directly above B, but the document's Background sits below A.
      { kind: "create-clip", id: "a", clip: "a", to: "b" },
    ],
  };
  const out = await s.executor.execute(bad);
  check("a clip that would attach elsewhere is impossible",
    out.status === "impossible", `${out.status}: ${out.error ?? out.reason}`);
  check("the refusal names the positional rule",
    (out.reason ?? "").includes("directly above"), String(out.reason));
  await expectRollback("misplaced clip", out, s, "impossible", 1);
  check("the symbolic map survives the rollback", s.executor.layerId("a") !== undefined);
  persistReport("misplaced-clip", out);
  await s.client.close();
}

// ---------------------------------------------------------------------------
// 6. A failing assertion: failed, rolled back, nothing saved.
// ---------------------------------------------------------------------------
{
  const broken = clone(order);
  broken.steps.push({
    kind: "assert", id: "scrim",
    assert: { kind: "layer-name", name: "Type::NotTheScrim" },
  } as WorkOrderStep);
  const s = await session();
  const out = await s.executor.execute(broken);
  check("a failed assertion stops the order", out.status === "failed", String(out.status));
  check("the report quotes the mismatch",
    (out.error ?? "").includes("Type::NotTheScrim"), String(out.error));
  await expectRollback("failed assertion", out, s, "failed", 1);
  persistReport("failed-assertion", out);
  await s.client.close();
}

// ---------------------------------------------------------------------------
// 7. A missing font, detected from the type.create reply, not from inspect.
// ---------------------------------------------------------------------------
{
  const broken = clone(order);
  const step = broken.steps.find(
    (s) => s.kind === "create-type" && s.id === "price-text",
  ) as Extract<WorkOrderStep, { kind: "create-type" }>;
  step.font = "NoSuchFont123";
  const s = await session();
  const out = await s.executor.execute(broken);
  check("a substituted font is impossible", out.status === "impossible"
    && (out.reason ?? "").includes("NoSuchFont123"), String(out.reason));
  await expectRollback("missing font", out, s, "impossible", 1);
  persistReport("missing-font", out);
  await s.client.close();
}

await first.client.close();
await second.client.close();

const assets = ["run-a/composite.psd", "run-b/composite.psd"].map((rel) => {
  const file = join(RUNS, rel);
  return {
    file: `composites/${rel}`,
    bytes: statSync(file).size,
    sha256: hash(file),
  };
});

writeFileSync(join(OUT, "report.json"), JSON.stringify({
  chapter: 6,
  exercise: 5,
  checks: { passed: pass, failed: failures.length, total: pass + failures.length },
  brief: BRIEF,
  plan: {
    steps: order.steps.length,
    assertions: asserted,
    validation: validatePlan(order),
  },
  runs: {
    a: {
      status: report.status,
      sha256: report.outputHash,
      assertions: report.assertions.length,
      requirements: report.requirements,
      applied: report.applied.length,
    },
    b: {
      status: again.status,
      sha256: again.outputHash,
      assertions: again.assertions.length,
      requirements: again.requirements,
      applied: again.applied.length,
    },
  },
  tree: treeNames,
  assets,
  failures,
}, null, 2) + "\n");

console.log(`\n${pass}/${pass + failures.length} checks passed`);
if (failures.length) process.exit(1);
