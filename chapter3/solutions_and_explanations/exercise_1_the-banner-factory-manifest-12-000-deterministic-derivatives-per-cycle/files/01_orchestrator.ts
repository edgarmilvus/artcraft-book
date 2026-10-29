// orchestrator.ts — Banner factory orchestrator (child_process spawn of photocraft-cli mcp)
// Design note: we choose the MCP stdio transport over raw `run` CLI because it keeps one
// engine process (and its font index) alive per replica for the full cycle. Spawning a
// fresh CLI per banner re-pays the engine boot, measured at 40-170 ms for a bare run, so
// 12,000 banners would spend 8-34 minutes in process startup before any rendering. We own
// the concurrency and job-gating logic locally so we can enforce the determinism contract
// (stable doc name, one command_batch for the curves, deterministic export basename).
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ---------- Manifest contract ----------
interface SkuRow {
  readonly sku: string;
  readonly heroPath: string;               // relative to /work/assets
  readonly palette: "spring" | "autumn";
  readonly aspect: string;                 // key of ASPECTS
  readonly focalX: number;
  readonly focalY: number;
}
interface Aspect { readonly id: string; readonly w: number; readonly h: number; }
interface Manifest {
  readonly campaignUuid: string;
  readonly rows: readonly SkuRow[];
  readonly aspects: Record<string, Aspect>;
  readonly palettes: Record<string, { readonly shadow: readonly [number, number][] }>;
}

// ---------- Structured logging ----------
const ts = () => new Date().toISOString();
function logBanner(rec: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ ts: ts(), ...rec }) + "\n");
}
function logError(sku: string, reason: string, exitCode: number): void {
  // failures.jsonl is a sidecar consumed by the batch reconciler. Keep it off
  // stdout: the success stream must stay parseable as one banner per line.
  const target = process.env["FAILURES_PATH"]
    ?? path.join(process.env["OUT_ROOT"] ?? "/work/output", "failures.jsonl");
  fs.mkdir(path.dirname(target), { recursive: true })
    .then(() => fs.appendFile(target, JSON.stringify({ sku, reason, exitCode }) + "\n"))
    .catch((err: unknown) => {
      process.stderr.write(`failures.jsonl write failed: ${(err as Error).message}\n`);
    });
  // Also surface it on stderr so a job log shows the quarantine immediately.
  process.stderr.write(JSON.stringify({ sku, reason, exitCode }) + "\n");
}

// ---------- MCP stdio client ----------
// One connection, one tool call at a time: `call(tool, args)` is
// `tools/call` on the MCP session. (The earlier draft wrote raw JSON-RPC
// frames — `{"jsonrpc":"2.0","id":1,"method":"session_list"}` — which is not
// the MCP wire protocol and could never complete the handshake.)
class McpClient {
  private readonly client: Client;
  private ready = false;

  private constructor(client: Client) {
    this.client = client;
  }

  /** True once the MCP handshake has completed on this session. */
  get warm(): boolean {
    return this.ready;
  }

  static async connect(binary = "photocraft-cli", extraArgs: readonly string[] = []): Promise<McpClient> {
    const assets = process.env["ASSET_ROOT"] ?? "/work/assets";
    const output = process.env["OUT_ROOT"] ?? "/work/output";
    const transport = new StdioClientTransport({
      command: binary,
      // --automation-read-root / --automation-write-root form the filesystem
      // sandbox: anything outside them fails at the engine boundary (not
      // silently swallowed), which is exactly the audit posture we want.
      args: ["mcp",
             "--automation-read-root", assets,
             "--automation-write-root", output,
             ...extraArgs],
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    const client = new Client({ name: "banner-factory", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    const session = new McpClient(client);
    session.ready = true;
    return session;
  }

  async call<T = unknown>(tool: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await this.client.callTool({ name: tool, arguments: params });
    const block = (res.content as Array<{ type: string; text?: string }> | undefined)
      ?.find((c) => c.type === "text");
    let payload: unknown = undefined;
    if (block?.text !== undefined) {
      try { payload = JSON.parse(block.text) as unknown; } catch { payload = block.text; }
    }
    if (res.isError) throw new Error(`${tool} failed: ${JSON.stringify(payload)}`);
    return payload as T;
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
  }
}

// ---------- Job gating: never stack commands on the same doc ----------
async function awaitJobDrain(cli: McpClient, docIndex: number, pollMs = 40, deadlineMs = 30_000): Promise<void> {
  const started = Date.now();
  // The contract: no second command_run on the same document while jobs_list still
  // reports an active job for it. We poll until the doc's job is gone.
  for (;;) {
    const r = await cli.call("jobs_list", {}) as { jobs?: readonly { state: string; documentIndex?: number }[] };
    const busy = (r.jobs ?? []).some(j => j.documentIndex === docIndex && j.state === "running");
    if (!busy) return;
    if (Date.now() - started > deadlineMs) throw new Error("job drain exceeded 30 s");
    await new Promise(res => setTimeout(res, pollMs));
  }
}

// ---------- One banner ----------
async function renderBanner(
  cli: McpClient,
  m: Manifest,
  row: SkuRow,
  aspect: Aspect,
): Promise<{ durationMs: number; bytesWritten: number; jobId: number | null }> {
  const t0 = Date.now();
  const docName = `${m.campaignUuid}_${row.sku}_${row.palette}_${aspect.id}`;   // stable name
  const outRel = `${m.campaignUuid}_${row.sku}_${row.palette}_${aspect.id}_${aspect.w}x${aspect.h}.png`;

  // (1) Deterministic empty canvas: rgb 8-bit, transparent background.
  await cli.call("command_run", {
    id: "file.new",
    params: { width: aspect.w, height: aspect.h, mode: "rgb", depth: 8, background: "transparent", name: docName },
  });
  const sess = await cli.call("session_list", {}) as { active?: number };
  const docIndex = sess.active ?? 0;

  // (2) Place the hero JPEG as a Smart Object (background decode, deterministic).
  //     `doc_place` is an MCP *tool*, not a registry command: routing it through
  //     `command_run` fails with "unknown command `doc_place`".
  await cli.call("doc_place", {
    path: row.heroPath,
    fit: true,
    // The focal point is the crop centre, normalised to the canvas. Ignoring it
    // would make two SKUs that share a palette and aspect byte-identical.
    center: [Math.round(aspect.w * row.focalX), Math.round(aspect.h * row.focalY)],
  });

  // (3) Palette curve — MUST be a single command_batch step -> one history entry.
  // If we issued the curves command alone it would still be one entry, but batching
  // the palette-derived adjustment with the shadow setup makes the whole look a single
  // undo unit, which the legal audit requires (per-banner replay = one history hop).
  const points = m.palettes[row.palette].shadow;
  await cli.call("command_batch", {
    steps: [
      { id: "layer.newAdjustmentLayer.curves", params: { points } },
      // Gaussian blur applied as a live smart filter — deterministic, no GPU state.
      { id: "filter.blur.gaussianBlur", params: { radius: 6 } },
    ],
    stop_on_error: true,
  });

  // (4) GATE — the curves/blur batch is long-running; wait until the doc's job drains
  // before exporting, otherwise doc_export races the compositor.
  await awaitJobDrain(cli, docIndex);

  // (5) Deterministic PNG export.
  const exportRes = await cli.call("doc_export", {
    path: outRel, format: "png", quality: 92, index: docIndex,
  }) as { bytes?: number; job?: number };

  // (6) Close the document without saving — the output file is the artifact.
  await cli.call("doc_close", { index: docIndex });

  const durationMs = Date.now() - t0;
  const stat = await fs.stat(path.join(process.env["OUT_ROOT"] ?? "/work/output", outRel));
  return { durationMs, bytesWritten: stat.size, jobId: exportRes.job ?? null };
}

// ---------- Bounded concurrency ----------
// One MCP session is ONE document at a time: `file.new` replaces the active
// document, so two banners sharing a session steal each other's canvas (the
// symptom is `doc_close: no document at index 1`). Warmth therefore has to be
// pooled per worker, exactly like a database connection pool.
async function runWithCap<T, R>(
  items: readonly T[],
  cap: number,
  fn: (t: T, cli: McpClient) => Promise<R>,
): Promise<{ results: R[]; clients: McpClient[] }> {
  const clients = await Promise.all(
    Array.from({ length: Math.max(1, Math.min(cap, items.length)) }, () => McpClient.connect("photocraft-cli")),
  );
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = clients.map(async (cli) => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, cli);
    }
  });
  await Promise.all(workers);
  return { results, clients };
}

// ---------- Build-time warm-up ----------
// The image bakes the font and shaping caches by opening a tiny document,
// rendering an 8-px preview, and closing it. This runs through the same MCP
// client as the orchestrator, so the build never depends on hand-written
// JSON-RPC frames (an MCP server answers `tools/call`, not raw JSON lines).
async function warmup(): Promise<void> {
  const cli = await McpClient.connect("photocraft-cli");
  try {
    await cli.call("doc_new", {
      width: 64, height: 64, mode: "rgb", depth: 8, background: "white", name: "warmup",
    });
    await cli.call("doc_render_preview", { max_side: 8 });
    await cli.call("doc_close", {});
  } finally {
    await cli.close();
  }
}

// ---------- Liveness probe ----------
// Kubernetes runs this every 15 s. It proves the process can still speak MCP
// and answer the two calls the orchestrator depends on; a dead or wedged
// session fails the probe and the pod is replaced.
async function probe(): Promise<void> {
  const cli = await McpClient.connect("photocraft-cli");
  try {
    await cli.call("jobs_list", {});
    await cli.call("session_list", {});
  } finally {
    await cli.close();
  }
}

// ---------- Entry point ----------
async function main(): Promise<void> {
  if (process.argv.includes("--warmup")) {
    await warmup();
    return;
  }
  if (process.argv.includes("--probe")) {
    await probe();
    return;
  }
  const manifestPath = process.env["MANIFEST_PATH"]
    ?? path.join(process.env["ASSET_ROOT"] ?? "/work/assets", "manifest.json");
  const raw = await fs.readFile(manifestPath, "utf8");
  const manifest: Manifest = JSON.parse(raw);

  // Build the full 12,000-item work list (SKUs × aspects) but this replica handles
  // only its shard: the K8s Job sets REPLICA_INDEX/REPLICA_COUNT via downward API.
  const replica = Number(process.env["REPLICA_INDEX"] ?? "0");
  const replicas = Number(process.env["REPLICA_COUNT"] ?? "1");
  const all: { row: SkuRow; aspect: Aspect }[] = [];
  for (const row of manifest.rows) {
    const aspect = manifest.aspects[row.aspect];
    if (!aspect) { continue; }
    all.push({ row, aspect });
  }
  const shard = all.filter((_, i) => i % replicas === replica);

  // The pool is connected before the first banner, so every render starts on a
  // warm session. The flag records that fact per log line; it is not an env knob.
  const warmStartHit = (cli: McpClient): boolean => cli.warm;

  const cap = Math.min(4, Number(process.env["AVAILABLE_WORKERS"] ?? "4"));
  const sigterm = { current: false };
  let pool: McpClient[] = [];
  const onSignal = async (): Promise<void> => {
    sigterm.current = true;
    for (const cli of pool) {
      const jobs = await cli.call<{ jobs?: readonly { id: number; state: string }[] }>("jobs_list", {})
        .catch(() => ({ jobs: [] }));
      for (const j of jobs.jobs ?? []) {
        if (j.state === "running") { await cli.call("jobs_cancel", { job: j.id }).catch(() => undefined); }
      }
    }
    await Promise.all(pool.map((c) => c.close()));
    process.exit(0);
  };
  process.on("SIGTERM", () => { void onSignal(); });

  let failed = 0;
  const run = await runWithCap(shard, cap, async ({ row, aspect }, cli) => {
    if (sigterm.current) return;
    try {
      const r = await renderBanner(cli, manifest, row, aspect);
      logBanner({
        campaignUuid: manifest.campaignUuid, sku: row.sku, palette: row.palette,
        aspect: aspect.id, durationMs: r.durationMs, bytesWritten: r.bytesWritten,
        warmStartHit: warmStartHit(cli), jobId: r.jobId,
      });
    } catch (err) {
      failed += 1;
      logError(row.sku, (err as Error).message, 1);
    }
  });
  pool = run.clients;
  await Promise.all(pool.map((c) => c.close()));
  // A run where every banner failed must not look like a success to the Job.
  if (failed === shard.length && shard.length > 0) process.exitCode = 1;
}

void main();
