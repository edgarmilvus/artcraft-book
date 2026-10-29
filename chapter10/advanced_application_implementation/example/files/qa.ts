// gfx-factory/qa.ts
import OpenAI from "openai";
import { PhotoCraftMcpClient } from "./mcp-client.js";
import type { Composition } from "./recipe.js";

interface QaIssue {
  kind:
    | "headline-overflow"
    | "price-illegible"
    | "hero-clipped"
    | "contrast-fail"
    | "safe-zone-violation"
    | "brand-mismatch";
  note: string;
  severity: "low" | "medium" | "high";
}

interface QaVerdict {
  pass: boolean;
  issues: QaIssue[];
}

/** Structured schema so GPT-4o cannot free-form-answer. */
const RubricSchema = {
  name: "banner_qa_verdict",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pass: { type: "boolean" },
      issues: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "note", "severity"],
          properties: {
            kind: {
              type: "string",
              enum: [
                "headline-overflow",
                "price-illegible",
                "hero-clipped",
                "contrast-fail",
                "safe-zone-violation",
                "brand-mismatch",
              ],
            },
            note: { type: "string" },
            severity: { type: "string", enum: ["low", "medium", "high"] },
          },
        },
      },
    },
    required: ["pass", "issues"],
  },
} as const;

/**
 * Structural QA — runs before we spend a Vision call. It detects
 * geometric failure modes via explicit text-extents lookups so
 * the LLM is reserved for aesthetic judgment.
 */
async function structuralQa(
  mcp: PhotoCraftMcpClient,
  c: Composition
): Promise<QaIssue[]> {
  const issues: QaIssue[] = [];

  // Ask the engine for the render tree so we can inspect the
  // document without pixel-level heuristics.
  const doc = (await mcp.tool("doc_inspect", {})) as {
    layers?: Array<{
      name?: string;
      bounds?: { x: number; y: number; w: number; h: number };
      text?: string;
    }>;
  };

  const byName = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const layer of doc.layers ?? []) {
    if (layer.name && layer.bounds) byName.set(layer.name, layer.bounds);
  }

  const headline = byName.get("headline");
  if (headline) {
    const rightLimit = c.canvas.width - c.safe.right;
    if (headline.x + headline.w > rightLimit) {
      issues.push({
        kind: "headline-overflow",
        note: `headline extends to x=${headline.x + headline.w} past safe right=${rightLimit}`,
        severity: "high",
      });
    }
  }

  const price = byName.get("price");
  if (price) {
    if (price.y < 0 || price.y + price.h > c.canvas.height) {
      issues.push({
        kind: "safe-zone-violation",
        note: `price layer at y=${price.y} h=${price.h} escapes canvas`,
        severity: "high",
      });
    }
  }

  const hero = byName.get("hero");
  if (hero) {
    const inset =
      hero.x < 0 ||
      hero.y < 0 ||
      hero.x + hero.w > c.canvas.width ||
      hero.y + hero.h > c.canvas.height;
    if (inset) {
      issues.push({
        kind: "hero-clipped",
        note: `hero bounds ${JSON.stringify(hero)} extend past canvas`,
        severity: "medium",
      });
    }
  }

  return issues;
}

/**
 * Ask GPT-4o (Vision) to review a banner against a fixed rubric.
 * The rubric is intentionally narrow: aesthetic deltas we know
 * how to correct algorithmically.
 */
async function visionQa(
  openai: OpenAI,
  pngBase64: string,
  c: Composition
): Promise<QaVerdict> {
  const prompt = [
    "You are a senior brand QA reviewer for an e-commerce graphics team.",
    `Canvas: ${c.canvas.width}×${c.canvas.height}.`,
    `Headline text: "${c.product.headline ?? c.product.name}".`,
    `Price text: "${c.priceText}".`,
    `CTA: "${c.cta}".`,
    "Return JSON matching the banner_qa_verdict schema.",
    "Flag ONLY issues that a graphician would correct by moving, resizing, or restyling.",
    "Do not hallucinate text; use only the strings above.",
  ].join("\n");

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_schema", json_schema: RubricSchema },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${pngBase64}` },
          },
        ],
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) return { pass: false, issues: [] };
  return JSON.parse(raw) as QaVerdict;
}

/**
 * Apply automated corrections for the bounded set of issues we
 * know how to fix. Returns true if any correction issued.
 */
async function applyCorrections(
  mcp: PhotoCraftMcpClient,
  c: Composition,
  issues: QaIssue[]
): Promise<boolean> {
  let touched = false;
  for (const issue of issues) {
    switch (issue.kind) {
      case "headline-overflow": {
        // Reduce headline size by 8% and re-wrap. Bounded to
        // three passes so a pathological feed cannot loop.
        const smaller = Math.round(c.headlinePx * 0.92);
        await mcp.run("type.setStyle", {
          layers: ["headline"],
          size: smaller,
          tracking: -10,
        });
        touched = true;
        break;
      }
      case "price-illegible": {
        await mcp.run("layer.layerStyle.dropShadow", {
          color: "#000000",
          opacity: 45,
          distance: 2,
          size: 6,
          angle: 90,
        });
        touched = true;
        break;
      }
      case "hero-clipped": {
        await mcp.run("edit.transform", {
          // Scale hero inward by 4%
          rect: [0, 0, c.canvas.width, c.canvas.height],
          quad: [
            [0.04 * c.canvas.width, 0.04 * c.canvas.height],
            [0.96 * c.canvas.width, 0.04 * c.canvas.height],
            [0.96 * c.canvas.width, 0.96 * c.canvas.height],
            [0.04 * c.canvas.width, 0.96 * c.canvas.height],
          ],
        });
        touched = true;
        break;
      }
      case "safe-zone-violation": {
        // Not auto-corrected this pass — surface to the caller.
        break;
      }
      case "contrast-fail":
      case "brand-mismatch": {
        // Aesthetic: defer to brand team.
        break;
      }
    }
  }
  return touched;
}

/**
 * Run the full QA loop: preview → structural checks → vision
 * review → (optionally) corrections → re-preview. Capped at
 * `maxRounds` re-attempts to guarantee termination.
 */
export async function qaBanner(
  mcp: PhotoCraftMcpClient,
  openai: OpenAI,
  c: Composition,
  opts: { maxRounds?: number; skipVision?: boolean } = {}
): Promise<QaVerdict> {
  const maxRounds = opts.maxRounds ?? 2;
  let last: QaVerdict = { pass: false, issues: [] };

  for (let round = 0; round < maxRounds; round++) {
    const structural = await structuralQa(mcp, c);
    let verdict: QaVerdict = { pass: structural.length === 0, issues: structural };

    if (!opts.skipVision) {
      const prev = (await mcp.preview({ maxSide: 1024 })) as {
        content?: Array<{ type: string; data?: string }>;
        data?: string;
      };
      const data =
        prev.data ?? prev.content?.find((x) => x.type === "image")?.data;
      if (data) {
        const vision = await visionQa(openai, data, c);
        verdict = {
          pass: verdict.pass && vision.pass,
          issues: [...verdict.issues, ...vision.issues],
        };
      }
    }

    last = verdict;
    if (verdict.pass) return verdict;

    const corrected = await applyCorrections(mcp, c, verdict.issues);
    if (!corrected) return verdict; // no more moves
  }
  return last;
}
