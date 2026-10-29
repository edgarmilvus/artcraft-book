// Vision review schema — your prompt must force exactly this shape.
interface VisionFinding {
  kind:
    | "numeric_mismatch"
    | "text_overflow"
    | "contrast_issue"
    | "placeholder_leftover"
    | "misaligned_element"
    | "other";
  severity: "info" | "medium" | "high" | "blocking";
  slide_index: number;
  region: { x: number; y: number; w: number; h: number };  // normalized 0..1
  detail: string;
  expected?: string;   // for numeric_mismatch
  observed?: string;   // for numeric_mismatch
  reason?: string;     // why the finding was escalated instead of corrected
}

interface VisionResponse {
  findings: VisionFinding[];
  overall_assessment: string;
  iteration_suggestion: string;
}

// One command of a batch.
interface BatchCommand {
  command: string;
  params: Record<string, unknown>;
}

// The batch DeckCraft really accepts: `batch` stops at the first failure
// unless `keepGoing` is set.
interface CommandBatch {
  commands: BatchCommand[];
  keepGoing: boolean;
}

interface IterationRecord {
  iteration: number;
  slide_index: number;
  screenshot_path: string;         // the PNG the reviewer saw
  screenshot_sha256: string;
  vision_raw: string;              // the answer as it came in
  vision_parsed: VisionResponse;
  vision_attempts: number;         // how often the answer had to be asked for
  vision_refusals: string[];       // why the earlier answers were rejected
  applied_batch: CommandBatch;
  blocking_issues: VisionFinding[];   // routed to human review
  new_screenshot_sha256: string | null;
  post_screenshot_path: string | null;
}

interface IterationGroup {
  iteration: number;
  records: IterationRecord[];
  blocking_issues: VisionFinding[];
  applied_commands: BatchCommand[];
}

interface DeckAuditReport {
  deck_path: string;
  pdf_path: string;
  binding_map_path: string;
  iterations: IterationGroup[];
  human_review_queue: VisionFinding[];
  converged: boolean;
  termination_reason:
    | "clean"
    | "max-iterations"
    | "blocking-only"
    | "error";
  total_wall_clock_ms: number;
}
