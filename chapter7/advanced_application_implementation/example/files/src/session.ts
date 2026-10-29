// ─── src/session.ts ──────────────────────────────────────────────────────────
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { BatchStep, BatchStepSchema } from './contracts.js';

/* ------------------------------------------------------------------ *
 * The registry commands the compiler is ALLOWED to emit during
 * corrective cycles. Anything outside this set — doc_open, doc_save,
 * plugin.run, file.automate.* — is rejected at the session boundary.
 * This is the prompt-injection blast radius.
 * ------------------------------------------------------------------ */
export const CORRECTION_ALLOWLIST: ReadonlySet<string> = new Set([
  // Tone & light
  'layer.newAdjustmentLayer.curves',
  'layer.newAdjustmentLayer.levels',
  'layer.newAdjustmentLayer.exposure',
  'layer.newAdjustmentLayer.brightnessContrast',
  'layer.newAdjustmentLayer.vibrance',
  'layer.newAdjustmentLayer.hueSaturation',
  'layer.newAdjustmentLayer.colorBalance',
  'layer.newAdjustmentLayer.blackWhite',
  'layer.newAdjustmentLayer.photoFilter',
  'layer.newAdjustmentLayer.channelMixer',
  'layer.newAdjustmentLayer.selectiveColor',
  'layer.newAdjustmentLayer.invert',
  'layer.newAdjustmentLayer.posterize',
  'layer.newAdjustmentLayer.threshold',
  'layer.newAdjustmentLayer.gradientMap',
  'layer.setAdjustment',

  // Geometry
  'image.crop',
  'image.imageSize',
  'image.canvasSize',
  'image.imageRotation.90cw',
  'image.imageRotation.90ccw',
  'image.imageRotation.180',
  'image.imageRotation.flipCanvasHorizontal',
  'image.imageRotation.flipCanvasVertical',
  'edit.transform',

  // Retouch & repair
  'filter.blur.gaussianBlur',
  'filter.blur.surfaceBlur',
  'filter.sharpen.unsharpMask',
  'filter.noise.reduceNoise',
  'filter.other.highPass',
  'layer.selectBottom',
  'layer.duplicate',
  'layer.layerStyle.blendingOptions',
  'filter.portraitureSkinSmooth',           // plugin path, allowlisted explicitly

  // Masked regional edits
  'select.rect',
  'select.deselect',
  'select.magicWand',
  'select.sky',
  'select.subject',
  'select.refineEdge',
  'layer.layerMask.revealSelection',
  'layer.layerMask.hideAll',
  'layer.layerMask.edit',
  'paint.setFill',
  'paint.setStroke',
  'paint.gradient',
  'edit.fill',
  'gradient.fill.create',
  'gradient.fill.set',

  // Typography
  'type.create',
  'type.edit',
  'type.setStyle',
  'type.rasterize',
  'layer.layerStyle.dropShadow',
  'layer.layerStyle.stroke',
  'layer.layerStyle.clear',

  // Diffusion-based healing (content-aware)
  'edit.contentAwareFill',
  'edit.deleteAndFillSelection',
  'paint.spotHealing',
  'paint.remove',
]);

/* ------------------------------------------------------------------ *
 * MCP content unwrapper. The protocol returns `content[]` where each
 * element is either `{type:'text', text}` or `{type:'image', data,
 * mimeType}`. Every caller here wants a discriminated union.
 * ------------------------------------------------------------------ */
type Unwrapped =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mime: string; base64: string }
  | { kind: 'json'; value: unknown };

interface Wiring {
  content?: unknown;
  isError?: boolean;
}

function unwrapContent(reply: unknown): Unwrapped {
  const { content, isError } = (reply ?? {}) as Wiring;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error('MCP reply had empty content[]');
  }
  const blocks = content as Array<Record<string, unknown>>;

  // Refusals also carry a text block; surface it as an exception rather
  // than letting it masquerade as a payload.
  if (isError) {
    const text = blocks.find((b) => b.type === 'text')?.text;
    throw new Error(String(text ?? 'MCP tool call failed'));
  }

  const image = blocks.find((b) => b.type === 'image');
  if (image) {
    return {
      kind: 'image',
      mime: String(image.mimeType ?? 'image/png'),
      base64: String(image.data ?? ''),
    };
  }

  const block = blocks.find((b) => b.type === 'text');
  if (!block) return { kind: 'json', value: blocks[0] };
  const text = String(block.text ?? '');
  // ArtCraft meta-tools that return structured JSON emit it as text.
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return { kind: 'json', value: JSON.parse(text) };
    } catch {
      /* fall through to text */
    }
  }
  return { kind: 'text', text };
}

/* ------------------------------------------------------------------ *
 * Shapes shared with the orchestrator.
 * ------------------------------------------------------------------ */
export interface OpenedDocument {
  index: number;
  width: number;
  height: number;
  layers: number;
  name: string;
  warnings: string[];
}

export interface SaveOutcome {
  path: string;
  warnings: string[];
}

export interface BatchOutcome {
  /** Steps handed to the session. */
  requested: number;
  /** Steps that remain applied when the call returns. */
  completed: number;
  /** Steps the engine rejected. */
  failed: number;
  /** Steps rolled back because the batch failed part-way. */
  undone: number;
  /** Steps rejected before dispatch by the allowlist or schema. */
  dropped: number;
  errors: string[];
}

export interface LayerState {
  id: number;
  kind: string;
  name: string;
  selected: boolean;
  visible: boolean;
}

export interface DocState {
  layers: LayerState[];
  history: string[];
  activeLayer: number | null;
  canUndo: boolean;
}

/** What the orchestrator needs from a session; handy to fake in tests. */
export interface ApertureSession {
  boot(): Promise<void>;
  shutdown(): Promise<void>;
  docOpen(path: string): Promise<OpenedDocument>;
  preview(maxSide?: number): Promise<{ base64: string; mime: string }>;
  inspect(): Promise<DocState>;
  runCorrectionBatch(steps: BatchStep[], stopOnError?: boolean): Promise<BatchOutcome>;
  undo(steps?: number): Promise<void>;
  save(path: string, format?: string, quality?: number): Promise<SaveOutcome>;
}

const BatchReplySchema = z.object({
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  results: z
    .array(z.object({ ok: z.boolean(), error: z.string().nullable().optional() }))
    .default([]),
});

/* ------------------------------------------------------------------ *
 * PhotoCraftSession
 * -----------------
 * Owns one `photocraft-cli mcp` subprocess. Designed to be pooled: the
 * orchestrator keeps 4–8 warm sessions per pod and leases them per job.
 * ------------------------------------------------------------------ */
export class PhotoCraftSession implements ApertureSession {
  private client!: Client;
  private transport!: StdioClientTransport;
  private readonly readRoot: string;
  private readonly writeRoot: string;
  private booted = false;

  /**
   * @param readRoot  Filesystem sandbox root for reads (briefs, input images).
   * @param writeRoot Filesystem sandbox root for writes (renders, sidecars).
   */
  constructor(readRoot: string, writeRoot: string) {
    this.readRoot = readRoot;
    this.writeRoot = writeRoot;
  }

  /** Spawn the MCP subprocess and perform the handshake. */
  async boot(): Promise<void> {
    if (this.booted) return;
    this.transport = new StdioClientTransport({
      command: 'photocraft-cli',
      args: [
        'mcp',
        '--automation-read-root', this.readRoot,
        '--automation-write-root', this.writeRoot,
      ],
    });
    this.client = new Client(
      { name: 'aperture-qa-orchestrator', version: '2.4.0' },
      { capabilities: {} },
    );
    await this.client.connect(this.transport);
    this.booted = true;
  }

  /** Close the transport. Idempotent. */
  async shutdown(): Promise<void> {
    if (!this.booted) return;
    await this.client.close();
    this.booted = false;
  }

  /* --------------------------------------------------------------- *
   *  Wrappers around the official MCP meta-tools.
   * --------------------------------------------------------------- */

  /** Open a source image under the read-root. */
  async docOpen(path: string): Promise<OpenedDocument> {
    const r = await this.client.callTool({ name: 'doc_open', arguments: { path } });
    const u = unwrapContent(r);
    if (u.kind !== 'json') throw new Error('doc_open did not return JSON');
    return u.value as OpenedDocument;
  }

  /**
   * Run a batch of allowlisted commands. The engine executes steps
   * sequentially and stops at the first failure; whatever landed before
   * that point stays applied. The session compensates by undoing that
   * prefix, so callers get all-or-nothing semantics and a truthful
   * `completed` count — without pretending the engine is transactional.
   */
  async runCorrectionBatch(steps: BatchStep[], stopOnError = true): Promise<BatchOutcome> {
    const parsed: BatchStep[] = [];
    const dropped: string[] = [];
    for (const step of steps) {
      const valid = BatchStepSchema.safeParse(step);
      if (!valid.success || !CORRECTION_ALLOWLIST.has(valid.data.id)) {
        dropped.push(step.id);
        continue;
      }
      parsed.push(valid.data);
    }

    const outcome: BatchOutcome = {
      requested: steps.length,
      completed: 0,
      failed: 0,
      undone: 0,
      dropped: dropped.length,
      errors: [],
    };
    if (parsed.length === 0) return outcome;

    const r = await this.client.callTool({
      name: 'command_batch',
      arguments: {
        steps: parsed.map((s) => ({ id: s.id, params: s.params })),
        stop_on_error: stopOnError,
      },
    });
    const u = unwrapContent(r);
    if (u.kind !== 'json') throw new Error('command_batch did not return JSON');
    const reply = BatchReplySchema.parse(u.value);
    outcome.failed = reply.failed;
    outcome.errors = reply.results
      .filter((step) => !step.ok && step.error)
      .map((step) => String(step.error));

    if (reply.failed > 0) {
      await this.undo(reply.completed);
      outcome.undone = reply.completed;
      return outcome;
    }

    outcome.completed = reply.completed;
    return outcome;
  }

  /** Full document JSON tree — layers, history, selection. */
  async inspect(): Promise<DocState> {
    const r = await this.client.callTool({ name: 'doc_inspect', arguments: {} });
    const u = unwrapContent(r);
    if (u.kind !== 'json') throw new Error('doc_inspect did not return JSON');
    return u.value as DocState;
  }

  /**
   * Bridge-mode screenshot of the live PhotoCraft window. Requires a
   * running desktop app; the headless server has no window to capture,
   * so canvas audits use `preview()` instead.
   */
  async screenshot(maxSide = 1536): Promise<{ base64: string; mime: string }> {
    const r = await this.client.callTool({
      name: 'ui_screenshot',
      arguments: { max_side: maxSide },
    });
    const u = unwrapContent(r);
    if (u.kind !== 'image') throw new Error('ui_screenshot did not return an image');
    return { base64: u.base64, mime: u.mime };
  }

  /** Headless flattened preview — cheaper than a window capture, no chrome. */
  async preview(maxSide = 1536): Promise<{ base64: string; mime: string }> {
    if (maxSide < 32 || maxSide > 2048) {
      throw new Error(`preview max_side must be 32..2048, got ${maxSide}`);
    }
    const r = await this.client.callTool({
      name: 'doc_render_preview',
      arguments: { max_side: maxSide },
    });
    const u = unwrapContent(r);
    if (u.kind !== 'image') throw new Error('doc_render_preview did not return an image');
    return { base64: u.base64, mime: u.mime };
  }

  /** Save the finished artifact. The engine never creates parent folders. */
  async save(path: string, format?: string, quality?: number): Promise<SaveOutcome> {
    const args: Record<string, unknown> = { path };
    if (format) args.format = format;
    if (quality != null) args.quality = quality;
    const r = await this.client.callTool({ name: 'doc_save', arguments: args });
    const u = unwrapContent(r);
    if (u.kind !== 'json') throw new Error('doc_save did not return JSON');
    const reply = u.value as { path?: string; warnings?: string[] };
    return { path: reply.path ?? path, warnings: reply.warnings ?? [] };
  }

  /** Undo N history steps (rollback primitive). */
  async undo(steps = 1): Promise<void> {
    for (let i = 0; i < steps; i++) {
      const r = await this.client.callTool({
        name: 'command_run',
        arguments: { id: 'edit.undo', params: {} },
      });
      unwrapContent(r);
    }
  }
}
