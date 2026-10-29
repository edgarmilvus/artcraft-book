/**
 * @file banner-service.ts
 * @description Minimal "Hello World" SaaS endpoint that renders a banner PNG
 *              via the PhotoCraft headless CLI. The process boundary between
 *              Node.js and the Rust engine is the entire point of the example:
 *              it demonstrates command chaining, sandboxed I/O, timeout
 *              handling and strict-typed request validation in one file.
 *
 * DESIGN NOTES
 * - Zero third-party dependencies. Only Node.js core modules are used, so the
 *   resulting Docker image stays small and CVE surface is minimal.
 * - Every request spawns a fresh `photocraft-cli` process ("cold start"). The
 *   "Warm Start" section at the end of this subsection shows the upgrade path
 *   to a persistent daemon for high-QPS production traffic.
 * - All file paths are absolute and confined to a per-request temp workspace,
 *   which we also use as the CLI's working directory.
 *
 * CLI REALITY (verified against photocraft-cli 0.8.2)
 * - `photocraft-cli run` does not accept `--automation-read-root` /
 *   `--automation-write-root`; only `mcp` and `serve` take those flags.
 * - `run` needs a document to operate on (`--new <json>` or a file) and a
 *   destination (`--out <file> [--format <ext>]`). `file.new` and
 *   `file.save` are therefore *not* CLI steps: they become the `--new`
 *   payload and the `--out` flag. The plan stays the semantic plan; only
 *   the translation in `planToArgv` knows the CLI grammar.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

/* ------------------------------------------------------------------ */
/*  Domain types — the "strict type discipline" contract               */
/* ------------------------------------------------------------------ */

/**
 * The user-facing request shape. In a fuller SaaS you would validate this
 * with Zod or TypeBox; here we do a manual narrow to stay dependency-free.
 * Note the `readonly` modifiers: this object is never mutated after
 * validation, and TS will enforce that.
 */
interface BannerRequest {
  readonly headline: string;
  readonly subhead: string;
  readonly width: number;
  readonly height: number;
}

/**
 * A single ArtCraft engine command as it appears on the `--cmd` CLI flag.
 * `id` matches a registered command id (verify with `photocraft-cli commands
 * --json`, or the `command_list` MCP tool). `params` is the
 * JSON object that command expects — see the "COMPILED RUNTIME SCHEMAS"
 * section for the canonical shape of each id.
 */
interface EngineStep {
  readonly id: string;
  readonly params: Record<string, unknown>;
}

/** Result envelope returned to the HTTP caller on success. */
interface BannerResult {
  readonly bytes: number;
  readonly durationMs: number;
}

/* ------------------------------------------------------------------ */
/*  Configuration                                                      */
/* ------------------------------------------------------------------ */

/** Binaries on the PATH inside the container. Overridable for tests. */
const PHOTOCRAFT_CLI: string =
  process.env["PHOTOCRAFT_CLI"] ?? "photocraft-cli";

/** Hard wall-clock limit for one render. CI pipelines enforce this too. */
const AUTOMATION_TIMEOUT_MS: number = Number(
  process.env["AUTOMATION_TIMEOUT_MS"] ?? "30000",
);

/** HTTP port. 8787 avoids colliding with common dev servers. */
const PORT: number = Number(process.env["PORT"] ?? "8787");

/* ------------------------------------------------------------------ */
/*  Plan construction                                                  */
/* ------------------------------------------------------------------ */

function planToArgv(plan: readonly EngineStep[], out: string): string[] {
  // `run` works on exactly one document, so the plan's `file.new` head and
  // `file.save` tail are not commands here: they are the document and the
  // destination. Anything else is a `--cmd <id> --params <json>` pair.
  const steps = [...plan];
  const head = steps[0];
  const tail = steps[steps.length - 1];
  if (head?.id !== "file.new") {
    throw new Error(`plan must start with file.new, got ${String(head?.id)}`);
  }
  if (tail?.id !== "file.save") {
    throw new Error(`plan must end with file.save, got ${String(tail?.id)}`);
  }
  const doc = head.params;
  const save = tail.params;
  const argv: string[] = ["run", "--new", JSON.stringify(doc)];
  for (const step of steps.slice(1, -1)) {
    argv.push("--cmd", step.id, "--params", JSON.stringify(step.params));
  }
  argv.push("--out", out);
  const format = save["format"];
  if (typeof format === "string") argv.push("--format", format);
  return argv;
}

/**
 * Translate a validated request into the ordered list of engine commands
 * that will turn an empty canvas into a finished banner. PhotoCraft
 * applies these top-to-bottom, exactly like a recorded Action in the GUI.
 *
 * @param req  The validated banner request.
 * @param out  Absolute path inside the sandbox where the PNG should land.
 * @returns    A frozen array of `{ id, params }` steps.
 */
function buildPlan(req: BannerRequest, out: string): readonly EngineStep[] {
  // PhotoCraft anchors point-type text at the *baseline*, not the visual
  // center, so we nudge Y downward to make the headline look centered.
  const headlineX: number = Math.round(req.width * 0.06);
  const headlineY: number = Math.round(req.height * 0.55);
  const subheadY: number = Math.round(req.height * 0.72);
  const headlineSize: number = Math.max(24, Math.round(req.height * 0.12));
  const subheadSize: number = Math.max(14, Math.round(req.height * 0.05));

  return [
    {
      id: "file.new",
      params: {
        width: req.width,
        height: req.height,
        mode: "rgb",
        depth: 8,
        background: "#0b1020",
        resolution: 144,
        name: "hello-banner",
      },
    },
    {
      id: "layer.newFillLayer.gradient",
      params: {
        from: "#1e293b",
        to: "#f59e0b",
        angle: 90,
        style: "linear",
      },
    },
    {
      id: "type.create",
      params: {
        x: headlineX,
        y: headlineY,
        text: req.headline,
        font: "Inter",
        fontStyle: "Bold",
        size: headlineSize,
        color: "#ffffff",
      },
    },
    {
      id: "type.create",
      params: {
        x: headlineX,
        y: subheadY,
        text: req.subhead,
        font: "Inter",
        fontStyle: "Regular",
        size: subheadSize,
        color: "#e2e8f0",
      },
    },
    {
      id: "file.save",
      params: {
        path: out,
        format: "png",
        quality: 92,
      },
    },
  ];
}

/* ------------------------------------------------------------------ */
/*  Subprocess execution                                               */
/* ------------------------------------------------------------------ */

/**
 * Spawn the ArtCraft CLI, pipe every step through `--cmd` / `--params`,
 * and reject on non-zero exit, signal death, spawn error, or timeout.
 *
 * Under the hood the CLI:
 *   1. Boots a headless Rust engine (crate `photocraft-engine`).
 *   2. Opens an empty document session with no GPU surface.
 *   3. Executes each `--cmd` in order against that session.
 *   4. Flushes any dirty buffers and writes the output file before exit.
 *
 * The returned promise settles exactly once; the timeout handler is
 * cleared on every terminal path so no dangling timers keep the Node
 * event loop alive.
 */
function runCli(
  bin: string,
  argv: readonly string[],
  timeoutMs: number,
  cwd: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(bin, [...argv], {
      stdio: ["ignore", "pipe", "pipe"],
      // No root flags on `run`, so the workspace is the working directory:
      // anything the CLI resolves relative to cwd lands inside the sandbox.
      cwd,
      env: {
        ...process.env,
        // Force the CPU reference compositor. CI runners rarely expose a
        // usable GPU, and this prevents the engine from probing wgpu
        // adapters (which can hang on some virtualized hosts).
        PHOTOCRAFT_GPU: process.env["PHOTOCRAFT_GPU"] ?? "0",
        // Richer Rust panic traces help enormously when CI fails.
        RUST_BACKTRACE: "1",
      },
    });

    // Bounded stderr buffer. The CLI streams `tracing` output here; we
    // keep only the last 8 KB so a runaway log cannot exhaust memory.
    let stderr: string = "";

    child.stderr.on("data", (chunk: Buffer): void => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8192);
    });

    const timer: NodeJS.Timeout = setTimeout((): void => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `photocraft-cli exceeded ${timeoutMs} ms; killed. ` +
            `Last stderr:\n${stderr}`,
        ),
      );
    }, timeoutMs);

    child.on("error", (err: Error): void => {
      clearTimeout(timer);
      reject(err);
    });

    child.on(
      "exit",
      (code: number | null, signal: NodeJS.Signals | null): void => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(
            `photocraft-cli exited code=${String(code)} ` +
              `signal=${String(signal)}\n${stderr}`,
          ),
        );
      },
    );
  });
}

/* ------------------------------------------------------------------ */
/*  Orchestration                                                      */
/* ------------------------------------------------------------------ */

/**
 * Full round-trip: create a sandbox, plan commands, execute, read the
 * PNG back, clean up. Returns the byte count and duration so the caller
 * can log, bill, or emit metrics for the artifact.
 *
 * The `finally` block guarantees temp-dir cleanup even if any step in
 * the `try` throws — critical in a long-lived service process.
 */
async function renderBanner(req: BannerRequest): Promise<BannerResult> {
  const workspace: string = await mkdtemp(join(tmpdir(), "artcraft-"));
  const outPath: string = join(workspace, "banner.png");
  const start: number = Date.now();

  try {
    const plan: readonly EngineStep[] = buildPlan(req, outPath);

    // The argv is derived from the plan, not concatenated by hand: the
    // document comes from `file.new`, the destination from `file.save`,
    // and every other step becomes a `--cmd <id> --params <json>` pair.
    const argv: string[] = planToArgv(plan, outPath);

    await runCli(PHOTOCRAFT_CLI, argv, AUTOMATION_TIMEOUT_MS, workspace);

    const info = await stat(outPath);
    const buf: Buffer = await readFile(outPath);

    // Cheap sanity check: a <8-byte file is almost certainly an error
    // page or an empty stream that lied about succeeding.
    if (buf.byteLength < 8) {
      throw new Error(
        `CLI reported success but produced a ${buf.byteLength}-byte artifact`,
      );
    }

    return { bytes: info.size, durationMs: Date.now() - start };
  } finally {
    // `KEEP_WORKSPACE=1` is the debugging escape hatch: in CI you want the
    // temp dir gone, but when a render looks wrong you want the PNG back.
    if (process.env["KEEP_WORKSPACE"] === "1") {
      console.log(`[banner-service] kept workspace ${workspace}`);
    } else {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

/* ------------------------------------------------------------------ */
/*  HTTP transport                                                     */
/* ------------------------------------------------------------------ */

/** Read the request body with a 256 KB hard cap. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total: number = 0;
  for await (const chunk of req) {
    const c: Buffer = chunk as Buffer;
    total += c.byteLength;
    if (total > 262_144) {
      throw new Error("Request body too large");
    }
    chunks.push(c);
  }
  const raw: string = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw) as unknown;
}

/** Type guard: narrow `unknown` JSON into a `BannerRequest`. */
function isBannerRequest(v: unknown): v is BannerRequest {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  const h = o["headline"];
  const s = o["subhead"];
  const w = o["width"];
  const hh = o["height"];
  return (
    typeof h === "string" &&
    h.length > 0 &&
    h.length <= 200 &&
    typeof s === "string" &&
    s.length <= 400 &&
    typeof w === "number" &&
    typeof hh === "number" &&
    w > 0 &&
    hh > 0 &&
    w <= 8000 &&
    hh <= 8000
  );
}

/* ------------------------------------------------------------------ */
/*  Server bootstrap                                                   */
/* ------------------------------------------------------------------ */

const server = createServer(
  async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "POST" || req.url !== "/banner") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    try {
      const body: unknown = await readJsonBody(req);
      if (!isBannerRequest(body)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid BannerRequest" }));
        return;
      }

      const result: BannerResult = await renderBanner(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (err) {
      const message: string =
        err instanceof Error ? err.message : "unknown error";
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: message }));
    }
  },
);

server.listen(PORT, (): void => {
  // eslint-disable-next-line no-console
  console.log(`[banner-service] listening on :${PORT}`);
});
