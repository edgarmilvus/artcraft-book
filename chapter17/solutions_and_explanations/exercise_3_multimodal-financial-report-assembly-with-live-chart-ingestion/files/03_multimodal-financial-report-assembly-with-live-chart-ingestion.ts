// =====================================================================
// Exercise 3 — Multimodal Financial Report Assembly
//
// The report is authored by WordCraft from the studio's template, the
// revenue page is rendered by PdfCraft and audited by a vision model, and
// the loop keeps correcting the chart until the audit is clean. The seal
// is the last write to the file.
// =====================================================================
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// ---- contracts ---------------------------------------------------------
export interface BibEntry  { key: string; author: string; year: number; title: string; venue: string; }
export interface ChartInput {
  section_number: 1|2|3|4|5; section_title: string;
  chart_png_path: string; caption: string; alt_text: string;
  citation_keys: string[];
}
export interface VisionAuditResponse {
  cv_safe: boolean;
  offending_chart: string | null;
  recommended_fix: "highlight_cell" | "change_bar_color" | "add_pattern_overlay" | null;
}

export const VISION_PROMPT = `You are a colour-vision accessibility auditor. Inspect the attached page render. Return JSON matching the schema exactly. Do not explain.`;

/** The styles the studio's template must ship. */
export const REQUIRED_STYLES = ["Heading1", "Heading2", "TableText", "Caption"];

/** The vision auditor. The default talks to a real model; the harness
 *  injects a scripted one so the pipeline is testable offline. */
export type VisionAuditor = (pngBase64: string, prompt: string) => Promise<VisionAuditResponse>;

class Mcp {
  private client: Client;
  private transport: StdioClientTransport;
  constructor(bin: string, args: string[], cwd?: string) {
    this.transport = new StdioClientTransport({
      command: bin,
      args,
      ...(cwd ? { cwd } : {}),
      env: process.env as Record<string, string>,
    });
    this.client = new Client({ name: "pulse-composer", version: "1.0.0" }, { capabilities: {} });
  }
  async connect() { await this.client.connect(this.transport); }
  async close()   { await this.client.close(); }

  /** Call an MCP tool and parse its text content block as JSON. */
  async call<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const r: any = await this.client.callTool({ name, arguments: args });
    const block = (r.content ?? []).find((c: any) => c.type === "text");
    if (r.isError) {
      throw new Error(`MCP tool ${name} failed: ${block?.text ?? "<no detail>"}`);
    }
    if (!block) throw new Error(`MCP tool ${name} produced no text result`);
    try { return JSON.parse(block.text) as T; }
    catch { return block.text as unknown as T; }
  }

  /** Call an MCP tool that answers with an image block and return its bytes. */
  async callImage(name: string, args: Record<string, unknown> = {}): Promise<{ data: string; mimeType: string }> {
    const r: any = await this.client.callTool({ name, arguments: args });
    const block = (r.content ?? []).find((c: any) => c.type === "image");
    if (r.isError) {
      const text = (r.content ?? []).find((c: any) => c.type === "text");
      throw new Error(`MCP tool ${name} failed: ${text?.text ?? "<no detail>"}`);
    }
    if (!block) throw new Error(`MCP tool ${name} produced no image result`);
    return { data: block.data, mimeType: block.mimeType ?? "image/png" };
  }
}

/** The default auditor: a real multimodal model, with a self-correcting parse. */
export function openAiAuditor(model = "gpt-4o"): VisionAuditor {
  // The SDK is imported lazily so the pipeline still runs when no provider
  // key is configured and a scripted auditor is injected instead.
  return async (pngBase64, prompt) => {
    const { default: OpenAI } = await import("openai");
    const openai = new OpenAI();
    let lastErr = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await openai.chat.completions.create({
          model,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: prompt + (lastErr ? `\n\nPrevious reply was invalid JSON: ${lastErr}` : "") },
              { type: "image_url", image_url: { url: `data:image/png;base64,${pngBase64}` } },
            ],
          }],
          response_format: { type: "json_object" },
        });
        return JSON.parse(res.choices[0]!.message.content!) as VisionAuditResponse;
      } catch (e: any) {
        lastErr = String(e.message ?? e).slice(0, 500);
      }
    }
    return { cv_safe: false, offending_chart: null, recommended_fix: null };
  };
}

// ---- composition -------------------------------------------------------
export async function compose(
  templatePath: string,
  charts: ChartInput[],
  bib: BibEntry[],
  wc: Mcp,
) {
  await wc.call("open_document", { path: templatePath });

  // Style-drift guard — the template must ship the correct styles. The
  // style catalogue is `styles.list`; `inspect_document` does not carry it.
  const styles = await wc.call<Array<{ id: string; name: string; kind: string }>>(
    "execute", { command: "styles.list", params: {} });
  const present = new Set((styles ?? []).map((s) => s.id));
  const missing = REQUIRED_STYLES.filter((r) => !present.has(r));
  if (missing.length) {
    throw new Error(`template_style_drift: missing ${missing.join(",")}`);
  }

  // Citation style is authoritative and must precede any citation.
  await wc.call("execute", { command: "references.citationStyle", params: { style: "APA" } });

  // Load the bibliography into the source manager. `year` is a string in
  // the engine's source schema, and `venue` is carried in `journal`.
  for (const b of bib) {
    await wc.call("execute", { command: "references.sources", params: {
      add: { tag: b.key, author: b.author, year: String(b.year),
             title: b.title, journal: b.venue },
    } });
  }

  // TOC before the first picture: the caret is at the top of the freshly
  // opened template, so the contents land on the first page.
  await wc.call("execute", { command: "references.toc",
                             params: { levels: 3, title: "Contents" } });

  // Sections + charts + captions + citations.
  for (const c of charts) {
    const level = Math.min(3, Math.max(1, c.section_number));
    await wc.call("execute",
      { command: `para.heading${level}`, params: {} });
    await wc.call("execute", { command: "text.insert",
                               params: { text: c.section_title } });
    await wc.call("execute", { command: "text.newParagraph", params: {} });

    const alt = c.alt_text?.trim() || `Chart showing ${c.section_title} for Q3 2026.`;
    await wc.call("execute", { command: "insert.picture",
      params: { path: c.chart_png_path, alt, width: 400 } });

    await wc.call("execute", { command: "references.caption",
      params: { label: "Figure", text: c.caption } });

    for (const k of c.citation_keys) {
      await wc.call("execute", { command: "references.citation",
                                 params: { tag: k } });
    }
  }

  // Bibliography + page-number field in the footer.
  await wc.call("execute", { command: "references.bibliography",
                             params: { title: "References" } });
  await wc.call("execute", { command: "insert.pageNumber",
    params: { position: "bottom", align: "center", format: "x of y" } });
  await wc.call("execute", { command: "insert.closeHeader", params: {} });

  // TOC must be refreshed *after* the last citation.
  await wc.call("execute", { command: "references.updateToc", params: {} });

  const inspect = await wc.call<any>("inspect_document", {});
  return { inspect, styles: styles ?? [] };
}

// ---- multimodal audit with self-correcting JSON parse ------------------
async function auditVision(
  pngB64: string,
  auditor: VisionAuditor,
): Promise<{ audit: VisionAuditResponse; raw: unknown }> {
  const audit = await auditor(pngB64, VISION_PROMPT);
  return { audit, raw: audit };
}

// ---- correction loop ---------------------------------------------------
export async function correctionLoop(
  charts: ChartInput[],
  wc: Mcp,
  pc: Mcp,
  pdfPath: string,
  auditor: VisionAuditor,
) {
  const MAX_ITER = 3;
  const transcript: Array<Record<string, unknown>> = [];
  let cv_safe = false;
  let iteration = 0;
  let tocUpdates = 1;

  while (iteration < MAX_ITER && !cv_safe) {
    iteration++;
    const docId = (await pc.call<{ doc: number }>("doc_open", { path: pdfPath })).doc;

    // Find the page carrying the Revenue chart by its caption text.
    const revenue = charts.find((c) => /revenue/i.test(c.section_title)) ?? charts[0]!;
    const hits = await pc.call<any>("text_find", { doc: docId, query: revenue.caption });
    const page: number = hits.matches?.[0]?.page ?? 1;

    // `page_render` answers with an *image* content block, not a text one.
    const rendered = await pc.callImage("page_render", { doc: docId, page, dpi: 150 });

    const { audit, raw } = await auditVision(rendered.data, auditor);
    transcript.push({ iteration, page, raw: JSON.stringify(raw).slice(0, 2048) });

    await pc.call("doc_close", { doc: docId, discard_changes: true });

    if (audit.cv_safe) { cv_safe = true; break; }

    // Apply the recommended fix on the WordCraft side, then re-export.
    if (audit.recommended_fix === "highlight_cell") {
      // Locate the specific cell label first so the highlight lands precisely.
      const targetLabel = extractCellLabel(audit.offending_chart ?? revenue.section_title);
      await wc.call("select_text", { text: targetLabel });
      await wc.call("execute", { command: "format.highlight",
                                 params: { color: "brightGreen" } });
    }

    // Refresh the TOC (citation/caption counts may have shifted) and re-export.
    await wc.call("execute", { command: "references.updateToc", params: {} });
    tocUpdates += 1;
    await wc.call("execute", { command: "file.exportPdf", params: { path: pdfPath } });
  }

  return { cv_safe, iteration, transcript, tocUpdates };
}

function extractCellLabel(s: string): string {
  // Best-effort cell label extraction; the analyst's naming convention is
  // "<metric> <quarter>", e.g. "Revenue Q3 2026".
  return s.replace(/[^A-Za-z0-9 ]/g, "").trim().split(/\s+/).slice(0, 3).join(" ");
}

// ---- driver ------------------------------------------------------------
export interface PulsePaths {
  templatePath: string;
  chartsPath: string;
  bibPath: string;
  docxPath: string;
  pdfPath: string;
  sealedPath: string;
  manifestPath: string;
  reportsDir: string;
}

export async function run(
  paths: PulsePaths,
  charts: ChartInput[],
  bib: BibEntry[],
  auditor: VisionAuditor,
  signingId: string,
  signingPassword: string,
) {
  mkdirSync(paths.reportsDir, { recursive: true });

  // `wordcraft-cli mcp` takes no directory flag: the working directory is
  // the boundary. `pdfcraft-cli mcp --root DIR` enforces its own.
  const wc = new Mcp("wordcraft-cli", ["mcp"], paths.reportsDir);
  const pc = new Mcp("pdfcraft-cli", ["mcp", "--root", paths.reportsDir], paths.reportsDir);
  await wc.connect(); await pc.connect();

  try {
    const { inspect } = await compose(paths.templatePath, charts, bib, wc);
    await wc.call("save_document", { path: paths.docxPath });
    await wc.call("execute", { command: "file.exportPdf", params: { path: paths.pdfPath } });

    const { cv_safe, iteration, transcript, tocUpdates } =
      await correctionLoop(charts, wc, pc, paths.pdfPath, auditor);

    // ---- PdfCraft seal (the LAST write) ----
    const docId = (await pc.call<{ doc: number }>("doc_open", { path: paths.pdfPath })).doc;
    await pc.call("pdfa_convert", { doc: docId, level: "3b" });
    await pc.call("doc_set_info", { doc: docId, key: "Title", value: "Q3 2026 Sector Pulse" });
    await pc.call("doc_watermark", {
      doc: docId, text: "SECTOR PULSE — SEALED",
      rotation: 0, opacity: 0.85, behind: false,
    });
    await pc.call("sign_document", {
      doc: docId, id: signingId,
      password: signingPassword,
      out: paths.sealedPath, certify: "no_changes",
      reason: "Q3 Sector Pulse publication seal",
    });
    const signatures = await pc.call<any>("sign_list", { doc: docId });
    const pdfa = await pc.call<any>("pdfa_verify", { doc: docId, level: "3b" });

    // ---- Manifest ----
    const manifest = {
      status: cv_safe ? "sealed" : "needs_human_cv_review",
      vision_iterations: iteration,
      vision_transcript: transcript,                 // each entry ≤ 2 KB
      docx_revision_index: inspect?.properties?.revision ?? inspect?.blocks?.length ?? 0,
      update_toc_calls: tocUpdates,                  // initial + per-iteration
      pdfa,
      signatures,
    };
    writeFileSync(paths.manifestPath, JSON.stringify(manifest, null, 2));
    return manifest;
  } finally {
    await wc.close(); await pc.close();
  }
}
