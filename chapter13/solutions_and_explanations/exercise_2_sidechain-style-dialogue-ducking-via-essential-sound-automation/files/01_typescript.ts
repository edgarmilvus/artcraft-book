interface DuckingConfig {
  sequenceId: number;
  dialogueTracks: Array<"A1" | "A2">;
  musicTracks:   Array<"A3" | "A4">;
  sfxTrack:      "A5";
  targetDialogueLufs: number;  // e.g. -23
  targetMusicLufs:    number;  // e.g. -28
  duckDepthDb:        number;  // e.g. -14
  attackMs:           number;  // e.g. 30
  releaseMs:          number;  // e.g. 450
  programTargetWindow: [number, number]; // [-26, -22] LKFS
  truePeakCeilingDbtp: number;           // -2
  minSpeechSii:        number;           // 12 dB
}

interface MixReport {
  sequenceId: number;
  preDuckLufs:     Record<string, number>;
  postDuckLufs:    Record<string, number>;
  truePeakDbtp:    number;
  generatedKeys:   number;
  maxDuckDepthDb:  number;
  speechIntervals: Array<{ startSec: number; endSec: number }>;
  masterCorrectionDb: number;
  residualDeviation: number; // 0 if fully compliant
  pass: boolean;
}

interface DuckingKeyframe {
  strip: "A3" | "A4";
  lane: "volume";
  time: number;         // ticks, 254016000000 == 1s
  value: number;        // dB
  interpolation: "bezier";
}
