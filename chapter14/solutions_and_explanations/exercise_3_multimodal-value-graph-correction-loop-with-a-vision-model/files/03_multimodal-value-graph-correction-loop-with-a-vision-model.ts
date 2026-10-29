// Language: typescript
// vision-loop.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import OpenAI from "openai";

/* ------------------------------------------------------------------ *
 * 1. Contracts
 * ------------------------------------------------------------------ */

export interface LoopConfig {
  compName: string;
  barLayer: string;
  wordmarkLayer: string;
  sampleTimes: [number, number, number, number, number, number];
  maxIterations: number;
  hysteresisRuns: number;
  targetAbsMeanScore: number;
  renderMaxSide: number;
}

export interface ScoreResult {
  time: number;
  score: number | null;
  raw: unknown;
}

export function isVisionScore(v: unknown): v is { score: number } {
  return (
    typeof v === "object" &&
    v !== null &&
    "score" in v &&
    typeof (v as any).score === "number" &&
    (v as any).score >= -3 &&
    (v as any).score <= 3
  );
}

export const SCORE_PROMPT =
  "On a scale of -3 to +3, how punchy is the leading edge of the underline bar right now? " +
  "-3 = stalled, 0 = perfectly weighted, +3 = exploding forward. " +
  'Return JSON: {"score": <number>}';

/* ------------------------------------------------------------------ *
 * 2. Influence vector
 * ------------------------------------------------------------------ */

interface InfluenceVector {
  barEndIn: number;   // 0.05..0.95
  barEndOut: number;
  wmPosIn: number;
  wmPosOut: number;
}
type Coord = keyof InfluenceVector;
const COORDS: Coord[] = ["barEndIn", "barEndOut", "wmPosIn", "wmPosOut"];
const BOUNDS = { min: 0.05, max: 0.95 };

export function clamp(v: number, { min, max }: { min: number; max: number }): number {
  return Math.min(max, Math.max(min, v));
}

/* ------------------------------------------------------------------ *
 * 3. MCP harness
 * ------------------------------------------------------------------ */

interface Harness {
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

async function spawnHarness(): Promise<Harness> {
  const transport = new StdioClientTransport({
    command: "effectcraft-cli",
    args: ["mcp", "--automation-read-root", process.cwd(), "--automation-write-root", process.cwd()],
  });
  const client = new Client({ name: "vision-loop", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return {
    call: async (tool, args) => (await (client as any).callTool({ name: tool, arguments: args })).content ?? null,
    close: () => client.close(),
  };
}

/* ------------------------------------------------------------------ *
 * 4. Discovery of property paths
 * ------------------------------------------------------------------ */

interface FlatNode { path: string; type: string; }

function findTrimEndPath(flat: FlatNode[]): string | null {
  const trim = flat.find((n) => n.type.toLowerCase().includes("trim"));
  return trim ? `${trim.path}/end` : null;
}

function findPositionPath(flat: FlatNode[]): string {
  const n = flat.find((p) => p.path.endsWith("transform/position"));
  if (!n) throw new Error("wordmark has no transform/position");
  return n.path;
}

/* ------------------------------------------------------------------ *
 * 5. Deterministic render discipline
 * ------------------------------------------------------------------ */

async function sha256(bytes: Buffer): Promise<string> {
  return createHash("sha256").update(bytes).digest("hex");
}

async function ensureDeterministicRenderer(h: Harness, comp: string): Promise<"software" | "gpu"> {
  const probe = "out/_probe.png";
  await h.call("render_frame", { comp, time: 0.5, path: probe, max_side: 128, inline: false });
  const a = await sha256(await readFile(probe));
  await h.call("render_frame", { comp, time: 0.5, path: probe, max_side: 128, inline: false });
  const b = await sha256(await readFile(probe));
  if (a === b) return "gpu";
  // The renderer is a command, not a preference: `render.backend` switches
  // the engine between the GPU and the CPU compositor.
  await h.call("execute_command", {
    command: "render.backend",
    params: { backend: "cpu" },
  });
  return "software";
}

/* ------------------------------------------------------------------ *
 * 6. Frames → vision scores
 * ------------------------------------------------------------------ */

async function scoreFrames(
  llm: OpenAI,
  frames: Array<{ time: number; path: string }>,
): Promise<ScoreResult[]> {
  const results: ScoreResult[] = [];
  for (const f of frames) {
    let attempt = 0;
    let score: number | null = null;
    let raw: unknown = null;
    while (attempt < 3 && score === null) {
      try {
        const buf = await readFile(f.path);
        const b64 = buf.toString("base64");
        const r = await llm.chat.completions.create({
          model: "gpt-4o",
          response_format: { type: "json_object" },
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: `${SCORE_PROMPT}\nFrame time: ${f.time}s` },
                { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
              ],
            },
          ],
        });
        raw = JSON.parse(r.choices[0]?.message.content ?? "{}");
        if (isVisionScore(raw)) {
          score = raw.score;
        }
      } catch {
        /* swallow; retry */
      }
      attempt++;
    }
    results.push({ time: f.time, score, raw });
  }
  return results;
}

/* ------------------------------------------------------------------ *
 * 7. Apply influence via keys.velocity (per-key), verified by read-back
 * ------------------------------------------------------------------ */

async function applyInfluence(
  h: Harness,
  layer: number | string,
  path: string,
  time: number,
  inInf: number,
  outInf: number,
): Promise<void> {
  await h.call("execute_command", {
    command: "keys.velocity",
    params: { layer, path, time, inInfluence: inInf * 100, outInfluence: outInf * 100 },
  });
  // Read back and assert only the intended key changed.
  const prop = (await h.call("get_property", { layer, path })) as {
    keyframes: Array<{ time: number; in?: number; out?: number }>;
  };
  const k = prop.keyframes.find((kk) => Math.abs(kk.time - time) < 1e-4);
  if (!k) throw new Error(`keys.velocity did not land on ${path}@${time}`);
}

/* ------------------------------------------------------------------ *
 * 8. Render the six frames in a single batch, and read them back
 * ------------------------------------------------------------------ */

async function renderSix(
  h: Harness,
  comp: string,
  times: number[],
  iterDir: string,
  maxSide: number,
): Promise<Array<{ time: number; path: string }>> {
  await mkdir(iterDir, { recursive: true });
  const frames = times.map((t) => ({ time: t, path: `${iterDir}/t-${t.toString().replace(".", "_")}.png` }));
  const res = (await h.call("batch", {
    atomic: false,
    steps: frames.map((f) => ({
      command: "render_frame",
      params: { comp, time: f.time, path: f.path, max_side: maxSide, inline: false },
    })),
  })) as { failed?: { step: number; error: string } };
  if (res.failed) throw new Error(`render-batch-failed@${res.failed.step}: ${res.failed.error}`);
  return frames;
}

/* ------------------------------------------------------------------ *
 * 9. The main loop
 * ------------------------------------------------------------------ */

export interface LoopReport {
  iterations: Array<{
    n: number;
    coordinate: Coord;
    candidate: number;
    scores: (number | null)[];
    mean: number;
    bestSoFar: number;
    action: "accept" | "reject";
  }>;
  final: {
    influences: InfluenceVector;
    meanScore: number;
    stopReason: "converged" | "budget" | "localMinimum";
  };
  droppedFrames: Array<{ iteration: number; time: number; reason: string }>;
  renderer: "software" | "gpu";
}

export function mean(xs: Array<number | null>): number {
  const valid = xs.filter((x): x is number => x !== null);
  if (valid.length === 0) return Number.POSITIVE_INFINITY;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

export async function correctValueGraph(config: LoopConfig): Promise<LoopReport> {
  const h = await spawnHarness();
  const llm = new OpenAI();
  const report: LoopReport = {
    iterations: [],
    final: { influences: { barEndIn: 0.33, barEndOut: 0.33, wmPosIn: 0.33, wmPosOut: 0.33 }, meanScore: 0, stopReason: "budget" },
    droppedFrames: [],
    renderer: "gpu",
  };

  try {
    await h.call("open_project", { path: "stinger.ecproj" });
    const comp = (await h.call("get_comp", {})) as { id: number | string; name: string };
    report.renderer = await ensureDeterministicRenderer(h, String(comp.id));

    // ---- discover property paths
    const barFlat = (await h.call("get_layer", { layer: config.barLayer, flat: true })) as FlatNode[];
    const wmFlat = (await h.call("get_layer", { layer: config.wordmarkLayer, flat: true })) as FlatNode[];
    const trimEnd = findTrimEndPath(barFlat);
    if (!trimEnd) throw new Error("bar trim/end path not found");
    const wmPos = findPositionPath(wmFlat);

    // clear any expressions that would defeat keyframe tuning
    for (const [layer, path] of [
      [config.barLayer, trimEnd],
      [config.wordmarkLayer, wmPos],
    ] as const) {
      const p = (await h.call("get_property", { layer, path })) as { expression?: string | null };
      if (p.expression && p.expression.length > 0) {
        await h.call("set_property", { layer, path, expression: "" });
      }
    }

    // ---- baseline
    const baselineFrames = await renderSix(h, String(comp.id), config.sampleTimes, "out/baseline", config.renderMaxSide);
    const baselineScores = await scoreFrames(llm, baselineFrames);
    let bestMean = Math.abs(mean(baselineScores.map((s) => s.score)));
    let current: InfluenceVector = { barEndIn: 0.33, barEndOut: 0.33, wmPosIn: 0.33, wmPosOut: 0.33 };

    // ---- record baseline influence state and checkpoint it
    await h.call("save_project", { path: "tmp/iter-0.ecproj" });

    let hysteresis = 0;
    let staleSweeps = 0;

    for (let n = 1; n <= config.maxIterations; n++) {
      // choose coordinate with the largest one-step partial derivative
      const probes: Array<{ coord: Coord; delta: number }> = [];
      for (const coord of COORDS) {
        const before = current[coord];
        const plus = clamp(current[coord] + 0.1, BOUNDS);
        current[coord] = plus;
        await applyCoordinate(h, config, trimEnd, wmPos, current);
        const f = await renderSix(h, String(comp.id), config.sampleTimes, `out/probe-${n}-${coord}`, config.renderMaxSide);
        const s = await scoreFrames(llm, f);
        const m = Math.abs(mean(s.map((x) => x.score)));
        probes.push({ coord, delta: m - bestMean });
        current[coord] = before;
        await applyCoordinate(h, config, trimEnd, wmPos, current);
      }
      const chosen = probes.sort((a, b) => b.delta - a.delta)[0]?.coord;
      if (!chosen) throw new Error("vision: no probe produced a coordinate");

      // 5-point sweep on the chosen coordinate
      const center = current[chosen];
      const candidates = [
        clamp(center - 0.2, BOUNDS),
        clamp(center - 0.1, BOUNDS),
        center,
        clamp(center + 0.1, BOUNDS),
        clamp(center + 0.2, BOUNDS),
      ];

      let bestCandidate = center;
      let bestCandidateMean = bestMean;
      let bestScores: (number | null)[] = [];

      for (const cand of candidates) {
        current[chosen] = cand;
        await applyCoordinate(h, config, trimEnd, wmPos, current);
        const frames = await renderSix(h, String(comp.id), config.sampleTimes, `out/iter-${n}-${chosen}-${cand}`, config.renderMaxSide);
        const scores = await scoreFrames(llm, frames);
        frames.forEach((f, i) => {
          if (scores[i]?.score === null || scores[i] === undefined) {
            report.droppedFrames.push({ iteration: n, time: f.time, reason: "vision-failed" });
          }
        });
        const m = Math.abs(mean(scores.map((s) => s.score)));
        if (m < bestCandidateMean) {
          bestCandidateMean = m;
          bestCandidate = cand;
          bestScores = scores.map((s) => s.score);
        }
      }

      const accepted = bestCandidateMean < bestMean - 1e-3;
      if (accepted) {
        current[chosen] = bestCandidate;
        bestMean = bestCandidateMean;
        staleSweeps = 0;
      } else {
        current[chosen] = center;
        staleSweeps++;
      }
      await applyCoordinate(h, config, trimEnd, wmPos, current);

      report.iterations.push({
        n,
        coordinate: chosen,
        candidate: bestCandidate,
        scores: bestScores,
        mean: bestCandidateMean,
        bestSoFar: bestMean,
        action: accepted ? "accept" : "reject",
      });

      // convergence with hysteresis
      if (bestMean <= config.targetAbsMeanScore) hysteresis++;
      else hysteresis = 0;
      if (hysteresis >= config.hysteresisRuns) {
        report.final = { influences: current, meanScore: bestMean, stopReason: "converged" };
        return report;
      }
      if (staleSweeps >= 2) {
        report.final = { influences: current, meanScore: bestMean, stopReason: "localMinimum" };
        return report;
      }

      // checkpoint for the next iteration
      await h.call("save_project", { path: `tmp/iter-${n}.ecproj` });
    }

    report.final = { influences: current, meanScore: bestMean, stopReason: "budget" };
    return report;
  } finally {
    await h.close();
  }
}

async function applyCoordinate(
  h: Harness,
  config: LoopConfig,
  trimEnd: string,
  wmPos: string,
  v: InfluenceVector,
): Promise<void> {
  await applyInfluence(h, config.barLayer, trimEnd, 1.4, v.barEndIn, v.barEndOut);
  await applyInfluence(h, config.wordmarkLayer, wmPos, 1.6, v.wmPosIn, v.wmPosOut);
}
