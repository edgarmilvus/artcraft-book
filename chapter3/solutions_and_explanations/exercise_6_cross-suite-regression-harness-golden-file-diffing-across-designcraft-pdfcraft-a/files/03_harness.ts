// harness.ts — Cross-suite golden-file regression harness.
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ---------- Plan contract ----------
interface PlanStep {
  readonly cli: "designcraft" | "pdfcraft" | "wordcraft";
  readonly command: string;
  readonly params: Readonly<Record<string, unknown>>;
}
interface Plan {
  readonly fixtureId: string;
  readonly tolerance: { readonly textDamerauLevenshtein: number; readonly renderPixelLevenshtein: number };
  readonly steps: readonly PlanStep[];
}
interface DriverResult {
  readonly ok: boolean;
  readonly commandId: string;
  readonly cli: "designcraft" | "pdfcraft" | "wordcraft";
  readonly stdout: string;
  readonly resultJson: unknown;
  readonly durationMs: number;
  readonly enabledAtRuntime: boolean;
}

// ---------- Driver ----------
interface LiveCommand { readonly id: string; readonly enabled: boolean; readonly [k: string]: unknown; }

class McpDriver {
  private client: Client | null = null;
  private liveCommands: Map<string, LiveCommand> | null = null;
  private toolNames = new Set<string>();

  constructor(private readonly cli: "designcraft" | "pdfcraft" | "wordcraft") {}

  async start(roots: readonly string[]): Promise<void> {
    const binary = `${this.cli}-cli`;
    const root = roots[0] ?? process.cwd();
    // Per-suite launch contract: PdfCraft takes `--root`, the other two take
    // no sandbox flags and resolve relative paths against cwd.
    const args = this.cli === "pdfcraft" ? ["mcp", "--root", root] : ["mcp"];
    const transport = new StdioClientTransport({
      command: binary, args, cwd: root, stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    const client = new Client({ name: "golden-harness", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    this.client = client;

    const tools = await client.listTools();
    this.toolNames = new Set(tools.tools.map((t) => t.name));
    // GROUND TRUTH PRECEDENCE: query the live registry before executing anything.
    this.liveCommands = await this.discoverCommands();
  }

  private async discoverCommands(): Promise<Map<string, LiveCommand>> {
    const tool = this.cli === "pdfcraft" ? "command_list" : "list_commands";
    if (!this.toolNames.has(tool) || this.client === null) return new Map();
    const payload = unwrap(await this.client.callTool({ name: tool, arguments: {} }));
    const list = Array.isArray(payload)
      ? (payload as LiveCommand[])
      : ((payload as { commands?: LiveCommand[] }).commands ?? []);
    const map = new Map<string, LiveCommand>();
    for (const c of list) if (typeof c.id === "string") map.set(c.id, { ...c, enabled: c.enabled !== false });
    return map;
  }

  async run(step: PlanStep): Promise<DriverResult> {
    const t0 = Date.now();
    if (this.client === null) throw new Error("driver not started");

    let result: unknown;
    if (this.cli === "pdfcraft") {
      // PdfCraft exposes its operations as *tools*, not registry ids.
      if (!this.toolNames.has(step.command)) {
        throw new Error(`Plan step references unknown pdfcraft tool '${step.command}'.`);
      }
      result = unwrap(await this.client.callTool({ name: step.command, arguments: step.params }));
    } else {
      let live = this.liveCommands?.get(step.command);
      // Commands that need a document or a selection start disabled and become
      // enabled after earlier steps mutate the document. Refresh the registry
      // at the point of use, not only once at process start.
      if (live === undefined || live.enabled === false) {
        this.liveCommands = await this.discoverCommands();
        live = this.liveCommands.get(step.command);
      }
      if (live !== undefined) {
        if (!live.enabled) {
          throw new Error(`Command '${step.command}' is present but disabled at runtime on '${this.cli}'.`);
        }
        result = unwrap(await this.client.callTool({
          name: "execute", arguments: { command: step.command, params: step.params },
        }));
      } else if (this.toolNames.has(step.command)) {
        // Meta-tools (inspect_document, …) are not registry commands: they are
        // called directly, which is exactly the distinction the plan ignores.
        result = unwrap(await this.client.callTool({ name: step.command, arguments: step.params }));
      } else {
        const near = [...(this.liveCommands?.keys() ?? [])]
          .filter((id) => id.startsWith(step.command.split(".")[0] ?? ""))
          .slice(0, 12);
        throw new Error(
          `Plan step references unknown command '${step.command}' on cli '${this.cli}'.\n` +
          `Nearest live ids: ${JSON.stringify(near)}`,
        );
      }
    }

    return {
      ok: true,
      commandId: step.command,
      cli: this.cli,
      stdout: JSON.stringify(result),
      resultJson: result,
      durationMs: Date.now() - t0,
      enabledAtRuntime: true,
    };
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => undefined);
  }
}

/** Unwrap a tool reply: JSON text payload, or `{pngBase64}` for image blocks. */
function unwrap(res: unknown): unknown {
  const r = res as { content?: unknown; isError?: boolean };
  const blocks = (r.content as Array<{ type: string; text?: string; data?: string }> | undefined) ?? [];
  const text = blocks.find((b) => b.type === "text")?.text;
  const image = blocks.find((b) => b.type === "image");
  if (r.isError === true) throw new Error(`tool failed: ${text ?? ""}`);
  if (text !== undefined) {
    try { return JSON.parse(text) as unknown; } catch { return text; }
  }
  if (image?.data !== undefined) return { pngBase64: image.data };
  return {};
}

// ---------- Canonicalization ----------
function sha256(b: Uint8Array | string): string {
  return createHash("sha256").update(b).digest("hex");
}

interface CanonicalPdfPage {
  readonly text: string;
  readonly renderPngBase64: string;
  readonly renderSha256: string;
  readonly rects: number;
}
interface CanonicalPdf {
  readonly pages: number;
  readonly perPage: readonly CanonicalPdfPage[];
  readonly metadata: Record<string, string | number | boolean>;
}

async function canonicalizePdf(pdfPath: string, driver: McpDriver): Promise<CanonicalPdf> {
  const opened = await driver.run({
    cli: "pdfcraft", command: "doc_open", params: { path: pdfPath },
  });
  const doc = (opened.resultJson as { doc?: number }).doc ?? 1;

  const info = await driver.run({ cli: "pdfcraft", command: "doc_info", params: { doc } });
  const ij = info.resultJson as {
    pages?: readonly unknown[];
    title?: string | null; author?: string | null; creator?: string | null;
    producer?: string | null; pdf_version?: string | null; tagged?: boolean;
    fonts?: readonly { name?: string }[];
  };
  const pages = Array.isArray(ij.pages) ? ij.pages.length : 0;

  const perPage: CanonicalPdfPage[] = [];
  for (let p = 1; p <= pages; p++) {
    const extracted = await driver.run({
      cli: "pdfcraft", command: "text_extract", params: { doc, pages: [p] },
    });
    const batches = (extracted.resultJson as { pages?: readonly { page?: number; text?: string }[] }).pages ?? [];
    const pageText = batches.find((b) => b.page === p)?.text ?? batches[0]?.text ?? "";
    const rects = pageText.split("\n").filter((line) => line.trim().length > 0).length;

    const render = await driver.run({
      cli: "pdfcraft", command: "page_render", params: { doc, page: p, dpi: 150 },
    });
    const pngBase64 = (render.resultJson as { pngBase64?: string }).pngBase64 ?? "";
    const pngBytes = Buffer.from(pngBase64, "base64");
    perPage.push({
      text: pageText,
      renderPngBase64: pngBase64,
      renderSha256: sha256(pngBytes),
      rects,
    });
  }

  // Canonical metadata: keep stable identity fields, drop volatile timestamps
  // and producer build strings.
  const metadata: Record<string, string | number | boolean> = {
    title: ij.title ?? "",
    author: ij.author ?? "",
    creator: ij.creator ?? "",
    producer: ij.producer ?? "",
    pdfVersion: ij.pdf_version ?? "",
    tagged: ij.tagged === true,
    fonts: (ij.fonts ?? []).map((f) => f.name ?? "").sort().join(","),
  };
  return { pages, perPage, metadata };
}

interface CanonicalDesignCraft {
  readonly pages: number;
  readonly spreads: number;
  readonly stories: number;
  readonly styles: readonly string[];
  readonly swatches: readonly string[];
}
async function canonicalizeDesignCraft(driver: McpDriver): Promise<CanonicalDesignCraft> {
  const doc = await driver.run({ cli: "designcraft", command: "inspect_document", params: {} });
  const dj = doc.resultJson as {
    pageCount?: number; spreads?: readonly unknown[]; stories?: readonly unknown[];
    paragraphStyles?: readonly string[]; characterStyles?: readonly string[];
    swatches?: readonly string[];
  };
  const styles = [...(dj.paragraphStyles ?? []), ...(dj.characterStyles ?? [])].sort();
  const swatches = [...(dj.swatches ?? [])].sort();
  return {
    pages: dj.pageCount ?? 0,
    spreads: dj.spreads?.length ?? 0,
    stories: dj.stories?.length ?? 0,
    styles, swatches,
  };
}

interface CanonicalWordCraft {
  readonly blocks: readonly { readonly kind: string; readonly text: string; readonly styleChain: readonly string[] }[];
  readonly styles: readonly string[];
}
async function canonicalizeWordCraft(driver: McpDriver): Promise<CanonicalWordCraft> {
  const doc = await driver.run({ cli: "wordcraft", command: "inspect_document", params: {} });
  const wj = doc.resultJson as {
    blocks?: readonly { type?: string; text?: string; style?: string }[];
  };
  let styles: string[] = [];
  try {
    const listed = await driver.run({ cli: "wordcraft", command: "styles.list", params: {} });
    const raw = listed.resultJson as Array<{ id?: string; name?: string }>;
    styles = (Array.isArray(raw) ? raw : []).map((s) => s.name ?? s.id ?? "").filter((s) => s.length > 0).sort();
  } catch {
    styles = [];
  }
  const blocks = (wj.blocks ?? []).map((b) => ({
    kind: b.type ?? "paragraph",
    text: b.text ?? "",
    styleChain: [b.style ?? "Normal"],
  }));
  return { blocks, styles };
}

// ---------- Diffing ----------
interface DiffReport {
  readonly fixtureId: string;
  readonly kind: "designcraft" | "pdfcraft" | "wordcraft";
  readonly total: number;
  readonly matched: number;
  readonly deltas: readonly { readonly field: string; readonly expected: unknown; readonly actual: unknown }[];
}

/** True Damerau-Levenshtein distance (insert, delete, substitute, transpose). */
function damerauLev(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) d[i]![0] = i;
  for (let j = 0; j < cols; j++) d[0]![j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + cost);
      }
    }
  }
  return d[a.length]![b.length]!;
}

function pngPixelDistance(aBase64: string, bBase64: string): number {
  try {
    const a = PNG.sync.read(Buffer.from(aBase64, "base64"));
    const b = PNG.sync.read(Buffer.from(bBase64, "base64"));
    if (a.width !== b.width || a.height !== b.height) return Number.POSITIVE_INFINITY;
    let differing = 0;
    const n = Math.min(a.data.length, b.data.length);
    for (let i = 0; i < n; i++) if (a.data[i] !== b.data[i]) differing += 1;
    return differing + Math.abs(a.data.length - b.data.length);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function comparePdf(expected: CanonicalPdf, actual: CanonicalPdf, plan: Plan): DiffReport {
  const deltas: DiffReport["deltas"][number][] = [];
  let total = 2;
  let matched = 0;
  if (expected.pages === actual.pages) matched += 1;
  else deltas.push({ field: "pages", expected: expected.pages, actual: actual.pages });
  if (JSON.stringify(expected.metadata) === JSON.stringify(actual.metadata)) matched += 1;
  else deltas.push({ field: "metadata", expected: expected.metadata, actual: actual.metadata });

  const pageCount = Math.max(expected.perPage.length, actual.perPage.length);
  for (let i = 0; i < pageCount; i++) {
    const e = expected.perPage[i];
    const a = actual.perPage[i];
    total += 3;
    if (e === undefined || a === undefined) {
      deltas.push({ field: `perPage[${i}]`, expected: e ?? null, actual: a ?? null });
      continue;
    }
    const textDistance = damerauLev(e.text, a.text);
    if (textDistance <= plan.tolerance.textDamerauLevenshtein) matched += 1;
    else deltas.push({ field: `perPage[${i}].textDistance`, expected: e.text, actual: a.text });
    const renderDistance = e.renderSha256 === a.renderSha256 ? 0 : pngPixelDistance(e.renderPngBase64, a.renderPngBase64);
    if (renderDistance <= plan.tolerance.renderPixelLevenshtein) matched += 1;
    else deltas.push({ field: `perPage[${i}].renderPixelDistance`, expected: e.renderSha256, actual: renderDistance });
    if (e.rects === a.rects) matched += 1;
    else deltas.push({ field: `perPage[${i}].rects`, expected: e.rects, actual: a.rects });
  }
  return { fixtureId: plan.fixtureId, kind: "pdfcraft", total, matched, deltas };
}

function compareWordCraft(expected: CanonicalWordCraft, actual: CanonicalWordCraft, plan: Plan): DiffReport {
  const deltas: DiffReport["deltas"][number][] = [];
  let total = 1;
  let matched = 0;
  if (JSON.stringify(expected.styles) === JSON.stringify(actual.styles)) matched += 1;
  else deltas.push({ field: "styles", expected: expected.styles, actual: actual.styles });
  const count = Math.max(expected.blocks.length, actual.blocks.length);
  for (let i = 0; i < count; i++) {
    const e = expected.blocks[i];
    const a = actual.blocks[i];
    total += 3;
    if (e === undefined || a === undefined) {
      deltas.push({ field: `blocks[${i}]`, expected: e ?? null, actual: a ?? null });
      continue;
    }
    if (e.kind === a.kind) matched += 1;
    else deltas.push({ field: `blocks[${i}].kind`, expected: e.kind, actual: a.kind });
    const distance = damerauLev(e.text, a.text);
    if (distance <= plan.tolerance.textDamerauLevenshtein) matched += 1;
    else deltas.push({ field: `blocks[${i}].textDistance`, expected: e.text, actual: a.text });
    if (JSON.stringify(e.styleChain) === JSON.stringify(a.styleChain)) matched += 1;
    else deltas.push({ field: `blocks[${i}].styleChain`, expected: e.styleChain, actual: a.styleChain });
  }
  return { fixtureId: plan.fixtureId, kind: "wordcraft", total, matched, deltas };
}

function compareExact(
  expected: unknown, actual: unknown, plan: Plan, kind: "designcraft",
): DiffReport {
  const e = expected as Record<string, unknown>;
  const a = actual as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(e), ...Object.keys(a)])].sort();
  const deltas: DiffReport["deltas"][number][] = [];
  for (const key of keys) {
    if (JSON.stringify(e[key]) !== JSON.stringify(a[key])) {
      deltas.push({ field: key, expected: e[key], actual: a[key] });
    }
  }
  return { fixtureId: plan.fixtureId, kind, total: keys.length, matched: keys.length - deltas.length, deltas };
}

function compareRun(
  expected: Record<string, unknown>, actual: Record<string, unknown>, plan: Plan,
): { ok: boolean; reports: DiffReport[] } {
  const reports: DiffReport[] = [];
  for (const key of ["designcraft", "pdfcraft", "wordcraft"] as const) {
    const e = expected[key];
    const a = actual[key];
    if (e === null || e === undefined || a === null || a === undefined) {
      if (JSON.stringify(e) !== JSON.stringify(a)) {
        reports.push({
          fixtureId: plan.fixtureId, kind: key, total: 1, matched: 0,
          deltas: [{ field: key, expected: e, actual: a }],
        });
      }
      continue;
    }
    if (key === "pdfcraft") {
      reports.push(comparePdf(e as CanonicalPdf, a as CanonicalPdf, plan));
    } else if (key === "wordcraft") {
      reports.push(compareWordCraft(e as CanonicalWordCraft, a as CanonicalWordCraft, plan));
    } else {
      reports.push(compareExact(e, a, plan, key));
    }
  }
  return { ok: reports.every((r) => r.deltas.length === 0), reports };
}

// ---------- Main harness ----------
interface Cli {
  readonly fixturesDir: string;
  readonly outDir: string;
  readonly updateGolden: boolean;
  readonly shardIndex: number;
  readonly shardTotal: number;
}
function parseCli(argv: readonly string[]): Cli {
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const positional = argv.find((a) => !a.startsWith("--") && argv.indexOf(a) > 0 && !["--fixtures-dir", "--out-dir", "--shard"].includes(argv[argv.indexOf(a) - 1] ?? ""));
  const shard = value("--shard") ?? "0/1";
  const match = /^(\d+)\/(\d+)$/.exec(shard);
  if (match === null) throw new Error("--shard must look like 0/8");
  const shardIndex = Number(match[1]);
  const shardTotal = Number(match[2]);
  if (shardTotal < 1 || shardIndex < 0 || shardIndex >= shardTotal) throw new Error("invalid --shard range");
  return {
    fixturesDir: value("--fixtures-dir") ?? positional ?? "fixtures",
    outDir: value("--out-dir") ?? "artifacts",
    updateGolden: argv.includes("--update-golden"),
    shardIndex,
    shardTotal,
  };
}

async function main(): Promise<number> {
  const cli = parseCli(process.argv.slice(2));
  if (cli.updateGolden && process.env["I_AM_SURE"] !== "1") {
    process.stderr.write("--update-golden requires I_AM_SURE=1\n");
    return 1;
  }
  const outRoot = path.resolve(cli.outDir);
  await fs.mkdir(outRoot, { recursive: true });

  const entries = await fs.readdir(cli.fixturesDir, { withFileTypes: true });
  const planFiles = entries
    .filter((f) => f.isDirectory())
    .map((f) => path.join(cli.fixturesDir, f.name, "plan.json"))
    .sort();
  const selected = planFiles.filter((_, index) => index % cli.shardTotal === cli.shardIndex);

  let anyNonDeterministic = false;
  let anyContentMismatch = false;

  for (const pf of selected) {
    const dir = path.dirname(pf);
    let plan: Plan;
    try {
      plan = JSON.parse(await fs.readFile(pf, "utf8")) as Plan;
    } catch (err) {
      const fixtureId = path.basename(dir);
      const failDir = path.join(outRoot, "diffs", fixtureId);
      await fs.mkdir(failDir, { recursive: true });
      await fs.writeFile(path.join(failDir, "error.txt"), `cannot read ${pf}: ${String(err)}\n`);
      anyContentMismatch = true;
      continue;
    }
    plan = { ...plan, tolerance: plan.tolerance ?? { textDamerauLevenshtein: 0, renderPixelLevenshtein: 0 } };
    const goldenPath = path.join(dir, "golden.json");

    let run1: Record<string, unknown>;
    let run2: Record<string, unknown>;
    try {
      run1 = await runFixture(plan, dir) as Record<string, unknown>;
      run2 = await runFixture(plan, dir) as Record<string, unknown>;
    } catch (err) {
      const failDir = path.join(outRoot, "diffs", plan.fixtureId);
      await fs.mkdir(failDir, { recursive: true });
      await fs.writeFile(path.join(failDir, "error.txt"),
        `${err instanceof Error ? err.message : String(err)}\n`);
      anyContentMismatch = true;
      continue;
    }

    if (JSON.stringify(run1) !== JSON.stringify(run2)) {
      const diffDir = path.join(outRoot, "diffs", plan.fixtureId);
      await fs.mkdir(diffDir, { recursive: true });
      await fs.writeFile(path.join(diffDir, "determinism.json"), JSON.stringify({ run1, run2 }, null, 2));
      anyNonDeterministic = true;
      continue;
    }

    let golden: Record<string, unknown> | undefined;
    try { golden = JSON.parse(await fs.readFile(goldenPath, "utf8")) as Record<string, unknown>; }
    catch { golden = undefined; }

    if (golden === undefined || cli.updateGolden) {
      await fs.writeFile(goldenPath, JSON.stringify(run1, null, 2) + "\n");
      continue;
    }

    const comparison = compareRun(golden, run1, plan);
    if (!comparison.ok) {
      const diffDir = path.join(outRoot, "diffs", plan.fixtureId);
      await fs.mkdir(diffDir, { recursive: true });
      await fs.writeFile(path.join(diffDir, "diff.json"), JSON.stringify(comparison.reports, null, 2));
      const md = [
        `# Diff Report — ${plan.fixtureId}`,
        "",
        `Tolerances: textDLE=${plan.tolerance.textDamerauLevenshtein}, renderPLE=${plan.tolerance.renderPixelLevenshtein}`,
        "",
        ...comparison.reports.map((r) => `## ${r.kind}: ${r.matched}/${r.total} matched\n\n` +
          r.deltas.map((d) => `- **${d.field}**\n  - expected: \`${JSON.stringify(d.expected)}\`\n  - actual:   \`${JSON.stringify(d.actual)}\``).join("\n")),
      ].join("\n");
      await fs.writeFile(path.join(diffDir, "summary.md"), md + "\n");
      anyContentMismatch = true;
    }
  }

  process.stdout.write(JSON.stringify({
    fixtures: selected.length,
    nondeterministic: anyNonDeterministic,
    mismatched: anyContentMismatch,
  }) + "\n");
  if (anyNonDeterministic) return 2;
  if (anyContentMismatch) return 1;
  return 0;
}

async function runFixture(plan: Plan, dir: string): Promise<unknown> {
  const used = new Set(plan.steps.map((s) => s.cli));
  const dc = new McpDriver("designcraft");
  const pc = new McpDriver("pdfcraft");
  const wc = new McpDriver("wordcraft");
  const drivers: Array<[PlanStep["cli"], McpDriver]> = [];
  if (used.has("designcraft")) drivers.push(["designcraft", dc]);
  if (used.has("pdfcraft")) drivers.push(["pdfcraft", pc]);
  if (used.has("wordcraft")) drivers.push(["wordcraft", wc]);
  const root = path.resolve(dir);
  for (const [, driver] of drivers) await driver.start([root]);

  try {
    const driverFor = (cli: PlanStep["cli"]): McpDriver =>
      cli === "designcraft" ? dc : cli === "pdfcraft" ? pc : wc;
    for (const step of plan.steps) {
      await driverFor(step.cli).run(step);
    }
    const dcOut = used.has("designcraft") ? await canonicalizeDesignCraft(dc) : null;
    const wcOut = used.has("wordcraft") ? await canonicalizeWordCraft(wc) : null;
    const pdfOut = used.has("pdfcraft") ? await canonicalizePdf(path.join(root, "out.pdf"), pc) : null;
    return { designcraft: dcOut, wordcraft: wcOut, pdfcraft: pdfOut };
  } finally {
    await Promise.all(drivers.map(([, d]) => d.close()));
  }
}

void main().then((code) => process.exit(code)).catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
