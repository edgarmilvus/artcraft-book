// run_basic.ts — deterministic harness for the three-way grading pipeline.
//
// The whole job runs against the real headless FilmCraft: a dialogue take, a
// music bed and four B-roll stills are imported, the timeline is laid out,
// the three-way wheels are pushed, the mix is governed and the delivery is
// exported.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import {
  FilmCraftMCP,
  findItemId,
  runAutoFinish,
  ticks,
  trackAlias,
  TICKS_PER_SECOND,
} from "./01_filmcraft-threeway-ducking.js";

const OUTPUT = resolve(process.cwd(), "output");
const PROJECT = resolve(OUTPUT, "project");

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

/** A still frame for the B-roll bin. */
function makeFrame(seed: number, size = 320): Buffer {
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      png.data[i] = 30 + Math.floor(150 * Math.sin((x + seed * 40) / 55) * Math.cos(y / 70));
      png.data[i + 1] = 50 + Math.floor(110 * Math.cos((y + seed * 15) / 50));
      png.data[i + 2] = 90 + Math.floor(100 * Math.sin((x + y + seed * 8) / 85));
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** A tone: the music bed. */
function makeTone(seconds: number, frequency: number): Buffer {
  const rate = 48000;
  const samples = rate * seconds;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) {
    // A slow tremolo, so the music is not a pure sine.
    const value = Math.sin((2 * Math.PI * frequency * i) / rate) * 0.3 * (0.6 + 0.4 * Math.sin(i / 4000));
    buffer.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  return buffer;
}

async function main(): Promise<void> {
  rmSync(OUTPUT, { recursive: true, force: true });
  const stems = resolve(PROJECT, "stems");
  const broll = resolve(PROJECT, "broll");
  const delivery = resolve(PROJECT, "deliveries");
  for (const dir of [stems, broll, delivery]) mkdirSync(dir, { recursive: true });

  const dialogue = resolve(stems, "dialogue.wav");
  const music = resolve(stems, "music.wav");
  writeFileSync(dialogue, makeTone(12, 180));
  writeFileSync(music, makeTone(16, 110));
  const brollFiles: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const path = resolve(broll, `0${i + 1}.png`);
    writeFileSync(path, makeFrame(i));
    brollFiles.push(path);
  }

  console.log("\n# the arithmetic");
  equal("ticks: a second is 254016000000 ticks", TICKS_PER_SECOND, 254_016_000_000n);
  equal("ticks: two seconds", ticks(2), 508_032_000_000);
  equal("ticks: a quarter second", ticks(0.25), 63_504_000_000);
  equal("ticks: the fractional part survives", ticks(1.5), 381_024_000_000);
  equal("aliases: Video 1 is V1", trackAlias("Video 1"), "V1");
  equal("aliases: Audio 2 is A2", trackAlias("Audio 2"), "A2");

  console.log("\n# the job");
  await runAutoFinish({
    projectRoot: PROJECT,
    dialogueFile: dialogue,
    musicFile: music,
    brollFiles,
    grade: {
      shadows: { band: "shadows", hue: 0.58, sat: 0.35, lum: -0.12 },
      midtonesOpen: { band: "midtones", hue: 0.6, sat: 0.22, lum: -0.06 },
      midtonesClose: { band: "midtones", hue: 0.08, sat: 0.3, lum: 0.05 },
      highlights: { band: "highlights", hue: 0.1, sat: 0.18, lum: 0.08 },
      openAt: 0,
      closeAt: 8,
    },
    loudness: {
      dialogueLufs: -16,
      musicBedLufs: -26,
      truePeakDbtp: -1.0,
      duckDepthDb: -12,
      deliveryLufs: -14,
    },
    deliveryPath: resolve(delivery, "ep13_master.mp4"),
    projectPath: resolve(PROJECT, "ep13.fcproj"),
  });

  console.log("\n# the delivery");
  const exported = resolve(delivery, "ep13_master.mp4");
  ok("delivery: it exists", existsSync(exported), exported);
  ok("delivery: it is not empty", statSync(exported).size > 10_000, `${statSync(exported).size} bytes`);

  console.log("\n# the mix");
  // A second session reads the governed mix back out of the saved project.
  const fc = new FilmCraftMCP(PROJECT);
  await fc.connect();
  try {
    const opened = await fc.run("file.open", { path: resolve(PROJECT, "ep13.fcproj") });
    ok("mix: the project was saved and reopens", opened !== undefined);

    const tree = await fc.inspect();
    ok("mix: the dialogue is in the project", findItemId(tree, "dialogue.wav") > 0);
    ok("mix: the music is in the project", findItemId(tree, "music.wav") > 0);

    const seq = (tree as { sequence?: { audio?: Array<{ name: string; items?: Array<{ clip: number }> }> } }).sequence;
    const audio = seq?.audio ?? [];
    ok("mix: there are two audio tracks", audio.length >= 2, `${audio.length}`);
    const aliases = audio.map((t) => trackAlias(t.name));
    ok("mix: A1 carries the dialogue", aliases.includes("A1"), aliases.join(", "));
    ok("mix: A2 carries the music", aliases.includes("A2"), aliases.join(", "));

    // Essential Sound is addressed by *clip* id, not by item id.
    const clipOn = (alias: string): number => {
      const track = audio.find((t) => trackAlias(t.name) === alias);
      const clip = track?.items?.[0]?.clip;
      if (clip === undefined) throw new Error(`no clip on ${alias}`);
      return clip;
    };
    const musicClip = clipOn("A2");
    const dialogueClip = clipOn("A1");

    const inspected = (await fc.run("essentialSound.inspect", { clips: [musicClip] })) as {
      clips?: Array<{ settings?: { kind?: string; ducking?: { enabled?: boolean; reduce_db?: number }; loudness?: { measured_lufs?: number | null } } }>;
    };
    const musicSettings = inspected.clips?.[0]?.settings;
    equal("mix: the music is typed as music", musicSettings?.kind, "Music");
    ok("mix: the ducking is on", musicSettings?.ducking?.enabled === true, JSON.stringify(musicSettings?.ducking));
    equal(
      "mix: the ducking depth is the policy's",
      musicSettings?.ducking?.reduce_db,
      -12,
    );

    const dialogueSettings = (await fc.run("essentialSound.inspect", { clips: [dialogueClip] })) as {
      clips?: Array<{ settings?: { kind?: string; loudness?: { measured_lufs?: number | null } } }>;
    };
    equal(
      "mix: the dialogue is typed as dialogue",
      dialogueSettings.clips?.[0]?.settings?.kind,
      "Dialogue",
    );
    const measured = dialogueSettings.clips?.[0]?.settings?.loudness?.measured_lufs;
    ok("mix: the dialogue loudness was measured", typeof measured === "number", `${measured}`);
  } finally {
    await fc.close();
  }

  assert.ok(existsSync(exported));
  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
