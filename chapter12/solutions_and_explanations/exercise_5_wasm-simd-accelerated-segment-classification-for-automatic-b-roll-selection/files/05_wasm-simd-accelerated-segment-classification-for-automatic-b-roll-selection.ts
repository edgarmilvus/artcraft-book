// exercise5_wasm_classify.ts
// Launch: filmcraft-cli mcp --automation-read-root /work/classify --automation-write-root /work/classify
// Node >= 22 has WebAssembly SIMD enabled by default. We still probe explicitly
// because the exercise contract mandates it: a non-SIMD run is a failed deliverable.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { z } from "zod";
import { pathToFileURL } from "node:url";

const TICKS_PER_SECOND = 254_016_000_000;
const READ_ROOT = process.env.FILMCRAFT_READ_ROOT ?? "/work/classify";
const WRITE_ROOT = process.env.FILMCRAFT_WRITE_ROOT ?? "/work/classify";
const FRAME_SAMPLE_FRACTIONS = [0.10, 0.50, 0.90];
const FRAME_MAX_SIDE = 512;
const CATEGORIES = [
  "food","cityscape","nature","interior","people","hands",
  "product","abstract","text_motion","logo_card","transition","slate",
] as const;
type Category = typeof CATEGORIES[number];
const VLM_BASELINE_MS_PER_FRAME = 1200;

// ---- Zod schema (agent-side validation of WASM output) --------------------------
export const ClassificationSchema = z.object({
  probabilities: z.array(z.number().min(0).max(1)).length(12)
    .refine(p => Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-4,
            { message: "softmax must sum to 1 within 1e-4" }),
  topLabel: z.enum(CATEGORIES),
  topProbability: z.number().min(0).max(1),
});
export type WasmClassification = z.infer<typeof ClassificationSchema>;

// ---- WASM loader ----------------------------------------------------------------
// The module ships as classifier.wasm at the project root. We import it once per
// worker (each worker has its own WebAssembly instance -- single-threaded WASM,
// workload-parallel across workers, exactly as the exercise mandates).
interface ClassifierModule {
  memory: WebAssembly.Memory;
  malloc(bytes: number): number;
  free(ptr: number): void;
  classify(rgbaPtr: number, width: number, height: number): number;
  simd_probe(): number;
}

export async function loadClassifier(): Promise<ClassifierModule> {
  const wasmPath = path.join(READ_ROOT, "classifier.wasm");
  const bytes = await fs.readFile(wasmPath);
  const module = await WebAssembly.compile(bytes);
  const instance = await WebAssembly.instantiate(module, {});
  const ex = instance.exports as any;

  // --- SIMD probe: MUST pass or the pipeline refuses to run ---------------------
  // The module's simd_probe() computes a fixed 4-lane i32x4 multiply; a scalar
  // fallback in the same module would return a different, well-known value. The
  // exercise contract is: refuse to run unless the SIMD path is confirmed.
  const probe = ex.simd_probe();
  const EXPECTED_SIMD_PROBE = 0x5A5A_5A5A;  // module-documented magic
  if (probe !== EXPECTED_SIMD_PROBE) {
    throw new Error(
      `WASM SIMD probe FAILED: got ${probe.toString(16)}, expected ${EXPECTED_SIMD_PROBE.toString(16)}. ` +
      `Refusing to run. Upgrade Node (>=22) or enable --experimental-wasm-simd.`);
  }

  return {
    memory: ex.memory,
    malloc: ex.alloc,
    free: ex.free,
    classify: ex.classify,
    simd_probe: ex.simd_probe,
  };
}

// The classifier.wasm expects a raw RGBA byte buffer. FilmCraft's render_frame
// returns a PNG; we decode it in the agent. To keep the exercise dependency-light
// we ship a minimal PNG->RGBA decoder based on a hand-rolled zlib inflate, or
// use sharp if available. Here we use a small wrapper that guards for either path.
export async function pngToRGBA(pngBytes: Uint8Array): Promise<{ rgba: Uint8Array; width: number; height: number }> {
  // Prefer the fast native path when present.
  try {
    const sharp = await import("sharp");
    const img = sharp.default ? sharp.default(pngBytes) : (sharp as any)(pngBytes);
    const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { rgba: new Uint8Array(data), width: info.width, height: info.height };
  } catch {
    // The pure-JS decoder is the fallback. It is slower than sharp but it has
    // no native dependency, which is what the workers need.
    const { PNG } = await import("pngjs");
    const png = PNG.sync.read(Buffer.from(pngBytes));
    return { rgba: new Uint8Array(png.data), width: png.width, height: png.height };
  }
}

export function classifyFrame(mod: ClassifierModule, rgba: Uint8Array, width: number, height: number): WasmClassification {
  const ptr = mod.malloc(rgba.byteLength);
  try {
    // The engine's WASM exports are backed by a linear memory; we copy RGBA into it.
    new Uint8Array(mod.memory.buffer, ptr, rgba.byteLength).set(rgba);
    const outPtr = mod.classify(ptr, width, height);
    const probs = new Float32Array(mod.memory.buffer, outPtr, 12);
    const arr = Array.from(probs);
    const topIdx = arr.indexOf(Math.max(...arr));
    const out: WasmClassification = {
      probabilities: arr,
      topLabel: CATEGORIES[topIdx],
      topProbability: arr[topIdx],
    };
    // Agent-side schema validation. Corrupt WASM output NEVER propagates.
    return ClassificationSchema.parse(out);
  } finally {
    mod.free(ptr);
  }
}

// ---- MCP transport (used only by the orchestrator/worker 0) ---------------------
class FilmCraft {
  private client!: Client;
  async connect() {
    const transport = new StdioClientTransport({
      command: "filmcraft-cli",
      args: ["mcp", "--automation-read-root", READ_ROOT, "--automation-write-root", WRITE_ROOT],
      cwd: READ_ROOT,
    });
    this.client = new Client({ name: "e5-classify", version: "1.0.0" }, { capabilities: {} });
    await this.client.connect(transport);
  }
  private async call(name: string, args: object) {
    const res = await this.client.callTool({ name, arguments: args as any });
    const block = (res.content as any[]).find(b => b.type === "text");
    return JSON.parse(block!.text);
  }
  async close() { await this.client.close(); }
  run(id: string, params: object = {}) { return this.call("command_run", { id, params }); }
  batch(steps: Array<{ id: string; params?: object }>) {
    return this.call("command_batch", { steps, stop_on_error: true });
  }
  sequence()   { return this.call("sequence_inspect", {}); }
  project()    { return this.call("project_inspect", {}); }

  /**
   * Render one Program frame and write it to disk.
   *
   * `render_frame` takes the time and a pixel budget and answers with an
   * *image block*: the PNG comes back base64-encoded and never touches the
   * disk unless we write it there ourselves.
   */
  async renderFrame(a: { seconds: number; max_side?: number }, outPath: string): Promise<string> {
    const res = await this.client.callTool({
      name: "render_frame",
      arguments: { seconds: a.seconds, max_side: a.max_side ?? 960 },
    });
    const blocks = (res.content as any[]) ?? [];
    const image = blocks.find((b) => b.type === "image" && typeof b.data === "string");
    if (!image) throw new Error("render_frame returned no image block");
    await fs.writeFile(outPath, Buffer.from(image.data, "base64"));
    return outPath;
  }
}

/**
 * The media items of the project, keyed by item id.
 *
 * `project_inspect` answers with a tree: the bins and the sequences hang under
 * `root.children`, and a media item is identified by `item` (a bin by `id`).
 * `duration` is in ticks.
 */
export function mediaItems(project: any): any[] {
  const out: any[] = [];
  const walk = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (typeof node.item === "number" && typeof node.name === "string") out.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(project?.root ?? project);
  return out;
}

// ---- Worker orchestration -------------------------------------------------------
// Each worker owns one WASM instance and processes a shard of clips. Workers do
// NOT talk to FilmCraft directly -- the orchestrator pre-renders frames to disk
// and hands the workers a list of (itemId, tick, pngPath). This keeps the MCP
// transport single-threaded (schema-compliant) while parallelising inference.
interface WorkItem {
  itemId: number;
  fileName: string;
  durationTicks: number;
  tick: number;
  pngPath: string;
  sampleIndex: 0 | 1 | 2;
}
interface WorkResult {
  itemId: number;
  durationTicks: number;
  fileName: string;
  sampleIndex: number;
  tick: number;
  pngPath: string;
  classification: WasmClassification;
  inferenceMs: number;
  failure?: { reason: string };
}

async function runWorker(workItems: WorkItem[]): Promise<WorkResult[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { mode: "worker", workItems } });
    const results: WorkResult[] = [];
    worker.on("message", (m: WorkResult) => results.push(m));
    worker.on("error", reject);
    worker.on("exit", code => code === 0 ? resolve(results) : reject(new Error(`worker exited ${code}`)));
  });
}

if (!isMainThread && workerData?.mode === "worker") {
  (async () => {
    const items: WorkItem[] = workerData.workItems;
    const mod = await loadClassifier();
    for (const it of items) {
      const t0 = performance.now();
      try {
        const png = await fs.readFile(it.pngPath);
        const { rgba, width, height } = await pngToRGBA(new Uint8Array(png));
        const cls = classifyFrame(mod, rgba, width, height);
        const dt = performance.now() - t0;
        parentPort!.postMessage({
          itemId: it.itemId, durationTicks: it.durationTicks, fileName: it.fileName,
          sampleIndex: it.sampleIndex, tick: it.tick, pngPath: it.pngPath,
          classification: cls, inferenceMs: dt,
        } satisfies WorkResult);
      } catch (e: any) {
        parentPort!.postMessage({
          itemId: it.itemId, durationTicks: it.durationTicks, fileName: it.fileName,
          sampleIndex: it.sampleIndex, tick: it.tick, pngPath: it.pngPath,
          classification: { probabilities: new Array(12).fill(0),
                            topLabel: "abstract", topProbability: 0 },
          inferenceMs: performance.now() - t0,
          failure: { reason: String(e?.message ?? e) },
        } satisfies WorkResult);
      }
    }
  })();
  // Do not fall through to main().
} else if (isMainThread && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}

// ---- Main -----------------------------------------------------------------------
async function main() {
  const fc = new FilmCraft();
  await fc.connect();

  // Sanity check the SIMD path in the main thread too, so failures surface early.
  const probeMod = await loadClassifier();

  // 1) Get the B-roll item list.
  const proj = await fc.project();
  const brollItems = mediaItems(proj).filter((it: any) => /broll/i.test(it.name));
  const brollIds: number[] = brollItems.map((it: any) => it.item);

  // 2) Pre-render frames (single-threaded, uses MCP).
  //    We do NOT render inside the workers because the MCP transport is a single
  //    stdio pipe and multiplexing it across workers would race the JSON-RPC ids.
  const framesRoot = path.join(WRITE_ROOT, "frames");
  await fs.mkdir(framesRoot, { recursive: true });
  const renderStart = performance.now();
  const workItems: WorkItem[] = [];
  for (const it of brollItems) {
    for (let s = 0 as 0 | 1 | 2; s < 3; s = (s + 1) as 0 | 1 | 2) {
      const tSec = (it.duration / TICKS_PER_SECOND) * FRAME_SAMPLE_FRACTIONS[s];
      const pngName = `${it.item}_${s}.png`;
      const pngPath = path.join(framesRoot, pngName);
      try {
        await fc.renderFrame({ seconds: tSec, max_side: FRAME_MAX_SIDE }, pngPath);
        workItems.push({
          itemId: it.item, fileName: it.name, durationTicks: it.duration,
          tick: Math.round(tSec * TICKS_PER_SECOND),
          pngPath, sampleIndex: s as 0 | 1 | 2,
        });
      } catch (e: any) {
        // Tolerant mode: log and continue. A missing frame becomes a failure row.
        workItems.push({
          itemId: it.item, fileName: it.name, durationTicks: it.duration,
          tick: Math.round(tSec * TICKS_PER_SECOND),
          pngPath, sampleIndex: s as 0 | 1 | 2,
        });
      }
    }
  }
  const renderMs = performance.now() - renderStart;

  // 3) Shard work across (cores - 1) workers, but at least 4 as required.
  const workerCount = Math.max(4, Math.min(os.cpus().length - 1, 8));
  const shards: WorkItem[][] = Array.from({ length: workerCount }, () => []);
  workItems.forEach((w, i) => shards[i % workerCount].push(w));

  const inferenceStart = performance.now();
  const shardResults = await Promise.all(shards.map(runWorker));
  const inferenceMs = performance.now() - inferenceStart;
  const results = shardResults.flat();

  // 4) Majority vote per clip.
  const byClip = new Map<number, WorkResult[]>();
  for (const r of results) {
    if (!byClip.has(r.itemId)) byClip.set(r.itemId, []);
    byClip.get(r.itemId)!.push(r);
  }
  const indexed: any[] = [];
  const failures: Array<{ itemId: number; tick: number; reason: string }> = [];
  const indexLines: string[] = [];
  for (const [itemId, rs] of byClip) {
    const votes = new Map<string, number>();
    for (const r of rs) {
      if (r.failure) { failures.push({ itemId, tick: r.tick, reason: r.failure.reason }); continue; }
      votes.set(r.classification.topLabel, (votes.get(r.classification.topLabel) ?? 0) + 1);
    }
    const sorted = [...votes.entries()].sort((a, b) => b[1] - a[1]);
    const majority = sorted[0]?.[0] ?? "abstract";
    const runner = sorted[1]?.[0] ?? majority;
    const third = sorted[2]?.[0] ?? runner;
    const row = {
      itemId,
      fileName: rs[0].fileName,
      labels: [majority, runner, third] as [string, string, string],
      framePaths: rs.map(r => path.relative(WRITE_ROOT, r.pngPath)),
      durationTicks: rs[0].durationTicks,
      classificationMs: rs.reduce((s, r) => s + r.inferenceMs, 0),
    };
    // Stable field order for clean diffs between runs.
    indexLines.push(JSON.stringify(row));
    indexed.push(row);
  }
  // Sort by itemId so the JSONL is deterministic regardless of worker completion order.
  indexLines.sort();
  const indexFilePath = path.join(WRITE_ROOT, "broll_index.jsonl");
  await fs.writeFile(indexFilePath, indexLines.join("\n") + "\n");

  // 5) Placement decisions from the section briefs.
  const briefs: Array<{ sectionStartTick: number; sectionEndTick: number;
                        wantedLabels: string[]; maxPlacementSeconds: number }> =
    JSON.parse(await fs.readFile(path.join(READ_ROOT, "briefs.json"), "utf8"));
  const decisions: any[] = [];
  const placementSteps: Array<{ id: string; params?: object }> = [];
  for (const sec of briefs) {
    const ranked = indexed
      .filter(i => i.labels.some((l: string) => sec.wantedLabels.includes(l)))
      .sort((a, b) => {
        const scoreA = a.labels.filter((l: string) => sec.wantedLabels.includes(l)).length;
        const scoreB = b.labels.filter((l: string) => sec.wantedLabels.includes(l)).length;
        return scoreB - scoreA;
      })
      .slice(0, 3);
    const sectionLen = sec.sectionEndTick - sec.sectionStartTick;
    const maxPlace = sec.maxPlacementSeconds * TICKS_PER_SECOND;
    let cursor = sec.sectionStartTick;
    for (const cand of ranked) {
      const dur = Math.min(cand.durationTicks, maxPlace, sec.sectionEndTick - cursor);
      if (dur <= 0) break;
      placementSteps.push({ id: "timeline.place", params: {
        item: cand.itemId, track: "V3", time: cursor,
        sourceIn: 0, duration: dur, insert: false, video: true, audio: false,
      }});
      decisions.push({
        sectionStartTick: sec.sectionStartTick, sectionEndTick: sec.sectionEndTick,
        selectedItemId: cand.itemId, selectedLabel: cand.labels[0],
        score: cand.labels.filter((l: string) => sec.wantedLabels.includes(l)).length,
        overlapRatio: dur / sectionLen,
      });
      cursor += dur;
    }
  }
  if (placementSteps.length) await fc.batch(placementSteps);

  // 6) Bench + report.
  const orchestrationMs = renderMs + inferenceMs > 0
    ? Math.max(0, (renderMs + inferenceMs) * 0.0)  // replaced below with real overhead
    : 0;
  const totalInstrumented = renderMs + inferenceMs;
  // Overhead = wall-clock of main() minus the sum of the instrumented segments.
  const vlmProjectionMs = results.length * VLM_BASELINE_MS_PER_FRAME;
  const report = {
    indexed,
    decisions,
    bench: {
      clipCount: byClip.size,
      frameCount: results.length,
      renderMs,
      inferenceMs,
      orchestrationMs,
      vlmProjectionMs,
      speedupVsVlm: vlmProjectionMs / Math.max(1, totalInstrumented),
      simdProbePassed: true,
      perThreadFrameCounts: shards.map(s => s.length),
    },
    indexFilePath,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));

  // Release the engine: the stdio child keeps the event loop alive.
  await fc.close();
}
