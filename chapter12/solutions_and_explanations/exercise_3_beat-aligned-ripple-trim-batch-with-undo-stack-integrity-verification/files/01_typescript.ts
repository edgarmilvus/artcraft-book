interface BeatGrid {
  bpm: number;
  firstBeatTick: number;
  beatIntervalsTicks: number[];    // possibly non-uniform, one per beat
  cumulativeErrorTicks: number;    // |grid[n] - ideal[n]| at the last beat
  beatsTotal: number;
}

interface SnapOperation {
  clipId: number;
  track: "V1" | "V2";
  before: { inTicks: number; outTicks: number };
  after:  { inTicks: number; outTicks: number };
  deltaTicks: number;             // signed
  snappedTo: number;              // the beat tick chosen
}

interface RippleOperation {
  clipRemovedId: number;
  track: "V1" | "V2";
  gapStartTicks: number;
  gapEndTicks: number;
  gapDurationTicks: number;
  thresholdTicks: number;
}

interface UndoIntegrityCheck {
  undosRequested: number;
  undosSucceeded: number;
  statesMatched: boolean;
  mismatch?: {
    undoIndex: number;
    expected: { inTicks: number; outTicks: number };
    actual:   { inTicks: number; outTicks: number };
  };
}

interface SnapReport {
  sequenceId: number;
  beatGrid: BeatGrid;
  snaps: SnapOperation[];
  ripples: RippleOperation[];
  visualValidations: Array<{ timeTicks: number; pngPath: string; beatVisible: boolean }>;
  undoIntegrity: UndoIntegrityCheck;
  preRunSnapshotPath: string;
  abortedEarly: boolean;
}
