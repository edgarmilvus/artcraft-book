/**
 * Acceptance harness for the chapter-4 exercise 5 self-healing build.
 *
 * WordCraft and PdfCraft create the fixtures. The build then asks LightCraft
 * for two photos the catalogue cannot deliver, so the retry ladder must be
 * exhausted, both photos must become placeholders, and the run must be
 * reported as degraded. Everything lands under the solution's `output/`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { SelfHealingBuild } from "./05_self-healing-document-assembly-under-partial-engine-failure.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "..", "output");
const ROOT = path.join(OUT, "build-run");
const HERO_IMAGE = path.resolve(HERE, "assets", "hero-flat-v3.png");
const checks: { label: string; ok: boolean; detail: string }[] = [];
const ok = (label: string, cond: boolean, detail = ""): boolean => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label.padEnd(46)}${detail}`);
  checks.push({ label, ok: cond, detail });
  return cond;
};

function unwrap(res: unknown): unknown {
  const r = res as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  const text = r.content?.find((c) => c.type === "text")?.text;
  if (r.isError) return { ok: false, error: text ?? "tool error" };
  if (text === undefined) return res;
  try { return JSON.parse(text); } catch { return text; }
}

async function session<T>(bin: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const t = new StdioClientTransport({ command: bin, args: ["mcp"], cwd: ROOT, stderr: "ignore" });
  const c = new Client({ name: `fixture-${bin}`, version: "1" });
  await c.connect(t);
  try { return await fn(c); } finally { await c.close(); }
}

async function pdfSnapshot(pdfPath: string): Promise<{ pages: number; text: string; figures: number }> {
  return session("pdfcraft-cli", async (c) => {
    const opened = unwrap(await c.callTool({ name: "doc_open", arguments: { path: pdfPath } })) as {
      doc?: number; pages?: number;
    };
    const doc = Number(opened.doc ?? 1);
    const extracted = unwrap(await c.callTool({ name: "text_extract", arguments: { doc } })) as {
      pages?: Array<{ text?: string }>;
    };
    const figures = unwrap(await c.callTool({ name: "accessibility_figures", arguments: { doc } })) as {
      count?: number;
    };
    await c.callTool({ name: "doc_close", arguments: { doc } }).catch(() => undefined);
    return {
      pages: Number(opened.pages ?? extracted.pages?.length ?? 0),
      text: (extracted.pages ?? []).map((p) => p.text ?? "").join("\n"),
      figures: Number(figures.count ?? 0),
    };
  });
}

async function makeFixtures(): Promise<{ docx: string; pdf: string }> {
  const docx = path.join(ROOT, "template.docx");
  const pdf = path.join(ROOT, "out", "issue-42.pdf");

  await session("wordcraft-cli", async (c) => {
    await c.callTool({ name: "new_document", arguments: {} });
    await c.callTool({ name: "type_text", arguments: { text: "Issue 42 - draft" } }).catch(() => undefined);
    await c.callTool({ name: "save_document", arguments: { path: docx } });
  });

  await session("pdfcraft-cli", async (c) => {
    await c.callTool({ name: "doc_create", arguments: { from: "blank", pages: 2 } });
    await c.callTool({
      name: "page_add_text",
      arguments: {
        doc: 1, page: 1, at: [72, 76], width: 468, size: 26, bold: true,
        text: "THE AUTUMN DISPATCH\nIssue 42 · Field Notes from the Studio",
      },
    });
    await c.callTool({
      name: "page_add_text",
      arguments: {
        doc: 1, page: 1, at: [72, 160], width: 468, size: 11,
        text: "This week: the studio reopens, three new prints, and a dispatch from the archive. Subscriber services and credits are on the final page.",
      },
    });
    await c.callTool({
      name: "page_add_text",
      arguments: {
        doc: 1, page: 1, at: [72, 720], width: 468, size: 9,
        text: "Card on file: 4111 1111 1111 1111",
      },
    });
    await c.callTool({
      name: "page_add_text",
      arguments: {
        doc: 1, page: 2, at: [72, 76], width: 468, size: 20, bold: true,
        text: "FIELD NOTES",
      },
    });
    await c.callTool({
      name: "page_add_text",
      arguments: {
        doc: 1, page: 2, at: [72, 118], width: 468, size: 11,
        text: "The archive room is open by appointment. This issue ships with a short field report and a note on the images that could not be retrieved.",
      },
    });
    await c.callTool({
      name: "page_add_image",
      arguments: { doc: 1, page: 2, path: HERO_IMAGE, rect: [72, 170, 540, 280] },
    });
    await c.callTool({
      name: "page_add_text",
      arguments: {
        doc: 1, page: 2, at: [72, 286], width: 468, size: 8, italic: true,
        text: "Above: the studio archive, photographed before the network share went offline.",
      },
    });
    await c.callTool({
      name: "form_add_field",
      arguments: { doc: 1, page: 1, type: "text", name: "OrderNumber", rect: [390, 744, 540, 766] },
    });
    await c.callTool({ name: "doc_save", arguments: { doc: 1, path: pdf, full: true } });
    await c.callTool({ name: "doc_close", arguments: { doc: 1 } }).catch(() => undefined);
  });

  return { docx, pdf };
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  process.env.AUTOMATION_ROOT = ROOT;
  fs.rmSync(ROOT, { recursive: true, force: true });
  for (const d of ["out", "log", "quarantine"]) fs.mkdirSync(path.join(ROOT, d), { recursive: true });

  const { docx, pdf } = await makeFixtures();
  ok("DOCX template created", fs.existsSync(docx) && fs.statSync(docx).size > 1000,
    `${fs.existsSync(docx) ? fs.statSync(docx).size : 0} bytes`);
  ok("input PDF created", fs.existsSync(pdf) && fs.statSync(pdf).size > 100,
    `${fs.existsSync(pdf) ? fs.statSync(pdf).size : 0} bytes`);
  const inputSnapshot = await pdfSnapshot(pdf);
  const inputBytes = fs.statSync(pdf).size;
  ok("input PDF is two pages", inputSnapshot.pages === 2, `${inputSnapshot.pages} pages`);
  ok("input PDF carries newsletter text", inputSnapshot.text.trim().length > 50,
    `${inputSnapshot.text.trim().length} chars`);

  // The listing reads AUTOMATION_ROOT at module evaluation, so import it now.
  const { SelfHealingBuild: Build } = await import(
    "./05_self-healing-document-assembly-under-partial-engine-failure.js"
  );
  const build: SelfHealingBuild = new Build();
  const outcome = await build.run({
    newsletterIssue: "issue-42",
    photoIds: ["sku-118", "sku-204"],
    docxTemplatePath: docx,
    outputPdfPath: pdf,
    retryBackoffOverrideMs: [20, 20, 20],
    pdfaTargetLevel: "2b",
  });

  const kinds = outcome.summary.recoveries.map((r) => r.kind);
  console.log("  recoveries:", JSON.stringify(kinds));
  console.log("  summary:", JSON.stringify({ ...outcome.summary, recoveries: undefined }));

  ok("both photos requested", outcome.summary.photosRequested === 2);
  ok("nothing was delivered", outcome.summary.photosDelivered === 0, String(outcome.summary.photosDelivered));
  ok("retries were exhausted", kinds.filter((k) => k === "retry").length === 6, `${kinds.filter((k) => k === "retry").length} retries`);
  ok("both placeholders substituted", kinds.filter((k) => k === "placeholder_substituted").length === 2);
  ok("placeholder styles are metadata-driven",
    outcome.summary.recoveries.filter((r) => r.kind === "placeholder_substituted")
      .every((r) => r.kind === "placeholder_substituted" && (r.detail.style === "hero" || r.detail.style === "body")));
  ok("run marked degraded", outcome.summary.status === "degraded", outcome.summary.status);
  ok("PDF/A stayed at the requested level", outcome.summary.pdfaLevel === "2b", outcome.summary.pdfaLevel);
  ok("quarantine directory kept", fs.existsSync(outcome.quarantineDir), outcome.quarantineDir);
  ok("quarantine is inside the run tree", outcome.quarantineDir.startsWith(path.join(ROOT, "quarantine")));
  ok("three channel diagnostics", outcome.channelDiagnostics.length === 3,
    outcome.channelDiagnostics.map((d) => d.engine).join(","));

  const placeholders = fs.existsSync(outcome.quarantineDir)
    ? fs.readdirSync(outcome.quarantineDir).filter((f) => f.endsWith(".png")) : [];
  ok("placeholder files survived in quarantine", placeholders.length === 2, `${placeholders.length} files`);

  const logPath = path.join(ROOT, "log", "builds.jsonl");
  const lines = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean) : [];
  ok("build logged to JSONL", lines.length === 1, `${lines.length} lines`);
  let logged: any = null;
  try { logged = lines.length === 1 ? JSON.parse(lines[0]!) : null; } catch { logged = null; }
  ok("log line is valid JSON", logged !== null);
  ok("log line matches the summary", logged?.runId === outcome.summary.runId && logged?.status === "degraded",
    logged ? `${logged.runId} ${logged.status}` : "no log");
  ok("recoveries are typed and timestamped",
    outcome.summary.recoveries.every((r) => typeof r.at === "string" && !Number.isNaN(Date.parse(r.at)) && r.engine.length > 0));

  const outputSnapshot = await pdfSnapshot(pdf);
  const outputBytes = fs.statSync(pdf).size;
  ok("output PDF is still two pages", outputSnapshot.pages === 2, `${outputSnapshot.pages} pages`);
  ok("output PDF is not empty", outputSnapshot.text.trim().length > 50,
    `${outputSnapshot.text.trim().length} chars`);
  ok("output keeps the newsletter heading", outputSnapshot.text.includes("AUTUMN DISPATCH"));
  ok("placeholders are visible in the PDF",
    outputSnapshot.text.includes("sku-118") &&
      outputSnapshot.text.includes("sku-204") &&
      outputSnapshot.text.includes("Supplementary images will follow"));
  ok("output was saved after healing", outputBytes > inputBytes,
    `${inputBytes} -> ${outputBytes} bytes`);

  const failed = checks.filter((c) => !c.ok).length;
  fs.writeFileSync(path.join(OUT, "run-log.json"), JSON.stringify({
    checks: checks.length,
    failures: checks.filter((c) => !c.ok).map((c) => c.label),
    summary: outcome.summary,
    quarantineDir: outcome.quarantineDir,
    quarantineFiles: placeholders,
    channelDiagnostics: outcome.channelDiagnostics,
    inputPdf: { bytes: inputBytes, pages: inputSnapshot.pages, textChars: inputSnapshot.text.trim().length },
    outputPdf: {
      bytes: outputBytes,
      pages: outputSnapshot.pages,
      textChars: outputSnapshot.text.trim().length,
      figures: outputSnapshot.figures,
      hasPlaceholders: outputSnapshot.text.includes("Supplementary images will follow"),
    },
  }, null, 2) + "\n");
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
