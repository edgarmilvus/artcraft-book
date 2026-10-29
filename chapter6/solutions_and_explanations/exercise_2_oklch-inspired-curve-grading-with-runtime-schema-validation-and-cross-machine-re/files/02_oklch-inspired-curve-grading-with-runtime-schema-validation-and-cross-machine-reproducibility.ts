// oklch-to-photocraft.ts
// Every translation is defined as a pure function from the validated spec to a
// batch of engine commands. Nothing in the emitted batch depends on wall time,
// RNG, locale, or ambient environment — which is what makes the rendered
// preview hash reproducible.

import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// 1. Zod boundary for the webhook payload. Ranges are chosen to be the *engine's*
//    legal ranges wherever possible, so a spec that fits here is guaranteed to
//    be representable downstream. Anything outside these bounds is rejected
//    BEFORE the engine is opened.
// ---------------------------------------------------------------------------
export const OkLchGradeSpecSchema = z.object({
  photoId: z.string().min(1),
  lightnessOffset: z.number().min(-0.1).max(0.1),
  contrastPivot:   z.number().min(0.3).max(0.7),
  contrastAmount:  z.number().min(0).max(1),
  chromaGain:      z.number().min(0.5).max(2.0),
  coolHighlights:  z.boolean(),
  warmShadows:     z.boolean(),
  schemaVersion:   z.literal(1),
});
export type OkLchGradeSpec = z.infer<typeof OkLchGradeSpecSchema>;

// ---------------------------------------------------------------------------
// 2. Engine-side legal ranges — copied from the Level-1 catalog. These are the
//    contract; our Zod refinements above only *narrow* them, never widen them.
// ---------------------------------------------------------------------------
const ENGINE = {
  saturation: { min: -100, max: 100 },
  levelsGamma: { min: 0.01, max: 9.99 },
  curvePoints: { min: 2, max: 19, component: { min: 0, max: 255 } },
  colorBalance: { min: -100, max: 100 },
} as const;

// Named magnitude for the colour-balance push. A magic literal here would make
// the mid-tone bias drift if the constant were ever edited; a named one makes
// the audit trail readable.
const COOL_WARM_PUSH = 8;

// ---------------------------------------------------------------------------
// 3. Translation primitives. Each one is a pure function so the round-trip
//    report can record exactly what it decided.
// ---------------------------------------------------------------------------

// lightnessOffset → levels.gamma.
//
// A levels gamma of g maps mid-grey 0.5 to 0.5^g. Treating OkLCh lightness as
// log2-linear in the midtones, g = 2^(-4*offset) moves the midtone by roughly
// 4*offset stops, which is the right order of magnitude for the ±0.05 offsets
// this schema accepts. It is an approximation: below ~0.05 L the gamma curve is
// far more aggressive than the perceptual model, so very deep shadows drift.
// PhotoCraft exposes no shadows-specific control to correct that, so the report
// says so instead of pretending otherwise.
interface LevelsTranslation {
  inBlack: 0; gamma: number; inWhite: 255;
  outBlack: 0; outWhite: 255;
}
export function translateLightness(offset: number): { params: LevelsTranslation; clamped: boolean } {
  const gamma = Math.pow(2, -offset * 4);
  const clamped = Math.min(ENGINE.levelsGamma.max, Math.max(ENGINE.levelsGamma.min, gamma));
  return {
    params: { inBlack: 0, gamma: clamped, inWhite: 255, outBlack: 0, outWhite: 255 },
    clamped: clamped !== gamma,
  };
}

// contrastPivot/contrastAmount → curves.points (composite channel).
//
// Five anchors: black, a flank below the pivot, the pivot itself, a flank above
// it, and white. The flanks move away from identity by an amount that scales
// with contrastAmount, so contrastAmount = 0 collapses to the identity curve.
// The pivot never moves: by construction it is the point of least change.
export function translateContrast(
  pivot: number, amount: number
): { points: [number, number][]; clamped: boolean } {
  const p = pivot * 255;
  const lo = p / 2;
  const hi = (p + 255) / 2;
  const push = amount * 40; // 40 code values: the S-curve's practical ceiling
                            // before the endpoints themselves start to move.
  const loOut = lo - push;  // below the pivot: darker
  const hiOut = hi + push;  // above the pivot: brighter

  const clamp = (v: number) => Math.min(255, Math.max(0, v));
  const pts: [number, number][] = [
    [0, 0],
    [lo, clamp(loOut)],
    [p,  p],
    [hi, clamp(hiOut)],
    [255, 255],
  ];
  const clamped = clamp(loOut) !== loOut || clamp(hiOut) !== hiOut;
  return { points: pts, clamped };
}

// chromaGain → hueSaturation.saturation.
//
// Saturation 0 is identity; a gain of 1.15 maps to +15 units. The clamp is
// unreachable through the schema above (gain 2.0 is exactly +100), and stays as
// a guard for callers that use this function directly or widen the schema. The
// report carries the flag either way.
export function translateChroma(gain: number): { saturation: number; clamped: boolean } {
  const rough = Math.round((gain - 1.0) * 100);
  const clamped = Math.min(ENGINE.saturation.max, Math.max(ENGINE.saturation.min, rough));
  return { saturation: clamped, clamped: clamped !== rough };
}

// ---------------------------------------------------------------------------
// 4. The translation table as a whole. Every decision — including whether a
//    value was clamped — is recorded in this report so the caller can surface
//    the discrepancies to the user.
// ---------------------------------------------------------------------------
interface GradeReport {
  photoId: string;
  levels: { gamma: number; clamped: boolean };
  curves: { points: [number, number][]; clamped: boolean };
  saturation: { value: number; clamped: boolean };
  colorBalance: {
    highlights?: [number, number, number];
    shadows?: [number, number, number];
  };
  document: { width: number; height: number; layers: number };
  unsupported: string[]; // OkLCh features we cannot represent; surfaced, not hidden
}

interface GradeStep {
  id: string;
  params: Record<string, unknown>;
}

function translateSpec(spec: OkLchGradeSpec): { report: Omit<GradeReport, "document">; steps: GradeStep[] } {
  const lv = translateLightness(spec.lightnessOffset);
  const cv = translateContrast(spec.contrastPivot, spec.contrastAmount);
  const ch = translateChroma(spec.chromaGain);

  const steps: GradeStep[] = [
    { id: "layer.newAdjustmentLayer.levels", params: { ...lv.params } },
    { id: "layer.newAdjustmentLayer.curves", params: { points: cv.points, pencil: false } },
    {
      id: "layer.newAdjustmentLayer.hueSaturation",
      params: { hue: 0, saturation: ch.saturation, lightness: 0, colorize: false },
    },
  ];

  // One colour-balance layer carries both intents: a blue push in the
  // highlights and a blue pull (i.e. warmth) in the shadows. Two layers would
  // stack two transfer functions and double the effect in the midtones.
  const colorBalance: GradeReport["colorBalance"] = {};
  if (spec.coolHighlights) colorBalance.highlights = [0, 0, COOL_WARM_PUSH];
  if (spec.warmShadows)   colorBalance.shadows   = [0, 0, -COOL_WARM_PUSH];
  if (colorBalance.highlights || colorBalance.shadows) {
    steps.push({
      id: "layer.newAdjustmentLayer.colorBalance",
      params: {
        shadows:   colorBalance.shadows   ?? [0, 0, 0],
        midtones:  [0, 0, 0],
        highlights: colorBalance.highlights ?? [0, 0, 0],
        preserveLuminosity: true,
      },
    });
  }

  const unsupported = [
    "OkLCh chroma is scaled by hueSaturation in linear RGB, not in Oklab. " +
      "Highly saturated primaries therefore move along their own hue angle, so " +
      "the delivered chroma can differ from the spec's target on those pixels.",
    "OkLCh lightness is media-relative while levels.gamma acts on encoded " +
      "values. Grading an HDR deliverable through this table does not preserve " +
      "absolute luminance.",
  ];

  const report = {
    photoId: spec.photoId,
    levels: { gamma: lv.params.gamma, clamped: lv.clamped },
    curves: { points: cv.points, clamped: cv.clamped },
    saturation: { value: ch.saturation, clamped: ch.clamped },
    colorBalance,
    unsupported,
  };
  return { report, steps };
}

// ---------------------------------------------------------------------------
// 5. Reply helpers. A tool result is a content-block array; refusals arrive as
//    plain text with `isError`, successes as a JSON text block or, for a
//    render, as an image block whose `data` is base64.
// ---------------------------------------------------------------------------
function payload(result: unknown): unknown {
  const { content, isError } = result as {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  const text = content?.find((b) => b.type === "text")?.text;
  if (isError) throw new Error(text ?? "the engine refused the call");
  if (typeof text !== "string") throw new Error("the reply carried no text block");
  return JSON.parse(text);
}

function imageBytes(result: unknown): Buffer {
  const { content, isError } = result as {
    content?: Array<{ type?: string; text?: string; data?: string }>;
    isError?: boolean;
  };
  if (isError) {
    throw new Error(content?.find((b) => b.type === "text")?.text ?? "the render was refused");
  }
  const image = content?.find((b) => b.type === "image" && typeof b.data === "string");
  if (!image?.data) throw new Error("doc_render_preview returned no image block");
  return Buffer.from(image.data, "base64");
}

// ---------------------------------------------------------------------------
// 6. Driver. One photo = one batch. `command_batch` is *not* transactional:
//    the engine keeps the steps that succeeded, so the batch is validated
//    before it is sent and the render happens only after a clean report. The
//    final render's SHA-256 is the reproducibility claim.
// ---------------------------------------------------------------------------
/**
 * Undo the steps a failed batch left applied. `command_batch` is not
 * transactional and every step is its own history state, so the compensation is
 * exactly `completed` undos — not `failed` ones, and not one bulk undo.
 */
export async function undoAppliedPrefix(
  client: Client,
  completed: number,
): Promise<number> {
  for (let i = 0; i < completed; i += 1) {
    await client.callTool({
      name: "command_run",
      arguments: { id: "edit.undo", params: {} },
    });
  }
  return completed;
}

export async function gradePhoto(
  rawSpec: unknown,
  opts: {
    readRoot: string;
    writeRoot: string;
    photoPath: string;
    /** Optional evidence files. The engine's render is a byte stream, so the
     * caller decides whether to keep it; the hash is always returned. */
    previewPath?: string;
    savePath?: string;
  }
): Promise<{ report: GradeReport; sha256: string; warnings: string[] }> {
  // Boundary validation. This is the only place untrusted input becomes trusted.
  const spec = OkLchGradeSpecSchema.parse(rawSpec);

  const { report, steps } = translateSpec(spec);

  const transport = new StdioClientTransport({
    command: "photocraft-cli",
    args: ["mcp",
      "--automation-read-root", opts.readRoot,
      "--automation-write-root", opts.writeRoot],
  });
  const client = new Client({ name: "oklch-grader", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  try {
    const opened = z.object({
      index: z.number().int().nonnegative(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      layers: z.number().int().nonnegative(),
      warnings: z.array(z.string()).default([]),
    }).parse(payload(await client.callTool({
      name: "doc_open",
      arguments: { path: opts.photoPath },
    })));

    const batch = z.object({
      completed: z.number().int(),
      failed: z.number().int(),
      results: z.array(z.object({ ok: z.boolean(), error: z.string().optional() })),
    }).parse(payload(await client.callTool({
      name: "command_batch",
      arguments: { steps, stop_on_error: true },
    })));
    if (batch.failed > 0) {
      const broken = batch.results.findIndex((r) => !r.ok);
      // Leave the photo exactly as we found it: the steps that succeeded are
      // already on the undo stack, one entry each.
      await undoAppliedPrefix(client, batch.completed);
      throw new Error(`engine rejected ${steps[broken]?.id ?? "the grade batch"}: ${batch.results[broken]?.error ?? "no error text"}`);
    }

    // Read the tree back: the report should describe the document that exists,
    // not the one we asked for.
    const inspected = z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      layers: z.array(z.object({ kind: z.string() })),
    }).parse(payload(await client.callTool({
      name: "doc_inspect",
      arguments: { index: opened.index },
    })));

    if (opts.savePath) {
      await mkdir(dirname(opts.savePath), { recursive: true });
      await client.callTool({
        name: "doc_save",
        arguments: { path: opts.savePath, format: "psd" },
      });
    }

    const preview = imageBytes(await client.callTool({
      name: "doc_render_preview",
      arguments: { max_side: 1024, index: opened.index },
    }));
    if (opts.previewPath) {
      await mkdir(dirname(opts.previewPath), { recursive: true });
      await writeFile(opts.previewPath, preview);
    }
    const sha256 = createHash("sha256").update(preview).digest("hex");

    return {
      report: {
        ...report,
        document: {
          width: inspected.width,
          height: inspected.height,
          layers: inspected.layers.length,
        },
      },
      sha256,
      warnings: opened.warnings,
    };
  } finally {
    await client.close();
  }
}
