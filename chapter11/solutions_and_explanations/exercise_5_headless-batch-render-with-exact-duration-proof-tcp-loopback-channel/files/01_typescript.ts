interface Deliverable {
  name: string;
  format: "prores" | "h264" | "hevc" | "av1" | "mxf-op1a" | "wav";
  destination: string;    // relative to --automation-write-root
  burnSubtitles?: boolean;
}

interface DeliverableProof {
  name: string;
  format: string;
  expectedTicks: bigint;
  expectedSamples48k: bigint;
  renderedPath: string | null;
  actualSamples48k: bigint | null;
  driftSamples: bigint;          // must be 0
  videoFrameCount: bigint;
  residualTicks: bigint;
  error?: string;
}

interface DurationProofManifest {
  sequenceId: string;
  totalTicks: bigint;
  workAreaTicks: bigint | null;
  deliverables: DeliverableProof[];
  generatedAtUtc: string;        // ISO-8601, no floating-point timestamps
  engineVersion: string;
}

// TCP loopback invocation:
// filmcraft --control 7979 \
//   --automation-read-root /work/dist \
//   --automation-write-root /work/dist

// First TCP frame (mandatory):
// {"id":"auth","method":"auth","params":{"token":"<64_hex>"}}

// Subsequent frames (one JSON object per line):
// {"id":1,"method":"engine.execute","params":{"command":"sequence.inspect","params":{}}}
// {"id":2,"method":"engine.execute","params":{"command":"file.exportMedia","params":{...}}}
// {"id":3,"method":"engine.execute","params":{"command":"jobs.list","params":{}}}
