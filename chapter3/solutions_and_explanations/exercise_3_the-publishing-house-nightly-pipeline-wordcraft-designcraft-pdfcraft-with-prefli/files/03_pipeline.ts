// pipeline.ts — WordCraft → DesignCraft → PdfCraft nightly pipeline.
//
// STYLE CONFLICT CHOICE: `redefine`.
// Why: the master template defines the house canon for Title/Body/Caption/etc.
// If an author's DOCX brings a paragraph style called "Body" with a slightly
// different indent, `autoRename` would silently produce "Body 2" and leave the
// author's stray indent live in the final PDF — a silent-degradation class the
// exercise forbids. `redefine` overwrites the *incoming* style with the house
// definition at import time, so the author's future PDFs from the same source
// file will also carry the house look on re-import. This is a deliberate
// editorial policy: the house canon is authoritative, the author's local styles
// are treated as suggestions, and any deviation is visible only in the source
// DOCX (which authors own) — never in the published PDF.
//
// TRANSPORT NOTE (verified): this file speaks real MCP over stdio, through the
// official SDK. The earlier draft hand-rolled a raw JSON-RPC line protocol and
// called `session_list` as a JSON-RPC method: an MCP server answers
// `tools/call`, not `session_list`, so that client could never have
// completed a handshake. Tool names and argument shapes differ per suite and
// are wrapped once, here, so the stages stay readable.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

interface Manifest {
  readonly manuscriptId: string;
  readonly sourceDocx: string;
  readonly masterTemplate: string;
  readonly signaturePages: number;
  readonly styleMap: Record<string, string>;
  readonly pdfaConformance: "2b" | "3b";
  readonly outputRoot: string;
}

interface PreflightReport {
  readonly manuscriptId: string;
  readonly pdfSha256: string;
  readonly conformance: "pdfa2b" | "pdfa3b";
  readonly issues: readonly { severity: "info" | "warning" | "error" | "fatal"; rule: string; page?: number; message: string }[];
  readonly passed: boolean;
}

/** Per-suite launch contract: PdfCraft takes `--root`, the others do not. */
function launch(binary: string, readRoot: string, writeRoot: string): {
  args: string[]; cwd?: string;
} {
  if (binary === "pdfcraft-cli") return { args: ["mcp", "--root", writeRoot], cwd: writeRoot };
  return { args: ["mcp"], cwd: writeRoot };
}

class Mcp {
  private readonly client: Client;

  private constructor(client: Client) {
    this.client = client;
  }

  static async connect(binary: string, readRoot: string, writeRoot: string): Promise<Mcp> {
    const spec = launch(binary, readRoot, writeRoot);
    const transport = new StdioClientTransport({
      command: binary,
      args: spec.args,
      stderr: "pipe",
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
    });
    // Drain the CLI's banner/log lines or the pipe fills and the child blocks.
    transport.stderr?.on("data", () => undefined);
    const client = new Client({ name: "publishing-house", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    return new Mcp(client);
  }

  async call<T = unknown>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    const res = await this.client.callTool({ name: tool, arguments: args });
    const block = (res.content as Array<{ type: string; text?: string }> | undefined)
      ?.find((c) => c.type === "text");
    const payload = block?.text === undefined ? undefined : (() => {
      try { return JSON.parse(block.text) as unknown; } catch { return block.text; }
    })();
    if (res.isError) throw new Error(`${tool} failed: ${JSON.stringify(payload)}`);
    return payload as T;
  }

  /** Registry command through the `execute` meta-tool. */
  async exec<T = unknown>(command: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.call<T>("execute", { command, params });
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
  }
}

async function sha256File(p: string): Promise<string> {
  const buf = await fs.readFile(p);
  return createHash("sha256").update(buf).digest("hex");
}

// ---------- Stage 0: Normalize tracked changes in WordCraft ----------
interface ReviewPos {
  readonly off: number;
  readonly path: readonly number[];
  readonly story: string;
}
interface ReviewChange {
  readonly author: string;
  readonly kind: "insert" | "delete" | "format" | string;
  readonly start: ReviewPos;
  readonly end: ReviewPos;
  readonly text: string;
}
interface Selection {
  readonly anchor: ReviewPos;
  readonly focus: ReviewPos;
  readonly text?: string;
}
const samePath = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);
const selectionCovers = (ch: ReviewChange, sel: Selection): boolean => {
  const [a0, a1] = [Math.min(ch.start.off, ch.end.off), Math.max(ch.start.off, ch.end.off)];
  const [s0, s1] = [Math.min(sel.anchor.off, sel.focus.off), Math.max(sel.anchor.off, sel.focus.off)];
  return a0 === s0 && a1 === s1 &&
    samePath(ch.start.path, sel.anchor.path) && ch.start.story === sel.anchor.story;
};

async function stage0(wc: Mcp, m: Manifest, normalizedRel: string): Promise<{ changes: number; comments: number }> {
  await wc.call("open_document", { path: m.sourceDocx });

  // `inspect_document` exposes blocks/comments/pages but NOT revisions.
  // `review.changes` is the authoritative revision list. `review.accept` and
  // `review.reject` take no target: they act on the current selection, so the
  // policy walks the revisions with `review.nextChange` and decides per change.
  const doc = await wc.call<{ comments?: number }>("inspect_document", {});
  const revisions = await wc.exec<readonly ReviewChange[]>("review.changes", {});

  // Policy: accept any *editor* insert; reject any *editor* delete; leave the
  // author's own changes untouched (the manuscript is still theirs to finalize).
  const isEditor = (a: string): boolean => a.toLowerCase().includes("editor");
  let applied = 0;
  const seenAuthor = new Set<string>();
  const guard = revisions.length * 3 + 6;
  for (let step = 0; step < guard; step++) {
    try {
      await wc.exec("review.nextChange", {});
    } catch {
      break;
    }
    const snap = await wc.call<{ selection?: Selection }>("inspect_document", {});
    const sel = snap.selection;
    if (sel === undefined) break;
    const changes = await wc.exec<readonly ReviewChange[]>("review.changes", {});
    const ch = changes.find((c) => selectionCovers(c, sel));
    if (ch === undefined) break;
    if (!isEditor(ch.author)) {
      const key = `${ch.author}|${ch.kind}|${ch.start.off}|${ch.end.off}|${ch.text}`;
      if (seenAuthor.has(key)) break;
      seenAuthor.add(key);
      continue;
    }
    if (ch.kind === "insert") { await wc.exec("review.accept", {}); applied += 1; }
    else if (ch.kind === "delete") { await wc.exec("review.reject", {}); applied += 1; }
  }

  // WordCraft resolves `path` against its cwd (the write root), so the
  // normalized copy is addressed by its root-relative path. The engine does
  // not create missing parent directories.
  await fs.mkdir(path.dirname(path.join(m.outputRoot, normalizedRel)), { recursive: true });
  await wc.call("save_document", { path: normalizedRel });
  return { changes: applied, comments: doc.comments ?? 0 };
}

// ---------- Stage 1: Map styles + place into master ----------
async function stage1(dc: Mcp, m: Manifest, normalizedRel: string): Promise<{ pages: number; overset: boolean }> {
  await dc.call("open_document", { path: m.masterTemplate });

  // 1a. Autoflow into the master's threaded frames, with styleMap.
  //     removeStyles:false -> keep author's character-level runs where possible.
  //     styleConflicts:"redefine" -> the house canon wins (see header comment).
  //     The engine reports the placed story's `overset` flag: text that did not
  //     fit is a hard error downstream (a truncated manuscript is not shippable).
  const placed = await dc.exec<{ overset?: boolean; pagesAdded?: number; story?: number; warnings?: string[] }>(
    "file.place",
    {
      path: normalizedRel,
      autoflow: true,
      rect: [72, 72, 540, 720],
      removeStyles: false,
      styleMap: m.styleMap,
      styleConflicts: "redefine",
    },
  );
  if (placed.overset === true) {
    throw new Error("file.place: the story is overset — the master template is too short");
  }

  // 1b. If the master template didn't already size the signature, grow it.
  const doc = await dc.call<{ pageCount?: number }>("inspect_document", {});
  const pages = doc.pageCount ?? 1;
  if (pages < m.signaturePages) {
    await dc.exec("layout.pages.insert", { count: m.signaturePages - pages });
  }
  return { pages: Math.max(pages, m.signaturePages), overset: false };
}

// ---------- Stage 2: TOC ----------
async function stage2(dc: Mcp): Promise<{ entries: number }> {
  // The style ids the importer created are lower-cased ("heading 1"), so the
  // TOC must ask for those ids, not for the Word display names.
  const generated = await dc.exec<{ entries?: number; story?: number }>("toc.generate", {
    entries: [{ style: "heading 1", level: 1 }, { style: "heading 2", level: 2 }],
    title: "Contents",
    page: 0,
  });
  return { entries: generated.entries ?? 0 };
}

// ---------- Stage 3: PDF export from DesignCraft ----------
async function stage3(dc: Mcp, m: Manifest, outRel: string): Promise<{ path: string; bytes: number; pages: number }> {
  // DesignCraft's exportPdf emits a bookmarked, print-ready PDF; PDF/A
  // conformance is *not* guaranteed here — PdfCraft's `pdfa_convert` pass is
  // the authoritative conformance step (Stage 4).
  const exported = await dc.exec<{ path?: string; bytes?: number; pages?: number; warnings?: string[] }>(
    "file.exportPdf",
    { path: outRel },
  );
  return { path: exported.path ?? outRel, bytes: exported.bytes ?? 0, pages: exported.pages ?? 0 };
}

// ---------- Stage 4: Conformance + preflight in PdfCraft ----------
async function stage4(pc: Mcp, m: Manifest, pdfRel: string, pdfAbs: string): Promise<PreflightReport> {
  const opened = await pc.call<{ doc?: number }>("doc_open", { path: pdfRel });
  const doc = opened.doc ?? 1;

  await pc.call("pdfa_convert", { doc, level: m.pdfaConformance });

  // `pdfa_convert` rewrites the in-memory document; without a save the
  // conversion exists only in the engine's working copy and the file on disk
  // is still the pre-conversion export. Persist it before verifying.
  await pc.call("doc_save", { doc });

  const verify = await pc.call<{
    compliant?: boolean;
    rules?: readonly { clause?: string; message?: string; page?: number; fixable?: boolean }[];
    issues?: readonly { clause?: string; message?: string; page?: number; fixable?: boolean }[];
  }>("pdfa_verify", { doc, level: m.pdfaConformance });
  const verifyIssues = verify.issues ?? verify.rules ?? [];

  const a11y = await pc.call<{
    rules?: readonly { id?: string; status?: string; findings?: readonly { page?: number; message?: string }[] }[];
  }>("accessibility_check", { doc, all: false, rules: ["tagged-pdf", "figures-alt-text", "color-contrast"] });

  const issues: PreflightReport["issues"][number][] = [];
  if (verify.compliant === false && verifyIssues.length === 0) {
    issues.push({ severity: "error", rule: "pdfa-verify", message: "PDF/A verification failed" });
  }
  for (const r of verifyIssues) {
    issues.push({
      severity: r.fixable === false ? "error" : "warning",
      rule: r.clause ?? "pdfa-verify",
      ...(r.page === undefined ? {} : { page: r.page }),
      message: r.message ?? "",
    });
  }
  for (const r of a11y.rules ?? []) {
    if (r.status !== "passed" && r.status !== "manual") {
      for (const f of r.findings ?? []) {
        issues.push({
          severity: "error",
          rule: r.id ?? "accessibility",
          ...(f.page === undefined ? {} : { page: f.page }),
          message: f.message ?? "accessibility finding",
        });
      }
    }
  }

  const passed = !issues.some((i) => i.severity === "error" || i.severity === "fatal");
  if (!passed) {
    await pc.call("accessibility_report", { doc, path: "a11y.html" });
  }

  const report: PreflightReport = {
    manuscriptId: m.manuscriptId,
    pdfSha256: await sha256File(pdfAbs),
    conformance: m.pdfaConformance === "2b" ? "pdfa2b" : "pdfa3b",
    issues,
    passed,
  };
  await fs.writeFile(path.join(m.outputRoot, "preflight.json"), JSON.stringify(report, null, 2));
  return report;
}

// ---------- Idempotency short-circuit ----------
async function shortCircuitIfFresh(m: Manifest): Promise<boolean> {
  const pdf = path.join(m.outputRoot, `${m.manuscriptId}.pdf`);
  const manifestSide = path.join(m.outputRoot, "preflight.json");
  try {
    const stat = await fs.stat(pdf);
    const pre = JSON.parse(await fs.readFile(manifestSide, "utf8")) as PreflightReport;
    const current = await sha256File(pdf);
    if (pre.pdfSha256 === current && pre.passed && stat.size > 0) {
      process.stdout.write(JSON.stringify({ manuscriptId: m.manuscriptId, skipped: true, pdfSha256: current }) + "\n");
      return true;
    }
  } catch { /* fall through */ }
  return false;
}

// ---------- Entry ----------
async function main(): Promise<number> {
  const manifestPath = process.env["MANIFEST"] ?? "manifest.json";
  const m: Manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Manifest;
  if (await shortCircuitIfFresh(m)) return 0;

  const writeRoot = m.outputRoot;
  await fs.mkdir(writeRoot, { recursive: true });
  const normalizedRel = `normalized/${m.manuscriptId}.docx`;
  const pdfRel = `${m.manuscriptId}.pdf`;

  const wc = await Mcp.connect("wordcraft-cli", writeRoot, writeRoot);
  const dc = await Mcp.connect("designcraft-cli", writeRoot, writeRoot);
  const pc = await Mcp.connect("pdfcraft-cli", writeRoot, writeRoot);
  try {
    const norm = await stage0(wc, m, normalizedRel);
    const layout = await stage1(dc, m, normalizedRel);
    const toc = await stage2(dc);
    const pdf = await stage3(dc, m, pdfRel);

    // Persist the intermediate .designcraft for the editor's review.
    await dc.exec("file.saveAs", { path: `${m.manuscriptId}.designcraft` });

    const pdfAbs = path.join(writeRoot, pdf.path);
    const report = await stage4(pc, m, pdfRel, pdfAbs);
    // `pdf.bytes` is DesignCraft's export; `doc_save` rewrites the file when
    // it persists the PDF/A conversion, so the artifact size is read back.
    const pdfBytes = (await fs.stat(pdfAbs)).size;

    if (toc.entries === 0 && report.passed) {
      process.stdout.write(JSON.stringify({ manuscriptId: m.manuscriptId, warning: "empty-toc" }) + "\n");
    }

    if (!report.passed) {
      const blocker = {
        manuscriptId: m.manuscriptId,
        failedRule: report.issues.find((i) => i.severity === "error" || i.severity === "fatal"),
        findings: report.issues,
      };
      await fs.writeFile(path.join(writeRoot, "blocker.json"), JSON.stringify(blocker, null, 2));
      return 1;
    }
    process.stdout.write(JSON.stringify({
      manuscriptId: m.manuscriptId,
      passed: true,
      changes: norm.changes,
      comments: norm.comments,
      pages: layout.pages,
      pdfPages: pdf.pages,
      pdfBytes,
      tocEntries: toc.entries,
      pdfSha256: report.pdfSha256,
      issues: report.issues.length,
    }) + "\n");
    return 0;
  } catch (err) {
    process.stderr.write(`[pipeline] fatal: ${(err as Error).message}\n`);
    return 1;
  } finally {
    await wc.close();
    await dc.close();
    await pc.close();
  }
}

void main().then((code) => process.exit(code));
