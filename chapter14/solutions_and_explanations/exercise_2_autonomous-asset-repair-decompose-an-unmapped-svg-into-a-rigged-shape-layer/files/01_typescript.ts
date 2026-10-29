export interface RepairPlan {
  layerName: string;              // "AcmeMark"
  candidatesFolder: string;       // "brand-assets/"
  expectedReferenceHash: bigint;  // provided by the exercise fixture
  tolerance: number;              // 6
  markerName: string;             // "AcmeMark_repaired_v2"
}

export interface RepairReport {
  layer: string;
  candidateUsed: string | null;
  pathsInserted: number;
  warnings: string[];
  hammingDistance: number | null;
  modifiersPreserved: boolean;
  idempotentSkip: boolean;
  mode: "native" | "script-fallback";
}

// MCP tool signature the agent must consume.
type RunScriptResponse = {
  ok: boolean;
  result: unknown;    // narrow with isRepairResult
  output: string;
  error: { message: string; line: number; column: number } | null;
};

function isRepairResult(v: unknown): v is { inserted: number; warnings: string[] } {
  return (
    typeof v === "object" && v !== null &&
    "inserted" in v && typeof (v as any).inserted === "number" &&
    Array.isArray((v as any).warnings)
  );
}
