// run_basic.ts — deterministic harness for the autonomous video assembler.
//
// The graph is driven against the real headless FilmCraft: a dialogue take
// and two B-roll stills are imported, the transcript is cut, the dead air is
// ripple-trimmed, and the result is verified with a rendered frame.

import { strict as assert } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import {
  BrollScorer,
  FilmCraftClient,
  buildAssemblerGraph,
  runAssemblyJob,
  secondsToTicks,
  TICKS_PER_SECOND,
} from "./01_autonomousVideoAssembler.js";

const OUTPUT = resolve(process.cwd(), "output");
const MEDIA = resolve(OUTPUT, "media");

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

/** A still frame for the media bin. */
function makeFrame(seed: number, size = 480): Buffer {
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      png.data[i] = 30 + Math.floor(140 * Math.sin((x + seed * 50) / 70) * Math.cos(y / 90));
      png.data[i + 1] = 50 + Math.floor(100 * Math.cos((y + seed * 20) / 60));
      png.data[i + 2] = 90 + Math.floor(90 * Math.sin((x + y + seed * 10) / 100));
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

async function main(): Promise<void> {
  rmSync(OUTPUT, { recursive: true, force: true });
  mkdirSync(MEDIA, { recursive: true });

  const dialogue = resolve(MEDIA, "dialogue.png");
  const brollA = resolve(MEDIA, "broll-a.png");
  const brollB = resolve(MEDIA, "broll-b.png");
  writeFileSync(dialogue, makeFrame(0));
  writeFileSync(brollA, makeFrame(1));
  writeFileSync(brollB, makeFrame(2));

  console.log("\n# the arithmetic");
  equal("ticks: a second is 254016000000 ticks", TICKS_PER_SECOND, 254_016_000_000n);
  equal("ticks: two seconds", secondsToTicks(2), 508_032_000_000);
  equal("ticks: a quarter second", secondsToTicks(0.25), 63_504_000_000);
  ok("ticks: the value is a number", typeof secondsToTicks(1) === "number");

  console.log("\n# the graph");
  const client = new FilmCraftClient();
  await client.connect();
  try {
    const scorer = new BrollScorer();
    const graph = buildAssemblerGraph(client, scorer);
    ok("graph: it compiles", typeof graph.invoke === "function");

    const state = await graph.invoke({
      jobId: "job-1",
      mediaPaths: [dialogue, brollA, brollB],
    });

    ok("graph: the supervisor ran", state.next === "finish", state.next);
    ok("graph: the transcript was built", state.transcript.length === 6, `${state.transcript.length}`);
    ok("graph: the b-roll was ranked", state.brollRanked.length === 2, `${state.brollRanked.length}`);
    ok("graph: the timeline ops were recorded", state.timelineOps.length >= 4, `${state.timelineOps.length}`);
    ok("graph: the verification passed", state.verification.ok, state.verification.notes);

    console.log("\n# the sequence");
    const inspect = await client.run("sequence.inspect");
    const text = (inspect as { content?: { type: string; text?: string }[] })
      .content?.find((block) => block.type === "text")?.text ?? "{}";
    const sequence = JSON.parse(text) as any;
    const items = (sequence.video ?? []).flatMap((track: any) => track.items ?? []);
    ok("sequence: it exists", typeof sequence.id === "number");
    ok("sequence: the tracks are there", (sequence.video ?? []).length >= 2);
    ok("sequence: the dialogue is on V1", items.some((item: any) => item.start === 0));
  } finally {
    await client.close();
  }

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
