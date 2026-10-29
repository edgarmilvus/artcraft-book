// lightcraft-grading.ts
// ---------------------------------------------------------------------------
// Reference-anchored grading loop for LightCraft.
//
// The measured part is local: proxies and the reference are decoded, converted
// to CIELAB, and compared with CIEDE2000 per luminance zone. The vision model
// only says which way each zone should move; the translation layer turns that
// into LightCraft develop controls. A per-photo history of (control value, ΔE)
// points fits a quadratic, and the loop stops when the vertex says the current
// setting is already the minimum — or when the model starts oscillating.
//
// Transport: either MCP over stdio or the line-delimited TCP control channel.
// The TCP channel authenticates first and refuses to run before the auth reply.
// ---------------------------------------------------------------------------

import { createServer, Socket, type Server } from "node:net";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { OpenAI } from "openai";
import { PNG } from "pngjs";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------

export interface ZoneDelta {
  direction: "increase" | "decrease" | "hold";
  magnitude: "subtle" | "moderate" | "strong";
  rationale: string;
  confidence: number;
}

export interface VisionZoneCritique {
  zone_deltas: {
    shadows: ZoneDelta;
    midtones: ZoneDelta;
    highlights: ZoneDelta;
  };
  global_confidence: number;
  anomaly?: string;
}

export interface PhotoState {
  photoId: number;
  referencePng: string;
  iterations: {
    index: number;
    settingsBlob: Record<string, unknown>;
    renderedProxy: string;
    zoneDeltaE: { shadows: number; midtones: number; highlights: number };
    appliedDeltas: Record<string, number>;
    critique: VisionZoneCritique;
    converged: boolean;
    rolledBack: boolean;
  }[];
  lastGoodBlob: Record<string, unknown> | null;
}

export interface QuadraticFit {
  vertex: number;
  isMinimum: boolean;
  rss: number;
  trusted: boolean;
}

export type FitQuadratic = (points: { x: number; y: number }[]) => QuadraticFit;

export interface LightcraftAuthFrame {
  id: "auth";
  method: "auth";
  params: { token: string };
}

export interface LightcraftDevelopFrame {
  id: number;
  method: "engine.execute";
  params: { command: string; params: Record<string, unknown> };
}

export interface GradeReport {
  photoId: number;
  initialDeltaE: { shadows: number; midtones: number; highlights: number };
  finalDeltaE: { shadows: number; midtones: number; highlights: number };
  iterationsUsed: number;
  converged: boolean;
  escalated: boolean;
  rolledBack: boolean;
  appliedDeltas: [string, number][];
  reason: string;
}

export interface GradeConfig {
  maxIterations: number;
  zoneThresholds: { shadows: number; midtones: number; highlights: number };
  lowConfidence: number;
  convergenceHold: number;
  maxSide: number;
}

export const DEFAULT_CONFIG: GradeConfig = {
  maxIterations: 6,
  zoneThresholds: { shadows: 0.35, midtones: 0.3, highlights: 0.4 },
  lowConfidence: 0.65,
  convergenceHold: 2,
  maxSide: 512,
};

// ---------------------------------------------------------------------------
// Colour: sRGB → Lab, CIEDE2000
// ---------------------------------------------------------------------------

type Rgb = [number, number, number];
type Lab = [number, number, number];

function srgbToLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function rgbToLab([r, g, b]: Rgb): Lab {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  const x = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  const y = R * 0.2126729 + G * 0.7151522 + B * 0.072175;
  const z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function deltaE2000(a: Lab, b: Lab): number {
  const [L1, a1, b1] = a;
  const [L2, a2, b2] = b;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cbar, 7) / (Math.pow(Cbar, 7) + Math.pow(25, 7))));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h1p = (Math.atan2(b1, a1p) * 180 / Math.PI + 360) % 360;
  const h2p = (Math.atan2(b2, a2p) * 180 / Math.PI + 360) % 360;
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI / 180) / 2);
  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  const hbarp = C1p * C2p === 0
    ? h1p + h2p
    : Math.abs(h1p - h2p) > 180 ? (h1p + h2p + 360) / 2 : (h1p + h2p) / 2;
  const T = 1
    - 0.17 * Math.cos((hbarp - 30) * Math.PI / 180)
    + 0.24 * Math.cos((2 * hbarp) * Math.PI / 180)
    + 0.32 * Math.cos((3 * hbarp + 6) * Math.PI / 180)
    - 0.20 * Math.cos((4 * hbarp - 63) * Math.PI / 180);
  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const Rc = 2 * Math.sqrt(Math.pow(Cbarp, 7) / (Math.pow(Cbarp, 7) + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(Lbarp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(2 * dTheta * Math.PI / 180) * Rc;
  return Math.sqrt(
    Math.pow(dLp / Sl, 2) +
    Math.pow(dCp / Sc, 2) +
    Math.pow(dHp / Sh, 2) +
    Rt * (dCp / Sc) * (dHp / Sh),
  );
}

export interface ZoneDeltaE {
  shadows: number;
  midtones: number;
  highlights: number;
}

function decode(base64: string): PNG {
  return PNG.sync.read(Buffer.from(base64, "base64"));
}

function sample(png: PNG, x: number, y: number): Rgb {
  const px = Math.min(png.width - 1, Math.max(0, Math.round(x)));
  const py = Math.min(png.height - 1, Math.max(0, Math.round(y)));
  const i = (py * png.width + px) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
}

/**
 * Mean ΔE 2000 per luminance zone. Zones come from the reference's L* (the
 * target look), which keeps the same pixels in the same zone across the loop.
 */
export function perZoneDeltaE(proxyB64: string, referenceB64: string): ZoneDeltaE {
  const proxy = decode(proxyB64);
  const reference = decode(referenceB64);
  const width = Math.min(proxy.width, reference.width);
  const height = Math.min(proxy.height, reference.height);
  const sums = { shadows: 0, midtones: 0, highlights: 0, all: 0 };
  const counts = { shadows: 0, midtones: 0, highlights: 0, all: 0 };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = x / width * proxy.width;
      const sy = y / height * proxy.height;
      const candidate = rgbToLab(sample(proxy, sx, sy));
      const target = rgbToLab(sample(reference, x, y));
      const d = deltaE2000(candidate, target);
      const zone = target[0] < 25 ? "shadows" : target[0] < 75 ? "midtones" : "highlights";
      sums[zone] += d;
      counts[zone]++;
      sums.all += d;
      counts.all++;
    }
  }

  const mean = (zone: "shadows" | "midtones" | "highlights"): number => {
    // A zone with almost no pixels would otherwise dominate with a 0.
    const selected = counts[zone] >= 50 ? sums[zone] / counts[zone] : sums.all / Math.max(1, counts.all);
    return Math.round(selected * 1000) / 1000;
  };

  return { shadows: mean("shadows"), midtones: mean("midtones"), highlights: mean("highlights") };
}

// ---------------------------------------------------------------------------
// Quadratic fit
// ---------------------------------------------------------------------------

/** Least-squares parabola through the points; vertex and residual reported. */
export const fitQuadratic: FitQuadratic = (points) => {
  // Three points interpolate exactly; a fourth is the first point that can
  // contradict the parabola, so trust starts there.
  if (points.length < 4) {
    return { vertex: 0, isMinimum: false, rss: Number.POSITIVE_INFINITY, trusted: false };
  }
  // Up to the last five probes: with exactly three points the parabola is
  // interpolated and the residual would always be zero, which proves nothing.
  const use = points.slice(-5);
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
  let t0 = 0, t1 = 0, t2 = 0;
  for (const { x, y } of use) {
    const x2 = x * x;
    s0 += 1;
    s1 += x;
    s2 += x2;
    s3 += x2 * x;
    s4 += x2 * x2;
    t0 += y;
    t1 += x * y;
    t2 += x2 * y;
  }
  // Solve the normal equations for c + b x + a x².
  const matrix = [
    [s0, s1, s2, t0],
    [s1, s2, s3, t1],
    [s2, s3, s4, t2],
  ];
  for (let i = 0; i < 3; i++) {
    let pivot = i;
    for (let j = i + 1; j < 3; j++) {
      if (Math.abs(matrix[j][i]) > Math.abs(matrix[pivot][i])) pivot = j;
    }
    if (Math.abs(matrix[pivot][i]) < 1e-12) {
      return { vertex: 0, isMinimum: false, rss: Number.POSITIVE_INFINITY, trusted: false };
    }
    [matrix[i], matrix[pivot]] = [matrix[pivot], matrix[i]];
    for (let j = i + 1; j < 3; j++) {
      const factor = matrix[j][i] / matrix[i][i];
      for (let k = i; k < 4; k++) matrix[j][k] -= factor * matrix[i][k];
    }
  }
  const c = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let sum = matrix[i][3];
    for (let j = i + 1; j < 3; j++) sum -= matrix[i][j] * c[j];
    c[i] = sum / matrix[i][i];
  }
  const [, b, a] = c;

  let rss = 0;
  for (const { x, y } of use) {
    const predicted = c[0] + b * x + a * x * x;
    rss += (y - predicted) * (y - predicted);
  }
  const isMinimum = a > 1e-9;
  const vertex = Math.abs(a) > 1e-9 ? -b / (2 * a) : 0;
  const trusted = isMinimum && Number.isFinite(vertex) && rss < 0.05 * use.length;
  return {
    vertex: Math.round(vertex * 1000) / 1000,
    isMinimum,
    rss: Math.round(rss * 1e6) / 1e6,
    trusted,
  };
};

// ---------------------------------------------------------------------------
// Vision
// ---------------------------------------------------------------------------

const ZoneDeltaSchema = z.object({
  direction: z.enum(["increase", "decrease", "hold"]),
  magnitude: z.enum(["subtle", "moderate", "strong"]),
  rationale: z.string().max(300),
  confidence: z.number().min(0).max(1),
});

export const VisionCritiqueSchema = z.object({
  zone_deltas: z.object({
    shadows: ZoneDeltaSchema,
    midtones: ZoneDeltaSchema,
    highlights: ZoneDeltaSchema,
  }),
  global_confidence: z.number().min(0).max(1),
  anomaly: z.string().max(300).optional(),
});

export type CritiqueFn = (input: { proxyPng: string; referencePng: string }) => Promise<VisionZoneCritique>;

const SYSTEM_PROMPT = `You are a colourist's assistant comparing a rendered proxy with a reference grade.
Return JSON with zone_deltas for shadows, midtones and highlights. Each is
{direction: "increase"|"decrease"|"hold", magnitude: "subtle"|"moderate"|"strong",
rationale, confidence}. Direction means: increase or decrease the strength of
the look in that zone, not a numeric slider. Also return global_confidence 0..1
and an optional anomaly note. Never estimate ΔE: it is measured elsewhere.`;

export function createOpenAiCritique(model = process.env.OPENAI_VISION_MODEL ?? "gpt-4.1-mini"): CritiqueFn {
  let client: OpenAI | undefined;
  return async ({ proxyPng, referencePng }) => {
    client ??= new OpenAI();
    const completion = await client.chat.completions.create({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: "Proxy first, reference second." },
            { type: "image_url", image_url: { url: `data:image/png;base64,${proxyPng}`, detail: "high" } },
            { type: "image_url", image_url: { url: `data:image/png;base64,${referencePng}`, detail: "high" } },
          ],
        },
      ],
    });
    const parsed = VisionCritiqueSchema.safeParse(JSON.parse(completion.choices[0]?.message?.content ?? "{}"));
    if (!parsed.success) throw new Error(`critique failed validation: ${parsed.error.message}`);
    return parsed.data;
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface DevelopChannel {
  execute(command: string, params?: Record<string, unknown>): Promise<unknown>;
  render(photoId: number, maxSide: number): Promise<string>;
  close(): Promise<void>;
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string; data?: string }[];
}

export class LightcraftSession implements DevelopChannel {
  private readonly client = new Client({ name: "lightcraft-grading", version: "0.1.0" }, { capabilities: {} });

  async connect(): Promise<void> {
    await this.client.connect(new StdioClientTransport({ command: "lightcraft-cli", args: ["mcp"] }));
  }

  private async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const res = (await this.client.callTool({ name, arguments: args })) as ToolResult;
    if (res.isError) {
      const block = res.content.find((b) => b.type === "text");
      throw new Error(`${name}: ${block?.text ?? "unknown error"}`);
    }
    return res;
  }

  async import(paths: string[]): Promise<{ imported: number[] }> {
    const res = await this.call("import", { paths });
    const text = res.content.find((b) => b.type === "text")?.text ?? "{}";
    return JSON.parse(text);
  }

  async photos(): Promise<{ id: number; fileName: string }[]> {
    const res = await this.call("query_photos", {});
    const text = res.content.find((b) => b.type === "text")?.text ?? "{}";
    return JSON.parse(text).photos ?? [];
  }

  async select(id: number): Promise<void> {
    await this.call("select_photos", { ids: [id], active: id });
  }

  async controls(): Promise<{ id: string; min: number; max: number; step: number; value: number }[]> {
    const res = await this.call("command_run", { id: "develop.controls", params: {} });
    return JSON.parse(res.content.find((b) => b.type === "text")?.text ?? "[]");
  }

  async execute(command: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const res = await this.call("command_run", { id: command, params });
    const text = res.content.find((b) => b.type === "text")?.text;
    return text ? tryJson(text) : null;
  }

  async render(photoId: number, maxSide: number): Promise<string> {
    const res = await this.call("render_preview", { id: photoId, max_side: maxSide, format: "png" });
    const image = res.content.find((b) => b.type === "image");
    if (!image || typeof image.data !== "string") throw new Error("render_preview returned no image");
    return image.data;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * TCP control channel. The first frame must be the auth frame; the server
 * answers with `{ok:true}`. Every later frame is `engine.execute` and is
 * matched to its `id`.
 */
export class LightcraftTcp implements DevelopChannel {
  private socket: Socket | null = null;
  private buffer = "";
  private nextId = 1;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private authWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly token: string,
  ) {}

  connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const socket = new Socket();
      this.socket = socket;
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        const frame: LightcraftAuthFrame = { id: "auth", method: "auth", params: { token: this.token } };
        socket.write(JSON.stringify(frame) + "\n");
      });
      socket.on("data", (chunk: string) => this.onData(chunk));
      socket.connect(this.port, this.host);
      socket.on("error", (error: Error) => {
        reject(error);
        for (const waiter of this.pending.values()) waiter.reject(error);
        this.pending.clear();
      });
      this.authWaiter = {
        resolve,
        reject: (error) => reject(error),
      };
    });
    return this.ready;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id === "auth") {
        if (message.ok) this.authWaiter?.resolve();
        else this.authWaiter?.reject(new Error(`TCP auth refused: ${message.error ?? "unknown"}`));
        continue;
      }
      const waiter = this.pending.get(Number(message.id));
      if (waiter) {
        this.pending.delete(Number(message.id));
        if (message.error) waiter.reject(new Error(String(message.error)));
        else waiter.resolve(message.result);
      }
    }
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.socket) return Promise.reject(new Error("TCP channel is not connected"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const frame: LightcraftDevelopFrame = { id, method: "engine.execute", params: { command: method, params } };
      this.socket!.write(JSON.stringify(frame) + "\n");
    });
  }

  async execute(command: string, params: Record<string, unknown> = {}): Promise<unknown> {
    await this.connect();
    return this.request(command, params);
  }

  async render(photoId: number, maxSide: number): Promise<string> {
    await this.connect();
    return (await this.request("engine.render", { id: photoId, max_side: maxSide, format: "png" })) as string;
  }

  async close(): Promise<void> {
    this.socket?.end();
    this.socket = null;
  }
}

/**
 * Minimal control server used by the harness (and by any offline client) to
 * exercise the auth handshake and the frame contract.
 */
export function startStubControlServer(options: {
  token: string;
  execute: (command: string, params: Record<string, unknown>) => Promise<unknown>;
  render: (photoId: number, maxSide: number) => Promise<string>;
  reject?: boolean;
}): Promise<{ server: Server; port: number; authFrames: number }> {
  return new Promise((resolve, reject) => {
    const state = { authFrames: 0 };
    const server = createServer((socket) => {
      let buffer = "";
      let authorised = false;
      socket.setEncoding("utf8");
      socket.on("data", async (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let frame: any;
          try {
            frame = JSON.parse(line);
          } catch {
            continue;
          }
          if (frame.method === "auth") {
            state.authFrames++;
            authorised = !options.reject && frame.params?.token === options.token;
            socket.write(JSON.stringify({ id: "auth", ok: authorised, error: authorised ? undefined : "bad token" }) + "\n");
            continue;
          }
          if (!authorised) {
            socket.write(JSON.stringify({ id: frame.id, error: "unauthorised" }) + "\n");
            continue;
          }
          try {
            const result = frame.params.command === "engine.render"
              ? await options.render(Number(frame.params.params?.id ?? 1), Number(frame.params.params?.max_side ?? 512))
              : await options.execute(frame.params.command, frame.params.params ?? {});
            socket.write(JSON.stringify({ id: frame.id, result }) + "\n");
          } catch (error) {
            socket.write(JSON.stringify({ id: frame.id, error: String(error) }) + "\n");
          }
        }
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("stub server has no port"));
        return;
      }
      resolve({ server, port: address.port, get authFrames() { return state.authFrames; } } as any);
    });
  });
}

// ---------------------------------------------------------------------------
// Translation: critique → absolute develop values
// ---------------------------------------------------------------------------

const MAGNITUDE: Record<ZoneDelta["magnitude"], number> = { subtle: 0.3, moderate: 0.7, strong: 1.5 };

export interface ControlPlanEntry {
  zone: "shadows" | "midtones" | "highlights";
  control: string;
  scale: number;
}

/** Real LightCraft control ids; the book's colour.temperature is wb.temp. */
export const CONTROL_PLAN: ControlPlanEntry[] = [
  { zone: "shadows", control: "light.shadows", scale: 8 },
  { zone: "midtones", control: "light.exposure", scale: 0.12 },
  { zone: "highlights", control: "light.highlights", scale: 8 },
  { zone: "midtones", control: "mixer.orange.sat", scale: 4 },
  { zone: "shadows", control: "grading.shadows.hue", scale: 3 },
  { zone: "highlights", control: "grading.highlights.hue", scale: 3 },
];

function sign(direction: ZoneDelta["direction"]): number {
  return direction === "increase" ? 1 : direction === "decrease" ? -1 : 0;
}

export function critiqueToDeltas(
  critique: VisionZoneCritique,
  controls: { id: string; min: number; max: number; step: number }[],
  current: Record<string, number>,
): { settings: Record<string, number>; deltas: [string, number][] } {
  const settings: Record<string, number> = {};
  const deltas: [string, number][] = [];

  for (const entry of CONTROL_PLAN) {
    const zone = critique.zone_deltas[entry.zone];
    const direction = sign(zone.direction);
    if (!direction) continue;
    const delta = direction * MAGNITUDE[zone.magnitude] * entry.scale;
    if (Math.abs(delta) < 1e-6) continue;

    const control = controls.find((c) => c.id === entry.control);
    const min = control?.min ?? 0;
    const max = control?.max ?? 100;
    const step = control?.step ?? 0.01;
    const base = current[entry.control] ?? 0;

    let next = base + delta;
    if (entry.control.endsWith(".hue")) next = ((next % 360) + 360) % 360;
    next = Math.max(min, Math.min(max, next));
    next = Math.round(next / step) * step;
    next = Number(next.toFixed(4));

    settings[entry.control] = next;
    deltas.push([entry.control, Number((next - base).toFixed(4))]);
  }

  return { settings, deltas };
}

function flatSettings(develop: Record<string, any>): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (node: any, prefix: string) => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      if (typeof node === "number") out[prefix] = node;
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      walk(value, prefix ? `${prefix}.${key}` : key);
    }
  };
  walk(develop, "");
  return out;
}

// ---------------------------------------------------------------------------
// Convergence
// ---------------------------------------------------------------------------

export interface ConvergenceInput {
  history: { zoneDeltaE: ZoneDeltaE; appliedDeltas: Record<string, number> }[];
  critique: VisionZoneCritique;
  fit: { control: string; vertex: number; current: number; step: number; trusted: boolean }[];
  thresholds: GradeConfig["zoneThresholds"];
}

export interface ConvergenceResult {
  converged: boolean;
  reason: string;
}

export function shouldConverge(input: ConvergenceInput): ConvergenceResult {
  const { history, thresholds } = input;

  // The quadratic vertex says the current slider value is the minimum.
  for (const entry of input.fit) {
    if (entry.trusted && Math.abs(entry.vertex - entry.current) <= entry.step) {
      return { converged: true, reason: `quadratic vertex at ${entry.vertex} for ${entry.control}` };
    }
  }

  if (history.length < 2) return { converged: false, reason: "not enough history" };

  const [previous, last] = history.slice(-2);
  const deltas = {
    shadows: Math.abs(previous.zoneDeltaE.shadows - last.zoneDeltaE.shadows),
    midtones: Math.abs(previous.zoneDeltaE.midtones - last.zoneDeltaE.midtones),
    highlights: Math.abs(previous.zoneDeltaE.highlights - last.zoneDeltaE.highlights),
  };
  const flat = deltas.shadows < thresholds.shadows
    && deltas.midtones < thresholds.midtones
    && deltas.highlights < thresholds.highlights;

  // Oscillation: the model now points against at least two of the last three
  // applied directions, so chasing it further would just swing back.
  const currentDirections = {
    shadows: sign(input.critique.zone_deltas.shadows.direction),
    midtones: sign(input.critique.zone_deltas.midtones.direction),
    highlights: sign(input.critique.zone_deltas.highlights.direction),
  };
  const controlZones: Record<string, keyof typeof currentDirections> = {
    "light.shadows": "shadows",
    "light.exposure": "midtones",
    "light.highlights": "highlights",
    "mixer.orange.sat": "midtones",
    "grading.shadows.hue": "shadows",
    "grading.highlights.hue": "highlights",
  };
  let opposed = 0;
  for (const iteration of history.slice(-3)) {
    for (const [control, delta] of Object.entries(iteration.appliedDeltas)) {
      const zone = controlZones[control];
      if (!zone || !delta) continue;
      if (Math.sign(delta) !== 0 && Math.sign(delta) === -currentDirections[zone] && currentDirections[zone] !== 0) {
        opposed++;
      }
    }
  }

  if (flat && opposed >= 2) {
    return { converged: true, reason: "ΔE is flat for two iterations and the critique is reversing" };
  }
  if (flat) return { converged: true, reason: "ΔE is flat for two iterations" };
  return { converged: false, reason: "still moving" };
}

// ---------------------------------------------------------------------------
// Per-photo loop
// ---------------------------------------------------------------------------

export interface GradeDeps {
  critique: CritiqueFn;
  now?: () => number;
}

export async function gradePhoto(
  channel: DevelopChannel,
  photoId: number,
  referencePng: string,
  config: GradeConfig,
  deps: GradeDeps,
): Promise<{ report: GradeReport; state: PhotoState }> {
  const state: PhotoState = {
    photoId,
    referencePng,
    iterations: [],
    lastGoodBlob: null,
  };
  const controls = await channel.execute("develop.controls").then((v) => v as any[]) ?? [];
  const history: { zoneDeltaE: ZoneDeltaE; appliedDeltas: Record<string, number> }[] = [];
  const appliedDeltas: [string, number][] = [];
  const fits: { control: string; points: { x: number; y: number }[] }[] = [];
  let initial: ZoneDeltaE | null = null;
  let final: ZoneDeltaE | null = null;
  let lowStreak = 0;
  let reason = "iteration budget exhausted";

  for (let index = 0; index < config.maxIterations; index++) {
    const blob = (await channel.execute("develop.get")) as Record<string, unknown>;
    const proxy = await channel.render(photoId, config.maxSide);
    const zoneDeltaE = perZoneDeltaE(proxy, referencePng);
    initial ??= zoneDeltaE;
    final = zoneDeltaE;

    const critique = await deps.critique({ proxyPng: proxy, referencePng });
    state.lastGoodBlob ??= blob;

    if (critique.global_confidence < config.lowConfidence) {
      lowStreak++;
      if (lowStreak >= 2) {
        // Settings are non-destructive: the fallback is the last good blob.
        if (state.lastGoodBlob) {
          await channel.execute("develop.merge", { settings: state.lastGoodBlob, label: "rollback" });
        }
        // The merge above restored the blob, so the deltas applied since the
        // last good state are no longer in the document: clear the ledger too.
        appliedDeltas.length = 0;
        state.iterations.push({
          index,
          settingsBlob: blob,
          renderedProxy: proxy,
          zoneDeltaE,
          appliedDeltas: {},
          critique,
          converged: false,
          rolledBack: true,
        });
        return {
          report: {
            photoId,
            initialDeltaE: initial,
            finalDeltaE: final,
            iterationsUsed: index + 1,
            converged: false,
            escalated: true,
            rolledBack: true,
            appliedDeltas,
            reason: `vision confidence below ${config.lowConfidence} twice`,
          },
          state,
        };
      }
    } else {
      lowStreak = 0;
    }

    const current = flatSettings(blob);
    const fitEntries = fits.map((fit) => {
      const result = fitQuadratic(fit.points);
      const control = controls.find((c: any) => c.id === fit.control);
      return {
        control: fit.control,
        vertex: result.vertex,
        current: current[fit.control] ?? 0,
        step: control?.step ?? 0.01,
        trusted: result.trusted,
      };
    });

    history.push({ zoneDeltaE, appliedDeltas: {} });
    const convergence = shouldConverge({
      history: history.slice(0, -1).concat({ zoneDeltaE, appliedDeltas: {} }),
      critique,
      fit: fitEntries,
      thresholds: config.zoneThresholds,
    });

    state.iterations.push({
      index,
      settingsBlob: blob,
      renderedProxy: proxy,
      zoneDeltaE,
      appliedDeltas: {},
      critique,
      converged: convergence.converged,
      rolledBack: false,
    });

    if (convergence.converged) {
      reason = convergence.reason;
      return {
        report: {
          photoId,
          initialDeltaE: initial,
          finalDeltaE: final,
          iterationsUsed: index + 1,
          converged: true,
          escalated: false,
          rolledBack: false,
          appliedDeltas,
          reason,
        },
        state,
      };
    }

    const { settings, deltas } = critiqueToDeltas(critique, controls, current);
    if (!deltas.length) {
      reason = "critique asked for no change";
      return {
        report: {
          photoId,
          initialDeltaE: initial,
          finalDeltaE: final,
          iterationsUsed: index + 1,
          converged: false,
          escalated: true,
          rolledBack: false,
          appliedDeltas,
          reason,
        },
        state,
      };
    }

    await channel.execute("develop.beginInteraction", { label: `vision delta ${index + 1}` });
    try {
      await channel.execute("develop.set", { values: settings });
      await channel.execute("develop.endInteraction");
    } catch (error) {
      await channel.execute("develop.cancelInteraction");
      throw error;
    }

    const applied: Record<string, number> = {};
    for (const [control, delta] of deltas) {
      applied[control] = delta;
      appliedDeltas.push([control, delta]);
      const points = fits.find((f) => f.control === control)?.points ?? [];
      points.push({ x: settings[control], y: zoneDeltaE.shadows + zoneDeltaE.midtones + zoneDeltaE.highlights });
      if (!fits.find((f) => f.control === control)) fits.push({ control, points });
    }
    history[history.length - 1].appliedDeltas = applied;
    state.iterations[state.iterations.length - 1].appliedDeltas = applied;
    state.lastGoodBlob = blob;
  }

  return {
    report: {
      photoId,
      initialDeltaE: initial ?? { shadows: 0, midtones: 0, highlights: 0 },
      finalDeltaE: final ?? { shadows: 0, midtones: 0, highlights: 0 },
      iterationsUsed: config.maxIterations,
      converged: false,
      escalated: true,
      rolledBack: false,
      appliedDeltas,
      reason,
    },
    state,
  };
}

// ---------------------------------------------------------------------------
// Batch runner
// ---------------------------------------------------------------------------

export interface BatchJob {
  photos: { id: number; referencePng: string }[];
  config: GradeConfig;
  budgetMs: number;
}

export interface BatchResult {
  report: Record<string, GradeReport>;
  resumeFrom: number | null;
  elapsedMs: number;
}

export async function runBatch(
  channel: DevelopChannel,
  job: BatchJob,
  deps: GradeDeps & { persist?: (state: PhotoState[]) => Promise<void> },
): Promise<BatchResult> {
  const started = (deps.now ?? Date.now)();
  const report: Record<string, GradeReport> = {};
  const states: PhotoState[] = [];
  let resumeFrom: number | null = null;

  for (let index = 0; index < job.photos.length; index++) {
    const photo = job.photos[index];
    if ((deps.now ?? Date.now)() - started > job.budgetMs) {
      resumeFrom = index;
      break;
    }
    const { report: photoReport, state } = await gradePhoto(
      channel,
      photo.id,
      photo.referencePng,
      job.config,
      deps,
    );
    report[String(photo.id)] = photoReport;
    states.push(state);
  }

  if (resumeFrom !== null && deps.persist) await deps.persist(states);
  return { report, resumeFrom, elapsedMs: (deps.now ?? Date.now)() - started };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [rawDir, referencePath, outPath] = process.argv.slice(2);
  if (!rawDir || !referencePath || !outPath) {
    console.error("usage: tsx 02_lightcraft-grading.ts <raw-dir> <reference.png> <grading_report.json>");
    process.exit(1);
  }
  const { readFile, writeFile } = await import("node:fs/promises");
  const session = new LightcraftSession();
  await session.connect();
  try {
    const referencePng = (await readFile(referencePath)).toString("base64");
    const imported = await session.import([rawDir]);
    const photos = (await session.photos()).map((p) => ({ id: p.id, referencePng }));
    if (!photos.length) throw new Error("no photos imported");
    await session.select(photos[0].id);
    const { report } = await runBatch(session, {
      photos,
      config: DEFAULT_CONFIG,
      budgetMs: 45 * 60 * 1000,
    }, { critique: createOpenAiCritique(), now: Date.now });
    await writeFile(outPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ photos: Object.keys(report).length, outPath }, null, 2));
  } finally {
    await session.close();
  }
}


if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}


