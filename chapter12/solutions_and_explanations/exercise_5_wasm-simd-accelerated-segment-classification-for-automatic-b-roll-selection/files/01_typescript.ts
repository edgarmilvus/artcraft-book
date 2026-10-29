// The WASM module you must instantiate and call
// Exported functions (WAT-style signature sketch):
//   (func $alloc (param $bytes i32) (result i32))
//   (func $classify (param $rgba_ptr i32) (param $width i32) (param $height i32) (result i32))
//   (func $free (param $ptr i32))
//   (func $simd_probe (result i32))
// The classify function writes a 12-element f32 array to a fixed offset
// (returned pointer) and the agent reads it back as softmax probabilities.

interface WasmClassification {
  probabilities: number[];        // length 12, sums to 1 ± 1e-5
  topLabel: string;               // one of the twelve categories
  topProbability: number;
}

interface IndexedClip {
  itemId: number;
  fileName: string;
  labels: [string, string, string]; // majority, runner-up, third
  framePaths: string[];             // 3 PNGs
  durationTicks: number;
  classificationMs: number;
}

interface BriefSection {
  sectionStartTick: number;
  sectionEndTick: number;
  wantedLabels: string[];
  maxPlacementSeconds: number;
}

interface PlacementDecision {
  sectionStartTick: number;
  sectionEndTick: number;
  selectedItemId: number;
  selectedLabel: string;
  score: number;
  overlapRatio: number;   // fraction of the section the placement fills
}

interface BenchReport {
  clipCount: number;
  frameCount: number;
  renderMs: number;
  inferenceMs: number;
  orchestrationMs: number;
  vlmProjectionMs: number;
  speedupVsVlm: number;
  simdProbePassed: boolean;
  perThreadFrameCounts: number[];
}

interface ClassifyBatchReport {
  indexed: IndexedClip[];
  decisions: PlacementDecision[];
  bench: BenchReport;
  indexFilePath: string;
  failures: Array<{ itemId: number; tick: number; reason: string }>;
}
