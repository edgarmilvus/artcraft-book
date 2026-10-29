// llm-layered-render.mjs — Chapter 1, Basic example: the brief → plan →
// MCP batch pipeline from app/api/studio/layered-render/route.ts, run
// outside Next.js against the real engine.
//
//   OPENROUTER_API_KEY=… node examples/llm-layered-render.mjs
//
// The only changes vs the route: the model is the OpenRouter deepseek slug
// (the route hard-codes openai('gpt-4o-mini')) and `doc_save` gets an absolute
// path (automation resolves relative paths against the process cwd).
import { generateObject } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.env.RUN_OUTPUT ?? resolve(here, '..', '..', 'output');
await mkdir(outDir, { recursive: true });

const key = process.env.OPENROUTER_API_KEY;
if (!key) { console.error('OPENROUTER_API_KEY is not set'); process.exit(1); }
const openrouter = createOpenAI({
  baseURL: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
  apiKey: key,
});
const MODEL = process.env.OPENROUTER_MODEL ?? 'deepseek/deepseek-v4.1-flash';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb hex colour');
const CreativePlan = z.object({
  canvas: z.object({ width: z.number().int().min(320).max(4096), height: z.number().int().min(320).max(4096) }),
  palette: z.object({ background: hex, foreground: hex, accent: hex }),
  headline: z.string().min(1).max(60),
  subhead: z.string().max(160),
  exposure: z.number().min(-1.5).max(1.5),
  contrast: z.number().min(-50).max(50),
});

const flags = [];
const log = [];
const ok = (l, d = '') => { log.push({ step: l, ok: true, detail: d }); console.log(` ok  ${l.padEnd(30)}${d}`); };
const bad = (l, d) => { log.push({ step: l, ok: false, detail: String(d) }); console.log(`FAIL ${l.padEnd(30)}${d}`); };
const check = (l, c, d = '') => c ? ok(l, d) : bad(l, d);

// ── 1 — brief → plan (the only LLM call) ────────────────────────────────────
const BRIEF = process.env.BRIEF ?? 'flash sale banner for a stoneware mug';
const t0 = Date.now();
const { object: plan, usage } = await generateObject({
  model: openrouter(MODEL),
  schema: CreativePlan,
  system: [
    'You are the art-director module of a design-tool SaaS.',
    'Return ONLY a structured brief. No prose. No markdown.',
    'Pick a restrained palette; keep the headline punchy.',
    'Exposure is in stops (roughly -1.5 to 1.5).',
    'Contrast is in levels (roughly -50 to 50).',
  ].join(' '),
  prompt: `Product brief: ${BRIEF}`,
});
check('LLM brief → plan', Boolean(plan), `${Date.now() - t0} ms, tokens=${usage?.totalTokens ?? '?'}`);
console.log('   plan:', JSON.stringify(plan));

// ── 2 — plan → layered document (single MCP session) ────────────────────────
const mcp = new Client({ name: 'studio-layered-render', version: '1.0.0' }, { capabilities: {} });
await mcp.connect(new StdioClientTransport({
  command: process.env.PHOTOCRAFT_BIN ?? 'photocraft-cli',
  args: ['mcp', '--automation-read-root', outDir, '--automation-write-root', outDir],
}));
const call = async (name, args) => {
  const r = await mcp.callTool({ name, arguments: args ?? {} });
  const text = r.content?.find((c) => c.type === 'text')?.text;
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { isError: r.isError, text, data, images: r.content?.filter((c) => c.type === 'image') ?? [] };
};

await call('doc_new', {
  width: plan.canvas.width, height: plan.canvas.height, mode: 'rgb', depth: 8,
  background: plan.palette.background, name: 'studio-render',
});

const batch = await call('command_batch', {
  steps: [
    { id: 'layer.newFillLayer.solidColor', params: { color: plan.palette.background } },
    {
      id: 'shape.create',
      params: {
        kind: 'roundedRect',
        rect: [
          Math.round(plan.canvas.width * 0.07), Math.round(plan.canvas.height * 0.12),
          Math.round(plan.canvas.width * 0.86), Math.round(plan.canvas.height * 0.76),
        ],
        radii: 48, fill: plan.palette.accent, stroke: null, name: 'Accent Panel',
      },
    },
    {
      id: 'type.create',
      params: {
        x: Math.round(plan.canvas.width * 0.11), y: Math.round(plan.canvas.height * 0.35),
        text: plan.headline, font: 'Inter', size: Math.round(plan.canvas.height * 0.09), color: plan.palette.foreground,
      },
    },
    {
      id: 'type.create',
      params: {
        x: Math.round(plan.canvas.width * 0.11), y: Math.round(plan.canvas.height * 0.51),
        text: plan.subhead, font: 'Inter', size: Math.round(plan.canvas.height * 0.032), color: plan.palette.foreground,
      },
    },
    {
      id: 'layer.newAdjustmentLayer.brightnessContrast',
      params: { brightness: Math.round(plan.exposure * 100), contrast: Math.round(plan.contrast) },
    },
  ],
});
const failed = batch.data?.results?.filter((r) => !r.ok) ?? [];
check('MCP command_batch', batch.data?.failed === 0, `${batch.data?.completed}/${batch.data?.steps?.length ?? 5} steps`);
for (const f of failed) flags.push(`batch step rejected: ${JSON.stringify(f).slice(0, 140)}`);

const out = resolve(outDir, 'studio-render.pcraft');
await call('doc_save', { path: out });
const insp = await call('doc_inspect');
check('doc_save .pcraft', !insp.isError, out);
const layers = insp.data?.layers ?? [];
check('layers addressable', layers.length >= 4, layers.map((l) => `${l.id}:${l.kind}`).join(' '));

const png = await call('doc_render_preview', { max_side: 1024 });
if (png.images?.[0]) await writeFile(resolve(outDir, 'studio-render.png'), Buffer.from(png.images[0].data, 'base64'));

await writeFile(resolve(outDir, 'plan.json'), JSON.stringify({ model: MODEL, brief: BRIEF, plan, usage }, null, 2));
await writeFile(resolve(outDir, 'inspect.json'), JSON.stringify(insp.data, null, 2));
await writeFile(resolve(outDir, 'run-log.json'), JSON.stringify({ model: MODEL, flags, log }, null, 2));
await mcp.close();
console.log(`\n${log.filter((x) => !x.ok).length} failing check(s); artifacts in ${outDir}`);
