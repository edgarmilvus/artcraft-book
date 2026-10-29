// ─── src/audit.ts ────────────────────────────────────────────────────────────
import OpenAI from 'openai';
import { Critique, CritiqueSchema, DesignBrief, Finding } from './contracts.js';

/* ------------------------------------------------------------------ *
 * The system prompt is the single most important asset in this file.
 * It encodes the audit vocabulary, the JSON contract, and the
 * behavioural guardrails (conservative, region-aware, non-speculative).
 * ------------------------------------------------------------------ */
const AUDIT_SYSTEM_PROMPT = `You are a senior art director performing a
structured quality audit of a rendered e-commerce product frame.

You DO NOT edit images. You PRODUCE a JSON critique that a downstream
deterministic compiler will translate into adjustment layer commands.

Rules:
1. Return ONLY valid JSON matching the provided schema.
2. Report at most 12 findings. Order by severity: block, warn, info.
3. Never invent issues. If the frame is acceptable, say so with verdict "pass".
4. "block" is reserved for defects that would embarrass the brand:
   clipped highlights/shadows on hero subject, wrong aspect ratio, garbled text.
5. "warn" covers fixable aesthetics: colour cast, muddy midtones, weak
   subject separation, banal composition.
6. "info" covers polish: micro-contrast, subtle vignette opportunity,
   negative-space tightening.
7. Confidence is a 0..1 number describing how certain you are in your verdict.
   Below 0.55, prefer "escalate" over "revise".
8. Corrections are SUGGESTIONS expressed in plain vocabulary. The compiler
   maps your findings into commands; you do not need to know the commands.`;

/* ------------------------------------------------------------------ *
 * The context bundle passed alongside the image.
 * ------------------------------------------------------------------ */
export interface AuditContext {
  brief: DesignBrief;
  channel: { width: number; height: number };
  cycleIndex: number;
  priorFindings?: Finding[];
}

/** One multimodal completion request. Injected so the loop can be tested. */
export interface VisionRequest {
  system: string;
  userText: string;
  pngBase64: string;
}

export interface VisionClient {
  complete(request: VisionRequest): Promise<string>;
}

/** Anything that can audit a frame: GPT-4o, a local VLM, a test double. */
export type AuditFn = (pngBase64: string, ctx: AuditContext) => Promise<Critique>;

/**
 * GPT-4o implementation. The client is constructed on first use, so
 * importing this module never requires a key — only auditing does.
 */
export function createOpenAiVision(apiKey = process.env.OPENAI_API_KEY): VisionClient {
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  const client = new OpenAI({ apiKey });
  return {
    async complete(request: VisionRequest): Promise<string> {
      const response = await client.chat.completions.create({
        model: 'gpt-4o',
        temperature: 0.15,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: request.system },
          {
            role: 'user',
            content: [
              { type: 'text', text: request.userText },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/png;base64,${request.pngBase64}`,
                  detail: 'high',
                },
              },
            ],
          },
        ],
      });
      return response.choices[0]?.message?.content ?? '';
    },
  };
}

let sharedVision: VisionClient | null = null;

/** Process-wide default auditor, built on first call. */
export function defaultVisionClient(): VisionClient {
  return (sharedVision ??= createOpenAiVision());
}

/** Bind a vision client to the audit function — the loop's injection seam. */
export function makeAudit(vision: VisionClient): AuditFn {
  return (pngBase64, ctx) => auditFrame(pngBase64, ctx, vision);
}

const SEVERITY_ORDER: Record<Finding['severity'], number> = {
  block: 0,
  warn: 1,
  info: 2,
};

/**
 * Perform one vision audit pass. The image is provided as base64 PNG
 * captured from the headless render (`doc_render_preview`).
 *
 * @param imageBase64 Base64 PNG — no data: prefix.
 * @param ctx         Context bundle.
 * @param vision      Vision client; defaults to GPT-4o.
 * @returns           A validated Critique object.
 * @throws            If the reply is not JSON or fails schema validation.
 */
export async function auditFrame(
  imageBase64: string,
  ctx: AuditContext,
  vision: VisionClient = defaultVisionClient(),
): Promise<Critique> {
  const brief = ctx.brief;

  const userText = [
    `CHANNEL: ${brief.channelProfile} (${ctx.channel.width}×${ctx.channel.height})`,
    `BRAND TONE: ${brief.brandKit.tone}`,
    `PRIMARY BRAND HEX: ${brief.brandKit.primaryHex}`,
    `FORBIDDEN HEXES: ${brief.brandKit.forbiddenHex.join(', ') || '(none)'}`,
    `CYCLE: ${ctx.cycleIndex}`,
    ctx.priorFindings?.length
      ? `PRIOR FINDINGS (do not repeat if the frame has changed for the better):\n` +
        ctx.priorFindings.map((f) => `- [${f.severity}] ${f.axis}: ${f.message}`).join('\n')
      : `No prior findings.`,
    `Audit this frame. Return JSON only.`,
  ].join('\n');

  const raw = await vision.complete({
    system: AUDIT_SYSTEM_PROMPT,
    userText,
    pngBase64: imageBase64,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `audit: vision model returned malformed JSON (${(err as Error).message}): ` +
        raw.slice(0, 200),
    );
  }

  // Schema validation is the firewall — a hallucinated field never
  // survives this call.
  const result = CritiqueSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`audit: schema violation: ${result.error.message}`);
  }

  // The prompt asks for at most 12 findings, ordered by severity. Enforce
  // both properties here instead of trusting the model to comply.
  const findings = [...result.data.findings]
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .slice(0, 12);

  return { ...result.data, findings };
}
