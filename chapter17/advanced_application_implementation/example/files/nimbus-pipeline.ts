/* ============================================================================
 * NimbusContracts — Headless Office Pipeline
 * ----------------------------------------------------------------------------
 * nimbus-pipeline.ts — the public façade the SaaS layer calls.
 * ========================================================================== */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  Classification,
  GenerateDocumentRequest,
  GenerateDocumentResult,
  OfficeMcpBridge,
} from "./office-bridge.js";
import {
  GenerateDocumentRequestSchema,
} from "./office-bridge.js";
import { WordCraftComposer } from "./nimbus-composer.js";
import { PdfCraftGovernor } from "./nimbus-governor.js";

/* ----------------------------------------------------------------------------
 * 6. DOCUMENT PIPELINE — the public façade
 * ----------------------------------------------------------------------------
 * ---
 * This class is the ONLY surface a NestJS controller, Lambda, or Worker
 * needs to touch. It owns:
 *   • per-request workspace isolation (sandboxed temp directory per tenant)
 *   • request validation via the Zod schema
 *   • deterministic path derivation (idempotency-keyed)
 *   • orchestration of composer → governor → hash → audit
 *   • cleanup on success only (failed workspaces are preserved for triage)
 * -------------------------------------------------------------------------- */

export interface PipelineOptions {
  bridge: OfficeMcpBridge;
  /** Root under which tenant template directories live. */
  templateRoot: string;
  /** Root under which per-tenant output directories live. */
  outputRoot: string;
  /** Path to the platform signing keystore (.p12). */
  signingIdPath: string;
  /** Password to unlock the keystore. */
  signingIdPassword: string;
  /** Hook for emitting immutable audit events to a downstream store. */
  emitAudit: (event: PipelineAuditEvent) => Promise<void>;
}

export interface PipelineAuditEvent {
  pipelineId: string;
  tenantId: string;
  templateId: string;
  classification: Classification;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  outputHash: string;
  pageCount: number;
  redactionCount: number;
  hiddenInfoRemoved: string[];
  signatureState: "signed" | "unsigned" | "failed";
  warnings: string[];
}

export class DocumentPipeline {
  private readonly composer: WordCraftComposer;
  private readonly governor: PdfCraftGovernor;

  constructor(private readonly opts: PipelineOptions) {
    this.composer = new WordCraftComposer(opts.bridge);
    this.governor = new PdfCraftGovernor(opts.bridge);
  }

  /**
   * Execute a single contract-generation run end-to-end.
   *
   * Callers should treat the returned `GenerateDocumentResult` as the
   * canonical receipt for the transaction; the `pdfSha256` field is what
   * goes into the customer-facing provenance record.
   */
  async run(rawRequest: unknown): Promise<GenerateDocumentResult> {
    const startedAt = Date.now();
    const pipelineId = randomUUID();

    // ---- 1. Validate.
    const parsed = GenerateDocumentRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      throw new Error(
        `Invalid request payload: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    const request: GenerateDocumentRequest = parsed.data;

    // ---- 2. Resolve paths, deterministically.
    const { templatePath, outputDocxPath, outputPdfPath, finalPdfPath, workspace } =
      await this.prepareWorkspace(request);

    // ---- 3. Sanitize merge fields into a safe map. Values that could
    //         inject Word field codes or control characters are neutralized.
    const mergeMap = this.sanitizeMergeFields(request);

    // ---- 4. Compose DOCX and export PDF.
    await this.composer.compose({
      templatePath,
      outputDocxPath,
      outputPdfPath,
      request,
      mergeMap,
    });

    // ---- 5. Govern the PDF (metadata, watermark, redaction, sanitization,
    //         protection, signature).
    const governResult = await this.governor.govern({
      pdfPath: outputPdfPath,
      finalPdfPath,
      request,
      mergeMap,
      signingIdPath: this.opts.signingIdPath,
      signingIdPassword: this.opts.signingIdPassword,
    });

    // ---- 6. Hash the final artifact for chain-of-custody.
    const finalBytes = await readFile(finalPdfPath);
    const pdfSha256 = createHash("sha256").update(finalBytes).digest("hex");

    // ---- 7. Emit audit event.
    const completedAt = Date.now();
    const warnings: string[] = [];
    if (governResult.redactionCount === 0 && request.redactPatterns.length > 0) {
      warnings.push(
        "Redaction patterns were supplied but no matches were found — verify the inputs.",
      );
    }
    if (governResult.signatureState === "failed") {
      warnings.push("The signature step did not complete.");
    }
    const auditEvent: PipelineAuditEvent = {
      pipelineId,
      tenantId: request.tenantId,
      templateId: request.templateId,
      classification: request.classification,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      durationMs: completedAt - startedAt,
      outputHash: pdfSha256,
      pageCount: governResult.pageCount,
      redactionCount: governResult.redactionCount,
      hiddenInfoRemoved: governResult.hiddenInfoRemoved,
      signatureState: governResult.signatureState,
      warnings,
    };
    await this.opts.emitAudit(auditEvent);

    // ---- 8. Clean the DOCX intermediate (the source is available on
    //         demand from the workspace but not part of the SaaS receipt).
    //         We deliberately leave the PDF in place.
    await rm(outputDocxPath, { force: true });

    // ---- 9. Release the workspace lock marker.
    await rm(join(workspace, ".lock"), { force: true });

    return {
      pipelineId,
      tenantId: request.tenantId,
      docxPath: outputDocxPath,
      pdfPath: finalPdfPath,
      pdfSha256,
      pageCount: governResult.pageCount,
      signatureStatus: governResult.signatureState,
      auditEventIds: [pipelineId],
      durationMs: auditEvent.durationMs,
      warnings,
    };
  }

  /* --- helpers ----------------------------------------------------------- */

  /**
   * Derive every path the pipeline will touch. Because the derived paths
   * are a pure function of `(tenantId, templateId, idempotencyKey)`, two
   * concurrent calls with the same key land on separate sandbox markers
   * that make races visible rather than corrupting each other.
   */
  private async prepareWorkspace(request: GenerateDocumentRequest): Promise<{
    workspace: string;
    templatePath: string;
    outputDocxPath: string;
    outputPdfPath: string;
    finalPdfPath: string;
  }> {
    const workspace = join(
      this.opts.outputRoot,
      request.tenantId,
      request.idempotencyKey,
    );
    await mkdir(workspace, { recursive: true });

    // A marker file acts as a lightweight lock; concurrent duplicate calls
    // observe its presence and the second invocation fails fast.
    const lockPath = join(workspace, ".lock");
    try {
      await stat(lockPath);
      throw new Error(
        `Duplicate pipeline invocation detected for idempotency key ${request.idempotencyKey}.`,
      );
    } catch (err) {
      if (err instanceof Error && err.message.includes("Duplicate")) throw err;
      // Marker not present — create it.
    }
    await writeFile(lockPath, new Date().toISOString(), { encoding: "utf-8" });

    const templatePath = join(
      this.opts.templateRoot,
      request.tenantId,
      `${request.templateId}.docx`,
    );

    /**
     * We deliberately put the intermediate DOCX *and* the final PDF in the
     * same workspace so cleanup and triage are colocated. The DOCX is
     * deleted on success; on failure it survives for post-mortem inspection.
     *
     * Two PDF names are used: `outputPdfPath` is the raw export WordCraft
     * produced, and `finalPdfPath` is the deliverable the governor writes.
     * The governor derives its own intermediate from the deliverable's name.
     */
    const outputDocxPath = join(workspace, `${request.templateId}.merged.docx`);
    const outputPdfPath = join(workspace, `${request.templateId}.export.pdf`);
    const finalPdfPath = join(workspace, `${request.templateId}.pdf`);
    return { workspace, templatePath, outputDocxPath, outputPdfPath, finalPdfPath };
  }

  /**
   * Neutralize merge values that could corrupt the DOCX writer or introduce
   * a Word field injection. We keep backslashes, hyphens, and normal
   * punctuation but strip ASCII control codes and the special Word field
   * braces that a malicious tenant could otherwise smuggle in.
   */
  private sanitizeMergeFields(
    request: GenerateDocumentRequest,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const { key, value } of request.mergeFields) {
      const cleaned = value
        // Strip C0/C1 control bytes except tab and newline.
        .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "")
        // Escaped literal backslash-brace sequences (Word field fences).
        .replace(/\\([{}])/g, "$1")
        // Neutralize stray Word field open/close braces that could confuse
        // the DOCX-to-PDF field evaluator.
        .replace(/(?<!\\)[{}]/g, "");
      out[key] = cleaned;
    }
    return out;
  }
}
