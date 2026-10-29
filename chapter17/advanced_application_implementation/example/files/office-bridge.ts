/* ============================================================================
 * NimbusContracts — Headless Office Pipeline
 * ----------------------------------------------------------------------------
 * office-bridge.ts — the request contract, the shared types and the MCP
 * transport layer that every other module in the pipeline goes through.
 *
 * A production-grade MCP orchestrator that turns structured vendor data into
 * a governed, watermarked, redacted, signed PDF using WordCraft (DOCX
 * composition & PDF export) and PdfCraft (governance, redaction, signatures).
 *
 * Runtime target: Node.js >= 20, @modelcontextprotocol/sdk >= 1.x
 *
 * The module intentionally separates:
 *   • OfficeMcpBridge   — owns stdio transports, capability gating, retries
 *   • WordCraftComposer — knows how *this tenant's* DOCX template works
 *   • PdfCraftGovernor  — encodes the compliance policy as a fixed pass order
 *   • DocumentPipeline  — the public façade the SaaS layer calls
 *
 * Every MCP invocation goes through typed helper wrappers so callers never
 * touch raw `client.callTool` and every result is validated as it returns.
 * ========================================================================== */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

/* ----------------------------------------------------------------------------
 * 1. DOMAIN SCHEMAS
 * ----------------------------------------------------------------------------
 * Zod schemas are the single point of truth for what a tenant is allowed to
 * send. They are validated *before* we ever spawn an MCP subprocess, which
 * keeps the blast radius of malformed input to the orchestrator itself.
 * -------------------------------------------------------------------------- */

/** Classification levels drive watermark text, redaction scope, and metadata. */
export const ClassificationSchema = z.enum(["public", "internal", "confidential", "restricted"]);
export type Classification = z.infer<typeof ClassificationSchema>;

/** The supported contractual document types. Each maps to a DOCX template. */
export const TemplateIdSchema = z.enum(["MSA-v7", "SOW-v4", "NDA-EU-v3", "INVOICE-2024"]);
export type TemplateId = z.infer<typeof TemplateIdSchema>;

/** A single merge placeholder and the value the tenant wants substituted. */
export const MergeFieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/,
    "Placeholder keys are snake_case identifiers used inside {{ ... }} tokens."),
  value: z.string().max(4096),
});

/** One audit-relevant action the caller wants recorded after signing. */
export const AuditAnnotationSchema = z.object({
  author: z.string().min(2).max(120),
  text: z.string().min(1).max(2000),
});

/** The full request body a tenant SaaS endpoint accepts. */
export const GenerateDocumentRequestSchema = z.object({
  /** Stable tenant identifier — controls policy routing and output paths. */
  tenantId: z.string().regex(/^t_[a-z0-9]{6,32}$/),
  /** Which legal template to instantiate. */
  templateId: TemplateIdSchema,
  /** Free-form merge values; unknown keys are tolerated but unused. */
  mergeFields: z.array(MergeFieldSchema).max(512),
  /** Compliance classification; drives watermark and redaction scope. */
  classification: ClassificationSchema,
  /** Fields to search-and-destroy in the final PDF (regex literals). */
  redactPatterns: z.array(z.string().min(3).max(200)).max(64).default([]),
  /** Whether the platform signature authority must countersign the PDF. */
  requireSignature: z.boolean().default(true),
  /** When true, the PDF is opened with an empty open password. */
  encryptAtRest: z.boolean().default(false),
  /** Reviewer name(s) surfaced in the PDF's Document Info → Author field. */
  documentAuthor: z.string().min(2).max(120),
  /** Optional annotations inserted *after* signing as a certification trail. */
  auditAnnotations: z.array(AuditAnnotationSchema).max(32).default([]),
  /** Idempotency key — identical keys must produce byte-identical results. */
  idempotencyKey: z.string().min(16).max(128),
});

export type GenerateDocumentRequest = z.infer<typeof GenerateDocumentRequestSchema>;

/** Structured result returned to the SaaS caller. */
export interface GenerateDocumentResult {
  pipelineId: string;
  tenantId: string;
  docxPath: string;
  pdfPath: string;
  pdfSha256: string;
  pageCount: number;
  signatureStatus: "signed" | "unsigned" | "failed";
  auditEventIds: string[];
  durationMs: number;
  warnings: string[];
}

/* ----------------------------------------------------------------------------
 * 2. LOW-LEVEL TYPES FOR THE TWO MCP SERVERS
 * ----------------------------------------------------------------------------
 * We keep result shapes loose (`unknown`) at the call-site and validate with
 * narrow zod schemas right where the data is consumed — this makes the
 * pipeline resilient to additive changes in the ArtCraft runtimes.
 * -------------------------------------------------------------------------- */

/** Envelope for a PdfCraft doc_open reply. */
export const PdfCraftOpenReplySchema = z.object({
  doc: z.number().int().positive(),
  pages: z.number().int().nonnegative(),
  editable: z.boolean().optional(),
});

/** Envelope for a PdfCraft doc_info reply (partial — we only read what we use). */
export const PdfCraftInfoReplySchema = z.object({
  author: z.string().nullable().optional(),
  creator: z.string().nullable().optional(),
  keywords: z.string().nullable().optional(),
  annotations: z.array(z.unknown()).optional(),
  attachments: z.array(z.unknown()).optional(),
  fields: z.array(z.unknown()).optional(),
  links: z.array(z.unknown()).optional(),
  outline: z.array(z.unknown()).optional(),
  has_javascript: z.boolean().optional(),
  pages: z.number().int().nonnegative().optional(),
});

/**
 * The MCP reply envelope. Every ArtCraft tool answers with a `content` array;
 * the payload is the first `text` block, and a failure is flagged by
 * `isError` rather than by the payload's shape.
 */
const McpReplySchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  isError: z.boolean().optional(),
});

/* ----------------------------------------------------------------------------
 * 3. OFFICE MCP BRIDGE
 * ----------------------------------------------------------------------------
 * The bridge is the only component that knows about `StdioClientTransport`.
 * It owns:
 *   • process lifecycle (spawn, graceful close, TCP fallback in desktop mode)
 *   • capability negotiation (fails fast if a server lacks a required tool)
 *   • exponential-backoff retries for transient transport errors
 *   • tool-level wrappers that hide the SDK's generic callTool signature
 * -------------------------------------------------------------------------- */

export interface BridgeOptions {
  /** Absolute path to the `wordcraft-cli` binary. */
  wordcraftBinary: string;
  /** Absolute path to the `pdfcraft-cli` binary. */
  pdfcraftBinary: string;
  /** Directory the two servers are allowed to touch. */
  readRoot: string;
  /** Directory the two servers are allowed to write to. */
  writeRoot: string;
  /** Per-call timeout in milliseconds (default 120 000). */
  callTimeoutMs?: number;
}

export class OfficeMcpBridge {
  private readonly opts: Required<BridgeOptions>;
  private wc: Client | null = null;
  private pc: Client | null = null;

  constructor(opts: BridgeOptions) {
    this.opts = {
      callTimeoutMs: 120_000,
      ...opts,
    };
  }

  /** Establish both stdio sessions and verify the tools we depend on exist. */
  async connect(): Promise<void> {
    const { wordcraftBinary, pdfcraftBinary, readRoot, writeRoot } = this.opts;

    /**
     * Transport for WordCraft — DOCX composition + PDF export.
     *
     * `wordcraft-cli mcp` accepts `--connect HOST:PORT` and nothing else: it
     * has no directory flag and it does not police the file system. The
     * boundary is therefore the working directory we hand it, and the
     * *worker* owns the policy — every path the composer sends is a bare
     * file name that resolves inside `writeRoot`.
     */
    const wcTransport = new StdioClientTransport({
      command: wordcraftBinary,
      args: ["mcp"],
      cwd: writeRoot,
      env: process.env as Record<string, string>,
    });

    /**
     * Transport for PdfCraft — governance, redaction, signatures.
     *
     * `pdfcraft-cli mcp` takes `--root DIR`, and the server *enforces* it:
     * a path outside the root is refused with "… is outside the allowed
     * directory …".
     */
    const pcTransport = new StdioClientTransport({
      command: pdfcraftBinary,
      args: ["mcp", "--root", writeRoot],
      cwd: writeRoot,
      env: process.env as Record<string, string>,
    });

    this.wc = new Client(
      { name: "nimbus-contracts-wordcraft", version: "3.2.0" },
      { capabilities: {} },
    );
    this.pc = new Client(
      { name: "nimbus-contracts-pdfcraft", version: "3.2.0" },
      { capabilities: {} },
    );

    await Promise.all([
      this.wc.connect(wcTransport),
      this.pc.connect(pcTransport),
    ]);

    // Capability gating: fail loudly and early if a required tool is missing.
    await this.assertToolExists(this.wc, "execute");
    await this.assertToolExists(this.wc, "batch");
    await this.assertToolExists(this.pc, "doc_open");
    await this.assertToolExists(this.pc, "sign_document");
    await this.assertToolExists(this.pc, "redact_apply");
  }

  /** Shut both servers down cleanly, swallowing benign teardown errors. */
  async close(): Promise<void> {
    await Promise.allSettled([this.wc?.close(), this.pc?.close()]);
    this.wc = null;
    this.pc = null;
  }

  /**
   * Run a single WordCraft command via its `execute` meta-tool. The bridge
   * retries on stdio transport faults; a command-level failure is surfaced
   * unchanged so the composer can react.
   */
  async wcExecute<T = unknown>(
    command: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    if (!this.wc) throw new Error("WordCraft client is not connected.");
    const reply = await this.withRetry(() =>
      this.wc!.callTool({
        name: "execute",
        arguments: { command, params },
      }),
    );
    return this.unwrapWordCraftReply<T>(command, reply);
  }

  /** Run a batch of WordCraft commands in a single round trip. */
  async wcBatch<T = unknown>(
    commands: Array<{ command: string; params?: Record<string, unknown> }>,
    keepGoing = false,
  ): Promise<T> {
    if (!this.wc) throw new Error("WordCraft client is not connected.");
    const reply = await this.withRetry(() =>
      this.wc!.callTool({
        name: "batch",
        arguments: { commands, keepGoing },
      }),
    );
    return this.unwrapWordCraftReply<T>("batch", reply);
  }

  /**
   * Call a PdfCraft tool by its direct name. PdfCraft's MCP surface exposes
   * each governance verb as its own tool (`doc_watermark`, `redact_apply`,
   * `sign_document`, …) rather than a single `execute` — this wrapper hides
   * that asymmetry from callers.
   */
  async pdfCall<T = unknown>(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    if (!this.pc) throw new Error("PdfCraft client is not connected.");
    const reply = await this.withRetry(() =>
      this.pc!.callTool({ name: tool, arguments: args }),
    );
    return this.unwrapPdfCraftReply<T>(tool, reply);
  }

  /* --- private helpers --------------------------------------------------- */

  /** Verify a tool exists on the given client, throwing a named error if not. */
  private async assertToolExists(client: Client, name: string): Promise<void> {
    const { tools } = await client.listTools();
    if (!tools.some((t) => t.name === name)) {
      throw new Error(
        `Fatal capability mismatch: MCP server does not expose tool "${name}".`,
      );
    }
  }

  /**
   * Unwrap an MCP reply into the JSON payload the engine returned.
   *
   * Both servers answer with `{ content: [{ type: "text", text }] }`. The
   * text is a JSON document on success and a plain sentence on failure, and
   * the failure is flagged by `isError` — so the flag is checked *before*
   * the parse, or the error message would be reported as a syntax error.
   */
  private unwrapMcpReply<T>(tool: string, reply: unknown): T {
    const parsed = McpReplySchema.safeParse(reply);
    if (!parsed.success) {
      throw new Error(`${tool} returned an unparsable MCP envelope.`);
    }
    const text = parsed.data.content?.find((c) => c.type === "text")?.text;
    if (parsed.data.isError) {
      throw new Error(`${tool} failed: ${text ?? "<no detail>"}`);
    }
    if (text === undefined) {
      throw new Error(`${tool} returned no text content block.`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      // A tool may answer with plain text (a rendered snippet, a warning).
      return text as unknown as T;
    }
  }

  /** Wire the WordCraft reply into a normal return value. */
  private unwrapWordCraftReply<T>(command: string, reply: unknown): T {
    return this.unwrapMcpReply<T>(`WordCraft command "${command}"`, reply);
  }

  /** Wire the PdfCraft tool reply into a normal return value. */
  private unwrapPdfCraftReply<T>(tool: string, reply: unknown): T {
    return this.unwrapMcpReply<T>(`PdfCraft tool "${tool}"`, reply);
  }

  /** Bounded exponential backoff suited to stdio transport hiccups. */
  private async withRetry<T>(
    thunk: () => Promise<T>,
    attempts = 3,
    baseDelayMs = 250,
  ): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await this.raceWithTimeout(thunk(), this.opts.callTimeoutMs);
      } catch (err) {
        lastErr = err;
        if (i === attempts - 1) break;
        await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** Hard ceiling on any single tool call so the worker never stalls forever. */
  private raceWithTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`MCP call timed out after ${ms} ms.`)),
        ms,
      );
      p.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }
}
