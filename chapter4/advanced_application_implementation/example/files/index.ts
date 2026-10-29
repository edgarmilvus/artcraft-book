// src/index.ts
/**
 * Entry point. Boots a loopback session against PhotoCraft, wires it into
 * an MCP bridge on stdio, and demonstrates a vision-driven edit.
 *
 * Environment:
 *   PHOTOCRAFT_TOKEN   — 64-hex auth token (required)
 *   PHOTOCRAFT_PORT    — default 7878
 *   MCP_ENABLED        — "1" to serve MCP on stdio
 *   VISION_ENABLED     — "1" to run the demonstration loop
 */
import { CraftControlSession } from './session.js';
import { runMcpBridgeOnStdio } from './mcp-bridge.js';
import {
  runVisionLoop,
  type VisionAuditor,
} from './vision-loop.js';

async function main(): Promise<void> {
  const token = process.env.PHOTOCRAFT_TOKEN ?? '';
  const port = Number(process.env.PHOTOCRAFT_PORT ?? 7878);

  if (!/^[0-9a-fA-F]{64}$/.test(token)) {
    throw new Error(
      'PHOTOCRAFT_TOKEN must be a 64-hex-character shared secret',
    );
  }

  // 1. Bring the channel up. Reconnects automatically for the process
  //    lifetime; failures surface on the `warn` and `fatal` events.
  const session = new CraftControlSession({
    host: '127.0.0.1',
    port,
    token,
    challengeResponse: true,
    requestTimeoutMs: 30_000,
    heartbeatIntervalMs: 15_000,
    heartbeatTimeoutMs: 5_000,
    reconnectBaseMs: 250,
    reconnectMaxMs: 30_000,
    readRoot: process.env.READ_ROOT,
    writeRoot: process.env.WRITE_ROOT,
  });

  session.on('warn', (err) => console.warn('[session]', err.message));
  session.on('fatal', (err) => console.error('[session fatal]', err.message));
  session.on('event', (frame) => {
    // Long-running jobs (filters, Content-Aware Fill) report progress on
    // the `event` channel. Route them to your telemetry pipeline here.
    if (frame.event === 'progress') {
      console.log('[progress]', frame.params);
    }
  });

  await session.connect();

  // 2. Optional: run the MCP bridge on stdio so agent swarms can share
  //    this exact engine session.
  if (process.env.MCP_ENABLED === '1') {
    void runMcpBridgeOnStdio(session);
  }

  // 3. Optional: demonstrate a multimodal correction loop.
  if (process.env.VISION_ENABLED === '1') {
    const auditor: VisionAuditor = async (_png, ctx) => {
      // Replace with a real call to GPT-4o / Claude / Gemini.
      // The contract is strict: return `{ status: 'ok' }` or
      // `{ status: 'fix', command, params }`.
      if (ctx.iteration >= 1) return { status: 'ok' };
      return {
        status: 'fix',
        command: 'layer.newAdjustmentLayer.levels',
        params: { gamma: 1.15 },
        rationale: 'Shadows are slightly clipped.',
      };
    };

    await session.executeCommand('layer.newAdjustmentLayer.curves', {
      points: [
        [0, 0],
        [64, 40],
        [192, 215],
        [255, 255],
      ],
    });
    const result = await runVisionLoop(session, auditor, {
      maxIterations: 3,
      verbose: true,
    });
    console.log('[vision-loop] done', result);
  }
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
