// run_ex3.ts — acceptance harness for Chapter 3, Exercise 3.
//
// Builds a DOCX with three tracked changes and a DesignCraft master, runs the
// nightly pipeline against the real WordCraft → DesignCraft → PdfCraft stack,
// then reopens every artefact: the normalized DOCX is inspected for the
// revision policy, the PDF for text/TOC/PDF-A, and a second run for the
// idempotency short-circuit. A fatal missing template must leave no PDF.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const OUT = resolve(HERE, "..", "output");
const CLIS = resolve(REPO, "tools/craft-cli/bin");
const TSX = resolve(REPO, "node_modules/.bin/tsx");
const PIPELINE = join(HERE, "03_pipeline.ts");
const MANUSCRIPT = join(HERE, "build-manuscript.mjs");
const TEMPLATE = join(HERE, "make-template.mjs");
const MANIFEST = join(OUT, "manifest.json");
const PDF = join(OUT, "JAMS-2026-0089.pdf");
const NORMALIZED = join(OUT, "normalized", "JAMS-2026-0089.docx");

const checks: string[] = [];
const failures: string[] = [];
const quirks: string[] = [];
const lines: string[] = [];
const say = (line = ""): void => { lines.push(line); console.log(line); };
const check = (label: string, ok: boolean, detail = ""): void => {
  checks.push(label);
  if (!ok) failures.push(label);
  say(`${ok ? " ok " : "FAIL"} ${label.padEnd(60)}${detail}`);
};
const equal = (label: string, actual: unknown, expected: unknown): void =>
  check(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

type TextBlock = { type: string; text?: string };
type ToolReply = { content?: TextBlock[]; isError?: boolean };
const unwrap = (reply: ToolReply): unknown => {
  const block = reply.content?.find((b) => b.type === "text");
  if (reply.isError === true) throw new Error(String(block?.text ?? "tool failed"));
  if (block?.text === undefined) return {};
  try { return JSON.parse(block.text) as unknown; } catch { return block.text; }
};

async function withClient<T>(
  binary: string, args: string[], cwd: string, fn: (call: (tool: string, input?: Record<string, unknown>) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  const transport = new StdioClientTransport({ command: binary, args, cwd, stderr: "pipe" });
  transport.stderr?.on("data", () => undefined);
  const client = new Client({ name: "run-ex3", version: "1" }, { capabilities: {} });
  await client.connect(transport);
  const call = async (tool: string, input: Record<string, unknown> = {}): Promise<unknown> =>
    unwrap(await client.callTool({ name: tool, arguments: input }) as ToolReply);
  try { return await fn(call); } finally { await client.close().catch(() => undefined); }
}

const runNode = (script: string, args: string[]): { status: number | null; stdout: string; stderr: string } => {
  const r = spawnSync("node", [script, ...args], {
    cwd: HERE,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, PATH: `${CLIS}:${process.env.PATH ?? ""}` },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

const runPipeline = (manifest: string): { status: number | null; stdout: string; stderr: string } => {
  const r = spawnSync(TSX, [PIPELINE], {
    cwd: OUT,
    encoding: "utf8",
    timeout: 300_000,
    env: { ...process.env, PATH: `${CLIS}:${process.env.PATH ?? ""}`, MANIFEST: manifest },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

const reset = (): void => {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, "in"), { recursive: true });
  mkdirSync(join(OUT, "templates"), { recursive: true });
};

const manifest = (master: string, outputRoot = OUT) => ({
  manuscriptId: "JAMS-2026-0089",
  sourceDocx: "in/JAMS-2026-0089.docx",
  masterTemplate: master,
  signaturePages: 2,
  styleMap: {
    Heading1: "heading 1", Heading2: "heading 2",
    BodyText: "Basic Paragraph", Quote: "Basic Paragraph", Footnote: "Basic Paragraph",
  },
  pdfaConformance: "2b",
  outputRoot,
});

try {
  reset();
  say("── fixtures ───────────────────────────────────────────────────────────");
  const manuscript = runNode(MANUSCRIPT, [OUT]);
  equal("WordCraft builds the tracked-change manuscript", manuscript.status, 0);
  check("manuscript fixture exists", existsSync(join(OUT, "in", "JAMS-2026-0089.docx")),
    manuscript.stderr.slice(0, 140));
  const template = runNode(TEMPLATE, [OUT]);
  equal("DesignCraft builds the house master", template.status, 0);
  check("master template exists", existsSync(join(OUT, "templates", "house-master.designcraft")),
    template.stderr.slice(0, 140));
  writeFileSync(MANIFEST, JSON.stringify(manifest("templates/house-master.designcraft"), null, 2) + "\n");

  say("");
  say("── first run: normalize → reflow → TOC → PDF → preflight ───────────────");
  const first = runPipeline("manifest.json");
  writeFileSync(join(OUT, "pipeline-1.log"), first.stdout + first.stderr);
  equal("pipeline exits cleanly", first.status, 0);
  check("pipeline prints no traceback", !/^\s+at .+\(/m.test(first.stderr), first.stderr.slice(0, 180));
  const summaries = first.stdout.split("\n").filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l));
  check("pipeline prints one summary", summaries.length === 1, String(summaries.length));
  const summary = summaries[0] ?? {};
  equal("two editor changes were applied", summary.changes, 2);
  equal("no comments survived", summary.comments, 0);
  equal("signature size is honoured", summary.pages, 2);
  equal("PDF has two pages", summary.pdfPages, 2);
  check("TOC has entries", Number(summary.tocEntries) >= 2, String(summary.tocEntries));
  check("PDF is not empty", Number(summary.pdfBytes) > 5_000, `${summary.pdfBytes} bytes`);
  equal("reported PDF size is the file on disk", summary.pdfBytes, statSync(PDF).size);
  equal("preflight has no errors", summary.issues, 0);

  check("PDF exists", existsSync(PDF), existsSync(PDF) ? `${statSync(PDF).size} bytes` : "missing");
  check("PDF has a %PDF header", existsSync(PDF) && readFileSync(PDF).subarray(0, 5).toString() === "%PDF-");
  check("normalized DOCX exists", existsSync(NORMALIZED));
  const pre = JSON.parse(readFileSync(join(OUT, "preflight.json"), "utf8"));
  equal("preflight passed", pre.passed, true);
  equal("preflight records PDF/A-2b", pre.conformance, "pdfa2b");
  equal("preflight hashes the written PDF", pre.pdfSha256, sha(PDF));
  equal("preflight has no error-severity issues",
    pre.issues.filter((i: { severity: string }) => i.severity === "error" || i.severity === "fatal").length, 0);

  // Snapshot the first run. The rebuild probe below replaces the PDF and its
  // sidecar, and the directory should be left holding the run the log describes.
  const firstPdf = readFileSync(PDF);
  const firstPreflight = readFileSync(join(OUT, "preflight.json"));

  say("");
  say("── revision policy (reopen the normalized DOCX) ───────────────────────");
  const revisionView = await withClient("wordcraft-cli", ["mcp"], OUT, async (call) => {
    await call("open_document", { path: "normalized/JAMS-2026-0089.docx" });
    const changes = await call("execute", { command: "review.changes", params: {} }) as Array<Record<string, unknown>>;
    const inspected = await call("inspect_document", {}) as { blocks?: Array<{ text?: string }> };
    return { changes, text: (inspected.blocks ?? []).map((b) => b.text ?? "").join("\n") };
  });
  equal("only the author's revision is left", revisionView.changes.length, 1);
  equal("the remaining revision belongs to the author", String(revisionView.changes[0]?.author), "Author");
  check("the author's revision stayed tracked",
    String(revisionView.changes[0]?.text ?? "").includes("AUTHOR-TRACKED"));
  check("the editor insert was accepted", revisionView.text.includes("EDITOR-INSERT"));
  check("the editor delete was rejected (text restored)", revisionView.text.includes("PREFLIGHT-TARGET"));
  check("the author's text is present in the story", revisionView.text.includes("AUTHOR-TRACKED"));

  say("");
  say("── PDF text + PDF/A (reopen with PdfCraft) ──────────────────────────────");
  const pdfView = await withClient("pdfcraft-cli", ["mcp", "--root", OUT], OUT, async (call) => {
    const opened = await call("doc_open", { path: "JAMS-2026-0089.pdf" }) as { doc?: number; pages?: number };
    const doc = opened.doc ?? 1;
    const extracted = await call("text_extract", { doc }) as unknown;
    const verified = await call("pdfa_verify", { doc, level: "2b" }) as { compliant?: boolean };
    return { pages: opened.pages ?? 0, extracted, verified };
  });
  equal("PdfCraft sees two pages", pdfView.pages, 2);
  const pdfText = typeof pdfView.extracted === "string"
    ? pdfView.extracted
    : JSON.stringify(pdfView.extracted);
  check("PDF carries the title", pdfText.includes("Journal of Applied Materials Science"));
  check("PDF carries the accepted editor insert", pdfText.includes("EDITOR-INSERT"));
  check("PDF carries the restored editor-deleted text", pdfText.includes("PREFLIGHT-TARGET"));
  check("PDF carries the author's tracked text", pdfText.includes("AUTHOR-TRACKED"));
  check("PDF has a generated Contents page", /Contents/i.test(pdfText));
  equal("PdfCraft verifies PDF/A-2b", pdfView.verified.compliant, true);

  say("");
  say("── idempotency ─────────────────────────────────────────────────────────");
  const hash = sha(PDF);
  const second = runPipeline("manifest.json");
  writeFileSync(join(OUT, "pipeline-2.log"), second.stdout + second.stderr);
  equal("second run exits cleanly", second.status, 0);
  const secondSummary = JSON.parse(second.stdout.trim().split("\n").find((l) => l.startsWith("{")) ?? "{}");
  equal("second run short-circuits", secondSummary.skipped, true);
  equal("second run returns the same digest", secondSummary.pdfSha256, hash);
  equal("short-circuit does not rewrite the PDF", sha(PDF), hash);

  rmSync(join(OUT, "preflight.json"));
  const rebuilt = runPipeline("manifest.json");
  equal("removing the sidecar forces a rebuild", rebuilt.status, 0);
  const rebuiltSummary = JSON.parse(rebuilt.stdout.trim().split("\n").find((l) => l.startsWith("{")) ?? "{}");
  equal("rebuild is not a cache hit", rebuiltSummary.skipped, undefined);
  check("rebuild keeps the page count", rebuiltSummary.pdfPages === 2, String(rebuiltSummary.pdfPages));
  check("rebuild still passes preflight", rebuiltSummary.issues === 0, String(rebuiltSummary.issues));

  writeFileSync(PDF, firstPdf);
  writeFileSync(join(OUT, "preflight.json"), firstPreflight);
  equal("the restored PDF is the one the first-run log describes", sha(PDF), hash);

  say("");
  say("── fatal template path ─────────────────────────────────────────────────");
  const failing = join(OUT, "failing");
  mkdirSync(join(failing, "in"), { recursive: true });
  mkdirSync(join(failing, "templates"), { recursive: true });
  writeFileSync(join(failing, "in", "JAMS-2026-0089.docx"),
    readFileSync(join(OUT, "in", "JAMS-2026-0089.docx")));
  writeFileSync(join(failing, "manifest.json"),
    JSON.stringify(manifest("templates/does-not-exist.designcraft", failing), null, 2) + "\n");
  const failed = spawnSync(TSX, [PIPELINE], {
    cwd: failing, encoding: "utf8", timeout: 120_000,
    env: { ...process.env, PATH: `${CLIS}:${process.env.PATH ?? ""}`, MANIFEST: "manifest.json" },
  });
  check("missing master is a fatal error", failed.status !== 0, `exit ${failed.status}`);
  check("fatal error names the stage", /fatal:/.test(failed.stderr), failed.stderr.slice(0, 160));
  check("fatal run writes no PDF", !existsSync(join(failing, "JAMS-2026-0089.pdf")));

  say("");
  say("── code contracts ──────────────────────────────────────────────────────");
  const code = readFileSync(PIPELINE, "utf8");
  check("normalization reads review.changes", /review\.changes/.test(code));
  check("normalization does not read a non-existent revisions field", !/\.revisions/.test(code));
  check("style conflicts are resolved with redefine", /styleConflicts:\s*"redefine"/.test(code));
  check("overset is a hard failure", /overset === true/.test(code));
  check("PDF/A conversion precedes verification", code.indexOf("pdfa_convert") < code.indexOf("pdfa_verify"));
  check("accessibility is checked", /accessibility_check/.test(code));
  check("blockers are written as blocker.json", /blocker\.json/.test(code));
  check("no hand-rolled JSON-RPC frames", !/"jsonrpc"/.test(code));
  check("normalized parent directory is created", /mkdir\(path\.dirname/.test(code));
  quirks.push("WordCraft exposes revisions only through review.changes, not inspect_document");

  const result = { checks: checks.length, failures, quirks, pdfSha256: hash, pages: pdfView.pages };
  writeFileSync(join(OUT, "run-log.json"), JSON.stringify(result, null, 2) + "\n");
  say("");
  say(`${checks.length} checks, ${failures.length} failing; artefacts in ${OUT}`);
} catch (error) {
  say(`FAIL harness crashed: ${error instanceof Error ? error.stack : String(error)}`);
  writeFileSync(join(OUT, "run-log.json"), JSON.stringify({ checks: checks.length, failures, crash: String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  writeFileSync(join(OUT, "run_ex3.log"), lines.join("\n") + "\n");
}
if (failures.length > 0) process.exitCode = 1;
