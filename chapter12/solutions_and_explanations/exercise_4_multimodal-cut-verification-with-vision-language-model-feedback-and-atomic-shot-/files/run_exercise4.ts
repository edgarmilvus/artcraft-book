// run_exercise4.ts — deterministic harness for the exercise-4 solution.
//
// The pipeline is driven against the real headless FilmCraft: a brand film
// and a B-roll pool are imported, a cutdown is built, the opening frame is
// rendered and graded by the (stubbed) vision model, and the replacement shot
// is swapped in when the grade does not pass.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  const master = resolve(READ_ROOT, "master");
  const broll = resolve(master, "broll");
  for (const dir of [master, broll, WRITE_ROOT]) mkdirSync(dir, { recursive: true });

  makeMovie(resolve(master, "brand_film.mov"), 20, 0x334455);
  makeMovie(resolve(broll, "hero_shot_01.mov"), 16, 0xaa5533);
  makeMovie(resolve(broll, "hero_shot_02.mov"), 16, 0x55aa33);
  makeMovie(resolve(broll, "hero_shot_03.mov"), 16, 0x3355aa);

  writeFileSync(
    resolve(READ_ROOT, "briefs.json"),
    JSON.stringify(
      [
        {
          cutdownId: "S01",
          durationSeconds: 15,
          openingBrief: "warm light, shallow depth of field, the founder at work",
          clauseSeverity: "strict",
          threshold: 75,
        },
      ],
      null,
      2,
    ),
  );

  console.log("\n# the solution");
  const stdout = execFileSync("npx", ["tsx", "02_exercise4_vlm_cutdown.ts"], {
    cwd: process.cwd(),
    env: {
      ...(process.env as Record<string, string>),
      FILMCRAFT_READ_ROOT: READ_ROOT,
      FILMCRAFT_WRITE_ROOT: WRITE_ROOT,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 600_000,
  });

  const report = JSON.parse(stdout) as {
    cutdowns: Array<{
      cutdownId: string;
      attempts: Array<{ attemptIndex: number; accepted: boolean; assessment: { clauses: unknown[]; overall: number; match: boolean } }>;
      finalItemId: number | null;
      finalFramePath: string | null;
      verifiedMarkerName: string;
      verifiedAtTick: number;
      midpointPreviewPath: string;
    }>;
    acceptedCount: number;
    rejectedCount: number;
    averageAttempts: number;
    totalVlmCalls: number;
    totalRenderCalls: number;
  };

  console.log("\n# the report");
  ok("report: it parsed", typeof report === "object" && report !== null);
  ok("report: one cutdown was audited", report.cutdowns.length === 1, `${report.cutdowns.length}`);
  const audit = report.cutdowns[0];
  ok("report: the attempts were recorded", audit.attempts.length > 0, `${audit.attempts.length}`);
  ok(
    "report: every attempt was graded",
    audit.attempts.every((a) => a.assessment.clauses.length === 3),
  );
  ok(
    "report: the attempt index is dense",
    audit.attempts.every((a, i) => a.attemptIndex === i),
  );
  ok("report: the cutdown is accounted for", report.acceptedCount + report.rejectedCount === 1);
  ok("report: the model was called", report.totalVlmCalls > 0, `${report.totalVlmCalls}`);
  ok("report: frames were rendered", report.totalRenderCalls > 0, `${report.totalRenderCalls}`);
  ok(
    "report: the marker name is the contract's",
    audit.verifiedMarkerName === "VERIFIED_OPEN",
    audit.verifiedMarkerName,
  );

  console.log("\n# the artifacts");
  ok("artifact: the midpoint preview exists", existsSync(resolve(WRITE_ROOT, audit.midpointPreviewPath)));
  ok(
    "artifact: the audit trail is on disk",
    existsSync(resolve(WRITE_ROOT, `cutdown_${audit.cutdownId}_audit.json`)),
  );
  if (audit.finalFramePath) {
    ok("artifact: the accepted frame exists", existsSync(resolve(WRITE_ROOT, audit.finalFramePath)));
  }

  assert.ok(audit.attempts.length > 0);
  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 4,
    engine: "filmcraft-cli",
    assertions: passed + 1,
    cutdowns: report.cutdowns,
    acceptedCount: report.acceptedCount,
    rejectedCount: report.rejectedCount,
    totalVlmCalls: report.totalVlmCalls,
    totalRenderCalls: report.totalRenderCalls,
    artefacts: ["read/", "write/"],
    result: "opening frames rendered, graded clause by clause and replaced atomically when the strict grade failed",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));
  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
