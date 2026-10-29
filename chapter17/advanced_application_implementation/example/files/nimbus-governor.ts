/* ============================================================================
 * NimbusContracts — Headless Office Pipeline
 * ----------------------------------------------------------------------------
 * nimbus-governor.ts — the PdfCraft half: the compliance policy, encoded as a
 * fixed, ordered sequence of passes.
 *
 * Reordering these calls will silently break downstream guarantees — in
 * particular, signature-before-mutation renders the cryptographic seal
 * invalid, and protection-before-redaction hides content from the redactor.
 * ========================================================================== */

import { createHash } from "node:crypto";
import { copyFile } from "node:fs/promises";

import type {
  GenerateDocumentRequest,
  OfficeMcpBridge,
} from "./office-bridge.js";
import {
  PdfCraftOpenReplySchema,
} from "./office-bridge.js";

export interface GovernContext {
  /** Absolute path to the PDF freshly exported by WordCraft. */
  pdfPath: string;
  /** Absolute path to the hardened, signed PDF we aim to produce. */
  finalPdfPath: string;
  /** The validated request (classification, patterns, signature flag). */
  request: GenerateDocumentRequest;
  /** Merge map — used to build structured watermark text. */
  mergeMap: Record<string, string>;
  /** Path to the signing authority's .p12 keystore. */
  signingIdPath: string;
  /** Password to unlock the signing keystore. */
  signingIdPassword: string;
}

export interface GovernResult {
  pageCount: number;
  redactionCount: number;
  hiddenInfoRemoved: string[];
  signatureState: "signed" | "unsigned" | "failed";
  /** The governed-but-unsigned intermediate every artefact derives from. */
  governedPdfPath: string;
  /** The encrypted copy, when the request asked for one. */
  encryptedPdfPath?: string;
}

export class PdfCraftGovernor {
  constructor(private readonly bridge: OfficeMcpBridge) {}

  /**
   * Run the full governance pipeline in fixed order.
   *
   *   A. doc_open          — acquire a doc handle
   *   B. doc_set_info      — write DMS-facing metadata
   *   C. doc_watermark     — apply classification banner
   *   D. doc_header_footer — add page numbers + audit header
   *   E. redact_mark + redact_apply — search & destroy sensitive spans
   *   F. doc_remove_hidden — strip the hidden metadata/attachments classes
   *   G. doc_save          — write the governed intermediate
   *
   * and then, from that intermediate, two *independent* derivations:
   *
   *   H. sign_document     — the signed edition (when a signature is required)
   *   I. doc_protect       — the encrypted edition (when encryption is required)
   *
   * The two derivations are independent on purpose. PdfCraft refuses both
   * orders of "sign then encrypt":
   *
   *   • `sign_document` on an encrypted document answers
   *     "not supported: signing encrypted documents".
   *   • `doc_protect` on a signed document answers "Protect with password
   *     isn't possible in a signed document: it would rewrite the file and
   *     invalidate the signatures".
   *
   * so a caller who wants both artefacts gets two *files*, each with one
   * envelope, rather than one file with two contradictory ones.
   */
  async govern(ctx: GovernContext): Promise<GovernResult> {
    const {
      pdfPath, finalPdfPath, request, mergeMap,
      signingIdPath, signingIdPassword,
    } = ctx;

    const governedPdfPath = this.withSuffix(finalPdfPath, ".governed");
    let redactionCount = 0;
    let hiddenInfoRemoved: string[] = [];

    /* ---------------------------------------------------------------- *
     * A. Open the working copy.
     * ---------------------------------------------------------------- */
    const openReply = await this.bridge.pdfCall<unknown>("doc_open", {
      path: pdfPath,
    });
    const { doc, pages } = PdfCraftOpenReplySchema.parse(openReply);
    if (!doc) throw new Error("PdfCraft failed to return a doc handle.");
    if (!pages) throw new Error("PdfCraft reports a zero-page document.");

    try {
      /* -------------------------------------------------------------- *
       * B. DMS-facing metadata. Consumers index on these keys.
       * -------------------------------------------------------------- */
      const metadataWrites: Array<{ key: string; value: string }> = [
        { key: "Title",  value: mergeMap["document_title"] ?? request.templateId },
        { key: "Author", value: request.documentAuthor },
        { key: "Subject", value: `Classification: ${request.classification}` },
        {
          key: "Keywords",
          value: [
            `tenant:${request.tenantId}`,
            `classification:${request.classification}`,
            `template:${request.templateId}`,
            `idempotency:${request.idempotencyKey}`,
          ].join(","),
        },
        { key: "Creator", value: "NimbusContracts" },
        { key: "Producer", value: "WordCraft + PdfCraft" },
      ];
      for (const { key, value } of metadataWrites) {
        await this.bridge.pdfCall("doc_set_info", { doc, key, value });
      }

      /* -------------------------------------------------------------- *
       * C. Classification watermark. Public documents are untouched;
       *    everything else gets a diagonal banner whose opacity is a
       *    function of classification severity.
       * -------------------------------------------------------------- */
      const watermark = this.buildWatermark(request, mergeMap);
      if (watermark) {
        await this.bridge.pdfCall("doc_watermark", {
          doc,
          text: watermark.text,
          rotation: 45,
          opacity: watermark.opacity,
          color: watermark.color,
          behind: true,
        });
      }

      /* -------------------------------------------------------------- *
       * D. Header/footer. Footer carries a monotonically increasing
       *    numeric page index alongside the pipeline id for forensics.
       * -------------------------------------------------------------- */
      await this.bridge.pdfCall("doc_header_footer", {
        doc,
        header_left: `${request.templateId} — ${request.classification.toUpperCase()}`,
        header_right: request.tenantId,
        footer_center: "Page <<1>> of <<n>>",
        footer_right: `pid:${request.idempotencyKey.slice(0, 12)}`,
        font_size: 8,
      });

      /* -------------------------------------------------------------- *
       * E. Redaction. Patterns are tenant-supplied literals; we mark
       *    every match on every page and then apply — the two-phase
       *    (mark → apply) protocol is important because it lets us count
       *    what will be destroyed before we destroy it.
       * -------------------------------------------------------------- */
      for (const pattern of request.redactPatterns) {        // PdfCraft's `redact_mark` accepts a `pattern` enum for common cases
        // (phone, email, credit-card, ssn, date) OR a `find` literal. We treat
        // the tenant string as a `find` unless it exactly matches the enum.
        const isEnumPattern = (
          ["phone", "email", "credit-card", "ssn", "date"] as const
        ).includes(pattern as never);
        const markArgs: Record<string, unknown> = {
          doc,
          fill: "#000000",
          author: "NimbusContracts Redactor",
        };
        if (isEnumPattern) markArgs.pattern = pattern;
        else markArgs.find = pattern;

        await this.bridge.pdfCall("redact_mark", markArgs);
      }
      // Apply on all pages. The reply carries the number of marks that were
      // actually destroyed — that is the count the audit trail records.
      const applied = await this.bridge.pdfCall<{ applied?: number }>(
        "redact_apply",
        { doc },
      );
      redactionCount = applied.applied ?? 0;

      /* -------------------------------------------------------------- *
       * F. Hidden-information sanitization. We deliberately strip the
       *    classes we do not want downstream reviewers to see, but we
       *    *keep* bookmarks — they are useful to the recipient and
       *    carry no sensitive payload after metadata stripping.
       * -------------------------------------------------------------- */
      hiddenInfoRemoved = await this.removeHiddenInformation(doc);

      /* -------------------------------------------------------------- *
       * G. Persist the governed intermediate. Both derivations below
       *    start from this file, so it is written in full.
       * -------------------------------------------------------------- */
      await this.bridge.pdfCall("doc_save", { doc, path: governedPdfPath, full: true });
    } finally {
      await this.bridge.pdfCall("doc_close", { doc, discard_changes: true });
    }

    /* ---------------------------------------------------------------- *
     * H. The signed edition.
     * ---------------------------------------------------------------- */
    let signatureState: GovernResult["signatureState"] = "unsigned";
    if (request.requireSignature) {
      const signOpen = await this.bridge.pdfCall<unknown>("doc_open", {
        path: governedPdfPath,
      });
      const { doc: signDoc } = PdfCraftOpenReplySchema.parse(signOpen);
      try {
        await this.bridge.pdfCall("sign_document", {
          doc: signDoc,
          id: signingIdPath,
          password: signingIdPassword,
          out: finalPdfPath,
          reason: `NimbusContracts automatic countersignature — ${request.classification}`,
          location: "Nimbus Contracts Platform",
        });
        signatureState = "signed";
      } finally {
        await this.bridge.pdfCall("doc_close", { doc: signDoc, discard_changes: true });
      }
    } else {
      // No signature: the governed intermediate *is* the deliverable.
      await this.copyFile(governedPdfPath, finalPdfPath);
    }

    /* ---------------------------------------------------------------- *
     * I. The encrypted edition — derived from the governed intermediate,
     *    never from the signed file.
     * ---------------------------------------------------------------- */
    let encryptedPdfPath: string | undefined;
    if (request.encryptAtRest) {
      encryptedPdfPath = this.withSuffix(finalPdfPath, ".encrypted");
      const encOpen = await this.bridge.pdfCall<unknown>("doc_open", {
        path: governedPdfPath,
      });
      const { doc: encDoc } = PdfCraftOpenReplySchema.parse(encOpen);
      try {
        const copyAllowed = request.classification === "public";
        const changesPolicy = request.classification === "public"
          ? "any-except-extract"
          : "comment-fill-sign";
        const protectArgs: Record<string, unknown> = {
          doc: encDoc,
          compatibility: "aes-256",
          printing: "high",
          changes: changesPolicy,
          copy: copyAllowed,
          accessibility: true,
        };
        if (request.encryptAtRest) {
          // A real deployment would pull the password from a per-tenant secret
          // store; we keep the placeholder here to keep the pipeline self-
          // contained and auditable.
          protectArgs.open_password = this.deriveOpenPassword(request);
        }
        await this.bridge.pdfCall("doc_protect", protectArgs);
        // Encryption needs a full rewrite: an incremental update cannot
        // change the encryption dictionary.
        await this.bridge.pdfCall("doc_save", { doc: encDoc, path: encryptedPdfPath, full: true });
      } finally {
        await this.bridge.pdfCall("doc_close", { doc: encDoc, discard_changes: true });
      }
    }

    /* ---------------------------------------------------------------- *
     * J. Post-signature annotations. PdfCraft appends them as
     *    *incremental* updates, which leaves the signature envelope valid.
     * ---------------------------------------------------------------- */
    if (request.auditAnnotations.length > 0) {
      const reopen = await this.bridge.pdfCall<unknown>("doc_open", {
        path: finalPdfPath,
      });
      const { doc: reopened } = PdfCraftOpenReplySchema.parse(reopen);
      try {
        for (const annotation of request.auditAnnotations) {
          await this.bridge.pdfCall("comment_add", {
            doc: reopened,
            page: 1,
            type: "note",
            at: [72, 72],
            author: annotation.author,
            contents: annotation.text,
          });
        }
        // Incremental save keeps the signature cryptographically valid; a
        // full rewrite would be refused with "this document is signed".
        await this.bridge.pdfCall("doc_save", { doc: reopened, full: false });
      } finally {
        await this.bridge.pdfCall("doc_close", { doc: reopened });
      }
    }

    return {
      pageCount: pages,
      redactionCount,
      hiddenInfoRemoved: hiddenInfoRemoved,
      signatureState,
      governedPdfPath,
      ...(encryptedPdfPath ? { encryptedPdfPath } : {}),
    };
  }

  /* --- helpers ----------------------------------------------------------- */

  /** Compute watermark text, opacity, and colour from the classification. */
  private buildWatermark(
    request: GenerateDocumentRequest,
    mergeMap: Record<string, string>,
  ): { text: string; opacity: number; color: string } | null {
    if (request.classification === "public") return null;
    const vendor = mergeMap["vendor_name"] ?? "Unknown Vendor";
    const text = `${request.classification.toUpperCase()} — ${vendor}`;
    const opacity =
      request.classification === "internal"     ? 0.10 :
      request.classification === "confidential" ? 0.16 :
      /* restricted */                            0.22;
    const color =
      request.classification === "internal"     ? "#3f6fb5" :
      request.classification === "confidential" ? "#b53f6f" :
      /* restricted */                            "#a01414";
    return { text, opacity, color };
  }

  /** Remove a deliberate, named subset of hidden-information categories. */
  private async removeHiddenInformation(doc: number): Promise<string[]> {
    const categories = [
      "metadata",         // we already wrote *our* metadata; the original
                          // authoring machine's is now removed.
      "private-data",     // custom XMP, private app data.
      "hidden-text",      // invisible OCR layers, transparent text.
      "attachments",      // embedded files reviewer should not see.
    ];
    await this.bridge.pdfCall("doc_remove_hidden", { doc, categories });
    return categories;
  }

  /** Derive a stable, per-tenant open password from the request. */
  private deriveOpenPassword(request: GenerateDocumentRequest): string {
    return createHash("sha256")
      .update(`${request.tenantId}:${request.idempotencyKey}:atRest`)
      .digest("hex")
      .slice(0, 24);
  }

  /** Copy the governed intermediate over the deliverable's path. */
  private async copyFile(from: string, to: string): Promise<void> {
    await copyFile(from, to);
  }

  /** Insert a suffix before the `.pdf` extension. */
  private withSuffix(file: string, suffix: string): string {
    return file.replace(/\.pdf$/i, `${suffix}.pdf`);
  }
}
