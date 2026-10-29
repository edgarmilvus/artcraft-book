// run_ex1.ts — acceptance harness for the dialogue-ducking timebase.
//
// The engine is not required for the audit proof: the harness exercises the
// exact ms -> tick lift, the coalescing tolerance, the sample denominator and
// the per-interval audit rows, then writes the audit JSON.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  TICKS_PER_MS,
  TICKS_PER_SAMPLE,
  TICKS_PER_SECOND,
  buildDuckingAudit,
  coalesce,
  msToTicks,
  type WordTiming,
} from "./01_solutions_and_explanations.js";

const HERE = process.cwd();
const OUTPUT = resolve(HERE, "..", "output");

let passed = 0;
function ok(label: string, condition: boolean, detail = ""): void {
  if (!condition) {
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    process.exit(1);
  }
  passed += 1;
  console.log(`PASS ${label}`);
}

function equal<T>(label: string, actual: T, expected: T): void {
  ok(label, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

function main(): void {
  for (const name of ["ducking_audit.json", "ducking_audit.csv", "report.json"]) {
    rmSync(resolve(OUTPUT, name), { force: true });
  }
  mkdirSync(OUTPUT, { recursive: true });

  console.log("\n# exact primitives");
  equal("timebase: 254016000000 ticks per second", TICKS_PER_SECOND, 254_016_000_000n);
  equal("timebase: one ms is 254016000 ticks", TICKS_PER_MS, 254_016_000n);
  equal("timebase: 1000 ms is one second", msToTicks(1000), TICKS_PER_SECOND);
  equal("timebase: 48 kHz sample is 5292000 ticks", TICKS_PER_SAMPLE, 5_292_000n);
  equal("timebase: one second is 48000 samples", TICKS_PER_SECOND / TICKS_PER_SAMPLE, 48_000n);
  let integral = false;
  try { msToTicks(1.5); } catch { integral = true; }
  ok("timebase: non-integral ms is refused", integral);

  console.log("\n# coalescing");
  const overlapping: WordTiming[] = [
    { transcriptId: "w1", startMs: 0, endMs: 100, speaker: 0 },
    { transcriptId: "w2", startMs: 50, endMs: 150, speaker: 0 },
    { transcriptId: "w3", startMs: 300, endMs: 380, speaker: 1 },
  ];
  const groups = coalesce(overlapping);
  equal("coalesce: overlapping words merge", groups.length, 2);
  equal("coalesce: first group starts at zero", groups[0].startTick, 0n);
  equal("coalesce: first group end", groups[0].endTick, msToTicks(150));
  equal("coalesce: second group", groups[1].startTick, msToTicks(300));
  equal("coalesce: empty transcript", coalesce([]).length, 0);

  console.log("\n# ducking audit");
  const transcript: WordTiming[] = [
    { transcriptId: "w1", startMs: 1000, endMs: 1200, speaker: 0 },
    { transcriptId: "w2", startMs: 1100, endMs: 1400, speaker: 0 },
    { transcriptId: "w3", startMs: 2400, endMs: 2600, speaker: 1 },
  ];
  const rows = buildDuckingAudit(transcript);
  equal("audit: two word groups", rows.length, 2);
  equal("audit: every row has zero drift", rows.every((row) => row.driftTicks === 0), true);
  equal("audit: first attack tick", rows[0].attackTick, msToTicks(1000).toString());
  equal("audit: first release tick", rows[0].releaseTick, msToTicks(1400).toString());
  equal("audit: first expected samples", rows[0].expectedSamplesAt48k,
    ((msToTicks(1400) - msToTicks(1000)) / TICKS_PER_SAMPLE).toString());
  ok("audit: release is after attack", BigInt(rows[0].releaseTick) > BigInt(rows[0].attackTick));
  ok("audit: samples are positive", rows.every((row) => BigInt(row.expectedSamplesAt48k) > 0n));

  writeFileSync(resolve(OUTPUT, "ducking_audit.json"), JSON.stringify({ events: rows }, null, 2));
  writeFileSync(resolve(OUTPUT, "ducking_audit.csv"),
    "wordGroupId,attackTick,releaseTick,expectedSamplesAt48k,driftTicks\n" +
    rows.map((row) => `${row.wordGroupId},${row.attackTick},${row.releaseTick},${row.expectedSamplesAt48k},${row.driftTicks}`).join("\n") + "\n");
  ok("output: ducking_audit.json", existsSync(resolve(OUTPUT, "ducking_audit.json")));
  ok("output: ducking_audit.csv", existsSync(resolve(OUTPUT, "ducking_audit.csv")));
  const audit = JSON.parse(readFileSync(resolve(OUTPUT, "ducking_audit.json"), "utf8"));
  equal("output: audit has two events", audit.events.length, 2);

  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 1,
    engine: "filmcraft timebase (pure)",
    assertions: passed + 1,
    ticksPerSecond: TICKS_PER_SECOND.toString(),
    ticksPerSample48k: TICKS_PER_SAMPLE.toString(),
    wordGroups: groups.length,
    events: rows,
    artefacts: ["ducking_audit.json", "ducking_audit.csv"],
    result: "integer ms lift, overlap coalescing and 48 kHz sample counts verified; audit written",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));

  console.log(`\n${passed} assertions passed`);
}

main();
