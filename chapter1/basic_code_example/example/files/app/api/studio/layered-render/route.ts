// ---------------------------------------------------------------------------
// app/api/studio/layered-render/route.ts
//
// "Hello World" of the layered-generation pattern:
//   1. A free-text brief  →  2. a structured plan (Zod-validated JSON)
//   3. that plan          →  4. a MCP command_batch against PhotoCraft
//   5. the .pcraft file   →  6. a save, then an inspect for downstream agents
//
// The output is NOT a PNG. It is a .pcraft document whose layers,
// masks, text runs, and adjustment parameters are all still addressable.
// ---------------------------------------------------------------------------

import { NextResponse } from 'next/server';
import { generateObject } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// ---------------------------------------------------------------------------
// 1. THE CONTRACT
//
// The shape of what the LLM is allowed to say. Every field the model emits
// is a parameter we can hand to a discrete MCP command. Anything that
// cannot be expressed as a PhotoCraft command does not belong in the plan.
// ---------------------------------------------------------------------------

const hex = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb hex colour');

const CreativePlan = z.object({
  canvas: z.object({
    width: z.number().int().min(320).max(4096),
    height: z.number().int().min(320).max(4096),
  }),
  palette: z.object({
    background: hex,
    foreground: hex,
    accent: hex,
  }),
  headline: z.string().min(1).max(60),
  subhead: z.string().max(160),
  exposure: z.number().min(-1.5).max(1.5),   // stops
  contrast: z.number().min(-50).max(50),      // levels
});

type CreativePlan = z.infer<typeof CreativePlan>;

// ---------------------------------------------------------------------------
// 2. BRIEF  →  PLAN
//
// We ask the model for structured data only, never for prose and never for
// a picture. `generateObject` validates the shape on the way out, so a
// hallucinated JSON blob is rejected before it can poison the tool batch.
// ---------------------------------------------------------------------------

async function planFromBrief(brief: string): Promise<CreativePlan> {
  const { object } = await generateObject({
    model: openai(process.env.OPENAI_MODEL ?? 'gpt-4o-mini'),
    schema: CreativePlan,
    system: [
      'You are the art-director module of a design-tool SaaS.',
      'Return ONLY a structured brief. No prose. No markdown.',
      'Pick a restrained palette; keep the headline punchy.',
      'Exposure is in stops (roughly -1.5 to 1.5).',
      'Contrast is in levels (roughly -50 to 50).',
    ].join(' '),
    prompt: `Product brief: ${brief}`,
  });
  return object;
}

// ---------------------------------------------------------------------------
// 3. THE MCP BRIDGE
//
// One helper that owns the lifecycle of a stdio MCP session against
// photocraft-cli. The engine is headless: no window, no GPU, no user.
// Read/write roots are pinned to the working directory so the automation
// sandbox cannot wander outside the SaaS job's scratch space.
// ---------------------------------------------------------------------------

async function withPhotoCraft<T>(
  fn: (mcp: Client) => Promise<T>,
): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.env.PHOTOCRAFT_BIN ?? 'photocraft-cli',
    args: [
      'mcp',
      '--automation-read-root',  process.cwd(),
      '--automation-write-root', process.cwd(),
    ],
  });

  const mcp = new Client(
    { name: 'studio-layered-render', version: '1.0.0' },
    { capabilities: {} },
  );

  await mcp.connect(transport);
  try {
    return await fn(mcp);
  } finally {
    await mcp.close();
  }
}

// ---------------------------------------------------------------------------
// 4. THE ROUTE
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  const { brief, outputName = 'studio-render' } =
    (await req.json()) as { brief: string; outputName?: string };

  // 4a. Brief → plan. This is the only LLM call in the whole request.
  const plan = await planFromBrief(brief);

  // 4b. Plan → layered document, executed inside a single MCP session.
  const result = await withPhotoCraft(async (mcp) => {
    // Fresh RGB 8-bit canvas.
    await mcp.callTool({
      name: 'doc_new',
      arguments: {
        width: plan.canvas.width,
        height: plan.canvas.height,
        mode: 'rgb',
        depth: 8,
        background: plan.palette.background,
        name: outputName,
      },
    });

    // Every visual decision becomes a discrete, re-openable layer.
    await mcp.callTool({
      name: 'command_batch',
      arguments: {
        steps: [
          // Background as a *fill layer*, not baked pixels.
          {
            id: 'layer.newFillLayer.solidColor',
            params: { color: plan.palette.background },
          },
          // Accent block as a live, editable shape layer.
          {
            id: 'shape.create',
            params: {
              kind: 'roundedRect',
              rect: [
                Math.round(plan.canvas.width * 0.07),
                Math.round(plan.canvas.height * 0.12),
                Math.round(plan.canvas.width * 0.86),
                Math.round(plan.canvas.height * 0.76),
              ],
              radii: 48,
              fill: plan.palette.accent,
              stroke: null,
              name: 'Accent Panel',
            },
          },
          // Headline as live type — the string stays editable.
          {
            id: 'type.create',
            params: {
              x: Math.round(plan.canvas.width * 0.11),
              y: Math.round(plan.canvas.height * 0.35),
              text: plan.headline,
              font: 'Inter',
              size: Math.round(plan.canvas.height * 0.09),
              color: plan.palette.foreground,
            },
          },
          // Sub-headline as its own type layer.
          {
            id: 'type.create',
            params: {
              x: Math.round(plan.canvas.width * 0.11),
              y: Math.round(plan.canvas.height * 0.51),
              text: plan.subhead,
              font: 'Inter',
              size: Math.round(plan.canvas.height * 0.032),
              color: plan.palette.foreground,
            },
          },
          // Exposure + contrast as an adjustment layer, not a raster pass.
          {
            id: 'layer.newAdjustmentLayer.brightnessContrast',
            params: {
              brightness: Math.round(plan.exposure * 100),
              contrast: Math.round(plan.contrast),
            },
          },
        ],
      },
    });

    // Persist as a *native* document, not a screenshot.
    const saved = await mcp.callTool({
      name: 'doc_save',
      arguments: { path: `${outputName}.pcraft` },
    });

    // Hand the agent tree back to the caller. The next revision cycle
    // can address any node by id without re-running the LLM.
    const inspection = await mcp.callTool({
      name: 'doc_inspect',
      arguments: {},
    });

    return { saved, inspection };
  });

  return NextResponse.json({
    ok: true,
    plan,
    document: `${outputName}.pcraft`,
    inspection: result.inspection,
  });
}
