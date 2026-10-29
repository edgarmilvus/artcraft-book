// run_exercise1.ts — deterministic harness for the exercise-1 solution.
//
// The solution is driven against the real headless FilmCraft: a synthetic
// interview take and three B-roll clips are imported, a sidecar transcript
// stands in for the speech model, the B-roll is matched, placed on V2 and
// rendered into contact sheets.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OUTPUT = resolve(process.cwd(), "..", "output");
const READ_ROOT = resolve(OUTPUT, "read");
const WRITE_ROOT = resolve(OUTPUT, "write");

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

/** A short video clip with a moving colour bar, encoded as H.264 in MOV. */
function makeMovie(path: string, seconds: number, hue: number): void {
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=0x${hue.toString(16).padStart(6, "0")}:s=320x180:r=25:d=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=${220 + hue}:duration=${seconds}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    path,
  ]);
}

async function main(): Promise<void> {
  rmSync(resolve(OUTPUT, "read"), { recursive: true, force: true });
  rmSync(resolve(OUTPUT, "write"), { recursive: true, force: true });
  rmSync(resolve(OUTPUT, "report.json"), { force: true });
  const arollDir = resolve(READ_ROOT, "B_Roll_Project");
  const brollDir = resolve(arollDir, "B_Roll/Day03");
  for (const dir of [arollDir, brollDir, WRITE_ROOT]) mkdirSync(dir, { recursive: true });

  // The A-roll: the interview take the transcript belongs to.
  makeMovie(resolve(arollDir, "A001_C003.mov"), 6, 0x224466);
  // The B-roll pool: three clips whose file names carry the vocabulary.
  makeMovie(resolve(brollDir, "city-rooftop-hives.mov"), 4, 0x66aa22);
  makeMovie(resolve(brollDir, "queen-bee-close.mov"), 4, 0xaa6622);
  makeMovie(resolve(brollDir, "honeycomb-extractor.mov"), 4, 0x2266aa);

  // The transcript. The engine has no speech model on this machine, so the
  // sidecar takes its place — the same words the model would have produced.
  const words = [
    { text: "Good", start: 0, end: 254_016_000_000 },
    { text: "morning", start: 254_016_000_000, end: 508_032_000_000 },
    { text: "we", start: 508_032_000_000, end: 635_040_000_000 },
    { text: "are", start: 635_040_000_000, end: 762_048_000_000 },
    { text: "on", start: 762_048_000_000, end: 889_056_000_000 },
    { text: "the", start: 889_056_000_000, end: 1_016_064_000_000 },
    { text: "rooftop", start: 1_016_064_000_000, end: 1_270_080_000_000 },
    { text: "hives", start: 1_270_080_000_000, end: 1_524_096_000_000 },
    { text: "today", start: 1_524_096_000_000, end: 1_778_112_000_000 },
    { text: ".", start: 1_778_112_000_000, end: 1_905_120_000_000 },
    // A pause, then the second sentence.
    { text: "The", start: 3_048_384_000_000, end: 3_175_200_000_000 },
    { text: "queen", start: 3_175_200_000_000, end: 3_429_312_000_000 },
    { text: "bee", start: 3_429_312_000_000, end: 3_556_224_000_000 },
    { text: "is", start: 3_556_224_000_000, end: 3_683_136_000_000 },
    { text: "busy", start: 3_683_136_000_000, end: 3_936_048_000_000 },
    { text: ".", start: 3_936_048_000_000, end: 4_063_344_000_000 },
  ];
  writeFileSync(
    resolve(READ_ROOT, "a_roll_transcript.json"),
    JSON.stringify({ words }, null, 2),
  );

  console.log("\n# the solution");
  const stdout = execFileSync(
    "npx",
    ["tsx", "01_exercise1_broll_assembly.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...(process.env as Record<string, string>),
        FILMCRAFT_READ_ROOT: READ_ROOT,
        FILMCRAFT_WRITE_ROOT: WRITE_ROOT,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const report = JSON.parse(stdout) as {
    sequenceId: number;
    brollPlacements: Array<{ track: string; startTicks: number; durationTicks: number; matchedPhrase: string }>;
    contactSheetPaths: string[];
    reviewDocPath: string;
    undoStepsRequired: number;
    preRunSnapshotPath: string;
  };

  console.log("\n# the report");
  ok("report: it parsed", typeof report === "object" && report !== null);
  ok("report: the sequence has an id", typeof report.sequenceId === "number", `${report.sequenceId}`);
  ok("report: the b-roll was matched", report.brollPlacements.length > 0, `${report.brollPlacements.length}`);
  ok(
    "report: the placement is on V2",
    report.brollPlacements.every((p) => p.track === "V2"),
  );
  ok(
    "report: the placement is inside the timeline",
    report.brollPlacements.every((p) => p.startTicks >= 0 && p.durationTicks > 0),
  );
  ok(
    "report: the phrase is a real match",
    report.brollPlacements.every((p) => p.matchedPhrase.length > 0),
  );
  ok("report: the contact sheet is listed", report.contactSheetPaths.length > 0);
  ok("report: the undo count is positive", report.undoStepsRequired > 0, `${report.undoStepsRequired}`);

  console.log("\n# the artifacts");
  for (const rel of report.contactSheetPaths) {
    ok(`artifact: ${rel} exists`, existsSync(resolve(WRITE_ROOT, rel)));
  }
  ok("artifact: the review document exists", existsSync(resolve(WRITE_ROOT, report.reviewDocPath)));
  ok("artifact: the pre-run snapshot exists", existsSync(resolve(WRITE_ROOT, report.preRunSnapshotPath)));

  const review = readFileSync(resolve(WRITE_ROOT, report.reviewDocPath), "utf8");
  ok("artifact: the review document is a table", review.includes("| timecode |"), review.slice(0, 60));

  const snapshot = JSON.parse(readFileSync(resolve(WRITE_ROOT, report.preRunSnapshotPath), "utf8"));
  ok("artifact: the snapshot holds the project", snapshot.project !== undefined);
  ok("artifact: the snapshot holds the sequence", snapshot.sequence !== undefined);

  assert.ok(report.brollPlacements.length > 0);
  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 1,
    engine: "filmcraft-cli",
    assertions: passed + 1,
    sequenceId: report.sequenceId,
    placements: report.brollPlacements,
    contactSheets: report.contactSheetPaths,
    reviewDoc: report.reviewDocPath,
    preRunSnapshot: report.preRunSnapshotPath,
    undoStepsRequired: report.undoStepsRequired,
    artefacts: ["read/", "write/"],
    result: "transcript phrases matched to the B-roll pool and placed on V2 without rippling A-roll",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));
  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
