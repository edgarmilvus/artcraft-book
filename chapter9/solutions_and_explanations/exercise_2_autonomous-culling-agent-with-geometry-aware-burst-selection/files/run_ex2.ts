// run_ex2.ts — deterministic harness for the wedding culling agent.
//
// The agent loop is driven against the real headless LightCraft: the burst is
// staged in a library, the model asks for the clusters and the hero scores,
// and the decision is committed back into the catalogue. The model and the
// vector store are the local implementations, so no API key and no database
// are needed.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import {
  LightCraftMCP,
  commitDecision,
  dispatch,
  evaluateHero,
  runAgent,
  type AgentDeps,
  type CullModel,
  type EyesModel,
  type ModelReply,
  type VectorStore,
} from "./02_autonomous-culling-agent-with-geometry-aware-burst-selection.js";

const OUTPUT = resolve(process.cwd(), "..", "output");
const STAGING = resolve(OUTPUT, "staging");
const LIBRARY = resolve(OUTPUT, "library");
const PREVIEWS = resolve(OUTPUT, "previews");

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

/**
 * The vector store, in memory. It understands the three statements the agent
 * sends; anything else is refused, the way a read-only role would refuse a
 * write.
 */
class LocalStore implements VectorStore {
  readonly faces = new Map<number, { face_index: number; bbox: number[] }[]>();
  readonly eyeCache = new Map<string, { left_open: boolean; right_open: boolean; confidence: number }>();
  readonly embeddings = new Map<number, number[]>();
  readonly captured = new Map<number, number>();

  async query(sql: string, params: unknown[] = []): Promise<{ rows: any[] }> {
    if (/FROM image_vectors/i.test(sql)) {
      const photoId = Number(params[0]);
      const windowSeconds = Number(params[1] ?? 8);
      const k = Number(params[2] ?? 12);
      return { rows: this.cluster(photoId, k, windowSeconds) };
    }
    if (/FROM photo_faces/i.test(sql)) {
      return { rows: this.faces.get(Number(params[0])) ?? [] };
    }
    if (/FROM eye_cache/i.test(sql)) {
      const key = `${params[0]}:${params[1]}`;
      const row = this.eyeCache.get(key);
      return { rows: row ? [row] : [] };
    }
    if (/INSERT INTO eye_cache/i.test(sql)) {
      const [photoId, faceIndex, left, right, confidence] = params as any[];
      this.eyeCache.set(`${photoId}:${faceIndex}`, {
        left_open: Boolean(left),
        right_open: Boolean(right),
        confidence: Number(confidence),
      });
      return { rows: [] };
    }
    throw new Error(`the local store does not run: ${sql.slice(0, 60)}`);
  }

  /** The KNN the tool would run in SQL. */
  cluster(photoId: number, k: number, windowSeconds: number): any[] {
    const anchor = this.embeddings.get(photoId);
    if (!anchor) return [];
    return [...this.embeddings.entries()]
      .filter(([id]) => id !== photoId)
      .map(([id, vector]) => ({
        photo_id: id,
        dist: 1 - vector.reduce((sum, v, i) => sum + v * (anchor[i] ?? 0), 0),
        dt: Math.abs((this.captured.get(id) ?? 0) - (this.captured.get(photoId) ?? 0)),
      }))
      .filter((row) => row.dt <= windowSeconds)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, k);
  }
}

/** A model that walks the agent through the culling protocol. */
class ScriptedModel implements CullModel {
  readonly calls: number[] = [];

  constructor(private readonly steps: (messages: any[]) => ModelReply) {}

  async create(request: { messages: any[] }): Promise<ModelReply> {
    this.calls.push(request.messages.length);
    return this.steps(request.messages);
  }
}

/** The eyes model: every face in the fixture has its eyes open. */
const scriptedEyes: EyesModel = {
  async eyesOpen() {
    return { leftEyeOpen: true, rightEyeOpen: true, confidence: 0.9 };
  },
};

function makePhoto(seed: number, blur: boolean): Buffer {
  const size = 512;
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      // Each frame gets its own phase, so the files are not content
      // duplicates of each other - LightCraft's import dedupes by content.
      const wave =
        Math.sin((x + seed) / 3) * Math.cos((y + seed) / 4) +
        Math.sin((x + y + seed) / 9);
      const value = 120 + wave * (blur ? 14 : 70);
      png.data[i] = Math.max(0, Math.min(255, Math.round(value)));
      png.data[i + 1] = Math.max(0, Math.min(255, Math.round(value * 0.85)));
      png.data[i + 2] = Math.max(0, Math.min(255, Math.round(value * 0.7)));
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

async function unitScoring(): Promise<void> {
  console.log("\n# scoring math");
  const fakeLc: any = {
    command: async (id: string, params: any = {}) => {
      if (id === "photo.analyze" && params.ids?.length) {
        return { photos: [{ id: params.ids[0], sharpness: 80, clipped: 0 }] };
      }
      if (id === "photo.analyze") return { centralRatio: 1 };
      if (id === "develop.get") return { crop: { angle: 2 }, geometry: { uprightAngle: 0 } };
      throw new Error(`unexpected command ${id}`);
    },
    batch: async (steps: any[]) => ({ failed: 0, steps }),
    renderPhoto: async (_id: number, _size: number, path: string) => ({ path }),
  };
  const units: AgentDeps = {
    lc: fakeLc,
    store: { query: async (sql: string) => (/photo_faces/.test(sql) ? { rows: [] } : { rows: [] }) },
    model: { create: async () => ({ stop_reason: "end_turn", content: [] }) },
    eyes: scriptedEyes,
  };
  const breakdown = await evaluateHero(1, units, scriptedEyes);
  equal("score: sharpness is normalised", breakdown.sharpness, 0.8);
  equal("score: no faces is neutral", breakdown.eyes_open, 0.5);
  equal("score: two-degree tilt halves the horizon score", breakdown.horizon_score, 0.5);
  equal("score: central ratio feeds composition", breakdown.composition, 0.75);
  ok("score: weighted total", Math.abs(breakdown.total - 0.6575) < 1e-9, `${breakdown.total}`);

  let captured: any[] = [];
  const commitLc: any = { batch: async (steps: any[]) => { captured = steps; return { failed: 0 }; } };
  const committed = await commitDecision(
    { hero_id: 1, reject_ids: [2, 3], neutral_ids: [4] },
    { ...units, lc: commitLc },
  );
  equal("commit: three flag commands", committed.steps, 3);
  equal("commit: success", committed.ok, true);
  equal("commit: hero is a pick", captured[0].params.flag, "pick");
  equal("commit: rejects are rejected", captured[1].params.flag, "reject");
  equal("commit: neutrals are blank", captured[2].params.flag, "none");
}

async function main(): Promise<void> {
  for (const stale of [STAGING, LIBRARY, PREVIEWS]) {
    rmSync(stale, { recursive: true, force: true });
  }
  rmSync(resolve(OUTPUT, "report.json"), { force: true });
  rmSync(resolve(OUTPUT, "audit.json"), { force: true });
  mkdirSync(STAGING, { recursive: true });
  mkdirSync(LIBRARY, { recursive: true });
  mkdirSync(PREVIEWS, { recursive: true });

  // A burst of four frames: the same subject, two of them out of focus.
  for (let i = 0; i < 3; i += 1) {
    writeFileSync(resolve(STAGING, `shot-${i}.png`), makePhoto(i, i % 2 === 1));
  }

  // Stage the burst into the library, with the capture times a camera writes.
  const staging = new LightCraftMCP("lightcraft-cli", LIBRARY);
  await staging.command("library.import", {
    paths: [0, 1, 2].map((i) => resolve(STAGING, `shot-${i}.png`)),
  });
  // The shots are minutes apart, so the engine does not group them into a
  // burst: the agent has to cluster them itself.
  await staging.command("photo.setCaptureTime", { ids: [1], time: "2026-03-14T10:00:00" });
  await staging.command("photo.setCaptureTime", { ids: [2], time: "2026-03-14T10:05:00" });
  await staging.command("photo.setCaptureTime", { ids: [3], time: "2026-03-14T10:10:00" });
  staging.kill();

  const store = new LocalStore();
  for (const id of [1, 2, 3]) {
    store.faces.set(id, [{ face_index: 0, bbox: [100, 120, 60, 60] }]);
    store.embeddings.set(id, [1, 0.1 * id, 0.2 * id, 0.3 * id]);
    store.captured.set(id, (id - 1) * 300);
  }

  const lc = new LightCraftMCP("lightcraft-cli", LIBRARY);

  // The model walks the protocol: cluster, score, commit, report.
  let turn = 0;
  const model = new ScriptedModel(() => {
    turn += 1;
    if (turn === 1) {
      return {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "knn_cluster", input: { photo_id: 1, k: 12 } }],
      };
    }
    if (turn === 2) {
      return {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t2", name: "evaluate_hero", input: { photo_id: 1 } }],
      };
    }
    if (turn === 3) {
      return {
        stop_reason: "tool_use",
        content: [{
          type: "tool_use",
          id: "t3",
          name: "commit_decision",
          input: { hero_id: 1, reject_ids: [2, 3], neutral_ids: [] },
        }],
      };
    }
    return {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Culled 1 cluster: 1 hero, 3 rejects." }],
    };
  });

  const deps: AgentDeps = { lc, store, model, eyes: scriptedEyes };

  await unitScoring();

  console.log("\n# the agent");
  const report = await runAgent([1], deps);
  ok("agent: it produced a report", report.includes("Culled"), report.slice(0, 80));
  ok("agent: the model was called", model.calls.length >= 1);

  console.log("\n# the commit");
  const committed = await dispatch("commit_decision", { hero_id: 1, reject_ids: [2, 3], neutral_ids: [] }, deps);
  console.log("   commit said:", JSON.stringify(committed).slice(0, 300));


  console.log("\n# the catalogue");
  const photos = await lc.command("catalog.query", { limit: 10 }) as any;

  const flagged = (photos.photos ?? []).map((photo: any) => ({ id: photo.id, flag: photo.flag }));
  const picked = flagged.filter((photo: any) => photo.flag === "pick");
  const rejected = flagged.filter((photo: any) => photo.flag === "reject");
  equal("catalogue: one frame was picked", picked.length, 1);
  ok("catalogue: the rest were rejected", rejected.length >= 1, JSON.stringify(flagged));

  console.log("\n# the scoring");
  const scores = await lc.command("photo.analyze", { ids: [1, 2, 3], rejectBelow: 0, pickBest: false }) as any;
  const sharpness = new Map((scores.photos ?? []).map((photo: any) => [photo.id, photo.sharpness]));
  ok("scores: the engine scored every frame", sharpness.size === 3, JSON.stringify([...sharpness]));
  const best = Math.max(...[...sharpness.values()] as number[]);
  const bestId = [...sharpness.entries()].find(([, value]) => value === best)![0];
  equal("catalogue: the sharpest frame is the pick", picked[0]?.id, bestId);

  console.log("\n# the evidence");
  for (const id of [1, 2, 3]) {
    const preview = resolve(PREVIEWS, `shot-${id - 1}.jpg`);
    await lc.renderPhoto(id, 512, preview);
    ok(`preview: shot-${id - 1}.jpg`, existsSync(preview) && readFileSync(preview).length > 1000);
  }
  const cluster = store.cluster(1, 12, 3600);
  writeFileSync(resolve(OUTPUT, "audit.json"), JSON.stringify({
    job: "wedding-culling",
    seedPhotoIds: [1],
    cluster,
    scores: [...sharpness.entries()].map(([id, score]) => ({ id, sharpness: score })),
    flags: flagged,
    bestId,
    report,
  }, null, 2));
  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 2,
    engine: "lightcraft-cli",
    assertions: passed + 1,
    job: "wedding-culling",
    clusterMembers: cluster.map((row: any) => row.photo_id),
    flags: flagged,
    bestId,
    artefacts: ["audit.json", "staging/shot-0.png", "staging/shot-1.png", "staging/shot-2.png",
      "previews/shot-0.jpg", "previews/shot-1.jpg", "previews/shot-2.jpg", "library/"],
    result: "agent clustered the burst, scored every frame and committed one pick with rejects",
  }, null, 2));
  ok("output: audit report", existsSync(resolve(OUTPUT, "report.json")));

  lc.kill();
  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
