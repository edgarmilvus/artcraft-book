// run_ex2.ts — acceptance harness for the zero-drift ripple pass.
//
// The engine loop's invariant is pure integer arithmetic; this harness checks
// the banker's rounding, the frame snapping, the sequence total and the
// post-batch invariant, then writes the audit and a violating counter-example.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FRAME_TICKS_23976,
  TICKS_PER_MS,
  bankerRound,
  buildRippleAudit,
  snapToFrameTick,
  totalDurationTicks,
  type TrimTarget,
} from "./02_zero-drift-ripple-trim-agentic-loop-claude-code-via-mcp.js";

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
  for (const name of ["ripple_audit.json", "ripple_audit_drift.json", "report.json"]) {
    rmSync(resolve(OUTPUT, name), { force: true });
  }
  mkdirSync(OUTPUT, { recursive: true });

  console.log("\n# exact rationals");
  equal("timebase: one ms is 254016000 ticks", TICKS_PER_MS, 254_016_000n);
  equal("frame: 23.976 frame is 10594584000 ticks", FRAME_TICKS_23976, 10_594_584_000n);
  equal("frame: 24000 frames is 1001 seconds", FRAME_TICKS_23976 * 24_000n, 254_016_000_000n * 1001n);
  equal("banker: 1/2 rounds to even 0", bankerRound(1n, 2n), 0n);
  equal("banker: 3/2 rounds to even 2", bankerRound(3n, 2n), 2n);
  equal("banker: 5/2 rounds to even 2", bankerRound(5n, 2n), 2n);
  equal("banker: 7/2 rounds to even 4", bankerRound(7n, 2n), 4n);
  equal("banker: 2/3 rounds down", bankerRound(2n, 3n), 1n);
  equal("banker: 7/3 rounds up", bankerRound(7n, 3n), 2n);

  console.log("\n# frame snapping");
  equal("snap: zero is zero", snapToFrameTick(0), 0n);
  equal("snap: 20 ms is still frame zero", snapToFrameTick(20), 0n);
  equal("snap: 21 ms is still one frame", snapToFrameTick(21), FRAME_TICKS_23976);
  equal("snap: 42 ms is one frame", snapToFrameTick(42), FRAME_TICKS_23976);
  equal("snap: 83 ms is two frames", snapToFrameTick(83), 2n * FRAME_TICKS_23976);
  const before = snapToFrameTick(42);
  const after = snapToFrameTick(83);
  ok("snap: results are whole frames", before % FRAME_TICKS_23976 === 0n && after % FRAME_TICKS_23976 === 0n);
  ok("snap: monotonic", after >= before);
  let nonInteger = false;
  try { snapToFrameTick(1.5); } catch { nonInteger = true; }
  ok("snap: non-integral ms is refused", nonInteger);

  console.log("\n# sequence totals");
  const seq = {
    tracks: [
      { clips: [{ durationTicks: "100" }, { durationTicks: "250" }] },
      { clips: [{ durationTicks: "50" }] },
    ],
  };
  equal("sequence: sums every track and clip", totalDurationTicks(seq), 400n);
  equal("sequence: empty is zero", totalDurationTicks({ tracks: [] }), 0n);

  console.log("\n# ripple invariant");
  const targets: TrimTarget[] = [
    { wordIndex: 1, transcriptMs: 1000, direction: "extendPrev" },
    { wordIndex: 2, transcriptMs: 2000, direction: "extendPrev" },
  ];
  const preTick = 100n * FRAME_TICKS_23976;
  const postTick = 98n * FRAME_TICKS_23976;
  const preTotal = 1000n * FRAME_TICKS_23976;
  const postTotal = preTotal - (preTick - postTick);
  const audit = buildRippleAudit(targets, preTotal, postTotal, preTick, postTick);
  equal("audit: two rows", audit.rows.length, 2);
  equal("audit: zero drift", audit.totalDriftTicks, 0);
  equal("audit: every invariant passed", audit.rows.every((row) => row.invariantPassed), true);
  equal("audit: final duration is read back", audit.finalDurationTicks, postTotal.toString());
  equal("audit: frame constant is reported", audit.frameTicksAt23976, FRAME_TICKS_23976.toString());

  const drift = buildRippleAudit(targets, preTotal, postTotal - 1n, preTick, postTick);
  equal("audit: one tick of drift is caught", drift.totalDriftTicks, 2);
  equal("audit: drift rows failed", drift.rows.filter((row) => !row.invariantPassed).length, 2);

  writeFileSync(resolve(OUTPUT, "ripple_audit.json"), JSON.stringify(audit, null, 2));
  writeFileSync(resolve(OUTPUT, "ripple_audit_drift.json"), JSON.stringify(drift, null, 2));
  ok("output: ripple_audit.json", existsSync(resolve(OUTPUT, "ripple_audit.json")));
  ok("output: drift counter-example", existsSync(resolve(OUTPUT, "ripple_audit_drift.json")));
  const disk = JSON.parse(readFileSync(resolve(OUTPUT, "ripple_audit.json"), "utf8"));
  equal("output: audit zero drift", disk.totalDriftTicks, 0);
  assert.equal(disk.rows.length, 2);

  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 2,
    engine: "filmcraft timebase (pure)",
    assertions: passed + 1,
    ticksPerMs: TICKS_PER_MS.toString(),
    frameTicks23976: FRAME_TICKS_23976.toString(),
    targets: targets.length,
    audit: { totalDriftTicks: audit.totalDriftTicks, finalDurationTicks: audit.finalDurationTicks },
    artefacts: ["ripple_audit.json", "ripple_audit_drift.json"],
    result: "banker's rounding, frame snapping and the post-batch zero-drift invariant verified",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));

  console.log(`\n${passed} assertions passed`);
}

main();
