interface WordTiming {
  transcriptId: string;   // from transcript.search
  startMs: number;        // integer milliseconds, 1-ms precision
  endMs: number;          // integer milliseconds
  speaker: 0 | 1;
}

interface DuckingPlan {
  musicClipId: number;    // clip id from sequence_inspect
  dialogueClipId: number; // clip id from sequence_inspect
  attackTicksGoal: number; // coalesced interval start, in ticks
  holdTicksGoal: number;
  releaseTicksGoal: number;
}

interface DuckingAuditRow {
  wordGroupId: string;
  attackTick: number;
  releaseTick: number;
  expectedSamplesAt48k: number; // exact integer: ticks/5292000
  measuredDropTick: number;
  driftTicks: number;           // must be 0
}

// CLI invocation target (must be observed exactly by the harness):
// filmcraft-cli --control 7979 \
//   --automation-read-root /work/ep-142 \
//   --automation-write-root /work/ep-142

// TCP auth first frame (mandatory):
// {"id":"auth","method":"auth","params":{"token":"<64_hex>"}}

// Reference commands your harness will exercise (per FilmCraft command schema):
// effects.setParam {clip, effect:"volume", param:"level", value, time:ticks}
// effects.addKeyframe {clip, effect:"volume", param:"level", time:ticks}
// effects.setInterpolation {clip, effect:"volume", param:"level", mediaTime:ticks, interpolation:"linear"}
// render_frame {seconds?: number}   // you must convert tick -> seconds ONLY for the final render call
// sequence_inspect
