/**
 * @file app/api/briefs/route.ts
 *
 * HTTP entry point for the SaaS. Tenant auth is expected to have already
 * been resolved by middleware; `req.headers.get('x-tenant-id')` is
 * trustworthy by the time we reach here.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { runBrief } from '@/creativeforge/agent-loop';
import type { CraftApp } from '@/creativeforge/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  brief: z.string().min(1).max(8_000),
  apps: z.array(z.enum([
    'photocraft', 'vectorcraft', 'filmcraft', 'effectcraft',
    'designcraft', 'lightcraft', 'pdfcraft', 'wordcraft',
  ])).min(1),
  visualAttach: z.boolean().default(false),
});

export async function POST(req: NextRequest) {
  const tenantId = req.headers.get('x-tenant-id');
  if (!tenantId) {
    return new Response('missing tenant', { status: 401 });
  }

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const say = (ev: string, data: unknown) =>
        controller.enqueue(
          encoder.encode(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`),
        );

      say('status', { phase: 'starting' });
      try {
        const out = await runBrief(
          tenantId,
          parsed.data.brief,
          parsed.data.apps as CraftApp[],
          parsed.data.visualAttach,
        );
        say('status', { phase: 'complete' });
        say('result', out);
      } catch (err) {
        say('error', {
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}
