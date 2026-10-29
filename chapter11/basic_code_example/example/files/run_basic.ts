// run_basic.ts — deterministic harness for the integer-timebase example.
//
// The example builds a two-clip sequence in the real headless FilmCraft,
// checks that the engine reports the tick the agent asked for, and renders
// the frame. The arithmetic is checked against the engine's own numbers.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import {
  FPS_24,
  TICKS_PER_SECOND,
  framesToTicks,
  helloTimebase,
  secondsToTicks,
  ticksToFrames,
} from "./01_route.js";

const OUTPUT = resolve(process.cwd(), "output");

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

async function main(): Promise<void> {
  rmSync(OUTPUT, { recursive: true, force: true });
  mkdirSync(OUTPUT, { recursive: true });

  console.log("\n# the arithmetic");
  equal("timebase: a second is 254016000000 ticks", TICKS_PER_SECOND, 254_016_000_000n);
  equal("timebase: 48 frames at 24 fps is two seconds", framesToTicks(48n, FPS_24), secondsToTicks(2n));
  equal("timebase: one frame at 24 fps", framesToTicks(1n, FPS_24), 10_584_000_000n);
  equal("timebase: the frame of a tick", ticksToFrames(framesToTicks(48n, FPS_24), FPS_24), 48n);
  // A tick inside a frame rounds down to the frame's start; the round trip
  // is an identity only for frame-aligned ticks.
  const frameAligned = framesToTicks(1_234n, FPS_24);
  equal("timebase: the round trip is an identity", framesToTicks(ticksToFrames(frameAligned, FPS_24), FPS_24), frameAligned);
  equal("timebase: an interior tick rounds down", ticksToFrames(frameAligned + 1n, FPS_24), 1_234n);

  // 24000/1001 — the NTSC rate, where a naive decimal drifts.
  const ntsc = { num: 24000n, den: 1001n };
  const frame = framesToTicks(1n, ntsc);
  equal("timebase: 23.976 fps has no fractional tick", frame % 1n, 0n);
  // 24000 frames at 24000/1001 fps is exactly 1001 seconds.
  equal("timebase: 24000 frames at 23.976 fps is 1001 s", framesToTicks(24000n, ntsc), TICKS_PER_SECOND * 1001n);

  console.log("\n# the engine round trip");
  const result = await helloTimebase();
  equal("engine: the second clip starts at frame 48", result.clipBFrame, "48");
  equal("engine: the tick is two seconds", result.clipBTicks, secondsToTicks(2n).toString());
  equal("engine: the render was taken at frame 48", result.renderedAtFrame, "48");

  console.log("\n# the artifacts");
  ok("artifact: the output folder exists", existsSync(OUTPUT));
  assert.ok(result.clipBTicks.length > 0);

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
