// ---- Pipeline orchestration -------------------------------------------------

export type FailureKind =
  | "retryable_transient"
  | "retryable_with_correction"
  | "human_required"
  | "unrecoverable";

export interface StageResult<T> {
  stage: "photocraft" | "designcraft" | "pdfcraft" | "vision_local" | "vision_global" | "preflight";
  ok: boolean;
  output: T | null;
  failure: { kind: FailureKind; message: string; retryable: boolean } | null;
  attempts: number;
  elapsedMs: number;
}

export interface BrochureJob {
  jobId: string;
  productPhotos: { sku: string; sourcePath: string }[];   // 12 items
  designTemplatePath: string;                              // .designcraft
  outputPdfPath: string;
  preflightMinPpi: number;
  budgetMsPerSpread: number;                               // 6 * 60 * 1000
  /** Root of the job: pristine copies, working copies, treated photos, layout. */
  workspace: string;
  /** Photos per page in the template grid. */
  photosPerPage?: number;
  /** Grid gutter in points, used when the template does not expose one. */
  gutterPt?: number;
}

// ---- Cached local audits ----------------------------------------------------

export interface LocalAuditCacheEntry {
  photoSha256: string;
  critique: {
    exposure_ok: boolean;
    color_ok: boolean;
    retouch_artifacts: string[];
    confidence: number;
    note: string;
  };
  cachedAtEpochMs: number;
}

// ---- Global (brochure-level) audit ------------------------------------------

export interface SpreadAudit {
  spreadIndex: number;
  imageGutterSpill: { sku: string; frameId: number }[];
  typographyHierarchyOk: boolean;
  brandComplianceOk: boolean;
  /** Any finding that traces back to a source photo, so we can re-open it. */
  traceableFindings: { sku: string; photoCraftCommandToUndo: string; note: string }[];
  confidence: number;
}

// ---- Cross-app rollback strategy --------------------------------------------

export type RollbackStrategy = "accept_partial_human_required" | "restore_from_copy";

export interface CrossAppSnapshot {
  jobId: string;
  /** Directory holding the untouched source photos. */
  pristineCopyDir: string;
  /** Per-file sha256, so we can verify a restore. */
  pristineHashes: Record<string, string>;
  /** Whether any PhotoCraft doc_save has overwritten the working copy. */
  photosWereRewritten: boolean;
  /** Whether DesignCraft's .designcraft file has been saved in this run. */
  designCraftWasSaved: boolean;
}

export interface PipelineRunReport {
  jobId: string;
  stages: StageResult<unknown>[];
  localAuditCacheHits: number;
  localAuditCacheMisses: number;
  globalAudit: SpreadAudit[];
  rollbackStrategy: RollbackStrategy;
  finalPdfWritten: boolean;
  humanRequired: boolean;
  humanRequiredReasons: string[];
}
