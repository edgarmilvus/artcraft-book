// Language: typescript
// recover.ts — bounded MCP-driven Lottie rehydration
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Ajv, type JSONSchemaType } from "ajv";

const pexec = promisify(execFile);

// ---------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------
export const MAX_MCP_CALLS = 12;
export const MAX_AFFECTED_ASSETS = 3;

export class RecoveryBudgetExceeded extends Error { constructor() { super("RecoveryBudgetExceeded"); } }
export class HumanRequired extends Error { constructor(msg: string) { super(msg); } }
export class VisionMismatchAfterRetries extends Error { constructor() { super("VisionMismatchAfterRetries"); } }

export interface LottieAsset { id: string; u: string; p: string; w?: number; h?: number; e?: 0 | 1 }
export interface LottieJson { v: string; fr: number; ip: number; op: number; w: number; h: number; nm: string; ddd: 0 | 1; assets?: LottieAsset[]; layers: unknown[] }

export interface McpCall {
  readonly tool: "effectcraft" | "photocraft" | "tcp-photocraft";
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly reasoning: string;
}
export interface UnmappedAsset {
  readonly id: string;
  readonly originalPath: string;
  readonly suspectedFormat: "png" | "jpg" | "unknown";
  readonly reason: "missing" | "absolute-path" | "wrong-platform";
}
export interface RecoveryPlan {
  readonly assets: readonly UnmappedAsset[];
  readonly replacements: ReadonlyArray<{
    readonly assetId: string;
    readonly generatedFile: string;
    readonly sha256_16: string;
  }>;
  readonly budgetUsed: number;
  readonly aborted: false;
}

// ---------------------------------------------------------------------
// Transcript recorder
// ---------------------------------------------------------------------
export class Transcript {
  private lines: string[] = [];
  note(call: McpCall, response: unknown, index: number, max: number) {
    this.lines.push(`// Call ${index}/${max}: ${call.tool} ${call.method} ${JSON.stringify(call.params)}`);
    this.lines.push(`// Reasoning: ${call.reasoning}`);
    const clipped = JSON.stringify(response).slice(0, 400);
    this.lines.push(`// Response: ${clipped}${JSON.stringify(response).length > 400 ? " …" : ""}`);
    this.lines.push("");
  }
  async write(p: string) {
    // Trim to the exercise's 200-line budget; drop the oldest notes first.
    const out = this.lines.slice(-200).join("\n") + "\n";
    await fs.writeFile(p, out);
  }
}

// ---------------------------------------------------------------------
// MCP clients
// ---------------------------------------------------------------------
export interface Bucket { calls: number; transcript: Transcript }

async function effectCraft(): Promise<Client> {
  const c = new Client({ name: "recover-ec", version: "1.0.0" }, { capabilities: {} });
  await c.connect(new StdioClientTransport({
    command: "effectcraft-cli",
    args: ["mcp"],
  }));
  return c;
}
async function photoCraft(writeRoot: string): Promise<Client> {
  // PhotoCraft refuses to start when the write root does not exist.
  await fs.mkdir(writeRoot, { recursive: true });
  const c = new Client({ name: "recover-pc", version: "1.0.0" }, { capabilities: {} });
  await c.connect(new StdioClientTransport({
    command: "photocraft-cli",
    args: ["mcp", "--automation-write-root", writeRoot],
  }));
  return c;
}

// Guarded call wrapper — every MCP call in this script goes through it.
export async function guarded<T>(
  bucket: Bucket, call: McpCall, run: () => Promise<T>,
): Promise<T> {
  bucket.calls += 1;
  if (bucket.calls > MAX_MCP_CALLS) throw new RecoveryBudgetExceeded();
  try {
    const res = await run();
    bucket.transcript.note(call, res, bucket.calls, MAX_MCP_CALLS);
    return res;
  } catch (err) {
    bucket.transcript.note(call, { error: String(err) }, bucket.calls, MAX_MCP_CALLS);
    throw err;
  }
}

export function jsonText<T>(res: unknown): T {
  const r = res as { content?: ReadonlyArray<{ type: string; text?: string }> };
  const first = r.content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("MCP: non-text reply");
  }
  return JSON.parse(first.text) as T;
}

// ---------------------------------------------------------------------
// Detect unmapped assets
// ---------------------------------------------------------------------
export function detectUnmapped(lottie: LottieJson): UnmappedAsset[] {
  const out: UnmappedAsset[] = [];
  for (const a of lottie.assets ?? []) {
    const u = a.u ?? "";
    const p = a.p ?? "";
    const abs = u.startsWith("/Users/") || u.startsWith("C:\\") || u.startsWith("file://");
    const wrongPlatform = u.startsWith("C:\\") && process.platform !== "win32";
    const reason: UnmappedAsset["reason"] =
      abs ? (wrongPlatform ? "wrong-platform" : "absolute-path") : "missing";
    if (!abs) continue; // relative paths are presumed good
    const ext = p.toLowerCase();
    const fmt: UnmappedAsset["suspectedFormat"] =
      ext.endsWith(".png") ? "png" : ext.endsWith(".jpg") || ext.endsWith(".jpeg") ? "jpg" : "unknown";
    out.push({ id: a.id, originalPath: u + p, suspectedFormat: fmt, reason });
  }
  return out;
}

// ---------------------------------------------------------------------
// Regenerate a glow via PhotoCraft MCP
// ---------------------------------------------------------------------
async function regenerateGlow(
  bucket: Bucket, pc: Client, outDir: string,
): Promise<{ file: string; sha256_16: string }> {
  // Step 1 — transparent canvas
  await guarded(bucket, {
    tool: "photocraft", method: "doc_new",
    params: { width: 512, height: 512, mode: "rgb", depth: 8, background: "transparent" },
    reasoning: "transparent canvas so the glow composites without a matte",
  }, () => pc.callTool({ name: "doc_new", arguments: {
    width: 512, height: 512, mode: "rgb", depth: 8, background: "transparent",
  }}));

  // Step 2 — deterministic curves adjustment (recipe from the reference doc)
  await guarded(bucket, {
    tool: "photocraft", method: "command_run",
    params: { id: "layer.newAdjustmentLayer.curves", points: [[0,0],[64,40],[192,215],[255,255]] },
    reasoning: "deterministic S-curve that reads as a soft radial glow",
  }, () => pc.callTool({ name: "command_run", arguments: {
    id: "layer.newAdjustmentLayer.curves",
    params: { points: [[0,0],[64,40],[192,215],[255,255]] },
  }}));

  // Step 3 — export the canvas, then content-address the bytes. The
  // name cannot be known before the file exists, so the export goes to
  // a staging name and is renamed once the digest is known.
  const stagingName = "glow.staging.png";
  const stagingPath = path.join(outDir, stagingName);
  await fs.mkdir(outDir, { recursive: true });
  await guarded(bucket, {
    tool: "photocraft", method: "doc_export",
    params: { path: stagingName, format: "png" },
    reasoning: "export the flattened canvas so the file can be content-addressed",
  }, () => pc.callTool({ name: "doc_export", arguments: {
    path: stagingName, format: "png",
  }}));

  const bytes = await fs.readFile(stagingPath);
  const sha = createHash("sha256").update(bytes).digest("hex").slice(0, 16);

  // Step 4 — publish under the content-addressed name.
  const fileName = `glow-${sha}.png`;
  const outPath = path.join(outDir, fileName);
  await fs.rename(stagingPath, outPath);

  return { file: fileName, sha256_16: sha };
}

// ---------------------------------------------------------------------
// Optional multimodal sanity check over the live PhotoCraft window
// ---------------------------------------------------------------------
async function liveScreenshot(token: string, port: number, outPath: string): Promise<void> {
  const sock = net.connect(port, "127.0.0.1");
  await new Promise<void>((res, rej) => { sock.once("connect", res); sock.once("error", rej); });

  // The mandatory auth frame MUST be the very first write on the socket.
  // Omitting it closes the socket immediately per the runtime rules.
  sock.write(JSON.stringify({
    id: "auth", method: "auth", params: { token },
  }) + "\n");

  await new Promise<void>((res, rej) => {
    let buf = "";
    const onData = (d: Buffer) => {
      buf += d.toString("utf8");
      const line = buf.split("\n")[0];
      if (!line) return;
      const parsed = JSON.parse(line) as { ok?: boolean };
      if (!parsed.ok) return rej(new Error("TCP auth rejected"));
      sock.off("data", onData);
      res();
    };
    sock.on("data", onData);
    setTimeout(() => rej(new Error("auth timeout")), 5000);
  });

  const reply = await new Promise<string>((res, rej) => {
    sock.write(JSON.stringify({
      id: 1, method: "ui.screenshot", params: { path: outPath },
    }) + "\n");
    let buf = "";
    sock.once("data", (d) => { buf += d.toString("utf8"); res(buf); });
    setTimeout(() => rej(new Error("screenshot timeout")), 10_000);
  });
  if (!reply.includes("ok")) throw new Error("ui.screenshot failed");
  sock.destroy();
}

async function visionSaysRadialGlow(pngPath: string): Promise<boolean> {
  const script = path.resolve("scripts/vision-check.mjs");
  try {
    const { stdout } = await pexec("node", [script, pngPath], { timeout: 30_000 });
    return stdout.trim() === "match";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
// Validation schema (Lottie v5.7 minimum surface we rely on)
// ---------------------------------------------------------------------
const ajv = new Ajv({ allErrors: true, strict: false });
const LottieSchema: JSONSchemaType<unknown> = {
  type: "object",
  required: ["v", "fr", "ip", "op", "w", "h", "nm", "ddd", "layers"],
  properties: {
    v: { type: "string" },
    fr: { type: "number", minimum: 1 },
    ip: { type: "number" },
    op: { type: "number" },
    w: { type: "number", minimum: 1 },
    h: { type: "number", minimum: 1 },
    nm: { type: "string" },
    ddd: { type: "number", enum: [0, 1] },
    layers: { type: "array", minItems: 1, items: {} as never },
    assets: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "u", "p"],
        properties: {
          id: { type: "string" },
          u: { type: "string" },
          p: { type: "string" },
          w: { type: "number" },
          h: { type: "number" },
          e: { type: "number", enum: [0, 1] },
        },
        additionalProperties: true,
      } as unknown as never,
    },
  },
  additionalProperties: true,
} as unknown as JSONSchemaType<unknown>;
export const validateLottie = ajv.compile(LottieSchema);

// ---------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------
async function main() {
  const lottiePath = process.argv[2] ?? "comps/Main_HeroLoop.json";
  const outDir = process.argv[3] ?? "recovered-assets";
  const token = process.env.PHOTOCRAFT_TOKEN ?? "0".repeat(64);
  const port = Number(process.env.PHOTOCRAFT_PORT ?? "7979");

  const transcript = new Transcript();
  const bucket: Bucket = { calls: 0, transcript };
  const raw = await fs.readFile(lottiePath, "utf8");
  const lottie = JSON.parse(raw) as LottieJson;

  const unmapped = detectUnmapped(lottie);
  if (unmapped.length === 0) {
    // Idempotency gate: healed JSON produces zero work.
    console.log("recovery: nothing to do (healthy)");
    return;
  }
  if (unmapped.length > MAX_AFFECTED_ASSETS) {
    // Bounded scope: mass-breakage files an issue and exits 0.
    const title = `Lottie rehydration refused: ${unmapped.length} unmapped assets`;
    const body = unmapped.map((u) => `- ${u.id}: ${u.originalPath} (${u.reason})`).join("\n");
    await pexec("gh", ["issue", "create", "--title", title, "--body", body])
      .catch(() => { /* offline CI: still exit cleanly */ });
    console.log("recovery: requires-human");
    return;
  }

  const ec = await effectCraft();
  const pc = await photoCraft(outDir);
  try {
    // Call 1 — confirm the lottie export command exists.
    await guarded(bucket, {
      tool: "effectcraft", method: "list_commands",
      params: { filter: "lottie" },
      reasoning: "confirm export endpoint before touching any state",
    }, () => ec.callTool({ name: "list_commands", arguments: {
      filter: "lottie",
    }}));

    // Call 2 — read the composition back to verify it is present.
    await guarded(bucket, {
      tool: "effectcraft", method: "get_comp",
      params: { comp: "Main_HeroLoop" },
      reasoning: "read the composition to verify Main_HeroLoop is present",
    }, () => ec.callTool({ name: "get_comp", arguments: { comp: "Main_HeroLoop" } }));

    const replacements: Array<RecoveryPlan["replacements"][number]> = [];
    for (let i = 0; i < unmapped.length; i++) {
      const u = unmapped[i]!;
      const { file, sha256_16 } = await regenerateGlow(bucket, pc, outDir);

      // Optional: multimodal sanity over the live PhotoCraft window.
      if (i === 0) {
        let attempts = 0;
        let ok = false;
        while (attempts < 3 && !ok) {
          const shot = path.join(outDir, `live-${attempts}.png`);
          await guarded(bucket, {
            tool: "tcp-photocraft", method: "ui.screenshot",
            params: { path: shot },
            reasoning: "capture the live preview for the vision audit",
          }, () => liveScreenshot(token, port, shot).then(() => ({ ok: true })));

          ok = await visionSaysRadialGlow(shot);
          if (!ok) {
            // Nudge gamma on retry. Second attempt uses a mildly warmer curve.
            attempts += 1;
            await guarded(bucket, {
              tool: "photocraft", method: "command_run",
              params: { id: "image.adjustments.curves", gamma: 1.0 + 0.15 * attempts },
              reasoning: `retry ${attempts}: gamma nudge after vision mismatch`,
            }, () => pc.callTool({ name: "command_run", arguments: {
              id: "image.adjustments.curves",
              params: { gamma: 1.0 + 0.15 * attempts },
            }}));
          }
        }
        if (!ok) throw new VisionMismatchAfterRetries();
      }

      replacements.push({ assetId: u.id, generatedFile: file, sha256_16 });
    }

    // Re-emit the JSON with relative paths.
    const healed: LottieJson = JSON.parse(JSON.stringify(lottie));
    for (const r of replacements) {
      const idx = (healed.assets ?? []).findIndex((a) => a.id === r.assetId);
      if (idx < 0) continue;
      const asset = healed.assets![idx]!;
      asset.u = "recovered-assets/";
      asset.p = r.generatedFile;
    }
    if (!validateLottie(healed)) {
      throw new Error(`validate: ${ajv.errorsText(validateLottie.errors)}`);
    }
    await fs.writeFile(
      path.join(outDir, "Main_HeroLoop.healed.json"),
      JSON.stringify(healed, null, 2) + "\n");

    const plan: RecoveryPlan = {
      assets: unmapped, replacements,
      budgetUsed: bucket.calls, aborted: false,
    };
    await fs.writeFile(path.join(outDir, "plan.json"), JSON.stringify(plan, null, 2) + "\n");
    await transcript.write(path.join(outDir, "recovery-transcript.md"));
    console.log(`recovery: healed ${replacements.length} asset(s) using ${bucket.calls}/${MAX_MCP_CALLS} calls`);
  } catch (err) {
    await transcript.write(path.join(outDir, "recovery-transcript.md"));
    if (err instanceof RecoveryBudgetExceeded) {
      console.error("RecoveryBudgetExceeded");
      process.exit(2);
    }
    if (err instanceof HumanRequired || err instanceof VisionMismatchAfterRetries) {
      console.error(String(err));
      process.exit(3);
    }
    throw err;
  } finally {
    await ec.close(); await pc.close();
  }
}

if (process.argv[1]?.endsWith("03_autonomous-asset-recovery-mcp-driven-lottie-rehydration-in-a-ci-cd-pipeline.ts")) {
  await main().catch((e) => { console.error(e); process.exit(1); });
}
