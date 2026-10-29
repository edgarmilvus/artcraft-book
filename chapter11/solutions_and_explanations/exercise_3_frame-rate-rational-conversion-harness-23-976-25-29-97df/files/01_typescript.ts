interface EdlCut {
  cutId: string;
  sourceIn25: number;    // 25 fps frame number
  sourceOut25: number;   // 25 fps frame number
}

interface ConversionRow {
  cutId: string;
  sourceFrame25: number;
  sourceTick: bigint;
  targetFrame23Rounded: number;
  targetTick: bigint;
  residualTicks: bigint;
  df29Timecode: string;      // HH:MM:SS;FF
  nf29Frame: number;         // integer non-drop frame count recovered from df29Timecode
}

interface ParityReport {
  maxResidualAbsTicks: bigint;   // must be ≤ 5297292000 (half of 10594584000)
  maxResidualMicroseconds: number;
  maxResidualSamples48k: number;
  cutsProcessed: number;
  dfRoundTripFailures: 0;
}

// CLI target (Channel B, headless batch):
// filmcraft-cli run /work/ep-142/reconvert.actions.json \
//   --actions /work/ep-142/reconvert.actions.json \
//   --in /work/ep-142/in --out /work/ep-142/out

// Engine commands used:
// sequence.settings {fps: 23.976}
// sequence.inspect
// edit.undo
// command_batch (from MCP) or `--cmd` (from CLI)
