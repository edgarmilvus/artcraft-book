/**
 * autonomousVideoAssembler.ts
 * ────────────────────────────────────────────────────────────────────────────
 * "Hello World" autonomous video assembly pipeline for a SaaS backend built
 * on the ArtCraft / Storytold suite.
 *
 * Responsibilities
 *   1. Speak MCP to a headless FilmCraft process (stdio transport).
 *   2. Orchestrate four Worker nodes through a single Supervisor node using
 *      a LangGraph `StateGraph`.
 *   3. Score B-roll candidates locally with ONNX Runtime Web so we do not
 *      stream large frames to a remote inference endpoint.
 *   4. Perform ripple trims via FilmCraft's `timeline.trim` engine command.
 *   5. Verify the result with `render_frame` before the job is declared
 *      complete.
 *
 * The whole module is self-contained: wire it up to a webhook handler and
 * you have a working Studio-as-a-Service assembler.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StateGraph, Annotation, START, END } from "@langchain/langgraph";

/* ═════════════════════════════════════════════════════════════════════════════
 * 1. GRAPH STATE
 *    ─────────────
 *    The mutable object shared by every node. Reducers decide how concurrent
 *    or sequential writes combine; defaults give safe initial values.
 * ═══════════════════════════════════════════════════════════════════════════*/

/** FilmCraft's timeline clock is expressed in ticks; 254016000000 = 1 second. */
export const TICKS_PER_SECOND = 254_016_000_000n;

/**
 * Convert seconds (float) to FilmCraft integer ticks.
 *
 * The engine's time parameters are JSON numbers of ticks, so the value has to
 * leave this function as a number. A tick is 254 016 000 000, so the exact
 * range of whole seconds that survives a double is about 32 000 years.
 */
export function secondsToTicks(seconds: number): number {
  const whole = BigInt(Math.round(seconds * 1e9));
  return Number((whole * TICKS_PER_SECOND) / 1_000_000_000n);
}

const AssemblerState = Annotation.Root({
  /** Customer-supplied job identifier; used for logging + idempotency keys. */
  jobId: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),

  /** Absolute paths on the FilmCraft read root for every asset in the job. */
  mediaPaths: Annotation<string[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),

  /** Word-level transcript produced by the dialogue-sync worker. */
  transcript: Annotation<{ startSec: number; endSec: number; text: string }[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),

  /** B-roll files ranked descending by ONNX aesthetic/composition score. */
  brollRanked: Annotation<{ path: string; score: number }[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),

  /** Accumulating list of engine commands the assemble node will batch. */
  timelineOps: Annotation<{ command: string; params: Record<string, unknown> }[]>({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),

  /** Final verification verdict from the multimodal review stage. */
  verification: Annotation<{ ok: boolean; notes: string }>({
    reducer: (_prev, next) => next,
    default: () => ({ ok: false, notes: "" }),
  }),

  /** Which node the Supervisor selected for the *next* superstep. */
  next: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "supervisor",
  }),
});

/** Narrow the synthesized LangGraph state type for readability. */
type AssemblerStateT = typeof AssemblerState.State;

/* ═════════════════════════════════════════════════════════════════════════════
 * 2. MCP CLIENT WRAPPER
 *    ────────────────────
 *    Every Worker talks to FilmCraft through this thin façade. It uses the
 *    official `command_run` meta-tool so we never need to regenerate a tool
 *    schema when the engine grows new commands.
 * ═══════════════════════════════════════════════════════════════════════════*/

export class FilmCraftClient {
  private client: Client | null = null;

  /** Spawn `filmcraft-cli mcp` as a child process and complete the MCP handshake. */
  async connect(): Promise<void> {
    // We deliberately avoid `--control` TCP mode here: stdio transport ties the
    // NLE lifetime to the Node worker, which is exactly what a short-lived
    // SaaS job wants.
    const transport = new StdioClientTransport({
      command: "filmcraft-cli",
      args: ["mcp"],
    });

    // The MCP client "identity" is only used for capability negotiation.
    this.client = new Client(
      { name: "artcraft-assembler-supervisor", version: "1.0.0" },
      { capabilities: {} }
    );

    await this.client.connect(transport);
  }

  /** Fire a single engine command. Returns the tool's `content` block. */
  async run(
    commandId: string,
    params: Record<string, unknown> = {}
  ): Promise<unknown> {
    if (!this.client) throw new Error("FilmCraft MCP client not connected");
    const result = await this.client.callTool({
      name: "command_run",
      arguments: { id: commandId, params },
    });
    return result;
  }

  /**
   * Batch several engine commands atomically. The FilmCraft MCP server
   * applies them in order and stops at the first failure.
   */
  async batch(
    steps: { id: string; params?: Record<string, unknown> }[]
  ): Promise<unknown> {
    if (!this.client) throw new Error("FilmCraft MCP client not connected");
    const result = await this.client.callTool({
      name: "command_batch",
      arguments: { steps, stop_on_error: true },
    });
    return result;
  }

  /** Invoke any MCP tool directly (used for `render_frame`). */
  async call<T = unknown>(tool: string, args: Record<string, unknown>): Promise<T> {
    if (!this.client) throw new Error("FilmCraft MCP client not connected");
    const result = await this.client.callTool({ name: tool, arguments: args });
    return result as T;
  }

  /**
   * The media items of the project, resolved by file name.
   *
   * `project.inspect` answers with the project object: the media items hang
   * under `root.children`, and the id `timeline.place` wants is the item's
   * `item` field.
   */
  async projectItems(): Promise<{ idFor(path: string): number | undefined; ids: number[] }> {
    const result = await this.run("project.inspect");
    const text = (result as { content?: { type: string; text?: string }[] })
      .content?.find((block) => block.type === "text")?.text ?? "{}";
    const payload = JSON.parse(text) as Record<string, any>;
    const items: { id: number; name: string }[] = [];
    const visit = (node: any): void => {
      if (!node || typeof node !== "object") return;
      const id = node.item ?? node.id;
      if (typeof id === "number" && typeof node.name === "string") {
        items.push({ id, name: node.name });
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(payload.root ?? payload.project?.root ?? payload);
    const byName = new Map(items.map((item) => [item.name, item.id]));
    return {
      ids: items.map((item) => item.id),
      idFor: (path: string) => {
        const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
        return byName.get(name);
      },
    };
  }

  /** Politely close stdio; the child FilmCraft process shuts down too. */
  async close(): Promise<void> {
    if (this.client) await this.client.close();
    this.client = null;
  }
}

/* ═════════════════════════════════════════════════════════════════════════════
 * 3. ONNX B-ROLL SCORER
 *    ────────────────────
 *    A tiny in-process model scores each B-roll still between 0 and 1.
 *    WebGPU is preferred, WASM is the fallback — both are inside ONNX Runtime
 *    Web, so the same code path runs on the edge or in the browser.
 * ═══════════════════════════════════════════════════════════════════════════*/

/** The slice of an ONNX inference session this class uses. */
export interface OnnxSession {
  inputNames: string[];
  outputNames: string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number> }>>;
}

export class BrollScorer {
  private session: OnnxSession | null = null;

  /**
   * Load a Small-inference-graph ONNX model. The model is expected to be a
   * MobileNet-style classifier with a single float scalar output
   * (probability that the frame is "usable B-roll").
   */
  async load(modelPath = "./models/broll-score.onnx"): Promise<void> {
    // The runtime is loaded on demand: a deployment that scores B-roll
    // elsewhere never pays for the WASM binary, and the module loads
    // without onnxruntime-web installed.
    const runtimeName = "onnxruntime-web";
    const runtime = (await import(runtimeName)) as any;
    this.session = (await runtime.InferenceSession.create(modelPath, {
      executionProviders: ["webgpu", "wasm"],
      graphOptimizationLevel: "all",
    })) as OnnxSession;
  }

  /**
   * Score a single 224×224×3 float32 NCHW tensor in [0, 1].
   * If the model is absent we fail-open with 0.5 so the pipeline still runs.
   */
  async score(tensorData: Float32Array): Promise<number> {
    if (!this.session) return 0.5;

    const runtimeName = "onnxruntime-web";
    const runtime = (await import(runtimeName)) as any;
    const tensor = new runtime.Tensor("float32", tensorData, [1, 3, 224, 224]);
    const feeds: Record<string, unknown> = {
      [this.session.inputNames[0]]: tensor,
    };
    const outputs = await this.session.run(feeds);
    const firstOutput = outputs[this.session.outputNames[0]];
    return Number(firstOutput.data[0]);
  }
}

/* ═════════════════════════════════════════════════════════════════════════════
 * 4. NODES
 *    ─────
 *    One Supervisor and four Workers. Every Worker is a pure function of
 *    (state, deps) → Partial<state>. This makes them trivially unit-testable.
 * ═══════════════════════════════════════════════════════════════════════════*/

/** The id of the first clip a `timeline.place` created. */
function firstClipId(result: unknown): number {
  const text = (result as { content?: { type: string; text?: string }[] })
    .content?.find((block) => block.type === "text")?.text ?? "{}";
  const parsed = JSON.parse(text) as { clips?: number[] };
  return parsed.clips?.[0] ?? 0;
}

/**
 * Supervisor: choose exactly one next hop based on which fields of the state
 * are still empty. In a full system this method would call an LLM with a
 * compact JSON summary of `state`; for the Hello-World example we use a
 * deterministic decision tree.
 */
export async function supervisorNode(
  state: AssemblerStateT
): Promise<Partial<AssemblerStateT>> {
  let next: string;
  if (state.transcript.length === 0) {
    next = "dialogueSync";
  } else if (state.brollRanked.length === 0) {
    next = "brollIndex";
  } else if (state.timelineOps.length === 0) {
    next = "assemble";
  } else if (!state.verification.ok) {
    next = "verify";
  } else {
    next = "finish";
  }
  return { next };
}

/**
 * dialogueSync: ask FilmCraft for a transcript of the audio-bearing asset,
 * then convert its timestamps into plain seconds for downstream math.
 */
export async function dialogueSyncNode(
  state: AssemblerStateT,
  client: FilmCraftClient
): Promise<Partial<AssemblerStateT>> {
  // The project is created *before* the import: `file.newProject` starts a
  // fresh project, so importing first and creating afterwards would throw the
  // imported items away. `file.import` is idempotent — re-importing the same
  // path returns the existing project item id, so retries are safe.
  await client.run("file.newProject", { name: `job-${state.jobId}` });
  await client.run("file.import", { paths: state.mediaPaths });

  // In a real deployment you would call `transcript.generate` here. For the
  // Hello-World code we synthesize a transcript that spans the source clip.
  const transcript = [
    { startSec: 0.0, endSec: 0.9, text: "Hello" },
    { startSec: 0.9, endSec: 1.4, text: "and" },
    { startSec: 1.4, endSec: 2.1, text: "welcome." },
    // …dead air 2.1–4.6 seconds would normally be detected from audio peaks…
    { startSec: 4.6, endSec: 5.4, text: "Today" },
    { startSec: 5.4, endSec: 6.1, text: "we" },
    { startSec: 6.1, endSec: 7.2, text: "ship." },
  ];

  return { transcript };
}

/**
 * brollIndex: score every candidate asset with the in-process ONNX model
 * and return them sorted, best first.
 */
export async function brollIndexNode(
  state: AssemblerStateT,
  scorer: BrollScorer
): Promise<Partial<AssemblerStateT>> {
  // Pretend each candidate file has already been decoded + letterboxed to
  // 224×224×3 floats by a helper. In production, use OffscreenCanvas +
  // `createImageBitmap` for the browser, or `sharp` in Node.
  const candidates = state.mediaPaths.filter((p) => p.includes("broll"));

  const ranked: { path: string; score: number }[] = [];
  for (const path of candidates) {
    // A real implementation would `const t = await decodeToTensor(path)`.
    const dummyTensor = new Float32Array(3 * 224 * 224); // zeros
    const score = await scorer.score(dummyTensor);
    ranked.push({ path, score });
  }
  ranked.sort((a, b) => b.score - a.score);

  return { brollRanked: ranked };
}

/**
 * assemble: build the timeline. This is the heart of the chapter —
 * placing the dialogue clips, razoring at sentence boundaries and
 * ripple-trimming the dead air out so the following clips slide left.
 */
export async function assembleNode(
  state: AssemblerStateT,
  client: FilmCraftClient
): Promise<Partial<AssemblerStateT>> {
  // 1. Create the sequence sized for the customer's deliverable. The
  //    project itself was created by the dialogue-sync node, before the
  //    import, so the media is still in the bin.
  await client.run("file.newSequence", {
    name: "Assembly",
    width: 1920,
    height: 1080,
    fps: 23.976,
  });

  // 2. Place the raw dialogue take at t=0 on V1.
  //    `timeline.place` takes the *numeric* item id, so the path has to be
  //    resolved against the project tree after the import.
  const items = await client.projectItems();
  const dialogueId = items.idFor(state.mediaPaths[0]);
  if (dialogueId === undefined) {
    throw new Error(`dialogue take not found in the project: ${state.mediaPaths[0]}`);
  }

  // 3. Place the dialogue take at t=0 on V1.
  const placed = await client.run("timeline.place", {
    item: dialogueId,
    track: "V1",
    time: secondsToTicks(0),
    insert: true,
  });
  const dialogueClip = firstClipId(placed);

  // 4. Razor at every sentence boundary so ripple trims can consume the
  //    dead air between words. This is the "cut list" the supervisor built.
  let cursorSec = 0;
  for (const word of state.transcript) {
    cursorSec = word.endSec;
    await client.run("timeline.razor", {
      time: secondsToTicks(cursorSec),
      track: "V1",
    });
  }

  // 5. Ripple-trim a representative 2.5s of dead air between "welcome."
  //    and "Today". A ripple trim closes the gap; a *regular* trim would
  //    leave a hole that the customer would see as a flash frame. The clip
  //    argument is the id the placement returned, not the file name.
  await client.run("timeline.trim", {
    clip: dialogueClip,
    edge: "out",
    mode: "ripple",
    delta: secondsToTicks(-2.5),
  });

  // 6. Insert the highest-scoring B-roll clip into the tightest speech gap.
  if (state.brollRanked.length > 0) {
    const brollId = items.idFor(state.brollRanked[0].path);
    if (brollId !== undefined) {
      await client.run("timeline.place", {
        item: brollId,
        track: "V2",
        time: secondsToTicks(3.0),
        insert: false,
      });
    }
  }

  // 7. Record what we did so the supervisor can see we made progress.
  const ops = [
    { command: "file.newProject", params: { name: `job-${state.jobId}` } },
    { command: "file.import", params: { paths: state.mediaPaths } },
    { command: "file.newSequence", params: { name: "Assembly" } },
    { command: "timeline.place", params: { track: "V1", time: secondsToTicks(0) } },
    { command: "timeline.trim", params: { mode: "ripple", delta: secondsToTicks(-2.5) } },
  ];
  return { timelineOps: ops };
}

/**
 * verify: render a frame at the splice point and confirm the timeline is
 * coherent. In a full system this PNG is sent to a vision LLM; here we
 * check that `render_frame` returned any bytes at all.
 */
export async function verifyNode(
  state: AssemblerStateT,
  client: FilmCraftClient
): Promise<Partial<AssemblerStateT>> {
  const frame = await client.call<{ content: { type: string; data?: string }[] }>(
    "render_frame",
    { seconds: 3.0, max_side: 512 }
  );

  const gotImage = Array.isArray(frame.content)
    ? frame.content.some((c) => c.type === "image")
    : false;

  return {
    verification: gotImage
      ? { ok: true, notes: "render succeeded" }
      : { ok: false, notes: "no image content returned" },
  };
}

/* ═════════════════════════════════════════════════════════════════════════════
 * 5. GRAPH WIRING
 *    ────────────
 *    The StateGraph class is the foundation of any agentic loop: nodes are
 *    computational steps and edges are transitions over the shared state.
 * ═══════════════════════════════════════════════════════════════════════════*/

export function buildAssemblerGraph(
  client: FilmCraftClient,
  scorer: BrollScorer
) {
  const graph = new StateGraph(AssemblerState)
    // ── Node registrations. Each is a thin closure binding the shared deps.
    .addNode("supervisor", (s) => supervisorNode(s))
    .addNode("dialogueSync", (s) => dialogueSyncNode(s, client))
    .addNode("brollIndex", (s) => brollIndexNode(s, scorer))
    .addNode("assemble", (s) => assembleNode(s, client))
    .addNode("verify", (s) => verifyNode(s, client))
    // ── Static edges.
    .addEdge(START, "supervisor")
    .addEdge("dialogueSync", "supervisor")
    .addEdge("brollIndex", "supervisor")
    .addEdge("assemble", "supervisor")
    .addEdge("verify", "supervisor")
    // ── Conditional edge: the Supervisor's `next` field picks the target.
    .addConditionalEdges("supervisor", (s) => s.next, {
      dialogueSync: "dialogueSync",
      brollIndex: "brollIndex",
      assemble: "assemble",
      verify: "verify",
      finish: END,
    });

  return graph.compile();
}

/* ═════════════════════════════════════════════════════════════════════════════
 * 6. PUBLIC ENTRY POINT
 *    ───────────────────
 *    Called by the SaaS webhook handler. Everything downstream is fire-and-
 *    forget from the caller's point of view; the returned state is enough
 *    to enqueue a "job complete" event.
 * ═══════════════════════════════════════════════════════════════════════════*/

export async function runAssemblyJob(
  jobId: string,
  mediaPaths: string[]
): Promise<AssemblerStateT> {
  const client = new FilmCraftClient();
  const scorer = new BrollScorer();

  await client.connect();
  await scorer.load();

  try {
    const app = buildAssemblerGraph(client, scorer);
    const finalState = (await app.invoke({
      jobId,
      mediaPaths,
    })) as AssemblerStateT;
    return finalState;
  } finally {
    await client.close();
  }
}
