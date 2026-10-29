interface SyncAnchor {
  anchorId: string;
  anchorTick: number;         // the timeline tick the operator expects sync at
  description: string;        // e.g. "clap slate", "door slam at 00:14"
}

interface SyncAnchorResult {
  anchorId: string;
  visualEventTick: number | null;
  audioTransientTick: number | null;
  driftTicks: number | null;
  rejected: boolean;
  rejectReason?: "llm_out_of_bounds" | "no_event_found" | "audio_envelope_flat";
}

interface SyncQcReport {
  anchors: SyncAnchorResult[];
  maxDriftTicks: number;
  passThresholdTicks: 10584000;      // 2 samples @ 48 kHz, integer-authored
  rejectedAnchors: number;
  systematicOffsetCorrection: {
    applied: boolean;
    deltaTicks: number;
    residualBefore: number;
    residualAfter: number;
  };
  verdict: "pass" | "fail" | "inconclusive";
}

// Bridge-mode MCP invocation:
// filmcraft-cli mcp --connect 7979

// Meta-tools and commands used:
// ui_screenshot {panel:"Program"}
// ui_inspect {}
// render_preview {seconds, max_side}
// command_batch (for the systematic correction)
// sequence_inspect {}
// edit.undo {}
