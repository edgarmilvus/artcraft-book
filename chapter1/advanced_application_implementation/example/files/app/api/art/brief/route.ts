// ═══════════════════════════════════════════════════════════════════════════
// FILE 9/9 (part A) — app/api/art/brief/route.ts
// Streams a single, non-conversational art-direction brief.
// ═══════════════════════════════════════════════════════════════════════════

import { streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** The system prompt is the contract: one artifact, no conversation. */
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

export async function POST(req: Request): Promise<Response> {
  const { prompt } = (await req.json()) as { prompt?: string };
  const description = (prompt ?? '').trim();
  if (description.length === 0) {
    return new Response('prompt is required', { status: 400 });
  }

  const model = createOpenAI({
    apiKey: process.env.OPENAI_COMPATIBLE_API_KEY,
    baseURL: process.env.OPENAI_COMPATIBLE_BASE_URL,
  })(process.env.OPENAI_COMPATIBLE_MODEL!);

  const result = streamText({
    model,
    system: BRIEF_SYSTEM,
    prompt: description,
    temperature: 0.4,
    // 700 is ample for a small chat model but starves a reasoning model: the
    // whole budget goes to reasoning tokens and the visible stream comes back
    // empty. Raise this if your model thinks before it answers.
    maxOutputTokens: Number(process.env.OPENAI_COMPATIBLE_MAX_OUTPUT_TOKENS ?? 700),
  });

  return result.toTextStreamResponse();
}
