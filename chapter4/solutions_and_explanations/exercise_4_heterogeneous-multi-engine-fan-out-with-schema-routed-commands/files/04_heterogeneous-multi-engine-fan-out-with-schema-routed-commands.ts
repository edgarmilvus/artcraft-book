// Solution for Chapter 4. The full implementation used by the acceptance harness.

// fanout-orchestrator.ts
import * as net from "node:net";

export type Engine = "photocraft" | "vectorcraft" | "designcraft" | "pdfcraft";

// Catalog shape is a readonly tuple; the orchestrator diffs against it during preflight.
export interface EngineSpec<E extends Engine> {
  readonly engine: E;
  readonly binary: string;
  readonly port: number;
  readonly tokenEnvVar: string;
  readonly commandCatalogShape: ReadonlyArray<{ id: string; params?: string }>;
}
export type AnySpec = EngineSpec<Engine>;

// The four specs: because they're `as const`, the union is closed.
export const ENGINE_SPECS = {
  photocraft:  { engine: "photocraft",  binary: "photocraft-cli",  port: 7878, tokenEnvVar: "PHOTOCRAFT_TOKEN",
                 commandCatalogShape: [
                   { id: "layer.newAdjustmentLayer.curves", params: "{points: [[in,out],...]}" },
                   { id: "filter.sharpen.unsharpMask",      params: "{amount, radius, threshold}" },
                   { id: "file.save",                        params: "{path, format}" },
                 ] },
  vectorcraft: { engine: "vectorcraft", binary: "vectorcraft-cli", port: 7879, tokenEnvVar: "VECTORCRAFT_TOKEN",
                 commandCatalogShape: [
                   { id: "shape.rectangle",  params: "{x, y, width, height}" },
                   { id: "object.group",     params: "{}" },
                   { id: "document.export",  params: "{format, path}" },
                 ] },
  designcraft: { engine: "designcraft", binary: "designcraft-cli", port: 7880, tokenEnvVar: "DESIGNCRAFT_TOKEN",
                 commandCatalogShape: [
                   { id: "file.open",      params: "{path}" },
                   { id: "object.stroke",  params: "{swatch, weight, ids}" },
                   { id: "file.exportPdf", params: "{path, pages}" },
                 ] },
  pdfcraft:    { engine: "pdfcraft",    binary: "pdfcraft-cli",    port: 7881, tokenEnvVar: "PDFCRAFT_TOKEN",
                 commandCatalogShape: [
                   { id: "doc_open",        params: "{path}" },
                   { id: "ocr_recognize",   params: "{doc}" },
                   { id: "form_fill",       params: "{doc, values}" },
                   { id: "redact_mark",     params: "{doc, pattern}" },
                   { id: "redact_apply",    params: "{doc}" },
                   { id: "pdfa_verify",     params: "{doc, level}" },
                   { id: "pdfa_convert",    params: "{doc, level}" },
                   { id: "doc_compare",     params: "{doc, other}" },
                 ] },
} satisfies { readonly [K in Engine]: EngineSpec<K> };
export type EngineCatalogShape = typeof ENGINE_SPECS;

// A step is narrowed by `engine`; the command string is a member of that engine's catalog.
export interface Step<E extends Engine = Engine> {
  readonly stepId: string;
  readonly engine: E;
  readonly command: EngineCatalogShape[E]["commandCatalogShape"][number]["id"];
  readonly params: Readonly<Record<string, unknown>>;
  readonly compensate?: string | null;
}
export type AnyStep = Step<Engine>;

// ---------- Preflight: two checks per step ----------
export class PreflightError extends Error { constructor(m: string) { super(m); this.name = "PreflightError"; } }


/** Top-level keys of a `{key: type, key?: type}` pseudo-signature. */
function requiredKeys(schema: string): string[] {
  const open = schema.indexOf("{");
  if (open < 0) return [];
  const body: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = open + 1; i < schema.length; i++) {
    const ch = schema[i]!;
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      if (depth === 0) break;
      depth--;
    }
    if (ch === "," && depth === 0) {
      body.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  body.push(current);
  return body
    .map((part) => part.split(":")[0]!.trim())
    .filter((key) => key.length > 0 && !key.endsWith("..."));
}

export function preflight(step: AnyStep, spec: AnySpec): void {
  const known = spec.commandCatalogShape.find(c => c.id === step.command);
  if (!known) throw new PreflightError(`Unknown command '${step.command}' for engine '${spec.engine}'`);
  // Schema-driven required-field check. The schema is a pseudo-signature
  // like `{points: [[in,out],...]}`: only the top-level keys are required,
  // and nested brackets must not be mistaken for separators.
  if (known.params) {
    for (const key of requiredKeys(known.params)) {
      if (!(key in step.params)) {
        throw new PreflightError(`Missing required param '${key}' for ${spec.engine}.${step.command}`);
      }
    }
  }
}

// ---------- Exhaustive runStep dispatch ----------
export function runStep(step: AnyStep, channel: ChannelHandle): Promise<unknown> {
  switch (step.engine) {
    case "photocraft":  return executePhoto(step as Step<"photocraft">,  channel);
    case "vectorcraft": return executeVector(step as Step<"vectorcraft">, channel);
    case "designcraft": return executeDesign(step as Step<"designcraft">, channel);
    case "pdfcraft":    return executePdf(step as Step<"pdfcraft">,    channel);
  }
  // Compiler enforces exhaustiveness: adding a fifth engine breaks compilation here.
  const _exhaustive = step as never;
  return Promise.reject(new Error(`Unreachable: ${JSON.stringify(_exhaustive)}`));
}
function executePhoto(s: Step<"photocraft">, c: ChannelHandle): Promise<unknown> {
  return c.execute(s.command, s.params);
}
function executeVector(s: Step<"vectorcraft">, c: ChannelHandle): Promise<unknown> {
  return c.execute(s.command, s.params);
}
function executeDesign(s: Step<"designcraft">, c: ChannelHandle): Promise<unknown> {
  return c.execute(s.command, s.params);
}
function executePdf(s: Step<"pdfcraft">, c: ChannelHandle): Promise<unknown> {
  return c.execute(s.command, s.params);
}

// ---------- Minimal channel handle ----------
export interface ChannelHandle {
  readonly engine: Engine;
  readonly port: number;
  readonly token: string;
  execute: (command: string, params: unknown) => Promise<unknown>;
  heartbeatNow: () => void;
  close: () => Promise<void>;
}

// ---------- Saga ----------
export interface RunManifest {
  readonly catalogId: string;
  readonly startedAt: string;
  readonly engines: ReadonlyArray<{
    readonly engine: Engine;
    readonly port: number;
    readonly commandsIssued: number;
    readonly warnings: readonly string[];
  }>;
  readonly assetsWritten: readonly { readonly path: string; readonly bytes: number }[];
  readonly failures: readonly { readonly stepId: string; readonly error: { readonly code: string; readonly message: string } }[];
  readonly compensated: readonly string[];
}

export interface CatalogRequest {
  readonly catalogId: string;
  readonly steps: readonly AnyStep[];
}

export class FanOutOrchestrator {
  private readonly compensationTable = new Map<string, () => Promise<void>>();

  public async run(req: CatalogRequest): Promise<RunManifest> {
    const startedAt = new Date().toISOString();
    const channels = new Map<Engine, ChannelHandle>();
    const failures: { stepId: string; error: { code: string; message: string } }[] = [];
    const compensated: string[] = [];
    let commandsIssued: Record<Engine, number> = { photocraft: 0, vectorcraft: 0, designcraft: 0, pdfcraft: 0 };
    const warnings: Record<Engine, string[]> = { photocraft: [], vectorcraft: [], designcraft: [], pdfcraft: [] };
    const assetsWritten: { path: string; bytes: number }[] = [];

    try {
      // Open one channel per engine.
      for (const e of Object.keys(ENGINE_SPECS) as Engine[]) {
        const spec = ENGINE_SPECS[e];
        const token = process.env[spec.tokenEnvVar] ?? "";
        const handle = await this.openChannel(spec, token);
        channels.set(e, handle);
      }

      for (const step of req.steps) {
        const spec = ENGINE_SPECS[step.engine];
        preflight(step, spec); // throws PreflightError before any byte hits the wire

        const handle = channels.get(step.engine)!;
        try {
          const result = await runStep(step, handle);
          commandsIssued[step.engine]++;
          void result;
          // Record compensation closure for this step.
          if (step.compensate) {
            const cmd = step.compensate;
            this.compensationTable.set(step.stepId, async () => {
              await handle.execute(cmd, {});
              compensated.push(step.stepId);
            });
          }
        } catch (e) {
          failures.push({ stepId: step.stepId, error: { code: "STEP_FAILED", message: String(e) } });
          // Saga: run compensations for completed steps in reverse order.
          for (const [id, comp] of Array.from(this.compensationTable.entries()).reverse()) {
            try { await comp(); } catch (err) { warnings[step.engine].push(String(err)); }
            this.compensationTable.delete(id);
          }
          break;
        }
      }

      // PdfCraft's doc_compare channel: fresh token, two doc_open calls, compare, close.
      await this.runShortLivedCompare();

      return this.emitManifest(req.catalogId, startedAt, channels, commandsIssued, warnings, assetsWritten, failures, compensated);
    } finally {
      for (const [, h] of channels) { try { await h.close(); } catch { /* ignore */ } }
    }
  }

  private async openChannel(spec: AnySpec, token: string): Promise<ChannelHandle> {
    const sock = net.createConnection({ host: "127.0.0.1", port: spec.port });
    await new Promise<void>((res, rej) => { sock.once("connect", () => res()); sock.once("error", rej); });
    const send = (frame: Record<string, unknown>) =>
      new Promise<void>((res, rej) => sock.write(JSON.stringify(frame) + "\n", err => err ? rej(err) : res()));

    // First frame MUST be auth.
    await send({ id: "auth", method: "auth", params: { token } });

    // Per-channel heartbeat: independent timers.
    const hb = setInterval(() => { void send({ id: "hb", method: "ping", params: {} }); }, 5_000);

    return {
      engine: spec.engine, port: spec.port, token,
      execute: async (command, params) => { await send({ id: Date.now() % 1e9, method: "engine.execute", params: { command, params } }); },
      heartbeatNow: () => { void send({ id: "hb", method: "ping", params: {} }); },
      close: async () => { clearInterval(hb); await new Promise<void>(res => sock.end(() => res())); },
    };
  }

  private async runShortLivedCompare(): Promise<void> {
    const freshToken = await this.tokenBroker("pdfcraft");
    const spec = ENGINE_SPECS.pdfcraft;
    const channel = await this.openChannel(spec, freshToken);
    try {
      await channel.execute("doc_open", { path: "/work/pre-ocr.pdf" });
      await channel.execute("doc_open", { path: "/work/post-ocr.pdf" });
      await channel.execute("doc_compare", { doc: 2, other: 1 });
    } finally {
      await channel.close();
    }
  }
  /** Short-lived channels get their own credential from the broker; the
   *  local implementation hands out the same per-engine secret. */
  private async tokenBroker(e: Engine): Promise<string> {
    return process.env[ENGINE_SPECS[e].tokenEnvVar] ?? "0".repeat(64);
  }

  private emitManifest(
    catalogId: string, startedAt: string,
    channels: ReadonlyMap<Engine, ChannelHandle>,
    commandsIssued: Record<Engine, number>,
    warnings: Record<Engine, string[]>,
    assetsWritten: { path: string; bytes: number }[],
    failures: { stepId: string; error: { code: string; message: string } }[],
    compensated: string[],
  ): RunManifest {
    const engines = (Array.from(channels.keys()) as Engine[]).map(e => ({
      engine: e, port: channels.get(e)!.port,
      commandsIssued: commandsIssued[e], warnings: warnings[e],
    }));
    return {
      catalogId, startedAt, engines,
      assetsWritten, failures, compensated,
    };
  }
}
