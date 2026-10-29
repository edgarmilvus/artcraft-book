export interface LoopConfig {
  compName: string;
  barLayer: string;          // "Bar–Underline"
  wordmarkLayer: string;     // "Logo–Wordmark"
  sampleTimes: [number, number, number, number, number, number];
  // e.g. [0.2, 0.35, 0.5, 0.65, 0.75, 0.9]
  maxIterations: 8;
  hysteresisRuns: 2;
  targetAbsMeanScore: 0.4;
  renderMaxSide: 640;
}

export interface ScoreResult {
  time: number;
  score: number | null;
  raw: unknown;      // whatever the vision model returned; never trusted
}

// Type guard for the vision model response.
export function isVisionScore(v: unknown): v is { score: number } {
  return (
    typeof v === "object" && v !== null &&
    "score" in v &&
    typeof (v as any).score === "number" &&
    (v as any).score >= -3 && (v as any).score <= 3
  );
}
