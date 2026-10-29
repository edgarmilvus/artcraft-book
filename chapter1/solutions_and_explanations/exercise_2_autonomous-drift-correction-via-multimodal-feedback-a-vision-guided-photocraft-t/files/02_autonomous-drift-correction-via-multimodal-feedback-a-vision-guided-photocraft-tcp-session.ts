// ---------------------------------------------------------------------------
// Chapter 1, Exercise 2 — Autonomous drift correction via multimodal feedback
//
// A strictly-authenticated client for PhotoCraft's TCP control channel plus
// the correction loop that drives one Hue/Saturation adjustment layer until a
// vision model reports that the skin tones are right.
//
// The channel is `photocraft-cli serve --port <p> --control-token <64 hex>`.
// The first line on the socket MUST be the auth frame; every later frame is a
// line-delimited JSON request carrying a monotonically increasing id.
//
// The Hue/Saturation layer is created once, before the loop. Every correction
// is applied cumulatively to that same layer, so the document ends with one
// live adjustment layer rather than a stack of them.
// ---------------------------------------------------------------------------

import { createConnection, type Socket } from "node:net";
import { createInterface, type Interface } from "node:readline";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// 1. The wire
// ---------------------------------------------------------------------------

export interface Adjustment {
  hue: number;
  saturation: number;
  lightness: number;
}

interface Frame {
  id: string;
  ok?: boolean;
  result?: unknown;
  error?: string;
}

export class AuthError extends Error {}
export class EngineError extends Error {}

export interface CraftLiveClientOptions {
  host?: string;
  port: number;
  token: string;
  /**
   * Local path of the engine's automation write root. The harness starts the
   * server with `--automation-read-root/--automation-write-root` pointing at
   * the exercise directory, so relative engine paths land under it.
   */
  root: string;
}

/**
 * Minimal authenticated control client.
 *
 * `connect()` sends the auth frame as the FIRST line on the socket and refuses
 * to resolve until the server answers `{"ok":true}`. Every other method calls
 * `requireAuth()` first, so no engine command can ever precede authentication.
 */
export class CraftLiveClient {
  readonly root: string;
  private readonly host: string;
  private readonly port: number;
  private readonly token: string;

  private socket?: Socket;
  private reader?: Interface;
  private nextId = 1;
  private pending = new Map<string, (frame: Frame) => void>();
  private authenticated = false;
  private closed = false;

  constructor(options: CraftLiveClientOptions) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port;
    this.token = options.token;
    this.root = options.root;
  }

  get isAuthenticated(): boolean {
    return this.authenticated;
  }

  /** Open the socket and authenticate. Resolves only after `ok: true`. */
  async connect(timeoutMs = 10_000): Promise<void> {
    if (this.socket) throw new Error("client is already connected");

    const socket = createConnection({ host: this.host, port: this.port });
    socket.setNoDelay(true);
    this.socket = socket;

    await new Promise<void>((done, fail) => {
      const timer = setTimeout(
        () => fail(new Error(`timed out connecting to ${this.host}:${this.port}`)),
        timeoutMs,
      );
      socket.once("connect", () => {
        clearTimeout(timer);
        done();
      });
      socket.once("error", (err) => {
        clearTimeout(timer);
        fail(err);
      });
    });

    const reader = createInterface({ input: socket, crlfDelay: Infinity });
    this.reader = reader;
    reader.on("line", (line) => this.onLine(line));
    socket.on("close", () => {
      this.authenticated = false;
      for (const settle of this.pending.values()) {
        settle({ id: "?", ok: false, error: "control channel closed" });
      }
      this.pending.clear();
    });
    socket.on("error", () => {
      /* surfaced through the request that is waiting on it */
    });

    let reply: Frame;
    try {
      reply = await this.send("auth", { token: this.token });
    } catch (err) {
      this.destroy();
      throw err;
    }
    if (!reply.ok || !hasAuthenticated(reply.result)) {
      this.destroy();
      throw new AuthError(reply.error ?? "control channel rejected the token");
    }
    this.authenticated = true;
  }

  /** Run one engine command. */
  async execute(command: string, params: Record<string, unknown> = {}): Promise<any> {
    const frame = await this.send("engine.execute", { command, params });
    if (!frame.ok) throw new EngineError(frame.error ?? `engine command ${command} failed`);
    return frame.result;
  }

  /** Render the active document to a PNG under the write root. */
  async render(path: string): Promise<{ path: string; bytes: number }> {
    const frame = await this.send("doc.render", { path });
    if (!frame.ok) throw new EngineError(frame.error ?? `render ${path} failed`);
    return frame.result as { path: string; bytes: number };
  }

  /** Open a native document from the read root. */
  async open(path: string): Promise<{ index: number; layers: number }> {
    const frame = await this.send("doc.open", { path });
    if (!frame.ok) throw new EngineError(frame.error ?? `open ${path} failed`);
    return frame.result as { index: number; layers: number };
  }

  /** Save the active document as a native `.pcraft` file. */
  async save(path: string): Promise<{ path: string; warnings: string[] }> {
    const frame = await this.send("doc.save", { path });
    if (!frame.ok) throw new EngineError(frame.error ?? `save ${path} failed`);
    return frame.result as { path: string; warnings: string[] };
  }

  /** Inspect the active document: layers, adjustments, history. */
  async inspect(): Promise<any> {
    const frame = await this.send("doc.inspect", {});
    if (!frame.ok) throw new EngineError(frame.error ?? "inspect failed");
    return frame.result;
  }

  close(): void {
    this.closed = true;
    this.destroy();
  }

  /** Absolute local path for an engine path under the write root. */
  localPath(enginePath: string): string {
    return resolve(this.root, enginePath);
  }

  private requireAuth(): void {
    if (!this.authenticated) {
      throw new AuthError("not authenticated: call connect() first");
    }
    if (this.closed) throw new Error("client is closed");
  }

  private requireSocket(): Socket {
    if (!this.socket) throw new Error("not connected");
    return this.socket;
  }

  private send(method: string, params: Record<string, unknown>): Promise<Frame> {
    if (method !== "auth") this.requireAuth();
    const socket = this.requireSocket();

    const id = method === "auth" ? "auth" : String(this.nextId++);
    const frame = JSON.stringify({ id, method, params }) + "\n";

    return new Promise<Frame>((done, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new Error(`no reply to ${method} (id ${id})`));
      }, 30_000);
      this.pending.set(id, (reply) => {
        clearTimeout(timer);
        this.pending.delete(id);
        done(reply);
      });
      socket.write(frame);
    });
  }

  private onLine(line: string): void {
    let frame: Frame;
    try {
      frame = JSON.parse(line) as Frame;
    } catch {
      return;
    }
    const settle = this.pending.get(frame.id);
    if (settle) settle(frame);
  }

  private destroy(): void {
    this.reader?.close();
    this.reader = undefined;
    this.socket?.destroy();
    this.socket = undefined;
    this.authenticated = false;
  }
}

function hasAuthenticated(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { authenticated?: unknown }).authenticated === true
  );
}

// ---------------------------------------------------------------------------
// 2. The auditor contract
//
// The vision model is supplied by the caller. It receives the screenshot as
// base64 (that is what a multimodal model would consume) and returns a JSON
// value that the loop hard-validates before acting on it.
// ---------------------------------------------------------------------------

export interface AuditRequest {
  iteration: number;
  pngPath: string;
  pngBase64: string;
  values: Adjustment;
}

export interface Auditor {
  review(request: AuditRequest): Promise<unknown>;
}

export const AUDITOR_SCHEMA = z
  .object({
    status: z.enum(["ok", "adjust"]),
    diagnosis: z
      .object({
        skin_saturation: z.number().min(0).max(1),
        shadow_clipping: z.boolean(),
      })
      .strict(),
    correction: z
      .object({
        saturation_delta: z.number().min(-40).max(40),
        hue_delta: z.number().min(-30).max(30),
        lightness_delta: z.number().min(-30).max(30),
      })
      .strict()
      .optional(),
  })
  .strict();

export type AuditorReply = z.infer<typeof AUDITOR_SCHEMA>;

// ---------------------------------------------------------------------------
// 3. The oscillation detector
//
// A well-behaved auditor asks for smaller corrections as it converges. Two
// failure modes are worth stopping early:
//
//   stall      two consecutive |saturation_delta| below EPSILON
//   sign flip  the auditor reverses direction with a comparable magnitude
//              (within SIGN_FLIP_RATIO of the previous one)
//
// Both mean the loop is no longer making progress, so the document is saved
// as-is and the run is reported as oscillating.
// ---------------------------------------------------------------------------

export interface DetectorOptions {
  epsilon?: number;
  window?: number;
  signFlipRatio?: number;
}

export type OscillationVerdict =
  | { kind: "stall"; why: string }
  | { kind: "sign_flip"; why: string }
  | null;

export class OscillationDetector {
  private readonly epsilon: number;
  private readonly window: number;
  private readonly signFlipRatio: number;
  private readonly deltas: number[] = [];
  private readonly signs: number[] = [];

  constructor(options: DetectorOptions = {}) {
    this.epsilon = options.epsilon ?? 1.0;
    this.window = options.window ?? 3;
    this.signFlipRatio = options.signFlipRatio ?? 0.15;
  }

  observe(saturationDelta: number): OscillationVerdict {
    this.deltas.push(Math.abs(saturationDelta));
    this.signs.push(Math.sign(saturationDelta));
    while (this.deltas.length > this.window) {
      this.deltas.shift();
      this.signs.shift();
    }

    const n = this.deltas.length;
    if (n >= 2 && this.deltas[n - 2] < this.epsilon && this.deltas[n - 1] < this.epsilon) {
      return { kind: "stall", why: "auditor asked for sub-epsilon corrections twice" };
    }

    if (n >= 3) {
      const [a, b] = [this.deltas[n - 2], this.deltas[n - 1]];
      const [sa, sb] = [this.signs[n - 2], this.signs[n - 1]];
      const largest = Math.max(a, b);
      const comparable = largest > 0 && Math.min(a, b) / largest >= 1 - this.signFlipRatio;
      if (sa * sb < 0 && comparable) {
        return { kind: "sign_flip", why: "alternating sign with comparable magnitude" };
      }
    }

    return null;
  }
}

// ---------------------------------------------------------------------------
// 4. The correction loop
// ---------------------------------------------------------------------------

export interface DriftRunOptions {
  client: CraftLiveClient;
  auditor: Auditor;
  /** Engine-relative paths; the client's root maps them onto the local disk. */
  fixture: string;
  auditDir: string;
  finalPath: string;
  seed?: Adjustment;
  maxIterations?: number;
  epsilon?: number;
  window?: number;
  signFlipRatio?: number;
  log?: (line: string) => void;
}

export type DriftStatus = "ok" | "budget_exhausted" | "oscillating";

export interface DriftRunResult {
  status: DriftStatus;
  why: string;
  /** Auditor calls that consumed iteration budget (malformed replies included). */
  iterations: number;
  corrections: number;
  malformed: number;
  layerId: number | string;
  applied: Adjustment[];
  values: Adjustment;
  screenshots: string[];
  savedPath: string;
  saveWarnings: string[];
  inspection: any;
}

const ZERO: Adjustment = { hue: 0, saturation: 0, lightness: 0 };

function add(base: Adjustment, delta: Partial<Adjustment>): Adjustment {
  return {
    hue: base.hue + (delta.hue ?? 0),
    saturation: base.saturation + (delta.saturation ?? 0),
    lightness: base.lightness + (delta.lightness ?? 0),
  };
}

function correctionOf(reply: AuditorReply): Adjustment {
  const c = reply.correction;
  return {
    hue: c?.hue_delta ?? 0,
    saturation: c?.saturation_delta ?? 0,
    lightness: c?.lightness_delta ?? 0,
  };
}

/**
 * Drive the document toward the auditor's target on a single Hue/Saturation
 * layer and save the result.
 */
export async function runDriftCorrection(options: DriftRunOptions): Promise<DriftRunResult> {
  const { client, auditor, fixture, auditDir, finalPath } = options;
  const seed = options.seed ?? { hue: -3, saturation: -6, lightness: 0 };
  const maxIterations = options.maxIterations ?? 6;
  const log = options.log ?? (() => {});

  mkdirSync(client.localPath(auditDir), { recursive: true });
  mkdirSync(dirname(client.localPath(finalPath)), { recursive: true });

  await client.open(fixture);

  // One layer, created once. Its id is the single handle every iteration uses.
  const created = await client.execute("layer.newAdjustmentLayer.hueSaturation", {
    hue: 0,
    saturation: 0,
    lightness: 0,
  });
  const layerId: number | string = created.layer;
  log(`hue/saturation layer ${layerId}`);

  const detector = new OscillationDetector({
    epsilon: options.epsilon,
    window: options.window,
    signFlipRatio: options.signFlipRatio,
  });

  const applied: Adjustment[] = [];
  const screenshots: string[] = [];
  let values: Adjustment = { ...ZERO };
  let iterations = 0;
  let corrections = 0;
  let malformed = 0;
  let status: DriftStatus | undefined;
  let why = "";
  let pending: Partial<Adjustment> | null = { ...seed };

  while (iterations < maxIterations) {
    if (pending) {
      values = add(values, pending);
      pending = null;
      await client.execute("layer.setAdjustment", { layer: layerId, ...values });
      applied.push({ ...values });
      log(`applied hue=${values.hue} saturation=${values.saturation} lightness=${values.lightness}`);
    }

    const pngPath = `${auditDir}/step_${iterations}.png`;
    const rendered = await client.render(pngPath);
    screenshots.push(pngPath);

    const pngBase64 = readFileSync(client.localPath(pngPath)).toString("base64");
    const raw = await auditor.review({
      iteration: iterations,
      pngPath,
      pngBase64,
      values: { ...values },
    });
    iterations += 1;

    const parsed = AUDITOR_SCHEMA.safeParse(raw);
    if (!parsed.success) {
      // A malformed reply costs one unit of budget but must leave the
      // document byte-identical: no setAdjustment, no new layer.
      malformed += 1;
      log(`iteration ${iterations - 1}: malformed auditor reply (${parsed.error.issues[0]?.message})`);
      continue;
    }

    const reply = parsed.data;
    if (reply.status === "ok") {
      status = "ok";
      why = "auditor reported the skin tones are correct";
      break;
    }

    const delta = correctionOf(reply);
    const verdict = detector.observe(delta.saturation);
    if (verdict) {
      status = "oscillating";
      why = verdict.why;
      log(`iteration ${iterations - 1}: ${verdict.kind} — ${verdict.why}`);
      break;
    }

    pending = {
      hue: delta.hue,
      saturation: delta.saturation,
      lightness: delta.lightness,
    };
    corrections += 1;
    log(`iteration ${iterations - 1}: corrected by ${JSON.stringify(delta)} (${rendered.bytes} bytes)`);
  }

  if (!status) {
    status = "budget_exhausted";
    why = `no convergence within ${maxIterations} iterations`;
  }

  const saved = await client.save(finalPath);
  const inspection = await client.inspect();

  return {
    status,
    why,
    iterations,
    corrections,
    malformed,
    layerId,
    applied,
    values,
    screenshots,
    savedPath: saved.path,
    saveWarnings: saved.warnings,
    inspection,
  };
}

/** Count Hue/Saturation adjustment layers in a `doc.inspect` result. */
export function hueSaturationLayers(inspection: any): any[] {
  const layers: any[] = inspection?.layers ?? [];
  return layers.filter((layer) => layer?.adjustment?.HueSaturation);
}

/** Adjustment values of a layer id, as the engine reports them. */
export function adjustmentOf(inspection: any, layerId: number | string): Adjustment | null {
  const layers: any[] = inspection?.layers ?? [];
  const layer = layers.find((l) => String(l.id) === String(layerId));
  const hs = layer?.adjustment?.HueSaturation;
  if (!hs) return null;
  return { hue: hs.hue, saturation: hs.saturation, lightness: hs.lightness };
}

// ---------------------------------------------------------------------------
// 5. Wire transcript — the literal frames this client emits
//
// One line per frame, `\n`-terminated. `id` is the client's counter; the auth
// frame always goes first and the client refuses to send anything else until
// the reply carries `result.authenticated === true`.
//
//   -> {"id":"auth","method":"auth","params":{"token":"<64 hex chars>"}}
//   <- {"id":"auth","ok":true,"result":{"authenticated":true}}
//
//   -> {"id":"1","method":"doc.open","params":{"path":"output/fixtures/product-42.pcraft"}}
//
//   -> {"id":"2","method":"engine.execute","params":{"command":"layer.newAdjustmentLayer.hueSaturation","params":{"hue":0,"saturation":0,"lightness":0}}}
//   <- {"id":"2","ok":true,"result":{"layer":3}}
//
// Iteration 0 first applies the seed (-3 / -6), then renders and audits:
//
//   -> {"id":"3","method":"engine.execute","params":{"command":"layer.setAdjustment","params":{"layer":3,"hue":-3,"saturation":-6,"lightness":0}}}
//   -> {"id":"4","method":"doc.render","params":{"path":"output/converge/audit/step_0.png"}}
//   <- {"id":"4","ok":true,"result":{"path":"output/converge/audit/step_0.png","bytes":1366}}
//
// A well-formed auditor reply of {status:"adjust", correction:{saturation_delta:20}}
// makes iteration 1 cumulative on the same layer:
//
//   -> {"id":"5","method":"engine.execute","params":{"command":"layer.setAdjustment","params":{"layer":3,"hue":-3,"saturation":14,"lightness":0}}}
//   -> {"id":"6","method":"doc.render","params":{"path":"output/converge/audit/step_1.png"}}
//
// A malformed reply costs one iteration and emits nothing: the next frame is
// the following `doc.render`, never a `layer.setAdjustment`.
//
// Any terminal condition saves and inspects once:
//
//   -> {"id":"N","method":"doc.save","params":{"path":"output/converge/product-42.pcraft"}}
//   -> {"id":"N+1","method":"doc.inspect","params":{}}
//
// Per-iteration ids: correction k (0-based) is id 2k+3 and its render is
// id 2k+4, so a three-iteration run ends at id 8 before the save/inspect pair.
// ---------------------------------------------------------------------------
