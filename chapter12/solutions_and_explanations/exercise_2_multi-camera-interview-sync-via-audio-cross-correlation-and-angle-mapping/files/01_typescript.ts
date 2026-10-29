// Raw correlation result for a pair of camera tracks
interface CorrelationResult {
  pair: [string, string];          // e.g. ["A", "B"]
  sampleRate: number;
  windowStartSamples: number;
  windowLengthSamples: number;
  peakOffsetSamples: number;       // signed; positive means A leads B
  peakValue: number;               // normalized, 0..1
  noiseFloorStdDev: number;
  peakZScore: number;              // (peakValue - mean) / stddev
  lobeWidthSamples: number;        // width of the peak at half-maximum
  rejected: boolean;
  rejectionReason?: "impulse" | "lowZ" | "multiModal";
}

// Reconciliation output
interface GlobalAlignment {
  referenceCamera: "A" | "B" | "C";
  cameraOffsetsTicks: Record<"A" | "B" | "C", number>;
  residualRms_ms: number;          // should be < 2 ms for a clean solve
  confidence: number;              // 0..1
}

// Angle map entry
interface AngleCut {
  timeTicks: number;
  cameraIndex: 1 | 2 | 3;          // 1 = A, 2 = B, 3 = C
  reason: "pauseBefore" | "pauseAfter" | "manual";
  pauseDurationMs: number;
}

interface MulticamSessionReport {
  sequenceId: number;
  alignment: GlobalAlignment;
  correlations: CorrelationResult[];
  angleMap: AngleCut[];
  validationPngs: string[];
  validationPassed: boolean;
  recoveryAttempts: number;
}
