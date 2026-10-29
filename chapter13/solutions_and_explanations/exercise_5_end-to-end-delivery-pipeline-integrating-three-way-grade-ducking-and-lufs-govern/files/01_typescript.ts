// Raw spec shapes for three different clients
interface SpecStreamingA {
  client: "StreamingA";
  creativeTone: "warm_cinematic" | "cool_desaturated" | "neutral_documentary";
  acquisitionCamera: "Sony_FX6" | "Sony_A7SIII" | "Canon_C70";
  loudnessStandard: "STREAMING";
  expectedRuntimeSec: number;
  targetCodec: "prores" | "h264";
}

interface SpecStreamingB {
  client: "StreamingB";
  tone: { adjective1: string; adjective2: string };  // free-form
  camera: string;
  loudness: { standard: "STREAMING" | "ATSC_A85" };
  runtimeSec: number;
  codec: { container: "mov" | "mp4"; profile: string };
}

interface SpecBroadcastX {
  client: "BroadcastX";
  styleGuide: {
    palette: "warm" | "cool" | "neutral";
    saturation: "low" | "medium" | "high";
  };
  cameraModel: string;
  deliverySpec: {
    loudness: "EBU_R128" | "ATSC_A85";
    truePeakCeilingDbtp: number;
  };
  duration: { hours: number; minutes: number; seconds: number };
  outputFormat: "prores" | "dnxhr";
}

type RawSpec = SpecStreamingA | SpecStreamingB | SpecBroadcastX;

// Normalized internal shape — the pipeline consumes only this
interface DeliverySpec {
  client: string;
  creativeTone: "warm_cinematic" | "cool_desaturated" | "neutral_documentary";
  acquisitionCamera: string;
  loudnessStandard: "EBU_R128" | "ATSC_A85" | "STREAMING";
  integratedLufsTarget: number;
  integratedLufsTolerance: number;
  truePeakCeilingDbtp: number;
  expectedRuntimeSec: number;
  targetCodec: "prores" | "h264" | "dnxhr";
  targetContainer: "mov" | "mp4";
  proresProfile?: "hq" | "4444" | "lt";
}

interface DeliveryManifest {
  pipelineVersion: string;
  specNormalization: { raw: RawSpec; normalized: DeliverySpec };
  gradeEvidence: Array<{
    clipId: number;
    verificationPng: string;
    scopeReadout: { paradeMaxIre: number; waveformMaxIre: number; midtoneMeanY: number };
  }>;
  audioEvidence: {
    preDuckLufs: number;
    postDuckLufs: number;
    duckingKeyframes: number;
    finalIntegratedLufs: number;
    finalTruePeakDbtp: number;
  };
  exportEvidence: {
    path: string;
    codec: string;
    durationSec: number;
    sampleRate: number;
    channels: number;
  };
  idempotencyHash: string;
  manifestGeneratedAtIso: string;
}
