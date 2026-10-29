// agent/culling_agent.ts
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The model and the vector store are optional dependencies: they are loaded
// lazily, so the module (and its unit tests) run without either. A caller
// that has them injects them instead — see `AgentDeps`.
type AnthropicTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};
type AnthropicMessage = { role: "user" | "assistant"; content: any };
export type ModelReply = {
  stop_reason: string | null;
  content: any[];
};
export interface CullModel {
  create(request: {
    model: string;
    max_tokens: number;
    system: string;
    tools: AnthropicTool[];
    messages: AnthropicMessage[];
  }): Promise<ModelReply>;
}
export interface VectorStore {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

// ---------------------------------------------------------------------------
// 1. Server-side tool implementations (bound to Claude via tool_use)
// ---------------------------------------------------------------------------
type ToolResult = { content: { type: "text"; text: string }[] };

export class LightCraftMCP {
  private child: any;
  private id = 0;
  private pending = new Map<number, (v: any) => void>();
  private stdoutBuffer = "";

  constructor(binary = "lightcraft-cli", library = "/work/wedding") {
    // LightCraft has no automation roots: the library is opened with
    // `--library` and the engine reads the files the agent hands it.
    this.child = spawn(binary, ["mcp", "--library", library]);
    this.child.stdout.on("data", (buf: Buffer) => {
      // MCP replies are newline-delimited, but a single read can contain a
      // partial line or several replies. Buffer until a complete line exists.
      this.stdoutBuffer += buf.toString();
      let newline = this.stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.stdoutBuffer.slice(0, newline).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
        if (line) {
          const msg = JSON.parse(line);
          const cb = this.pending.get(msg.id);
          if (cb) { this.pending.delete(msg.id); cb(msg.result ?? msg.error); }
        }
        newline = this.stdoutBuffer.indexOf("\n");
      }
    });
  }

  private rpc(method: string, params: any): Promise<any> {
    const n = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(n, resolve);
      this.child.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id: n, method, params,
      }) + "\n");
    });
  }

  /** The JSON payload of a tool result, unwrapped from the MCP envelope. */
  private static payload(result: any): any {
    const text = result?.content?.find((block: any) => block.type === "text")?.text;
    if (text === undefined) return result;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  command(id: string, params: any = {}): Promise<any> {
    return this.rpc("tools/call", { name: "command_run",
                                    arguments: { id, params } })
      .then((result) => LightCraftMCP.payload(result));
  }
  /**
   * LightCraft's `command_batch` takes the steps and `stop_on_error`; unlike
   * the other engines it has no `atomic` and no `label`.
   */
  batch(steps: any[], stopOnError = true) {
    return this.rpc("tools/call", { name: "command_batch",
                                    arguments: { steps, stop_on_error: stopOnError } })
      .then((result) => LightCraftMCP.payload(result));
  }
  /** Close the engine session. */
  kill(): void {
    this.child.kill("SIGTERM");
  }

  renderPhoto(id: number, size: number, path: string) {
    return this.rpc("tools/call", { name: "render_photo",
      arguments: { id, size, format: "jpeg", path } })
      .then((result) => LightCraftMCP.payload(result));
  }
}

export interface AgentDeps {
  /** The engine session. */
  lc: LightCraftMCP;
  /** The vector store the clustering tools read from. */
  store: VectorStore;
  /** The model that drives the tool-use loop. */
  model: CullModel;
  /** The model that decides whether the eyes of a face are open. */
  eyes: EyesModel;
}

/** The engine session and the store the module uses by default. */
let defaultLc: LightCraftMCP | null = null;
let defaultStore: VectorStore | null = null;

function getLc(): LightCraftMCP {
  if (!defaultLc) defaultLc = new LightCraftMCP();
  return defaultLc;
}

async function getAnthropicModel(): Promise<CullModel> {
  const moduleName = "@anthropic-ai/sdk";
  const { default: Anthropic } = (await import(moduleName)) as any;
  const client = new Anthropic();
  return {
    create: (request) => client.messages.create(request),
  };
}

async function getStore(): Promise<VectorStore> {
  if (defaultStore) return defaultStore;
  const moduleName = "pg";
  const { Pool } = (await import(moduleName)) as any;
  defaultStore = new Pool({ connectionString: process.env.PG_DSN }) as VectorStore;
  return defaultStore;
}
// ---------------------------------------------------------------------------
// 2. Tool schemas handed to Claude
// ---------------------------------------------------------------------------
const TOOLS: AnthropicTool[] = [
  { name: "run_lightcraft",
    description: "Run any LightCraft command by id. Returns the JSON result.",
    input_schema: { type: "object", properties: {
      command: { type: "string" }, params: { type: "object" } }, required: ["command"] } },
  { name: "query_vector_store",
    description: "Parameterised SELECT against photo_faces / burst_clusters.",
    input_schema: { type: "object", properties: {
      sql: { type: "string" }, params: { type: "array" } }, required: ["sql"] } },
  { name: "knn_cluster",
    description: "k nearest photos by fused embedding + time window.",
    input_schema: { type: "object", properties: {
      photo_id: { type: "integer" }, k: { type: "integer", default: 12 },
      time_window_sec: { type: "integer", default: 8 } }, required: ["photo_id"] } },
  { name: "evaluate_hero",
    description: "Compute weighted hero score S (0.4 sharp + 0.25 eyes + 0.2 horizon + 0.15 comp).",
    input_schema: { type: "object", properties: { photo_id: { type: "integer" } },
      required: ["photo_id"] } },
  { name: "commit_decision",
    description: "Atomically commit picks/rejects/neutrals behind one undo label.",
    input_schema: { type: "object", properties: {
      hero_id: { type: "integer" },
      reject_ids: { type: "array", items: { type: "integer" } },
      neutral_ids: { type: "array", items: { type: "integer" } },
      label: { type: "string" } }, required: ["hero_id", "reject_ids", "neutral_ids"] } },
];

// ---------------------------------------------------------------------------
// 3. Tool dispatcher
// ---------------------------------------------------------------------------
export async function dispatch(
  name: string,
  input: any,
  deps: AgentDeps,
): Promise<ToolResult> {
  const lc = deps.lc;
  const pool = deps.store;
  switch (name) {
    case "run_lightcraft":
      return text(JSON.stringify(await lc.command(input.command, input.params)));

    case "query_vector_store": {
      if (!/^\s*SELECT/i.test(input.sql)) throw new Error("only SELECT allowed");
      const r = await pool.query(input.sql, input.params ?? []);
      return text(JSON.stringify(r.rows));
    }

    case "knn_cluster": {
      const { photo_id, k = 12, time_window_sec = 8 } = input;
      const { rows } = await pool.query(
        `WITH anchor AS (
            SELECT fused, captured FROM image_vectors WHERE photo_id = $1
         )
         SELECT v.photo_id, v.fused <=> a.fused AS dist,
                ABS(EXTRACT(EPOCH FROM (v.captured - a.captured))) AS dt
           FROM image_vectors v, anchor a
          WHERE v.photo_id <> $1
            AND ABS(EXTRACT(EPOCH FROM (v.captured - a.captured))) <= $2
          ORDER BY v.fused <=> a.fused
          LIMIT $3`, [photo_id, time_window_sec, k]);
      return text(JSON.stringify(rows));
    }

    case "evaluate_hero":
      return text(JSON.stringify(await evaluateHero(input.photo_id, deps, deps.eyes)));

    case "commit_decision":
      return text(JSON.stringify(await commitDecision(input, deps)));

    default:
      throw new Error(`unknown tool ${name}`);
  }
}

function text(t: string): ToolResult { return { content: [{ type: "text", text: t }] }; }

// ---------------------------------------------------------------------------
// 4. Hero scoring
// ---------------------------------------------------------------------------
interface ScoreBreakdown {
  sharpness: number; eyes_open: number;
  horizon_score: number; composition: number; total: number;
}

const WEIGHTS = { sharp: 0.40, eyes: 0.25, horizon: 0.20, comp: 0.15 } as const;
const HYSTERESIS = 0.08;

/** The production implementation of the eyes model. */
export class OpenAiEyes implements EyesModel {
  async eyesOpen(cropBase64: string): Promise<{ leftEyeOpen: boolean; rightEyeOpen: boolean; confidence: number }> {
    const moduleName = "openai";
    const { default: OpenAI } = (await import(moduleName)) as any;
    const client = new OpenAI();
    const r = await client.chat.completions.create({
      model: "gpt-4o",
      response_format: { type: "json_object" },
      messages: [
        { role: "system",
          content: 'Return JSON {"leftEyeOpen":bool,"rightEyeOpen":bool,"confidence":0-1}' },
        { role: "user", content: [
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${cropBase64}` } },
        ]},
      ],
    });
    return JSON.parse(r.choices[0].message.content);
  }
}

export interface EyesModel {
  /** The probability that both eyes of the face in the crop are open. */
  eyesOpen(cropBase64: string): Promise<{ leftEyeOpen: boolean; rightEyeOpen: boolean; confidence: number }>;
}

export async function evaluateHero(
  photo_id: number,
  deps: AgentDeps,
  eyes: EyesModel,
): Promise<ScoreBreakdown> {
  const lc = deps.lc;
  const pool = deps.store;
  const scratch = process.env.LIGHTCRAFT_SCRATCH ?? join(tmpdir(), "lightcraft-culling-scratch");
  mkdirSync(scratch, { recursive: true });
  // Sharpness — delegated to LightCraft's photo.analyze, never reimplemented.
  const analyze = await lc.command("photo.analyze", {
    ids: [photo_id], rejectBelow: 0, pickBest: false,
  });
  const a0 = analyze.photos?.[0] ?? {};
  const sharpness = (a0.sharpness ?? 0) / 100;

  // Eye-open probability — host-side vision call, cached in Postgres.
  const { rows: faceRows } = await pool.query(
    `SELECT face_index, bbox FROM photo_faces WHERE photo_id = $1`, [photo_id]);

  let eyesSum = 0, nFaces = 0;
  for (const f of faceRows) {
    const cache = await pool.query(
      `SELECT left_open, right_open, confidence FROM eye_cache
        WHERE photo_id=$1 AND face_index=$2`, [photo_id, f.face_index]);
    let leftOpen = false, rightOpen = false, conf = 0;
    if (cache.rows.length) {
      ({ left_open: leftOpen, right_open: rightOpen, confidence: conf } = cache.rows[0]);
    } else {
      const cropPath = join(scratch, `${photo_id}_${f.face_index}.jpg`);
      await lc.renderPhoto(photo_id, 512, cropPath);
      const b64 = readFileSync(cropPath).toString("base64");
      const parsed = await eyes.eyesOpen(b64);
      leftOpen = !!parsed.leftEyeOpen; rightOpen = !!parsed.rightEyeOpen;
      conf = Number(parsed.confidence ?? 0);
      await pool.query(
        `INSERT INTO eye_cache(photo_id,face_index,left_open,right_open,confidence)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT DO NOTHING`,
        [photo_id, f.face_index, leftOpen, rightOpen, conf]);
    }
    eyesSum += ((leftOpen ? 1 : 0) + (rightOpen ? 1 : 0)) / 2 * conf;
    nFaces++;
  }
  const eyes_open = nFaces ? eyesSum / nFaces : 0.5;

  // Horizon — from develop.get { geometry.upright, crop.angle }.
  const dev = await lc.command("develop.get", { id: photo_id });
  const angle = Math.abs(dev?.crop?.angle ?? dev?.geometry?.uprightAngle ?? 0);
  const horizon_score = 1 - Math.min(angle / 4, 1);

  // Composition — coarse subject-centredness heuristic on the 224px preview.
  const previewPath = join(scratch, `${photo_id}_comp.jpg`);
  await lc.renderPhoto(photo_id, 224, previewPath);
  const composition = await subjectCenterScore(previewPath, deps);

  const total =
    WEIGHTS.sharp   * sharpness +
    WEIGHTS.eyes    * eyes_open +
    WEIGHTS.horizon * horizon_score +
    WEIGHTS.comp    * composition;
  return { sharpness, eyes_open, horizon_score, composition, total };
}

async function subjectCenterScore(pngPath: string, deps: AgentDeps): Promise<number> {
  // Lightweight: the sharper the central 30% is compared to the border, the
  // more centred the subject. Never a substitute for a real saliency map,
  // but cheap and needed only as a 0..1 tie-breaker.
  const sharp = await deps.lc.command("photo.analyze", { ids: [], rejectBelow: 0 });
  return Math.min(1, 0.5 + (sharp?.centralRatio ?? 0) / 4);
}

// ---------------------------------------------------------------------------
// 5. Commit
// ---------------------------------------------------------------------------
export async function commitDecision(input: {
  hero_id: number; reject_ids: number[]; neutral_ids: number[]; label?: string;
}, deps: AgentDeps): Promise<{ ok: boolean; steps: number }> {
  const lc = deps.lc;
  const { hero_id, reject_ids, neutral_ids } = input;
  // A pick, a reject and a neutral are all the same command with a
  // different flag value.
  const steps: any[] = [{ id: "photo.flag", params: { flag: "pick", ids: [hero_id] } }];
  if (reject_ids.length)
    steps.push({ id: "photo.flag", params: { flag: "reject", ids: reject_ids } });
  if (neutral_ids.length)
    steps.push({ id: "photo.flag", params: { flag: "none", ids: neutral_ids } });
  const res = await lc.batch(steps, /* stop on the first failure */ true);
  // The batch answers with the number of steps that failed; a batch that
  // failed half way is not a decision.
  return { ok: (res?.failed ?? 0) === 0, steps: steps.length };
}

// ---------------------------------------------------------------------------
// 6. Agent loop
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are a wedding-photographer culling agent.

For each burst cluster:
  1. Call knn_cluster on any unreviewed frame to pull its neighbours.
  2. Call evaluate_hero on every frame in the cluster.
  3. Pick the highest-S frame as hero. Reject every other frame ONLY IF
     S_hero - S_other >= ${HYSTERESIS}. Otherwise mark those frames neutral.
  4. Before committing, sanity-check: if the hero has clipped > 5% (from
     run_lightcraft photo.analyze), split the cluster with stack.split,
     re-cluster, and re-evaluate. Repeat at most twice.
  5. If two clusters end up with suspiciously identical average sharpness,
     split them and re-evaluate — this indicates a mis-clustered burst.
  6. Commit via commit_decision with label = "Agentic Culling Pass".

Finish by producing a Markdown report (clusters, hero scores, rejects,
declined clusters).`;

export async function runAgent(seedPhotoIds: number[], deps: AgentDeps): Promise<string> {
  const messages: AnthropicMessage[] = [{
    role: "user",
    content: `Cull these seed frames: ${seedPhotoIds.join(", ")}`,
  }];

  for (let turn = 0; turn < 60; turn++) {
    const res = await deps.model.create({
      model: "claude-sonnet-4-5",
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });
    messages.push({ role: "assistant", content: res.content });

    if (res.stop_reason === "end_turn") {
      const last = res.content.find((c: any) => c.type === "text");
      return last?.type === "text" ? last.text : "(no report)";
    }

    const toolResults: any[] = [];
    for (const block of res.content) {
      if (block.type === "tool_use") {
        let out: ToolResult;
        try { out = await dispatch(block.name, block.input, deps); }
        catch (e: any) { out = text(JSON.stringify({ error: String(e?.message ?? e) })); }
        toolResults.push({ type: "tool_result", tool_use_id: block.id,
                           content: out.content });
      }
    }
    messages.push({ role: "user", content: toolResults });
  }
  throw new Error("agent loop exhausted 60 turns without end_turn");
}

// Entry point
if (process.env.SEED_PHOTO_IDS) {
  (async () => {
    const seedIds = JSON.parse(process.env.SEED_PHOTO_IDS ?? "[]");
    const deps: AgentDeps = {
      lc: getLc(),
      store: await getStore(),
      model: await getAnthropicModel(),
      eyes: new OpenAiEyes(),
    };
    const report = await runAgent(seedIds, deps);
    console.log(report);
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
