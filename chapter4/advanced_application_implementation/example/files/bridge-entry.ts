/**
 * Child process for the bridge harness: one engine session, exposed as an
 * MCP server on stdio — the deployment shape the chapter argues for, where
 * many agents share one authenticated engine process.
 */
import { randomBytes } from 'node:crypto';
import { EngineStub } from '../../../_harness/engine-stub.js';
import { CraftControlSession } from './session.js';
import { runMcpBridgeOnStdio } from './mcp-bridge.js';

async function main(): Promise<void> {
  const port = Number(process.env.RUN_PORT ?? 7902);
  const token = randomBytes(32).toString('hex');

  const stub = new EngineStub({ port, token, challenge: true });
  await stub.start();

  const session = new CraftControlSession({ port, token, challengeResponse: true });
  await session.connect();

  const shutdown = async () => {
    session.close('stdin closed');
    await stub.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.stdin.on('close', () => void shutdown());

  // Takes over stdio: from here the process speaks MCP, not logs.
  await runMcpBridgeOnStdio(session);
}

main().catch((e) => {
  console.error('bridge-entry failed:', e);
  process.exit(1);
});
