// banner-assembler.ts
// Drives photocraft-cli mcp over stdio. Every creation goes into one
// command_batch; renames, moves, clips and flag changes go into a second one
// whose steps address the ids the first batch returned. command_batch is *not*
// atomic — the engine keeps the steps that succeeded — which is why the save
// is the last call and a failed batch is reported instead of replayed.

import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir } from "node:fs/promises";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// 1. Zod schemas for every engine response we must trust BEFORE propagating ids.
//    Creation commands answer `{ layer: n }`; a few reply `{ id: n }`. Anything
//    else is refused here rather than surfacing as an undefined id three steps
//    later.
// ---------------------------------------------------------------------------
const LayerCreated = z.object({ layer: z.number().int().nonnegative() });
const LayerCreatedOrId = z.union([
  LayerCreated,
  z.object({ id: z.number().int().nonnegative() }),
]);
const BatchResult = z.object({
  completed: z.number().int(),
  failed: z.number().int(),
  results: z.array(
    z.object({ ok: z.boolean(), result: z.unknown().optional(), error: z.string().optional() })
  ),
});
const DocSaveResult = z.object({
  path: z.string(),
  warnings: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// 2. SKU input schema — the brief that drives the run.
// ---------------------------------------------------------------------------
const SkuBannerSpecSchema = z.object({
  sku: z.string().regex(/^[A-Z0-9\-]+$/),
  canvas: z.object({
    width: z.literal(1920),
    height: z.literal(1080),
  }),
  productCutoutPath: z.string(),
  gradient: z.object({
    from: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    to: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    angle: z.number(),
    style: z.enum(["linear", "radial"]),
  }),
  headline: z.object({
    text: z.string().min(1),
    font: z.string(),
    size: z.number().positive(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }),
  price: z.object({
    text: z.string().min(1),
    font: z.string(),
    size: z.number().positive(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }),
  seed: z.number().int(),
});
type SkuBannerSpec = z.infer<typeof SkuBannerSpecSchema>;

// ---------------------------------------------------------------------------
// 3. The banner contract, used both here (as a client-side sanity check) and
//    by the downstream auditor. Never assume — always inspect.
// ---------------------------------------------------------------------------
export type BannerContract = {
  mustHaveExactlyOne: {
    groupName: "Background";
    clippedLayerNamePrefix: "Product::";
    fillLayerNamePrefix: "Gradient::";
    groupNamePrefixes: ["Type::Headline", "Type::Price"];
    adjustmentLayerName: "Grade::Vibrance";
  };
  parentage: {
    productClippedTo: "Gradient::*";
    gradeClippedTo: "Type::Headline";
  };
  layerFlags: {
    forTypeGroups: { visible: true; opacity: 1; blend: "Normal" };
  };
};

// ---------------------------------------------------------------------------
// 4. MCP plumbing. A tool reply is a content-block array; the JSON we care
//    about is the text block, and `isError` means the engine refused us.
// ---------------------------------------------------------------------------
type Step = { id: string; params?: Record<string, unknown> };

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

function layerIdOf(reply: unknown, context: string): number {
  const parsed = LayerCreatedOrId.safeParse(reply);
  if (!parsed.success) {
    throw new Error(`${context}: expected a layer id, got ${JSON.stringify(reply).slice(0, 200)}`);
  }
  return "layer" in parsed.data ? parsed.data.layer : parsed.data.id;
}

/** Run one batch and return the per-step results, or throw on the first failure. */
/**
 * Compensate a non-atomic batch. `command_batch` keeps the steps that succeeded,
 * one history state each, so the undo count is the report's `completed`, never
 * its `failed`.
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

async function runBatch(
  client: Client,
  steps: Step[],
): Promise<Array<{ ok: boolean; result?: unknown; error?: string }>> {
  const reply = await client.callTool({
    name: "command_batch",
    arguments: { steps, stop_on_error: true },
  });
  const report = BatchResult.parse(payload(reply));
  const broken = report.results.findIndex((r) => !r.ok);
  if (broken >= 0) {
    // The SKU failed: leave the document as it was before the batch, then report
    // which step broke the chain.
    await undoAppliedPrefix(client, report.completed);
    throw new Error(
      `batch stopped at ${steps[broken]?.id ?? `step ${broken}`}: ` +
        (report.results[broken]?.error ?? "no error text"),
    );
  }
  return report.results;
}

// ---------------------------------------------------------------------------
// 5. Phase A — creation. No step needs an id produced by an earlier step, which
//    is what makes a single batch possible at all: `command_batch` has no
//    cross-step reference syntax, so the ids are read off the report instead.
// ---------------------------------------------------------------------------
function creationSteps(spec: SkuBannerSpec): Step[] {
  return [
    // [0] The backdrop group. Created first so it sits at the bottom.
    { id: "layer.new.group", params: { name: "Background" } },
    // [1] The gradient fill. Its stops come from the brief, not from a swatch.
    {
      id: "layer.newFillLayer.gradient",
      params: {
        from: spec.gradient.from,
        to: spec.gradient.to,
        angle: spec.gradient.angle,
        style: spec.gradient.style,
      },
    },
    // [2] / [3] Headline group and its area type.
    { id: "layer.new.group", params: { name: "Type::Headline" } },
    {
      id: "type.create",
      params: {
        box: [160, 540, 1400, 180],
        text: spec.headline.text,
        font: spec.headline.font,
        size: spec.headline.size,
        color: spec.headline.color,
        align: "left",
      },
    },
    // [4] / [5] Price group and its area type.
    { id: "layer.new.group", params: { name: "Type::Price" } },
    {
      id: "type.create",
      params: {
        box: [160, 760, 1400, 160],
        text: spec.price.text,
        font: spec.price.font,
        size: spec.price.size,
        color: spec.price.color,
        align: "left",
      },
    },
    // [6] The grade: a hue/saturation adjustment with +12 saturation.
    {
      id: "layer.newAdjustmentLayer.hueSaturation",
      params: { hue: 0, saturation: 12, lightness: 0, colorize: false },
    },
  ];
}

// ---------------------------------------------------------------------------
// 6. Phase B — wiring. Every step here names a concrete engine id: the seven
//    from the creation batch plus the product layer that `doc_place` created.
// ---------------------------------------------------------------------------
interface LayerIds {
  background: number;
  gradient: number;
  headlineGroup: number;
  headline: number;
  priceGroup: number;
  price: number;
  grade: number;
  product: number;
}

function wiringSteps(spec: SkuBannerSpec, ids: LayerIds): Step[] {
  return [
    // The gradient becomes Gradient::<SKU> and moves inside the backdrop group.
    {
      id: "layer.setProps",
      params: {
        layer: ids.gradient,
        name: `Gradient::${spec.sku}`,
        visible: true, opacity: 1, blend: "Normal",
      },
    },
    { id: "layer.moveTo", params: { layer: ids.gradient, target: ids.background, position: "into" } },
    // The placed cutout becomes Product::<SKU>, lands on top of the gradient,
    // and is clipped to it: `layer.createClippingMask` clips to the layer
    // directly below, which is exactly the gradient after the move.
    {
      id: "layer.setProps",
      params: {
        layer: ids.product,
        name: `Product::${spec.sku}`,
        visible: true, opacity: 1, blend: "Normal",
      },
    },
    { id: "layer.moveTo", params: { layer: ids.product, target: ids.background, position: "into" } },
    { id: "layer.createClippingMask", params: { layer: ids.product } },
    // Type layers move into their groups; the groups get the contract flags.
    { id: "layer.moveTo", params: { layer: ids.headline, target: ids.headlineGroup, position: "into" } },
    {
      id: "layer.setProps",
      params: { layer: ids.headlineGroup, visible: true, opacity: 1, blend: "Normal" },
    },
    { id: "layer.moveTo", params: { layer: ids.price, target: ids.priceGroup, position: "into" } },
    {
      id: "layer.setProps",
      params: { layer: ids.priceGroup, visible: true, opacity: 1, blend: "Normal" },
    },
    // The grade sits directly above the headline group and clips to it. Moving
    // it first is what makes the clip target unambiguous: the layer below a
    // clipping mask is the clip base.
    { id: "layer.moveTo", params: { layer: ids.grade, target: ids.headlineGroup, position: "above" } },
    {
      id: "layer.setProps",
      params: {
        layer: ids.grade,
        name: "Grade::Vibrance",
        visible: true, opacity: 1, blend: "Normal",
      },
    },
    { id: "layer.createClippingMask", params: { layer: ids.grade } },
  ];
}

// ---------------------------------------------------------------------------
// 7. The driver: one MCP session, two batches per SKU, save, then audit.
// ---------------------------------------------------------------------------
export async function assembleAllSkus(
  skus: SkuBannerSpec[],
  opts: { readRoot: string; writeRoot: string }
): Promise<{ sku: string; status: "pass" | "fail"; detail?: string }[]> {
  // Validate SKUs against Zod (webhook-adjacent trust boundary).
  const validated = skus.map((s) => SkuBannerSpecSchema.parse(s));

  const transport = new StdioClientTransport({
    command: "photocraft-cli",
    args: [
      "mcp",
      "--automation-read-root", opts.readRoot,
      "--automation-write-root", opts.writeRoot,
    ],
  });
  const client = new Client({ name: "banner-assembler", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  const out: { sku: string; status: "pass" | "fail"; detail?: string }[] = [];

  try {
    for (const spec of validated) {
      // Fresh 1920×1080 RGB/8 document for every SKU so layering is
      // reproducible regardless of what a previous SKU left behind.
      await client.callTool({
        name: "doc_new",
        arguments: {
          width: spec.canvas.width, height: spec.canvas.height,
          mode: "rgb", depth: 8, background: "white",
        },
      });

      let created;
      try {
        created = await runBatch(client, creationSteps(spec));
      } catch (err) {
        out.push({ sku: spec.sku, status: "fail", detail: (err as Error).message });
        continue;
      }
      const ids: LayerIds = {
        background: layerIdOf(created[0]?.result, "layer.new.group"),
        gradient: layerIdOf(created[1]?.result, "layer.newFillLayer.gradient"),
        headlineGroup: layerIdOf(created[2]?.result, "layer.new.group"),
        headline: layerIdOf(created[3]?.result, "type.create"),
        priceGroup: layerIdOf(created[4]?.result, "layer.new.group"),
        price: layerIdOf(created[5]?.result, "type.create"),
        grade: layerIdOf(created[6]?.result, "layer.newAdjustmentLayer.hueSaturation"),
        product: 0, // replaced below by doc_place
      };

      // doc_place is a meta-tool, not a registry command: it embeds the cutout
      // as a smart object and creates the layer itself, which is why the
      // product layer is not part of the creation batch.
      try {
        const placed = await client.callTool({
          name: "doc_place",
          arguments: { path: spec.productCutoutPath, fit: true },
        });
        ids.product = layerIdOf(payload(placed), "doc_place");
      } catch (err) {
        out.push({ sku: spec.sku, status: "fail", detail: `placement: ${(err as Error).message}` });
        continue;
      }

      try {
        await runBatch(client, wiringSteps(spec, ids));
      } catch (err) {
        out.push({ sku: spec.sku, status: "fail", detail: (err as Error).message });
        continue;
      }

      // Save, then verify warnings are empty.
      const savePath = path.join(opts.writeRoot, spec.sku, "banner.psd");
      await mkdir(path.dirname(savePath), { recursive: true });
      const saved = await client.callTool({
        name: "doc_save",
        arguments: { path: savePath, format: "psd" },
      });
      const saveParsed = DocSaveResult.parse(payload(saved));
      if (saveParsed.warnings.length > 0) {
        out.push({
          sku: spec.sku, status: "fail",
          detail: `save warnings: ${saveParsed.warnings.join("; ")}`,
        });
        continue;
      }

      // Final contract audit.
      const inspection = await client.callTool({ name: "doc_inspect", arguments: {} });
      const verdict = auditAgainstContract(payload(inspection), spec.sku);
      out.push({
        sku: spec.sku, status: verdict.ok ? "pass" : "fail",
        detail: verdict.ok ? undefined : verdict.reason,
      });
    }
  } finally {
    await client.close();
  }
  return out;
}

// ---------------------------------------------------------------------------
// 8. Audit. Lives here for convenience; a real deployment would ship it as a
//    standalone checker (see Exercise 4 for the full auditor).
// ---------------------------------------------------------------------------
function auditAgainstContract(
  inspection: unknown, sku: string
): { ok: true } | { ok: false; reason: string } {
  type Node = { id: number; name: string; kind: string; clipped?: boolean; children?: Node[] };
  const roots = ((inspection as { layers?: Node[] }).layers ?? []);
  const flattened: { id: number; name: string; kind: string; clipped: boolean; parent?: string; belowName?: string }[] = [];

  (function walk(nodes: Node[], parent?: string) {
    nodes.forEach((n, index) => {
      flattened.push({
        id: n.id, name: n.name, kind: n.kind, clipped: !!n.clipped, parent,
        belowName: nodes[index + 1]?.name,
      });
      if (n.children?.length) walk(n.children, n.name);
    });
  })(roots);

  const bg = flattened.filter((l) => l.name === "Background" && l.kind === "Group");
  if (bg.length !== 1) return { ok: false, reason: `Background group count = ${bg.length}` };

  const products = flattened.filter((l) => l.name === `Product::${sku}`);
  const product = products[0];
  if (products.length !== 1 || !product)
    return { ok: false, reason: "Product layer missing" };
  if (!product.clipped)
    return { ok: false, reason: "Product layer is not clipped" };
  if (product.parent !== "Background" || product.belowName !== `Gradient::${sku}`)
    return { ok: false, reason: `Product clips to '${product.belowName ?? "nothing"}' instead of Gradient::${sku}` };

  const gradient = flattened.find((l) => l.name === `Gradient::${sku}`);
  if (!gradient) return { ok: false, reason: "Gradient layer missing" };
  if (gradient.parent !== "Background")
    return { ok: false, reason: `Gradient sits in '${gradient.parent ?? "the root"}', not Background` };

  const headlineGroup = flattened.find((l) => l.name === "Type::Headline" && l.kind === "Group");
  if (!headlineGroup) return { ok: false, reason: "Type::Headline group missing" };

  const priceGroup = flattened.find((l) => l.name === "Type::Price" && l.kind === "Group");
  if (!priceGroup) return { ok: false, reason: "Type::Price group missing" };

  const grade = flattened.find((l) => l.name === "Grade::Vibrance");
  if (!grade) return { ok: false, reason: "Grade::Vibrance adjustment missing" };
  if (!grade.clipped) return { ok: false, reason: "Grade::Vibrance is not clipped" };
  if (grade.belowName !== "Type::Headline")
    return { ok: false, reason: `Grade::Vibrance clips to '${grade.belowName ?? "nothing"}'` };

  return { ok: true };
}
