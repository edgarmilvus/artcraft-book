/**
 * Acceptance harness for the chapter-4 exercise 4 heterogeneous fan-out.
 *
 * Four protocol-faithful stubs stand in for the four engines. The harness
 * verifies the preflight contract before any command is written, the
 * authenticated channel per engine, the exact command sequence, the
 * PdfCraft comparison channel, and the saga manifest.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { EngineStub } from "../../../_harness/engine-stub.js";
import {
  FanOutOrchestrator,
  PreflightError,
  ENGINE_SPECS,
  runStep,
  type AnyStep,
  type ChannelHandle,
} from "./04_heterogeneous-multi-engine-fan-out-with-schema-routed-commands.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "..", "output");
const checks: { label: string; ok: boolean; detail: string }[] = [];
const ok = (label: string, cond: boolean, detail = ""): boolean => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label.padEnd(44)}${detail}`);
  checks.push({ label, ok: cond, detail });
  return cond;
};

const steps: AnyStep[] = [
  { stepId: "s1", engine: "photocraft", command: "layer.newAdjustmentLayer.curves",
    params: { points: [[0, 0], [64, 70]] }, compensate: "edit.undo" },
  { stepId: "s2", engine: "vectorcraft", command: "shape.rectangle",
    params: { x: 0, y: 0, width: 200, height: 100 } },
  { stepId: "s3", engine: "designcraft", command: "file.open",
    params: { path: "/work/brochure.idml" } },
  { stepId: "s4", engine: "pdfcraft", command: "doc_open",
    params: { path: "/work/pre-ocr.pdf" }, compensate: "doc_close" },
];

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  process.chdir(OUT);
  const stubs = new Map<string, EngineStub>();

  for (const spec of Object.values(ENGINE_SPECS)) {
    const token = randomBytes(32).toString("hex");
    process.env[spec.tokenEnvVar] = token;
    const stub = new EngineStub({ port: spec.port, token, challenge: false });
    await stub.start();
    stubs.set(spec.engine, stub);
  }

  try {
    const manifest = await new FanOutOrchestrator().run({ catalogId: "sku-4417", steps });
    await new Promise((r) => setTimeout(r, 350)); // flush the last frames

    ok("four engines opened", manifest.engines.length === 4, manifest.engines.map((e) => e.engine).join(","));
    ok("engine order is deterministic", manifest.engines.map((e) => e.engine).join(",") === "photocraft,vectorcraft,designcraft,pdfcraft");
    ok("ports are distinct", new Set(manifest.engines.map((e) => e.port)).size === 4);
    ok("one command per engine", manifest.engines.every((e) => e.commandsIssued === 1),
      JSON.stringify(manifest.engines.map((e) => [e.engine, e.commandsIssued])));
    ok("no failures in the saga", manifest.failures.length === 0, JSON.stringify(manifest.failures));
    ok("no compensation needed", manifest.compensated.length === 0, JSON.stringify(manifest.compensated));
    ok("no assets written", manifest.assetsWritten.length === 0);
    ok("every channel authenticated", [...stubs.values()].every((s) => s.calls.includes("auth")));

    const expected: Record<string, string> = {
      photocraft: "layer.newAdjustmentLayer.curves",
      vectorcraft: "shape.rectangle",
      designcraft: "file.open",
      pdfcraft: "doc_open,doc_open,doc_open,doc_compare",
    };
    for (const [engine, commands] of Object.entries(expected)) {
      const actual = stubs.get(engine)!.commands.join(",");
      ok(`${engine} received the expected commands`, actual === commands, actual);
    }

    // Preflight: a missing required parameter never reaches the wire.
    const before = [...stubs.values()].reduce((n, s) => n + s.commands.length, 0);
    let missingError = "";
    try {
      await new FanOutOrchestrator().run({
        catalogId: "bad-missing",
        steps: [{ stepId: "x", engine: "photocraft", command: "layer.newAdjustmentLayer.curves", params: {} }],
      });
    } catch (e) {
      missingError = (e as Error).name;
      console.log("  preflight threw:", (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, 100));
    const afterMissing = [...stubs.values()].reduce((n, s) => n + s.commands.length, 0);
    ok("missing param rejected as PreflightError", missingError === "PreflightError", missingError);
    ok("no command sent on missing-param failure", afterMissing === before, `${before} -> ${afterMissing}`);

    let unknownError = "";
    try {
      await new FanOutOrchestrator().run({
        catalogId: "bad-unknown",
        steps: [{ stepId: "y", engine: "photocraft", command: "layer.notInCatalog" as never, params: { x: 1 } }],
      });
    } catch (e) {
      unknownError = (e as Error).name;
      console.log("  preflight threw:", (e as Error).message);
    }
    const afterUnknown = [...stubs.values()].reduce((n, s) => n + s.commands.length, 0);
    ok("unknown command rejected as PreflightError", unknownError === "PreflightError", unknownError);
    ok("no command sent on unknown-command failure", afterUnknown === afterMissing, `${afterMissing} -> ${afterUnknown}`);

    // Exhaustive dispatch skeleton resolves for every engine.
    const channel: ChannelHandle = {
      engine: "photocraft", port: 1, token: "",
      execute: async () => ({}), heartbeatNow: () => {}, close: async () => {},
    };
    const dispatched = await Promise.all(steps.map((s) => runStep(s, channel)));
    ok("runStep dispatches all four engines", dispatched.length === 4);

    const failed = checks.filter((c) => !c.ok).length;
    fs.writeFileSync(path.join(OUT, "run-manifest.json"), JSON.stringify({
      checks: checks.length,
      failures: checks.filter((c) => !c.ok).map((c) => c.label),
      manifest,
      wire: Object.fromEntries([...stubs].map(([engine, stub]) => [engine, stub.commands])),
    }, null, 2) + "\n");
    console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
    if (failed) process.exitCode = 1;
  } finally {
    await new Promise((r) => setTimeout(r, 100));
    for (const s of stubs.values()) await s.stop();
  }
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
