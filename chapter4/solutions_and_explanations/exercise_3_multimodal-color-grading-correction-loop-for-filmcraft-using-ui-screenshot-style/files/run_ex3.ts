/**
 * Acceptance harness for the chapter-4 exercise 3 colour correction loop.
 *
 * The loop uses two peers: the real FilmCraft engine over MCP for renders
 * and sequence inspection, and the authenticated loopback socket for
 * screenshots and heartbeat. The socket peer is the protocol stub because
 * the shipped FilmCraft CLI does not expose the chapter's raw TCP surface.
 *
 * Run from the solution's `output/` directory so frame rotation writes its
 * audit trail there.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { EngineStub } from "../../../_harness/engine-stub.js";
import { ColorCorrectionLoop } from "./03_multimodal-color-grading-correction-loop-for-filmcraft-using-ui-screenshot-style-feedback.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "..", "output");
const checks: { label: string; ok: boolean; detail: string }[] = [];
const ok = (label: string, cond: boolean, detail = ""): boolean => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label.padEnd(44)}${detail}`);
  checks.push({ label, ok: cond, detail });
  return cond;
};

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  process.chdir(OUT);
  fs.rmSync("audit", { recursive: true, force: true });
  fs.mkdirSync("audit", { recursive: true });

  const port = Number(process.env.RUN_PORT ?? 7905);
  const token = randomBytes(32).toString("hex");
  const stub = new EngineStub({ port, token, challenge: false });
  await stub.start();

  try {
    const outcome = await new ColorCorrectionLoop().run(
      {
        sequenceId: "seq-1",
        referenceFrameSeconds: 0,
        targetSeconds: [1, 2, 3],
        targetDeltaE: 1.0,
        maxCyclesPerClip: 3,
      },
      { port, token, filmcraftArgs: ["--demo"] },
    );

    const records = outcome.records;
    const audits = fs.existsSync("audit") ? fs.readdirSync("audit") : [];
    ok("one record per target second", records.length === 3, `records=${records.length}`);
    ok("target seconds preserved", records.map((r) => r.seconds).join(",") === "1,2,3");
    ok("each clip converged in one cycle", records.every((r) => r.cycle === 1), JSON.stringify(records.map((r) => r.cycle)));
    ok("all clip outcomes converged", [...outcome.clipOutcomes.values()].every((v) => v === "converged"),
      JSON.stringify([...outcome.clipOutcomes]));
    ok("under the delta-E target", outcome.finalDeltaE < 1.0, `deltaE=${outcome.finalDeltaE}`);
    ok("records are immutable", records.every((r) => Object.isFrozen(r)));
    ok("frame paths were recorded", records.every((r) => r.framePngPath.startsWith("audit/cycle-")));
    ok("rendered frames exist", records.every((r) => fs.existsSync(r.framePngPath)));
    ok("frame rotation keeps only three files", audits.length === 3, `files=${audits.length}`);
    ok("every audit file is a PNG", audits.every((f) => fs.readFileSync(path.join("audit", f)).subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))));
    const auditSizes = audits.map((f) => fs.statSync(path.join("audit", f)).size);
    ok("audit frames are real renders", auditSizes.every((n) => n > 1000),
      `min=${Math.min(...auditSizes)} bytes`);
    ok("auth reached the socket", stub.calls.filter((c) => c === "auth").length === 1, JSON.stringify(stub.calls));
    ok("one screenshot per rendered frame", stub.calls.filter((c) => c === "ui.screenshot").length === 3,
      JSON.stringify(stub.calls));

    const failed = checks.filter((c) => !c.ok).length;
    fs.writeFileSync(path.join(OUT, "run-log.json"), JSON.stringify({
      checks: checks.length,
      failures: checks.filter((c) => !c.ok).map((c) => c.label),
      records: records.map((r) => ({ cycle: r.cycle, seconds: r.seconds, deltaE: r.deltaE })),
      outcomes: [...outcome.clipOutcomes],
      finalDeltaE: outcome.finalDeltaE,
      auditFiles: audits,
    }, null, 2) + "\n");
    console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
    if (failed) process.exitCode = 1;
  } finally {
    await stub.stop();
  }
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
