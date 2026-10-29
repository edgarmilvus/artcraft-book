interface AestheticAudit {
  sku: string;
  variant: string;                 // e.g., "1:1-en-US"
  renderer: "photocraft" | "designcraft";
  iterations: Array<{
    iteration: number;
    imageBase64Preview: string;    // first 200 chars of the base64 payload
    score: {
      textClipped: boolean;
      contrast: number;
      hueDrift: number;
      heroCentered: boolean;
      heroOffsetPx: [number, number];
      rationale: string;
    } | null;                      // null when the vision response was malformed
    correction: { id: string; params: Record<string, unknown> } | null;
    elapsedMs: number;
  }>;
  status: "passed" | "no-progress" | "max-iterations" | "timed-out";
  finalPath: string;
  finalBytes: number;
  finalSha256: string;
}

// Target render invocation shape (targets, not solutions):
// command_run { id: "doc_render_preview", params: { max_side: 1024 } }
