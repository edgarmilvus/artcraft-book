interface ArtDirectorBrief {
  cutdownId: string;              // e.g. "S01"
  durationSeconds: number;        // always 15 for this batch
  openingBrief: string;           // natural language; may contain multiple clauses
  clauseSeverity: "strict" | "lenient"; // strict = any clause below threshold = reject
  threshold: number;              // default 75
}

interface VLMClauseScore {
  text: string;
  score: number;                  // 0..100
  evidence: string;               // short justification from the VLM
}

interface VLMAssessment {
  clauses: VLMClauseScore[];
  overall: number;
  match: boolean;
}

interface CutdownAttempt {
  attemptIndex: number;           // 0-based
  candidateItemId: number;
  candidateFileName: string;
  renderedFramePath: string;      // PNG path
  assessment: VLMAssessment;
  accepted: boolean;
  rejectionReason?: "clauseBelowThreshold" | "vlmError" | "renderFailed";
}

interface CutdownAudit {
  cutdownId: string;
  brief: ArtDirectorBrief;
  attempts: CutdownAttempt[];
  finalItemId: number | null;
  finalFramePath: string | null;
  verifiedMarkerName: "VERIFIED_OPEN";
  verifiedAtTick: number;
  midpointPreviewPath: string;
}

// The exercise deliverable for the whole batch
interface SocialBatchReport {
  cutdowns: CutdownAudit[];
  acceptedCount: number;
  rejectedCount: number;          // those that hit the 5-attempt limit
  averageAttempts: number;
  totalVlmCalls: number;
  totalRenderCalls: number;
}
