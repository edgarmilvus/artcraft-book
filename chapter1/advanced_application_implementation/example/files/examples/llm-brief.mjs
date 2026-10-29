// llm-brief.mjs — Chapter 1, Advanced example: the streaming art-direction
// brief from app/api/art/brief/route.ts ("File 9/9 part A"), run outside
// Next.js.
//
//   OPENROUTER_API_KEY=… node examples/llm-brief.mjs
//
// Only change vs the route: the model is the OpenRouter deepseek slug.
import { streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
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

const BRIEF_SYSTEM = [
  'You are an art director writing a production brief for a layered image pipeline.',
  'Reply with plain text only. No markdown fences, no bullet symbols, no preamble.',
  'Cover, in this exact order, one short paragraph each:',
  '1. Composition — subject placement, negative space, aspect intent.',
  '2. Palette — 3 to 5 hex colours with their roles.',
  '3. Light — key direction, contrast intent, highlight protection notes.',
  '4. Typography — family, weight, size ratio to canvas height, alignment.',
  '5. Grading — the single most important tone decision and why.',
].join('\n');

const description = (process.env.PROMPT ?? 'A moody still life of three ceramic mugs on a linen cloth').trim();

// The book's route caps the stream at maxOutputTokens: 700. That is fine for
// gpt-4o-mini, but deepseek-v4.1-flash is a reasoning model: at 700 the whole
// budget goes to reasoning_tokens and the visible brief comes back empty.
const MAX_OUT = Number(process.env.MAX_OUTPUT_TOKENS ?? 3000);

const t0 = Date.now();
const result = streamText({
  model: openrouter(MODEL),
  system: BRIEF_SYSTEM,
  prompt: description,
  temperature: 0.4,
  maxOutputTokens: MAX_OUT,
});

let text = '';
let firstChunkMs = null;
for await (const chunk of result.textStream) {
  if (firstChunkMs === null) firstChunkMs = Date.now() - t0;
  text += chunk;
}
// AI SDK v7: `textStream` can be empty if the stream is consumed lazily by the
// provider; `result.text` resolves to the full text either way.
if (!text) text = await result.text;
const usage = await result.usage;

const sections = ['Composition', 'Palette', 'Light', 'Typography', 'Grading'].filter((k) => text.includes(k)).length;
const flags = [];
if (MAX_OUT !== 700) flags.push('maxOutputTokens:700 (the book\'s value) truncates a reasoning model mid-reasoning and returns an empty brief; raised to ' + MAX_OUT);
if (sections === 5 && !/^\s*1\./m.test(text)) flags.push('the model follows the section order but drops the "1./2./…" numbering the system prompt asks for, so a numbered-list parser finds no sections');
const log = {
  model: MODEL, prompt: description, source: 'app/api/art/brief/route.ts',
  first_chunk_ms: firstChunkMs, total_ms: Date.now() - t0, chars: text.length,
  usage, sections_found: sections, flags,
};
console.log(` ok  streamText        first chunk ${firstChunkMs} ms, ${Date.now() - t0} ms total, ${text.length} chars`);
console.log(` ok  plain-text brief  ${sections}/5 numbered sections, tokens=${usage?.totalTokens ?? '?'}`);
console.log(`\n--- brief (${text.length} chars) ---\n${text}`);

await writeFile(resolve(outDir, 'brief.txt'), text);
await writeFile(resolve(outDir, 'run-log.json'), JSON.stringify(log, null, 2));
console.log(`\nartifacts in ${outDir}`);
