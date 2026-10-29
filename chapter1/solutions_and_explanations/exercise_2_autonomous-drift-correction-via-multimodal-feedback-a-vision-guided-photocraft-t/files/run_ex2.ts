/**
 * run_ex2.ts — acceptance harness for Chapter 1, Exercise 2.
 *
 * Starts a real `photocraft-cli serve` control channel, drives the drift
 * correction loop against it with a scripted vision model, and verifies the
 * document, the artefacts and the loop's exit conditions.
 *
 *   npx tsx run_ex2.ts
 *
 * The engine is started with both automation roots pointed at this exercise,
 * so every engine path below is relative to
 * `solutions_and_explanations/exercise_2_.../`.
 */

import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

import {
  AuthError,
  CraftLiveClient,
  adjustmentOf,
  hueSaturationLayers,
  runDriftCorrection,
  type Adjustment,
  type AuditRequest,
  type Auditor,
  type DriftRunResult,
} from "./02_autonomous-drift-correction-via-multimodal-feedback-a-vision-guided-photocraft-tcp-session.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXERCISE = resolve(HERE, "..");
const OUT = resolve(EXERCISE, "output");
const REPO = resolve(HERE, "../../../..");
const BIN = process.env.PHOTOCRAFT_BIN ?? resolve(REPO, "tools/craft-cli/bin/photocraft-cli");

const FIXTURE = "output/fixtures/product-42.pcraft";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let assertions = 0;
const transcript: string[] = [];

function say(line: string): void {
  transcript.push(line);
  console.log(line);
}

function ok(label: string, condition: boolean, detail = ""): void {
  if (!condition) {
    say(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    throw new Error(label);
  }
  assertions += 1;
  say(`PASS ${label}`);
}

function equal<T>(label: string, actual: T, expected: T): void {
  ok(label, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

function deepEqual(label: string, actual: unknown, expected: unknown): void {
  assert.deepStrictEqual(actual, expected);
  assertions += 1;
  say(`PASS ${label}`);
}

function close(label: string, actual: number, expected: number, eps = 1e-9): void {
  ok(label, Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);
}

// ---------------------------------------------------------------------------
// Engine lifecycle
// ---------------------------------------------------------------------------

interface Engine {
  port: number;
  token: string;
  child: ChildProcess;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return await new Promise<number>((done, fail) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

async function startEngine(): Promise<Engine> {
  if (!existsSync(BIN)) throw new Error(`photocraft-cli not found at ${BIN}`);
  const port = await freePort();
  const token = randomBytes(32).toString("hex");
  const child = spawn(
    BIN,
    [
      "serve",
      "--port",
      String(port),
      "--control-token",
      token,
      "--automation-read-root",
      EXERCISE,
      "--automation-write-root",
      EXERCISE,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const output: string[] = [];
  child.stdout?.on("data", (chunk) => output.push(String(chunk)));
  child.stderr?.on("data", (chunk) => output.push(String(chunk)));

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((done) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        done(true);
      });
      socket.once("error", () => {
        socket.destroy();
        done(false);
      });
    });
    if (connected) break;
    await new Promise((done) => setTimeout(done, 100));
  }

  if (child.exitCode !== null) {
    throw new Error(`photocraft-cli serve exited: ${output.join("")}`);
  }

  return {
    port,
    token,
    child,
    async stop(): Promise<void> {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>((done) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            done();
          }, 5000);
          child.once("exit", () => {
            clearTimeout(timer);
            done();
          });
        });
      }
    },
  };
}

async function withEngine<T>(fn: (client: CraftLiveClient, engine: Engine) => Promise<T>): Promise<T> {
  const engine = await startEngine();
  const client = new CraftLiveClient({ port: engine.port, token: engine.token, root: EXERCISE });
  try {
    await client.connect();
    return await fn(client, engine);
  } finally {
    client.close();
    await engine.stop();
  }
}

// ---------------------------------------------------------------------------
// Scripted vision model
// ---------------------------------------------------------------------------

function reply(
  saturation: number,
  hue = 0,
  lightness = 0,
): { status: "adjust"; diagnosis: { skin_saturation: number; shadow_clipping: boolean }; correction: object } {
  return {
    status: "adjust",
    diagnosis: { skin_saturation: 0.71, shadow_clipping: false },
    correction: { saturation_delta: saturation, hue_delta: hue, lightness_delta: lightness },
  };
}

const DONE = {
  status: "ok",
  diagnosis: { skin_saturation: 0.48, shadow_clipping: false },
};

interface ScriptedAuditor extends Auditor {
  seen: AuditRequest[];
}

function scripted(replies: unknown[]): ScriptedAuditor {
  const seen: AuditRequest[] = [];
  return {
    seen,
    async review(request: AuditRequest): Promise<unknown> {
      seen.push(request);
      if (replies.length === 0) return DONE;
      return replies.length === 1 ? replies[0] : replies.shift();
    },
  };
}

// ---------------------------------------------------------------------------
// Assertions helpers
// ---------------------------------------------------------------------------

function pngSize(path: string): { width: number; height: number; bytes: number } {
  const buffer = readFileSync(path);
  ok(`png signature ${path}`, buffer.subarray(0, 8).equals(PNG_SIGNATURE), "not a PNG");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bytes: buffer.byteLength,
  };
}

function oneAdjustmentLayer(label: string, inspection: any): void {
  const found = hueSaturationLayers(inspection);
  equal(`${label}: exactly one Hue/Saturation layer`, found.length, 1);
  equal(`${label}: the background is still there`, inspection.layers.length, 2);
}

function checkScreenshots(label: string, run: DriftRunResult, auditor: ScriptedAuditor): void {
  equal(`${label}: one screenshot per iteration`, run.screenshots.length, run.iterations);
  for (let i = 0; i < run.screenshots.length; i += 1) {
    const absolute = resolve(EXERCISE, run.screenshots[i]);
    ok(`${label}: screenshot ${i} exists`, existsSync(absolute), absolute);
    const size = pngSize(absolute);
    ok(`${label}: screenshot ${i} has pixels`, size.width > 0 && size.height > 0);
    const wire = Buffer.from(auditor.seen[i].pngBase64, "base64");
    ok(`${label}: the auditor received screenshot ${i} as base64 PNG`, wire.subarray(0, 8).equals(PNG_SIGNATURE));
    ok(`${label}: the base64 payload is the rendered file`, wire.equals(readFileSync(absolute)));
    equal(`${label}: screenshot ${i} engine path`, auditor.seen[i].pngPath, run.screenshots[i]);
  }
}

function checkSaved(label: string, run: DriftRunResult): void {
  const saved = resolve(EXERCISE, run.savedPath);
  ok(`${label}: the native document was saved`, existsSync(saved), saved);
  ok(`${label}: the document is not empty`, statSync(saved).size > 5000, `${statSync(saved).size} bytes`);
  equal(`${label}: the save reported no warnings`, run.saveWarnings.length, 0);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/**
 * The control token is a hard gate: a client that has not sent the auth frame
 * is refused, and a client with the wrong token cannot connect at all.
 */
async function scenarioAuthIsMandatory(engine: Engine): Promise<void> {
  const unauthenticated = await new Promise<string>((done, fail) => {
    const socket = createConnection({ host: "127.0.0.1", port: engine.port });
    let buffer = "";
    socket.on("connect", () => {
      const frame = { id: "1", method: "engine.execute", params: { command: "document.inspect", params: {} } };
      socket.write(JSON.stringify(frame) + "\n");
    });
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      const line = buffer.split("\n").find((l) => l.trim().length > 0);
      if (line) {
        socket.destroy();
        done(line);
      }
    });
    socket.on("error", fail);
    setTimeout(() => {
      socket.destroy();
      fail(new Error("no reply to an unauthenticated frame"));
    }, 10_000);
  });
  const refusal = JSON.parse(unauthenticated) as { ok: boolean; error?: string };
  equal("auth: an unauthenticated frame is refused", refusal.ok, false);
  ok("auth: the refusal names authentication", /authenticat/i.test(refusal.error ?? ""), refusal.error ?? "");

  const wrong = new CraftLiveClient({ port: engine.port, token: "0".repeat(64), root: EXERCISE });
  await assert.rejects(() => wrong.connect(), AuthError);
  assertions += 1;
  say("PASS auth: a wrong token is rejected before any command runs");

  const offline = new CraftLiveClient({ port: engine.port, token: engine.token, root: EXERCISE });
  await assert.rejects(() => offline.execute("document.inspect"), AuthError);
  assertions += 1;
  say("PASS auth: execute() refuses to run before connect()");
  offline.close();
}

/** The book's worked sequence: -9, -11, then ok. */
async function scenarioConverge(): Promise<void> {
  await withEngine(async (client) => {
    const auditor = scripted([reply(-9, -2), reply(-11, -3), DONE]);
    const run = await runDriftCorrection({
      client,
      auditor,
      fixture: FIXTURE,
      auditDir: "output/converge/audit",
      finalPath: "output/converge/retouch/product-42-ok.pcraft",
      log: (line) => say(`  [converge] ${line}`),
    });

    equal("converge: status", run.status, "ok");
    equal("converge: iterations", run.iterations, 3);
    equal("converge: corrections applied", run.corrections, 2);
    equal("converge: no malformed replies", run.malformed, 0);
    deepEqual("converge: corrections are cumulative on one layer", run.applied, [
      { hue: -3, saturation: -6, lightness: 0 },
      { hue: -5, saturation: -15, lightness: 0 },
      { hue: -8, saturation: -26, lightness: 0 },
    ]);
    equal("converge: the auditor saw every iteration", auditor.seen.length, 3);
    checkScreenshots("converge", run, auditor);
    checkSaved("converge", run);

    oneAdjustmentLayer("converge", run.inspection);
    deepEqual("converge: the saved layer carries the final values", adjustmentOf(run.inspection, run.layerId), {
      hue: -8,
      saturation: -26,
      lightness: 0,
    });

    // Re-open the saved file in a fresh document: the layer is still live.
    await client.open(run.savedPath);
    const reopened = await client.inspect();
    oneAdjustmentLayer("converge/reopen", reopened);
    deepEqual("converge: values survive the save/re-open round trip", adjustmentOf(reopened, run.layerId), {
      hue: -8,
      saturation: -26,
      lightness: 0,
    });
  });
}

/** The auditor keeps reversing direction with the same magnitude. */
async function scenarioOscillation(): Promise<void> {
  await withEngine(async (client) => {
    const auditor = scripted([reply(-9), reply(10), reply(-10), reply(10)]);
    const run = await runDriftCorrection({
      client,
      auditor,
      fixture: FIXTURE,
      auditDir: "output/oscillation/audit",
      finalPath: "output/oscillation/retouch/product-42-oscillating.pcraft",
      maxIterations: 8,
      log: (line) => say(`  [oscillation] ${line}`),
    });

    equal("oscillation: status", run.status, "oscillating");
    ok("oscillation: reason names the sign flip", /alternating sign/i.test(run.why), run.why);
    equal("oscillation: stopped on the third reply", run.iterations, 3);
    equal("oscillation: only the non-oscillating corrections were applied", run.applied.length, 3);
    close("oscillation: saturation", run.values.saturation, -5);
    deepEqual("oscillation: the reversing delta was not applied", run.applied.at(-1), {
      hue: -3,
      saturation: -5,
      lightness: 0,
    });
    checkScreenshots("oscillation", run, auditor);
    checkSaved("oscillation", run);
    oneAdjustmentLayer("oscillation", run.inspection);
  });
}

/** Two sub-epsilon corrections in a row: the loop is stalling. */
async function scenarioStall(): Promise<void> {
  await withEngine(async (client) => {
    const auditor = scripted([reply(0.4), reply(-0.5), reply(0.3)]);
    const run = await runDriftCorrection({
      client,
      auditor,
      fixture: FIXTURE,
      auditDir: "output/stall/audit",
      finalPath: "output/stall/retouch/product-42-stalled.pcraft",
      maxIterations: 8,
      log: (line) => say(`  [stall] ${line}`),
    });

    equal("stall: status", run.status, "oscillating");
    ok("stall: reason names the sub-epsilon corrections", /sub-epsilon/i.test(run.why), run.why);
    equal("stall: stopped after the second reply", run.iterations, 2);
    equal("stall: only the first micro-correction was applied", run.applied.length, 2);
    close("stall: saturation", run.values.saturation, -5.6);
    checkScreenshots("stall", run, auditor);
    checkSaved("stall", run);
    oneAdjustmentLayer("stall", run.inspection);
  });
}

/** A schema violation costs a unit of budget but must not touch the document. */
async function scenarioMalformed(): Promise<void> {
  await withEngine(async (client) => {
    const bad = {
      status: "adjust",
      diagnosis: { skin_saturation: 1.7, shadow_clipping: false },
      correction: { saturation_delta: -4, hue_delta: 0, lightness_delta: 0 },
    };
    const auditor = scripted([bad, reply(-9), DONE]);
    const run = await runDriftCorrection({
      client,
      auditor,
      fixture: FIXTURE,
      auditDir: "output/malformed/audit",
      finalPath: "output/malformed/retouch/product-42-ok.pcraft",
      maxIterations: 6,
      log: (line) => say(`  [malformed] ${line}`),
    });

    equal("malformed: status", run.status, "ok");
    equal("malformed: the bad reply was counted", run.malformed, 1);
    equal("malformed: it still consumed budget", run.iterations, 3);
    equal("malformed: the earlier correction was skipped", run.applied.length, 2);
    deepEqual("malformed: only the valid delta reached the engine", run.applied[1], {
      hue: -3,
      saturation: -15,
      lightness: 0,
    });
    deepEqual("malformed: final values", run.values, { hue: -3, saturation: -15, lightness: 0 });
    checkScreenshots("malformed", run, auditor);
    checkSaved("malformed", run);
    oneAdjustmentLayer("malformed", run.inspection);
  });
}

/** The budget runs out while the auditor still asks for changes. */
async function scenarioBudget(): Promise<void> {
  await withEngine(async (client) => {
    const auditor = scripted([reply(20)]);
    const run = await runDriftCorrection({
      client,
      auditor,
      fixture: FIXTURE,
      auditDir: "output/budget/audit",
      finalPath: "output/budget/retouch/product-42-budget.pcraft",
      maxIterations: 3,
      log: (line) => say(`  [budget] ${line}`),
    });

    equal("budget: status", run.status, "budget_exhausted");
    ok("budget: reason names the iteration limit", /3 iterations/.test(run.why), run.why);
    equal("budget: iterations", run.iterations, 3);
    equal("budget: the seed and two audited corrections reached the engine", run.applied.length, 3);
    close("budget: saturation accumulated", run.values.saturation, 34);
    equal("budget: the last requested correction was not applied", run.corrections, 3);
    checkScreenshots("budget", run, auditor);
    checkSaved("budget", run);
    oneAdjustmentLayer("budget", run.inspection);
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function makeFixture(): Promise<void> {
  await withEngine(async (client) => {
    mkdirSync(dirname(resolve(EXERCISE, FIXTURE)), { recursive: true });
    await client.execute("file.new", {
      width: 512,
      height: 320,
      mode: "rgb",
      depth: 8,
      background: "#b98b6e",
      name: "product-42",
    });
    const saved = await client.save(FIXTURE);
    equal("fixture: saved", saved.path, FIXTURE);
    ok("fixture: exists", existsSync(resolve(EXERCISE, FIXTURE)));
  });
}

async function main(): Promise<void> {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  await makeFixture();

  for (const [name, scenario] of [
    ["auth", () => withEngine((_, engine) => scenarioAuthIsMandatory(engine))],
    ["converge", scenarioConverge],
    ["oscillation", scenarioOscillation],
    ["stall", scenarioStall],
    ["malformed", scenarioMalformed],
    ["budget", scenarioBudget],
  ] as Array<[string, () => Promise<void>]>) {
    say(`\n== ${name} ==`);
    await scenario();
  }

  say(`\n${assertions} assertions passed`);
  writeFileSync(resolve(OUT, "run_ex2.log"), transcript.join("\n") + "\n");
}

main().catch((err) => {
  say(`[fatal] ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  writeFileSync(resolve(OUT, "run_ex2.log"), transcript.join("\n") + "\n");
  process.exitCode = 1;
});
