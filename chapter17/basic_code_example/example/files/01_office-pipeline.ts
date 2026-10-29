/**
 * @file office-pipeline.ts
 * @description
 *   End-to-end headless office pipeline for a SaaS billing service.
 *
 *   Stage A — WordCraft (authoring):
 *       Spawn a WordCraft MCP server, build a structured statement
 *       document from validated JSON, save it as DOCX, and export a
 *       PDF seed file. The WordCraft process is torn down when the
 *       stage finishes, so no state leaks between jobs.
 *
 *   Stage B — PdfCraft (governance):
 *       Spawn a PdfCraft MCP server against the seed PDF, stamp
 *       document info (Title / Author / Subject), apply a diagonal
 *       "CONFIDENTIAL" watermark, flatten comments and form fields
 *       into the page content, then encrypt the file with AES-256
 *       under an owner password while leaving the document openable
 *       without a password. Save in place and close.
 *
 *   Stage C — Delivery:
 *       Read both artefacts back from the per-job working directory
 *       and return them as base64 payloads, together with byte
 *       counts and per-stage timings for observability.
 *
 *   The pipeline never trusts the incoming payload, never assumes
 *   the CLIs are on `$PATH` in a different form, and never leaves a
 *   child process alive past the end of its stage.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/* ------------------------------------------------------------------ *
 * 1. Payload contract — validated at the edge of the route handler.  *
 * ------------------------------------------------------------------ */

/**
 * The shape of the statement request the SaaS accepts. Zod validates
 * every field so that a hallucinated or malformed JSON body from an
 * upstream LLM agent never reaches the document pipeline.
 */
export const StatementRequestSchema = z.object({
  accountId: z.string().min(1),
  statementNumber: z.string().min(1),
  issuedAt: z.string().datetime(),
  currency: z.string().default("USD"),
  customer: z.object({
    name: z.string().min(1),
    email: z.string().email(),
    address: z.string().min(1),
  }),
  lineItems: z
    .array(
      z.object({
        sku: z.string().min(1),
        description: z.string().min(1),
        qty: z.number().int().positive(),
        unitPriceCents: z.number().int().nonnegative(),
      }),
    )
    .min(1),
});

export type StatementRequest = z.infer<typeof StatementRequestSchema>;

/** The shape returned to the web layer — pure base64 and metadata. */
export interface PipelineResult {
  docxBase64: string;
  pdfBase64: string;
  docxBytes: number;
  pdfBytes: number;
  workingDir: string;
  timings: {
    authoringMs: number;
    governanceMs: number;
    totalMs: number;
  };
}

/* ------------------------------------------------------------------ *
 * 2. MCP plumbing                                                     *
 * ------------------------------------------------------------------ */

/**
 * Spawns one ArtCraft CLI as an MCP stdio server and returns a
 * connected `Client`.
 *
 * The two servers take different arguments, and the difference is
 * load-bearing:
 *
 *   • `pdfcraft-cli mcp` accepts `--root DIR` and *enforces* it. A path
 *     outside the root is refused with "… is outside the allowed
 *     directory …".
 *   • `wordcraft-cli mcp` accepts no directory flag at all. It resolves
 *     relative paths against its own working directory, so the boundary
 *     is the `cwd` we hand it — and the *worker* owns it. The engine
 *     will happily write to an absolute path outside that directory, so
 *     the path policy below is not optional politeness: it is the
 *     sandbox.
 *
 * @param binary    - e.g. "wordcraft-cli" or "pdfcraft-cli".
 * @param workDir   - absolute path of the per-job working directory.
 */
async function connectCraftServer(
  binary: string,
  workDir: string,
): Promise<Client> {
  const args =
    binary === "pdfcraft-cli"
      ? ["mcp", "--root", workDir]
      : ["mcp"];

  const transport = new StdioClientTransport({
    command: binary,
    args,
    cwd: workDir,
    env: { ...process.env } as Record<string, string>,
  });

  const client = new Client(
    { name: `saas-office/${binary}`, version: "1.0.0" },
    { capabilities: {} },
  );

  await client.connect(transport);
  return client;
}

/**
 * The worker's own path policy. WordCraft resolves a path against its
 * working directory unless the path is absolute, and it does not police
 * the result — so every path we send is checked here first.
 *
 * Only a bare file name is accepted: no directory separator, no `..`,
 * no leading slash. The file lands in `workDir` and nowhere else.
 */
function assertSafeRelativePath(name: string): string {
  if (name.length === 0) throw new Error("empty path");
  if (path.isAbsolute(name)) throw new Error(`absolute path refused: ${name}`);
  if (name.includes("/") || name.includes("\\")) {
    throw new Error(`path separator refused: ${name}`);
  }
  if (name === "." || name === "..") throw new Error(`refused: ${name}`);
  return name;
}

/**
 * Unwraps a text-content response from an MCP tool into its parsed
 * JSON payload. Every ArtCraft MCP tool that returns data returns
 * it as a single `text` content block containing JSON. A tool that
 * failed answers with `isError: true` and a human-readable message —
 * that message is *not* JSON, so it is raised before the parse.
 */
function unwrapJson<T>(res: unknown): T {
  const envelope = res as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean | undefined;
  };
  const block = envelope.content?.find((c) => c.type === "text");
  if (envelope.isError) {
    throw new Error(`MCP tool reported an error: ${block?.text ?? "<no detail>"}`);
  }
  if (!block?.text) {
    throw new Error("MCP tool returned no text content block");
  }
  return JSON.parse(block.text) as T;
}

/* ------------------------------------------------------------------ *
 * 3. The pipeline                                                     *
 * ------------------------------------------------------------------ */

/**
 * The complete statement pipeline. Everything that touches a child
 * process is scoped to a `try / finally` so that no CLI outlives its
 * stage, even when an intermediate command throws.
 */
export async function buildGovernedStatement(
  raw: unknown,
): Promise<PipelineResult> {
  /* 3.1 — validate the incoming payload. */
  const req = StatementRequestSchema.parse(raw);

  /* 3.2 — allocate an isolated working directory for this job. */
  const jobId = randomUUID();
  const workingDir = path.join(tmpdir(), "saas-office", jobId);
  await mkdir(workingDir, { recursive: true });

  const docxRel = assertSafeRelativePath("statement.docx");
  const pdfRel  = assertSafeRelativePath("statement.pdf");

  const startedAt = Date.now();
  let authoringMs = 0;
  let governanceMs = 0;

  /* ------------------------------------------------------------------
   * 3.3 — STAGE A: WordCraft authors the DOCX and exports a PDF seed.
   * ------------------------------------------------------------------ */
  const wordcraft = await connectCraftServer("wordcraft-cli", workingDir);
  const authoringStart = Date.now();
  try {
    /* 3.3.1 — start from a blank document. */
    await wordcraft.callTool({
      name: "new_document",
      arguments: { template: "blank" },
    });

    /* 3.3.2 — stamp document properties: these ride into the PDF seed. */
    await wordcraft.callTool({
      name: "execute",
      arguments: {
        command: "file.properties",
        params: {
          title: `Statement ${req.statementNumber}`,
          subject: `Account statement for ${req.customer.name}`,
          author: "Acme SaaS Billing",
          keywords: `statement,${req.accountId},${req.currency}`,
          comments: `Generated at ${req.issuedAt}`,
        },
      },
    });

    /* 3.3.3 — title block: heading, centred; subtitle in italics. */
    await wordcraft.callTool({
      name: "batch",
      arguments: {
        keepGoing: false,
        commands: [
          { command: "para.style", params: { style: "Heading 1" } },
          { command: "para.align", params: { value: "center" } },
          { command: "text.insert", params: { text: `Statement #${req.statementNumber}` } },
          { command: "text.newParagraph", params: {} },
          { command: "para.style", params: { style: "Normal" } },
          { command: "format.italic", params: { value: true } },
          { command: "text.insert", params: { text: `Issued ${req.issuedAt} · ${req.currency}` } },
          { command: "format.italic", params: { value: false } },
          { command: "text.newParagraph", params: {} },
        ],
      },
    });

    /* 3.3.4 — customer block: one paragraph per line. */
    await wordcraft.callTool({
      name: "type_text",
      arguments: {
        paragraphs: true,
        text: `Bill to:\n${req.customer.name}\n${req.customer.address}\n${req.customer.email}`,
      },
    });

    /* 3.3.5 — a blank paragraph between the address and the table. */
    await wordcraft.callTool({
      name: "execute",
      arguments: { command: "text.newParagraph", params: {} },
    });

    /* 3.3.6 — build a CSV-accurate line-item table from the payload. */
    const csvRows: string[] = ["SKU,Description,Qty,Amount"];
    for (const item of req.lineItems) {
      const amount = ((item.qty * item.unitPriceCents) / 100).toFixed(2);
      const desc = `"${item.description.replace(/"/g, '""')}"`;
      csvRows.push(`${item.sku},${desc},${item.qty},${req.currency} ${amount}`);
    }
    await wordcraft.callTool({
      name: "execute",
      arguments: {
        command: "insert.spreadsheet",
        params: { csv: csvRows.join("\n") },
      },
    });

    /* 3.3.7 — closing paragraph under the table. */
    await wordcraft.callTool({
      name: "execute",
      arguments: { command: "text.newParagraph", params: {} },
    });
    await wordcraft.callTool({
      name: "execute",
      arguments: { command: "text.newParagraph", params: {} },
    });

    /* 3.3.8 — "Page x of y" footer, then exit header/footer mode. */
    await wordcraft.callTool({
      name: "execute",
      arguments: {
        command: "insert.pageNumber",
        params: { position: "bottom", align: "center", format: "x of y" },
      },
    });
    await wordcraft.callTool({
      name: "execute",
      arguments: { command: "insert.closeHeader", params: {} },
    });

    /* 3.3.9 — persist the DOCX and export the PDF seed. */
    await wordcraft.callTool({
      name: "save_document",
      arguments: { path: docxRel },
    });
    await wordcraft.callTool({
      name: "execute",
      arguments: {
        command: "file.exportPdf",
        params: { path: pdfRel },
      },
    });

    authoringMs = Date.now() - authoringStart;
  } finally {
    await wordcraft.close();
  }

  /* ------------------------------------------------------------------
   * 3.4 — STAGE B: PdfCraft governs the exported PDF.
   * ------------------------------------------------------------------ */
  const pdfcraft = await connectCraftServer("pdfcraft-cli", workingDir);
  const governanceStart = Date.now();
  try {
    /* 3.4.1 — open the seed PDF. PdfCraft returns an id + page count. */
    const openRes = unwrapJson<{ doc: number; pages: number; editable: boolean }>(
      await pdfcraft.callTool({
        name: "doc_open",
        arguments: { path: pdfRel },
      }),
    );
    const docId = openRes.doc;

    /* 3.4.2 — stamp the PDF metadata dictionary. */
    for (const [key, value] of [
      ["Title",    `Statement ${req.statementNumber}`],
      ["Author",   "Acme SaaS Billing"],
      ["Subject",  `Account statement for ${req.customer.name}`],
      ["Keywords", `statement;${req.accountId};${req.currency}`],
    ] as const) {
      await pdfcraft.callTool({
        name: "doc_set_info",
        arguments: { doc: docId, key, value },
      });
    }

    /* 3.4.3 — diagonal watermark, low opacity, behind the content. */
    await pdfcraft.callTool({
      name: "doc_watermark",
      arguments: {
        doc: docId,
        text: "ACME · CONFIDENTIAL",
        rotation: 45,
        opacity: 0.15,
        color: "#8a94a6",
        behind: true,
      },
    });

    /* 3.4.4 — flatten comments and form fields into page content so
       downstream readers cannot accidentally reveal pre-flatten data. */
    await pdfcraft.callTool({
      name: "doc_flatten",
      arguments: { doc: docId, comments: true, fields: true },
    });

    /* 3.4.5 — encrypt. No open password → anyone with the file can
       read it; an owner password is required to change permissions. */
    await pdfcraft.callTool({
      name: "doc_protect",
      arguments: {
        doc: docId,
        permissions_password: process.env.PDF_OWNER_PASSWORD!,
        printing: "high",
        changes: "fill-sign",
        copy: false,
        accessibility: true,
        compatibility: "aes-256",
        encrypt_metadata: true,
      },
    });

    /* 3.4.6 — full rewrite (required for encryption), then close. */
    await pdfcraft.callTool({
      name: "doc_save",
      arguments: { doc: docId, full: true },
    });
    await pdfcraft.callTool({
      name: "doc_close",
      arguments: { doc: docId },
    });

    governanceMs = Date.now() - governanceStart;
  } finally {
    await pdfcraft.close();
  }

  /* ------------------------------------------------------------------
   * 3.5 — STAGE C: read both artefacts back for the web layer.
   * ------------------------------------------------------------------ */
  const [docxBuf, pdfBuf] = await Promise.all([
    readFile(path.join(workingDir, docxRel)),
    readFile(path.join(workingDir, pdfRel)),
  ]);

  return {
    docxBase64: docxBuf.toString("base64"),
    pdfBase64: pdfBuf.toString("base64"),
    docxBytes: docxBuf.byteLength,
    pdfBytes: pdfBuf.byteLength,
    workingDir,
    timings: {
      authoringMs,
      governanceMs,
      totalMs: Date.now() - startedAt,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 4. Web layer — a Next.js App Router handler that wraps the pipeline.
 *    (Drop this into `app/api/statements/route.ts`.)
 * ------------------------------------------------------------------ */

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json();
    const result = await buildGovernedStatement(body);

    return Response.json({
      docx: {
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        base64: result.docxBase64,
        bytes: result.docxBytes,
      },
      pdf: {
        mime: "application/pdf",
        base64: result.pdfBase64,
        bytes: result.pdfBytes,
      },
      timings: result.timings,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: "invalid_payload", issues: err.issues }, { status: 422 });
    }
    const message = err instanceof Error ? err.message : "unknown_error";
    return Response.json({ error: "pipeline_failed", message }, { status: 500 });
  }
}

/* ------------------------------------------------------------------ *
 * 5. Tool-invocation signature contract (framework bridge).
 *
 *    When the same pipeline is exposed to a LangGraph / agent runtime
 *    as a callable tool, the LLM emits a JSON argument object that must
 *    be handed to the handler below. This is the "tool invocation
 *    signature" the framework expects: a single params object in, an
 *    awaitable result out.
 * ------------------------------------------------------------------ */
export const toolInvocation = {
  name: "build_governed_statement",
  description:
    "Author a DOCX statement via WordCraft and return a governed PDF via PdfCraft.",
  parameters: StatementRequestSchema,
  handler: async (params: StatementRequest): Promise<PipelineResult> =>
    buildGovernedStatement(params),
} as const;
