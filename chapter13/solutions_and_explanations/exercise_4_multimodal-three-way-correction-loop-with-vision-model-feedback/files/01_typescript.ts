interface VisionGradeFeedback {
  status: "ok" | "too_cool" | "too_warm" | "too_flat" |
          "too_contrasty" | "shadows_muddy" | "highlights_blown";
  shadowAdjustment:    { hue: number; sat: number; balance: number } | null;
  midtoneAdjustment:   { hue: number; sat: number; balance: number } | null;
  highlightAdjustment: { hue: number; sat: number; balance: number } | null;
  confidence: number; // 0.0 – 1.0
}

interface GradeIteration {
  iteration: number;
  frameHash: string;       // SHA-256 of the rendered PNG bytes
  visionRawResponse: string;
  visionParsed: VisionGradeFeedback | null;
  appliedAdjustments: CommandBatchStep[];
  scopeReadout: {
    waveformMinIre: number;
    waveformMaxIre: number;
    midtoneMeanY: number;
  };
  passedNumeric: boolean;
  passedVision: boolean;
  oscillated: boolean;
}

interface AgenticGradeReport {
  sequenceId: number;
  clipId: number;
  maxIterations: number;
  iterations: GradeIteration[];
  finalStatus: "CONVERGED" | "OSCILLATION_HALT" | "ITERATION_CAP";
  finalFrameHash: string;
  finalGradeState: {
    shadows:    { hue: number; sat: number; balance: number };
    midtones:   { hue: number; sat: number; balance: number };
    highlights: { hue: number; sat: number; balance: number };
  };
}

interface CommandBatchStep {
  id: string;
  params: Record<string, unknown>;
}
