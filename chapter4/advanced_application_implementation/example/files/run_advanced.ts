/**
 * Harness for the chapter-4 advanced example.
 *
 * The book's control channel is a loopback TCP protocol: NDJSON frames,
 * `auth` handshake, `system.ping` heartbeat, `engine.execute` commands.
 * No shipped CLI speaks that protocol (they serve MCP over stdio), so the
 * runner stands up a *protocol-faithful* engine stub and drives the real
 * `CraftControlSession` against it. Everything under test is the book's
 * code; only the peer is local.
 *
 *   tsx run_advanced.ts
 */
import { randomBytes } from 'node:crypto';
import { CraftControlSession } from './session.js';
import { runVisionLoop, type VisionAuditor } from './vision-loop.js';

const ok = (label: string, cond: boolean, detail = ''): boolean => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label.padEnd(38)}${detail}`);
  return cond;
};

import { EngineStub } from '../../../_harness/engine-stub.js';

// ─── the run ────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const port = Number(process.env.RUN_PORT ?? 7901);
  const token = randomBytes(32).toString('hex');
  const challenge = process.env.CHALLENGE !== '0';
  const stub = new EngineStub({ port, token, challenge });
  await stub.start();

  const checks: boolean[] = [];
  const session = new CraftControlSession({
    port,
    token: challenge ? token : token,
    challengeResponse: challenge,
    heartbeatIntervalMs: 250,
    heartbeatTimeoutMs: 1_000,
  });

  session.on('warn', (e) => console.log('  warn:', e.message));
  let lastState = '';
  session.on('state', (s) => { lastState = s; console.log('  state:', s); });

  await session.connect();
  checks.push(ok('handshake (challenge-response)', lastState === 'ready', `state=${lastState}`));

  const doc = await session.executeCommand<{ document: { width: number }; layers: unknown[] }>('doc.inspect');
  checks.push(ok('engine.execute doc.inspect', doc.document.width === 1920, `${doc.layers.length} layers`));

  const layer = await session.executeCommand<{ id: number; name: string }>('layer.new.layer', { name: 'Ink' });
  checks.push(ok('engine.execute layer.new.layer', layer.name === 'Ink', `id=${layer.id}`));

  const batch = await session.executeBatch<{ applied: unknown[] }>([
    { id: 'layer.new.layer', params: { name: 'Type' } },
    { id: 'layer.new.layer', params: { name: 'Badge' } },
  ]);
  checks.push(ok('engine.batch (2 steps)', batch.applied.length === 2, `layers=${stub.layers.length}`));

  const shot = await session.screenshot({ maxSide: 512 });
  checks.push(ok('ui.screenshot', shot.dataBase64.startsWith('iVBOR'), `${shot.dataBase64.length} b64 chars`));

  // Vision loop: auditors are caller-supplied; this one asks for one fix.
  let audits = 0;
  const auditor: VisionAuditor = async (_png, ctx) => {
    audits++;
    console.log(`  audit #${ctx.iteration}: ${audits === 1 ? 'fix' : 'ok'}`);
    return audits === 1
      ? { status: 'fix', command: 'layer.new.layer', params: { name: 'Contrast' }, rationale: 'flat render' }
      : { status: 'ok' };
  };
  await new Promise((r) => setTimeout(r, 900));   // let the heartbeat fire twice
  const loop = await runVisionLoop(session, auditor, { maxIterations: 4, verbose: false });
  checks.push(ok('vision loop applies one fix', audits === 2 && loop.iterations === 2, `iterations=${loop.iterations}`));

  session.close('done');
  await stub.stop();

  const pinged = stub.calls.filter((c) => c === 'system.ping').length;
  checks.push(ok('heartbeat observed', pinged >= 1, `pings=${pinged} calls=${stub.calls.length}`));

  const failed = checks.filter((c) => !c).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
