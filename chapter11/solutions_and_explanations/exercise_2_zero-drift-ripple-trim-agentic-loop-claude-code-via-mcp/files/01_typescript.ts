// MCP stdio launch (must be observed exactly):
// filmcraft-cli mcp --automation-read-root /work/doc-2026 --automation-write-root /work/doc-2026

interface TrimTarget {
  wordIndex: number;
  transcriptMs: number;      // 1-ms precision
  direction: "extendPrev" | "pullNext";
}

interface RippleAuditRow {
  wordIndex: number;
  fromTick: number;
  toTick: number;
  trimmedTicks: number;
  invariantPassed: boolean;
}

interface RippleAudit {
  rows: RippleAuditRow[];
  totalDriftTicks: number;        // must be 0
  finalDurationTicks: number;
  blocked?: { missingMediaPaths: string[]; wouldRunCommands: string[] };
  frameTicksAt23976: number;       // 10594584000 — the harness asserts this constant
}

// MCP meta-tool call shapes the assistant may use:
// command_list {filter:"trim", enabled_only:true}
// command_run  {id:"timeline.trim", params:{clip, edge:"in"|"out", mode:"ripple", delta:ticks}}
// command_batch {steps:[{id,params},…], stop_on_error:true}
// sequence_inspect {}
// doc_inspect {}
// render_frame {seconds?: number, max_side?: number}
