interface LoudnessSpec {
  programId: string;
  targetIntegratedLufs: -24;
  integratedToleranceLu: 2;
  truePeakCeilingDbtp: -2;
  maxSilenceMs: 200;
  iterationCap: 4;
}

interface LoudnessMeasurement {
  iteration: number;
  integratedLufs: number;
  truePeakDbtp: number;
  shortTermLufs: number[];      // one per 3-sec window
  hotWindows: Array<{
    startSec: number;
    endSec: number;
    peakDbtp: number;
    shortTermLufs: number;
  }>;
  silenceViolations: Array<{ startSec: number; endSec: number }>;
  compliant: boolean;
}

interface RemediationDecision {
  iteration: number;
  targetWindows: Array<{ startSec: number; endSec: number }>;
  action:
    | { kind: "clipGain"; db: number }
    | { kind: "essentialSoundRepair"; key: string; value: unknown }
    | { kind: "masterLimiter"; ceilingDbtp: number }
    | { kind: "escalate"; reason: string };
  reasoning: string;
}

interface GovernanceReport {
  programId: string;
  spec: LoudnessSpec;
  iterations: LoudnessMeasurement[];
  decisions: RemediationDecision[];
  finalStatus: "COMPLIANT" | "ESCALATE";
  residualLufsDelta?: number;
  residualTruePeakDbtp?: number;
  generatedAt: string;
}
