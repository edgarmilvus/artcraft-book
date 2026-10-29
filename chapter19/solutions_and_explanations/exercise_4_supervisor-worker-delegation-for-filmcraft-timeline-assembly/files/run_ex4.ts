// run_ex4.ts — the deterministic harness for the Cathedral Post supervisor.
//
// The harness starts three real FilmCraft MCP sessions (one per worker
// agent), runs a real call sheet through the supervisor, and proves that the
// delegation, the policy refusal and the audit trail behave as specified.
//
// It needs no API key and no network: every engine call travels over the
// MCP stdio channel of a locally installed FilmCraft binary.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";

import {
  DELEGATION_TASK_JSON_SCHEMA,
  DEFAULT_STUDIO_POLICY,
  DelegationJournal,
  DelegationTaskSchema,
  McpStdioTransport,
  Supervisor,
  assignScenes,
  authorize,
  planWaves,
  resolveReference,
  type CallSheet,
  type DelegationTask,
  type FilmCraftTransport,
  type StudioPolicy,
  type WorkerId,
} from "./04_supervisor-worker-delegation-for-filmcraft-timeline-assembly.js";

const FILES = resolve(process.cwd());
const OUTPUT = resolve(FILES, "..", "output");
const WORK = resolve(OUTPUT, "work");
const SANDBOX = resolve(WORK, "cathedral");
const DAILIES = resolve(SANDBOX, "dailies");
const RUNS = resolve(WORK, "runs");

const FIXED_NOW = Date.parse("2026-01-14T09:00:00.000Z");
const HMAC_KEY = Buffer.from("cathedral-shared-vault-key", "utf8");

let passed = 0;

function ok(label: string, condition: boolean, detail = ""): void {
  if (!condition) {
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    process.exit(1);
  }
  passed += 1;
  console.log(`PASS ${label}`);
}

function equal(label: string, actual: unknown, expected: unknown): void {
  ok(label, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

/* ── a minimal PNG writer, so the harness owns real media on disk ──────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function writePng(path: string, width: number, height: number, rgb: [number, number, number]): void {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      raw[offset] = rgb[0] ?? 0;
      raw[offset + 1] = rgb[1] ?? 0;
      raw[offset + 2] = rgb[2] ?? 0;
      offset += 3;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", ihdr),
      pngChunk("IDAT", deflateSync(raw)),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

/* ── the fixtures ───────────────────────────────────────────────────────── */

function callSheet(): CallSheet {
  return {
    runId: "2026-01-14-cathedral",
    workerCount: 3,
    fps: 24,
    scenes: [
      {
        number: 42,
        slug: "INT. CHAPEL - NIGHT",
        shots: [
          {
            shotId: "042A-1",
            clipPath: resolve(DAILIES, "Ocean_Sunset.mp4"),
            recordIn: "00:00:03:12",
            duration: "00:00:07:00",
          },
          {
            shotId: "042A-2",
            clipPath: resolve(DAILIES, "Aurora_Timelapse.mp4"),
            recordIn: "00:00:03:12",
            duration: "00:00:04:18",
          },
        ],
        audioSync: { mode: "timecode", reference: "A001" },
      },
      {
        number: 43,
        slug: "EXT. CLIFF - DUSK",
        shots: [
          {
            shotId: "043A-1",
            clipPath: resolve(DAILIES, "042A-1.png"),
            recordIn: "00:00:01:00",
            duration: "00:00:05:00",
          },
          {
            shotId: "043A-2",
            clipPath: resolve(DAILIES, "042A-2.png"),
            recordIn: "00:00:01:00",
            duration: "00:00:05:00",
          },
        ],
        audioSync: { mode: "scratch", reference: "A002" },
      },
      {
        number: 44,
        slug: "INT. CLOISTER - DAWN",
        shots: [
          {
            shotId: "044A-1",
            clipPath: resolve(DAILIES, "Misty_Forest.mp4"),
            recordIn: "00:00:00:00",
            duration: "00:00:06:00",
          },
        ],
        audioSync: { mode: "manual", reference: "A003" },
      },
    ],
  };
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `00000000-0000-4000-8000-${String(idCounter).padStart(12, "0")}`;
}

/**
 * A task that is deliberately outside the contract: the supervisor has to
 * reject it, so it is built without the schema's help.
 */
interface LooseOperation {
  id: string;
  params: Record<string, unknown>;
}

interface LooseTask extends Omit<DelegationTask, "operations"> {
  operations: LooseOperation[];
}

function rogueTask(overrides: Partial<LooseTask>): LooseTask {
  return {
    delegationId: nextId(),
    runId: "2026-01-14-cathedral",
    agentId: "worker-a",
    targetSequence: "CATHEDRAL-S099",
    scene: { number: 99, slug: "ROGUE" },
    operations: [{ id: "timeline.place", params: { item: resolve(DAILIES, "042A-1.png") } }],
    undoBoundary: "batch",
    deadlineIso: new Date(FIXED_NOW + 600_000).toISOString(),
    ...overrides,
  };
}

/* ── the run ────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(DAILIES, { recursive: true });
  mkdirSync(RUNS, { recursive: true });

  writePng(resolve(DAILIES, "042A-1.png"), 64, 36, [200, 40, 40]);
  writePng(resolve(DAILIES, "042A-2.png"), 64, 36, [40, 200, 40]);

  const transports: Record<WorkerId, McpStdioTransport> = {
    "worker-a": new McpStdioTransport({ binary: "filmcraft-cli", args: ["--demo"] }),
    "worker-b": new McpStdioTransport({ binary: "filmcraft-cli", args: ["--demo"] }),
    "worker-c": new McpStdioTransport({ binary: "filmcraft-cli", args: ["--demo"] }),
  };

  for (const transport of Object.values(transports)) await transport.start();

  try {
    const sheet = callSheet();
    const policy: StudioPolicy = {
      ...DEFAULT_STUDIO_POLICY,
      sandboxRoot: SANDBOX,
    };
    const supervisor = new Supervisor({
      policy,
      transports: transports as Record<WorkerId, FilmCraftTransport>,
      runsRoot: RUNS,
      hmacKey: HMAC_KEY,
      clock: () => FIXED_NOW,
      idFactory: nextId,
      fps: 24,
    });

    const manifest = await supervisor.run(sheet);

    /* ── the delegation ─────────────────────────────────────────────── */

    equal("the manifest carries one verdict per scene", manifest.scenes.length, 3);
    equal("the run is green", manifest.ok, true);

    const byScene = new Map(manifest.scenes.map((scene) => [scene.sceneNumber, scene]));
    const workerOf = (number: number): string => byScene.get(number)?.workerId ?? "";

    ok(
      "the least-loaded assignment gave the two heavy scenes to different workers",
      workerOf(42) !== workerOf(43),
      `${workerOf(42)} vs ${workerOf(43)}`,
    );
    ok(
      "the three scenes landed on the three workers",
      new Set(manifest.scenes.map((scene) => scene.workerId)).size === 3,
      JSON.stringify(manifest.scenes.map((scene) => scene.workerId)),
    );
    equal(
      "scene 42 was cut by worker-a",
      workerOf(42),
      "worker-a",
    );
    equal(
      "scene 43 was cut by worker-b",
      workerOf(43),
      "worker-b",
    );
    equal(
      "scene 44 was cut by worker-c",
      workerOf(44),
      "worker-c",
    );

    ok(
      "every scene assembled",
      manifest.scenes.every((scene) => scene.status === "assembled"),
      JSON.stringify(manifest.scenes.map((scene) => scene.status)),
    );
    equal("the post-condition list covers every scene", manifest.postConditions.length, 3);
    ok(
      "every scene was cut by a single worker",
      manifest.postConditions.every((post) => post.singleWorker),
    );
    ok(
      "every scene matches the call-sheet order",
      manifest.postConditions.every((post) => post.clipOrderMatchesCallSheet),
      JSON.stringify(manifest.postConditions),
    );

    /* ── the engine really was driven ──────────────────────────────── */

    const sequenceOf = async (worker: WorkerId) => {
      const snapshot = await transports[worker].activeSequence();
      return snapshot;
    };

    const scene42 = await sequenceOf("worker-a");
    equal("worker-a assembled the chapel sequence", scene42.name, "CATHEDRAL-S042");
    equal(
      "scene 42 holds two clips",
      scene42.video.flatMap((track) => track.items).length,
      2,
    );
    ok(
      "scene 42 is in call-sheet order",
      scene42.video
        .flatMap((track) => track.items)
        .sort((a, b) => a.start - b.start)
        .map((clip) => clip.name)
        .join(",") === "Ocean_Sunset.mp4,Aurora_Timelapse.mp4",
      JSON.stringify(scene42.video.flatMap((track) => track.items).map((clip) => clip.name)),
    );
    ok(
      "scene 42 got a video dissolve",
      scene42.video.some((track) =>
        track.transitions.some(
          (transition) =>
            typeof transition === "object" &&
            transition !== null &&
            (transition as { effect?: string }).effect === "cross_dissolve",
        ),
      ),
    );
    ok(
      "scene 42 got an audio cross-fade",
      scene42.audio.some((track) =>
        track.transitions.some(
          (transition) =>
            typeof transition === "object" &&
            transition !== null &&
            (transition as { effect?: string }).effect === "constant_power",
        ),
      ),
    );

    const scene43 = await sequenceOf("worker-b");
    equal("worker-b assembled the cliff sequence", scene43.name, "CATHEDRAL-S043");
    ok(
      "scene 43 holds the imported media",
      scene43.video
        .flatMap((track) => track.items)
        .sort((a, b) => a.start - b.start)
        .map((clip) => clip.name)
        .join(",") === "042A-1.png,042A-2.png",
      JSON.stringify(scene43.video.flatMap((track) => track.items).map((clip) => clip.name)),
    );

    const scene44 = await sequenceOf("worker-c");
    equal("worker-c assembled the cloister sequence", scene44.name, "CATHEDRAL-S044");
    equal("scene 44 holds one clip", scene44.video.flatMap((track) => track.items).length, 1);

    /* ── the media cache ────────────────────────────────────────────── */

    equal(
      "the pooled media was a cache hit",
      byScene.get(42)?.mediaCacheMisses ?? -1,
      0,
    );
    equal(
      "the unpooled media was imported",
      byScene.get(43)?.mediaCacheMisses ?? -1,
      2,
    );

    /* ── the audit trail ────────────────────────────────────────────── */

    const journalPath = resolve(RUNS, sheet.runId, "delegations.jsonl");
    ok("the journal was written", existsSync(journalPath), journalPath);
    const verification = DelegationJournal.verify(journalPath, HMAC_KEY);
    ok("the journal chain verifies", verification.ok, `broken at ${String(verification.brokenAt)}`);
    equal("the journal has more than a dozen entries", verification.entries > 12, true);

    const entries = DelegationJournal.read(journalPath);
    const kinds = new Set(entries.map((entry) => entry.kind));
    ok("the journal records the start of the run", kinds.has("run.started"));
    ok("the journal records the end of the run", kinds.has("run.finished"));
    ok(
      "the journal records every dispatched delegation",
      entries.filter((entry) => entry.kind === "task.dispatched").length === 3,
    );
    const journaledPlaces = entries
      .filter((entry) => entry.kind === "worker.result")
      .flatMap((entry) => (entry["operations"] as Array<{ id: string }> | undefined) ?? [])
      .filter((operation) => operation.id === "timeline.place").length;
    equal("every timeline.place call is journaled", journaledPlaces, 5);

    const manifestPath = resolve(RUNS, sheet.runId, "manifest.json");
    ok("the manifest was written to disk", existsSync(manifestPath));
    const onDisk = JSON.parse(readFileSync(manifestPath, "utf8")) as typeof manifest;
    equal("the manifest on disk is the manifest returned", onDisk.runId, manifest.runId);
    ok(
      "the delegation ids are reproducible",
      manifest.scenes.every((scene) =>
        /^00000000-0000-4000-8000-\d{12}$/.test(scene.delegationId ?? ""),
      ),
      JSON.stringify(manifest.scenes.map((scene) => scene.delegationId)),
    );

    /* ── the policy refuses what the policy refuses ─────────────────── */

    const before = await transports["worker-a"].activeSequence();
    const refused = await supervisor.dispatch(
      rogueTask({
        operations: [
          { id: "timeline.place", params: { item: resolve(DAILIES, "042A-1.png") } },
          { id: "edit.clear", params: {} },
        ],
      }),
    );
    equal("a denied command refuses the delegation", refused.status, "refused");
    ok(
      "the refusal names the offending command",
      refused.mismatches.join(" ").includes("edit.clear"),
      JSON.stringify(refused.mismatches),
    );
    ok(
      "the refusal is in the journal",
      DelegationJournal.read(journalPath).some((entry) => entry.kind === "policy.refused"),
    );
    const after = await transports["worker-a"].activeSequence();
    equal(
      "the refused delegation never reached the engine",
      after.video.flatMap((track) => track.items).length,
      before.video.flatMap((track) => track.items).length,
    );

    /* ── the schema rejects what the schema rejects ─────────────────── */

    const rejected = await supervisor.dispatch(
      rogueTask({ operations: [{ id: "timeline.explode", params: {} }] }),
    );
    equal("an unknown command id is rejected", rejected.status, "rejected");
    ok(
      "the rejection is in the journal",
      DelegationJournal.read(journalPath).some((entry) => entry.kind === "task.rejected"),
    );

    /* ── a failing scene is rolled back ─────────────────────────────── */

    const failing = await supervisor.dispatch(
      rogueTask({
        agentId: "worker-b",
        targetSequence: "CATHEDRAL-S098",
        scene: { number: 98, slug: "BROKEN" },
        operations: [
          { id: "playhead.set", params: { frame: 0 } },
          { id: "timeline.place", params: { item: resolve(DAILIES, "042A-1.png") } },
          { id: "timeline.place", params: { item: resolve(DAILIES, "does-not-exist.mov") } },
        ],
      }),
    );
    equal("a scene the engine cannot finish fails", failing.status, "failed");
    ok("the failed scene was rolled back", failing.undoMarkers.length === 1, JSON.stringify(failing.undoMarkers));
    const rolledBack = await transports["worker-b"].activeSequence();
    equal("the rolled-back sequence is empty", rolledBack.video.flatMap((t) => t.items).length, 0);
    ok(
      "the rollback is in the journal",
      DelegationJournal.read(journalPath).some((entry) => entry.kind === "scene.rolledback"),
    );

    /* ── the sandbox refuses a path outside the studio ───────────────── */

    const outside = await supervisor.dispatch(
      rogueTask({
        agentId: "worker-c",
        targetSequence: "CATHEDRAL-S097",
        scene: { number: 97, slug: "OUTSIDE" },
        operations: [
          { id: "timeline.place", params: { item: resolve("/tmp", "not-in-the-sandbox.mov") } },
        ],
      }),
    );
    equal("media outside the sandbox fails the scene", outside.status, "failed");
    const failureRecords = DelegationJournal.read(journalPath)
      .filter((entry) => entry.kind === "worker.result")
      .flatMap((entry) => (entry["failures"] as Array<{ error?: string }> | undefined) ?? []);
    ok(
      "the journal names the sandbox refusal",
      failureRecords.some((failure) => (failure.error ?? "").includes("outside the studio sandbox")),
      JSON.stringify(failureRecords),
    );

    /* ── the schema and the policy are themselves testable ──────────── */

    const jsonSchema = DELEGATION_TASK_JSON_SCHEMA as {
      $schema?: string;
      required?: string[];
    };
    equal(
      "the delegation schema is a draft 2020-12 JSON Schema",
      jsonSchema.$schema,
      "https://json-schema.org/draft/2020-12/schema",
    );
    ok(
      "the delegation schema names every field of the contract",
      ["delegationId", "runId", "agentId", "targetSequence", "scene", "operations", "undoBoundary", "deadlineIso"].every(
        (field) => (jsonSchema.required ?? []).includes(field),
      ),
      JSON.stringify(jsonSchema.required),
    );
    ok(
      "the schema refuses a task without operations",
      !DelegationTaskSchema.safeParse({
        delegationId: nextId(),
        runId: "r",
        agentId: "worker-a",
        targetSequence: "s",
        scene: { number: 1, slug: "x" },
        undoBoundary: "batch",
        deadlineIso: new Date(FIXED_NOW).toISOString(),
      }).success,
    );

    const role = DEFAULT_STUDIO_POLICY.roles["sequence-assembler"]!;
    equal("the policy allows a command in the role's allow list", authorize(role, "timeline.place").allow, true);
    equal("the policy denies a command in the role's deny list", authorize(role, "edit.clear").allow, false);
    equal(
      "the policy denies a command outside the role's allow list",
      authorize(role, "file.import").allow,
      false,
    );

    /* ── the assignment and the reference resolver ──────────────────── */

    const assignment = assignScenes(sheet.scenes, ["worker-a", "worker-b", "worker-c"]);
    equal("the assignment maps one worker per scene", assignment.size, 3);
    equal("the assignment is least-loaded", assignment.get(43), "worker-b");
    equal("the assignment is deterministic", assignScenes(sheet.scenes, ["worker-c", "worker-b", "worker-a"]).get(42), "worker-a");

    const resolved = resolveReference("$0.result.clips.1", [
      { ok: true, result: { clips: [56, 57] } },
    ]);
    equal("a $N.result reference resolves against an earlier result", resolved, 57);
    equal(
      "a reference to a step that never ran is unresolvable",
      resolveReference("$3.result.clips.1", [{ ok: true, result: { clips: [1] } }]),
      undefined,
    );

    const waves = planWaves(
      [
        { id: "playhead.set", params: { frame: 0 } },
        { id: "timeline.place", params: { item: "x" } },
        { id: "sequence.applyAudioTransition", params: { clip: "$1.result.clips.1" } },
      ],
      "batch",
    );
    equal("a referencing operation opens a new batch", waves.length, 2);
    equal("a clip boundary runs every operation on its own", planWaves(
      [
        { id: "playhead.set", params: { frame: 0 } },
        { id: "timeline.place", params: { item: "x" } },
      ],
      "clip",
    ).length, 2);

    /* ── a tampered trail breaks the chain ──────────────────────────── */

    const tamperedPath = resolve(WORK, "tampered.jsonl");
    const lines = readFileSync(journalPath, "utf8").split("\n").filter((line) => line.length > 0);
    const tampered = lines.map((line, index) => {
      if (index !== 2) return line;
      const entry = JSON.parse(line) as Record<string, unknown>;
      entry["sceneNumber"] = 4242;
      return JSON.stringify(entry);
    });
    writeFileSync(tamperedPath, `${tampered.join("\n")}\n`);
    const tamperedVerification = DelegationJournal.verify(tamperedPath, HMAC_KEY);
    ok(
      "a tampered record breaks the chain",
      !tamperedVerification.ok,
      JSON.stringify(tamperedVerification),
    );
    equal("the tamper is detected at the tampered line", tamperedVerification.brokenAt, 2);

    for (const [from, to] of [
      [resolve(RUNS, sheet.runId, "manifest.json"), "cathedral-manifest.json"],
      [resolve(RUNS, sheet.runId, "delegations.jsonl"), "cathedral-delegations.jsonl"],
    ] as const) copyFileSync(from, resolve(OUTPUT, to));

    console.log(`\n${passed} assertions passed`);
  } finally {
    for (const transport of Object.values(transports)) await transport.close();
  }
}

await main();
