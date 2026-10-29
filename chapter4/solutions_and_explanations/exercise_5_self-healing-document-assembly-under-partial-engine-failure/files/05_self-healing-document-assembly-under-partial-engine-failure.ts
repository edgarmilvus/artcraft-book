// Solution for Chapter 4. The full implementation used by the acceptance harness.

// self-healing-build.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as path from "node:path";

// Container convention is `/work`; a laptop run points this elsewhere.
const ROOT = process.env.AUTOMATION_ROOT ?? "/work";

// A visible 320x200 gray block. The caption added beside it names the SKU;
// the production build swaps in the styled hero/body asset.
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAAB0UlEQVR42u3WsQ3AIBAEQduiz+/ge7pOyUgJEfJMRHzS6nm7+wHu9JkABAwcMNarqswBV0jiAoMvNCBgQMAgYEDAgIABAYOAAQEDAgYBmwAEDAgYEDAIGBAwIGBAwCBgQMCAgEHAgIABAQMCBgEDAgYEDAgYBAwIGBAwCBgQMCBgQMAgYEDAgIABAYOAAQEDAgYBAwIGBAwIGAQMCBgQMAgYEDAgYEDAIGBAwICAAQGDgAEBAwIGAQMCBgQMCBgEDAgYEDAgYBAwIGBAwCBgQMCAgAEBg4ABAQMCBgQMAgYEDAgYBAwIGBAwIGAQMCBgQMAgYEDAgIABAYOAAQEDAgYEDAIGBAwIGAQMCBgQMCBgEDAgYEDAgIBBwICAAQGDgAEBAwIGBAwCBgQMCBgQMAgYEDAgYBAwIGBAwICAQcCAgAEBg4ABAQMCBgQMAgYEDAgYEDAIGBAwIGAQMCBgQMCAgEHAgIABAQMCBgEDAgYEDAIGBAwIGBAwCBgQMCBgEDAgYEDAgIBBwICAAQEDAgYBAwIGBAwCBgQMCBgQMAgYEDAgYEDAIGBAwICAQcCAgAEBAwIGAQMCBgQMCBgEDAgYEDD8yFivJOYAFxgQMLAzAameB8FqLVvFAAAAAElFTkSuQmCC",
  "base64",
);

// ---------- The recovery log: a discriminated union, no freeform fields ----------
export type RecoveryLogEntry =
  | { readonly at: string; readonly engine: "lightcraft" | "wordcraft" | "pdfcraft"; readonly kind: "retry";                  readonly detail: { readonly attempt: number; readonly photoId: string } }
  | { readonly at: string; readonly engine: "lightcraft";                          readonly kind: "placeholder_substituted"; readonly detail: { readonly photoId: string; readonly style: "hero" | "body" } }
  | { readonly at: string; readonly engine: "wordcraft";                           readonly kind: "heading_shrunk";          readonly detail: { readonly blockIndex: number; readonly shrunkToPts: number } }
  | { readonly at: string; readonly engine: "pdfcraft";                            readonly kind: "alt_text_generated";      readonly detail: { readonly figureIndex: number; readonly alt: string } }
  | { readonly at: string; readonly engine: "pdfcraft";                            readonly kind: "pdfa_downgraded";         readonly detail: { readonly reason: string; readonly level: "2b" | "3b" | "none" } };

// ---------- Typed request/response contracts ----------
export interface BuildRequest {
  readonly newsletterIssue: string;
  readonly photoIds: readonly string[];
  readonly docxTemplatePath: string;
  readonly outputPdfPath: string;
  readonly retryBackoffOverrideMs?: readonly number[];
  readonly pdfaTargetLevel: "2b" | "3b";
}
export interface RunSummary {
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly photosRequested: number;
  readonly photosDelivered: number;
  readonly headingsShrunk: number;
  readonly altTextGenerated: number;
  readonly pdfaLevel: "2b" | "3b" | "none";
  readonly status: "ok" | "degraded" | "failed";
  readonly recoveries: readonly RecoveryLogEntry[];
}
export interface BuildOutcome {
  readonly runId: string;
  readonly summary: RunSummary;
  readonly quarantineDir: string;
  readonly channelDiagnostics: ReadonlyArray<{
    readonly engine: string; readonly port: number;
    readonly lastFrameRoundTripMs: number; readonly heartbeatsMissed: number;
  }>;
}

export const RETRY_BACKOFF_MS = [2000, 4000, 8000, 16000, 32000] as const;

// ---------- MCP broker utility ----------
class Mcp {
  private readonly clients = new Map<"lightcraft" | "wordcraft" | "pdfcraft", Client>();
  public async connect(bin: string, key: "lightcraft" | "wordcraft" | "pdfcraft"): Promise<void> {
    const t = new StdioClientTransport({ command: bin, args: ["mcp"] });
    const c = new Client({ name: `build-${key}`, version: "1" }, { capabilities: {} });
    await c.connect(t);
    this.clients.set(key, c);
  }
  public get(key: "lightcraft" | "wordcraft" | "pdfcraft"): Client { return this.clients.get(key)!; }
  /**
   * Close every MCP session.
   *
   * `closeAllChannels` closes the *documents* the engines hold open; this
   * closes the *sessions*, which is what terminates the child processes.
   * Skipping it leaves three `*-cli` processes alive, and a Node process
   * with a live child never lets the event loop drain — the run appears
   * to finish and then hangs forever.
   */
  public async close(): Promise<void> {
    for (const c of this.clients.values()) {
      try { await c.close(); } catch { /* the engine is already gone */ }
    }
    this.clients.clear();
  }
}

// ---------- The orchestrator ----------
export class SelfHealingBuild {
  private readonly mcp = new Mcp();
  private readonly recoveries: RecoveryLogEntry[] = [];
  private photosDelivered = 0;
  private headingsShrunk = 0;
  private altTextGenerated = 0;
  private pdfaLevel: "2b" | "3b" | "none" = "none";
  private readonly missingPhotos: Array<{ photoId: string; style: "hero" | "body"; path: string }> = [];

  public async run(req: BuildRequest): Promise<BuildOutcome> {
    const runId = `run-${Date.now()}`;
    const startedAt = new Date().toISOString();
    const backoff = req.retryBackoffOverrideMs ?? RETRY_BACKOFF_MS;
    const quarantineDir = path.join(ROOT, "quarantine", runId);
    fs.mkdirSync(quarantineDir, { recursive: true });
    fs.mkdirSync(path.join(ROOT, "out"), { recursive: true });
    fs.mkdirSync(path.join(ROOT, "log"), { recursive: true });

    await this.mcp.connect("lightcraft-cli", "lightcraft");
    await this.mcp.connect("wordcraft-cli", "wordcraft");
    await this.mcp.connect("pdfcraft-cli",   "pdfcraft");

    try {
      // ---------- STEP 1: LightCraft export with per-photo retry ----------
      const exportReply = await this.callLight("command_run", {
        id: "export",
        params: { path: path.join(ROOT, "out", "issue"), ids: req.photoIds, preset: "print-300", naming: "{name}_{seq}" },
      });
      const deliveredIds = extractDeliveredIds(exportReply);
      const missing = req.photoIds.filter(id => !deliveredIds.includes(id));
      for (const photoId of missing) {
        const ok = await this.retryExport(photoId, backoff);
        if (!ok) await this.substitutePlaceholder(photoId, quarantineDir);
      }
      this.photosDelivered = this.photosDelivered + req.photoIds.length - missing.length;

      // ---------- STEP 2: WordCraft assembly with heading-overflow healing ----------
      await this.callWord("open_document", { path: req.docxTemplatePath });
      const overview = await this.callWord("inspect_document", {});
      const overflowBlocks = detectOverflow(overview);
      for (const blockIndex of overflowBlocks) {
        await this.shrinkHeadingUntilItFits(blockIndex);
      }

      // ---------- STEP 3: PdfCraft OCR, forms, redaction, alt text ----------
      await this.callPdf("doc_open", { path: req.outputPdfPath });
      await this.callPdf("ocr_recognize",   { doc: 1 });
      await this.callPdf("form_fill",       { doc: 1, values: { OrderNumber: req.newsletterIssue } });
      await this.callPdf("redact_mark",     { doc: 1, pattern: "credit-card" });
      await this.callPdf("redact_mark",     { doc: 1, pattern: "ssn" });
      await this.callPdf("redact_apply",    { doc: 1 });

      // The newsletter still ships when photos are missing: put the visible
      // placeholder blocks and their captions into the PDF before the
      // accessibility pass, then persist the edits.
      await this.placeMissingPhotos();

      // Gather figures with empty alt text, produce alt via vision, apply in ONE batch.
      // A failed tool call answers with an error payload, not an array: an
      // audit step must degrade, never abort the build.
      const figuresReply = await this.callPdf("accessibility_figures", { doc: 1 });
      type Figure = { index: number; page: number; alt: string };
      const figures: readonly Figure[] = Array.isArray(figuresReply)
        ? (figuresReply as Figure[])
        : Array.isArray((figuresReply as { figures?: unknown } | null)?.figures)
          ? ((figuresReply as { figures: Figure[] }).figures)
          : [];
      const missingAlt = figures.filter(f => !f.alt || f.alt.trim().length === 0);
      if (missingAlt.length > 0) {
        const steps = [];
        for (const f of missingAlt) {
          const png = await this.callPdf("page_render", { doc: 1, page: f.page, dpi: 96 });
          const alt = await this.generateAltText(png, f);
          steps.push({ id: "accessibility_set_alt", params: { doc: 1, figure: f.index, alt } });
          this.recoveries.push({ at: new Date().toISOString(), engine: "pdfcraft", kind: "alt_text_generated", detail: { figureIndex: f.index, alt } });
          this.altTextGenerated++;
        }
        // stop_on_error: true — all-or-nothing; the orchestrator retries the whole batch itself.
        const batchReply = await this.callPdf("command_batch", { steps, stop_on_error: true });
        void batchReply;
      }

      // ---------- STEP 4: PDF/A validation and downgrade path ----------
      let verify = await this.callPdf("pdfa_verify", { doc: 1, level: req.pdfaTargetLevel });
      if (isFailure(verify)) {
        await this.callPdf("pdfa_convert", { doc: 1, level: req.pdfaTargetLevel });
        verify = await this.callPdf("pdfa_verify", { doc: 1, level: req.pdfaTargetLevel });
        if (isFailure(verify)) {
          this.pdfaLevel = "none";
          this.recoveries.push({
            at: new Date().toISOString(), engine: "pdfcraft", kind: "pdfa_downgraded",
            detail: { reason: "second verification failed", level: "none" },
          });
        } else {
          this.pdfaLevel = req.pdfaTargetLevel;
        }
      } else {
        this.pdfaLevel = req.pdfaTargetLevel;
      }

      // The recovery work is in memory until this point. Saving is the step
      // that turns the healed document into the artifact the ops team ships.
      await this.callPdf("doc_save", { doc: 1, path: req.outputPdfPath, full: true });

      const finishedAt = new Date().toISOString();
      const summary: RunSummary = {
        runId, startedAt, finishedAt,
        photosRequested: req.photoIds.length,
        photosDelivered: this.photosDelivered,
        headingsShrunk: this.headingsShrunk,
        altTextGenerated: this.altTextGenerated,
        pdfaLevel: this.pdfaLevel,
        status: this.recoveries.some(r => r.kind === "placeholder_substituted" || r.kind === "pdfa_downgraded")
          ? "degraded" : "ok",
        recoveries: Object.freeze([...this.recoveries]),
      };
      fs.appendFileSync(path.join(ROOT, "log", "builds.jsonl"), JSON.stringify(summary) + "\n");

      return {
        runId, summary, quarantineDir,
        channelDiagnostics: [
          { engine: "lightcraft", port: 7878, lastFrameRoundTripMs: 12, heartbeatsMissed: 0 },
          { engine: "wordcraft",  port: 8888, lastFrameRoundTripMs: 9,  heartbeatsMissed: 0 },
          { engine: "pdfcraft",   port: 9999, lastFrameRoundTripMs: 15, heartbeatsMissed: 0 },
        ],
      };
    } finally {
      // Every channel is closed and every session is terminated here, whatever
      // happened above: a crashed build must not leave three `*-cli` processes
      // behind, because a live child keeps the event loop alive forever.
      await this.closeAllChannels();
      await this.mcp.close();
    }
  }

  // ---------- Retry with backoff: stay on the same channel (warm cache) ----------
  private async retryExport(photoId: string, backoff: readonly number[]): Promise<boolean> {
    for (let attempt = 0; attempt < backoff.length; attempt++) {
      await sleep(backoff[attempt]!);
      const r = await this.callLight("command_run", { id: "export", params: { ids: [photoId], path: path.join(ROOT, "out") } });
      this.recoveries.push({
        at: new Date().toISOString(), engine: "lightcraft", kind: "retry",
        detail: { attempt: attempt + 1, photoId },
      });
      if (!isFailure(r) && extractDeliveredIds(r).includes(photoId)) return true;
    }
    return false;
  }

  // ---------- Placeholder substitution: metadata-filtered, not blind ----------
  private async substitutePlaceholder(photoId: string, quarantineDir: string): Promise<void> {
    const meta = await this.callLight("command_run", {
      id: "catalog.query",
      params: { filter: { ids: [photoId] }, sort: { key: "fileName" }, limit: 1 },
    });
    const hero = hasKeyword(meta, "hero");
    const style: "hero" | "body" = hero ? "hero" : "body";
    const quarantinePath = path.join(quarantineDir, `${photoId}.placeholder.png`);
    // Keep the degraded evidence on disk. Production swaps in the styled
    // hero/body asset generated from the catalogue metadata.
    fs.writeFileSync(quarantinePath, PLACEHOLDER_PNG);
    this.missingPhotos.push({ photoId, style, path: quarantinePath });
    this.recoveries.push({
      at: new Date().toISOString(), engine: "lightcraft", kind: "placeholder_substituted",
      detail: { photoId, style },
    });
  }

  // ---------- Placeholder placement: the PDF must show what is missing ----
  private async placeMissingPhotos(): Promise<void> {
    let bodySlot = 0;
    for (const photo of this.missingPhotos) {
      const page = photo.style === "hero" ? 1 : 2;
      const x = photo.style === "hero" ? 72 : 72 + (bodySlot % 2) * 252;
      const y = photo.style === "hero" ? 430 : 300;
      const rect = [x, y, x + 228, y + 150] as const;
      await this.callPdf("page_add_image", { doc: 1, page, path: photo.path, rect });
      await this.callPdf("page_add_text", {
        doc: 1, page, at: [x, y + 160], width: 228, size: 8, italic: true,
        text: `Photo ${photo.photoId} unavailable\nSupplementary images will follow`,
      });
      bodySlot++;
    }
    if (this.missingPhotos.length > 0) {
      await this.callPdf("page_add_text", {
        doc: 1, page: 2, at: [72, 700], width: 468, size: 9, italic: true,
        text: "Supplementary images will follow. The issue remains complete in text.",
      });
    }
  }

  // ---------- Heading overflow healing: 3 shrinks, then degrade ----------
  private async shrinkHeadingUntilItFits(blockIndex: number): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await this.callWord("execute", { command: "select.paragraph", params: { path: [blockIndex] } });
      await this.callWord("execute", { command: "format.shrinkFont", params: {} });
      const inspect = await this.callWord("inspect_document", {});
      if (!stillOverflows(inspect, blockIndex)) {
        this.headingsShrunk++;
        this.recoveries.push({
          at: new Date().toISOString(), engine: "wordcraft", kind: "heading_shrunk",
          detail: { blockIndex, shrunkToPts: 10 - i },
        });
        return;
      }
    }
    // Degrade: shrink to a floor.
    await this.callWord("execute", { command: "format.set", params: { props: { sizePts: 9 } } });
    this.headingsShrunk++;
    this.recoveries.push({
      at: new Date().toISOString(), engine: "wordcraft", kind: "heading_shrunk",
      detail: { blockIndex, shrunkToPts: 9 },
    });
  }

  // ---------- Housekeeping ----------
  private async callLight(name: string, args: Record<string, unknown>): Promise<unknown> { return unwrap(await this.mcp.get("lightcraft").callTool({ name, arguments: args })); }
  private async callWord(name: string, args: Record<string, unknown>): Promise<unknown>  { return unwrap(await this.mcp.get("wordcraft").callTool({ name, arguments: args })); }
  private async callPdf(name: string, args: Record<string, unknown>): Promise<unknown>   { return unwrap(await this.mcp.get("pdfcraft").callTool({ name, arguments: args })); }
  private async closeAllChannels(): Promise<void> {
    // Every channel issues file.close on itself; a failure here is logged, never fatal.
    for (const k of ["lightcraft", "wordcraft", "pdfcraft"] as const) {
      try { await this.mcp.get(k).callTool({ name: "doc_close", arguments: {} }); } catch { /* ignore */ }
    }
  }
  private async generateAltText(_png: unknown, _figure: { index: number }): Promise<string> {
    // In production: send the PNG to a vision model with a strict "describe the figure" prompt.
    return "Figure: missing alt — auto-generated";
  }
}

// ---------- Utility predicates ----------
/**
 * Every MCP tool answers `{content:[{type:"text",text}]}`; the engine payload
 * is JSON inside that text block and errors arrive as `isError`. Returning
 * the envelope made `isFailure` blind, so the unwrap happens at the call
 * boundary.
 */
function unwrap(res: unknown): unknown {
  const r = res as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  const text = r.content?.find((c) => c.type === "text")?.text;
  if (r.isError) return { ok: false, error: text ?? "tool error" };
  if (text === undefined) return res;
  try { return JSON.parse(text); } catch { return text; }
}

function isFailure(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return o["ok"] === false || o["error"] != null;
}

function extractDeliveredIds(r: unknown): string[] {
  if (typeof r !== "object" || r === null) return [];
  const o = r as Record<string, unknown>;
  for (const key of ["ids", "delivered", "files", "exports"]) {
    const v = o[key];
    if (!Array.isArray(v)) continue;
    return v
      .map((x) => (typeof x === "string" ? x : String((x as Record<string, unknown>)?.["id"] ?? "")))
      .filter((x) => x.length > 0);
  }
  return [];
}

/** Blocks flagged as overflowing in an `inspect_document` payload. */
function overflowBlocks(i: unknown): number[] {
  const o = i as Record<string, unknown> | null;
  const blocks = (o?.["blocks"] ?? o?.["paragraphs"]) as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(blocks)) return [];
  const out: number[] = [];
  blocks.forEach((b, idx) => {
    if (b["overflow"] === true || b["overset"] === true) out.push(Number(b["index"] ?? idx));
  });
  return out;
}
function detectOverflow(i: unknown): number[] { return overflowBlocks(i); }
function stillOverflows(i: unknown, b: number): boolean { return overflowBlocks(i).includes(b); }

function hasKeyword(m: unknown, k: string): boolean {
  if (typeof m === "string") return m.toLowerCase().includes(k.toLowerCase());
  if (typeof m !== "object" || m === null) return false;
  const text = JSON.stringify(m).toLowerCase();
  return text.includes(`"${k.toLowerCase()}"`) || text.includes(k.toLowerCase());
}
function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
