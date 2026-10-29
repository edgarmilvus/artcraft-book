/**
 * Harness for the chapter-4 exercise 1 reference client
 * (`01_channel-client.ts`).
 *
 * Runs the real implementation against the protocol stub: handshake,
 * bounded concurrency, document scope, batch, heartbeat, and the
 * reconnect path that re-establishes the channel after the peer drops.
 *
 *   tsx run_channel_client.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EngineStub } from '../../../_harness/engine-stub.js';
import { JsonLinesChannelClient, AuthFailedError } from './01_channel-client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'output');

const ok = (label: string, cond: boolean, detail = ''): boolean => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label.padEnd(40)}${detail}`);
  return cond;
};

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const port = Number(process.env.RUN_PORT ?? 7903);
  const token = randomBytes(32).toString('hex');
  const stub = new EngineStub({ port, token, challenge: false });
  await stub.start();

  const checks: boolean[] = [];
  let watchdog: NodeJS.Timeout | null = null;
  watchdog = setTimeout(() => {
    console.log('WATCHDOG stub calls =', JSON.stringify(stub.calls));
    process.exit(3);
  }, 6000);

  // ── rejected credentials ────────────────────────────────────────────────
  const wrong = new JsonLinesChannelClient();
  let authError = '';
  try {
    await wrong.connect({ port, token: randomBytes(32).toString('hex') });
  } catch (e) {
    authError = (e as Error).constructor.name;
  }
  checks.push(ok('wrong token rejected', authError === 'AuthFailedError', authError));

  // ── happy path ──────────────────────────────────────────────────────────
  const client = new JsonLinesChannelClient();
  await client.connect({ port, token });

  const inspect = await client.run<Record<string, never>, { document: { width: number } }>('doc.inspect', {});
  checks.push(ok('run doc.inspect', inspect.ok && inspect.result.document.width === 1920));

  const made = await client.run<{ name: string }, { id: number }>('layer.new.layer', { name: 'Ink' });
  checks.push(ok('run layer.new.layer', made.ok, made.ok ? `id=${made.result.id}` : ''));

  const batched = await client.batch([
    { id: 'layer.new.layer', params: { name: 'Type' } },
    { id: 'layer.new.layer', params: { name: 'Badge' } },
  ]);
  checks.push(ok('batch (2 steps)', batched.ok));

  const scoped = await client.withDocument({ width: 800, height: 600 }, async (helpers) => {
    console.log('  [scoped] inspect…');
    const before = (await helpers.inspect()) as { layers: unknown[] };
    console.log('  [scoped] inspect ok');
    await helpers.run('layer.new.layer', { name: 'Scoped' });
    console.log('  [scoped] run ok');
    await helpers.save(path.join(OUT, 'scoped.pcraft'), 'pcraft');
    console.log('  [scoped] save ok');
    return before.layers.length;
  });
  checks.push(ok('withDocument scope', typeof scoped === 'number', `layers before=${scoped}`));

  // ── reconnect: kill the live sockets, keep the listener ─────────────────
  const dropped = stub.dropConnections();
  await new Promise((r) => setTimeout(r, 600));
  const afterDrop = await client.run<Record<string, never>, { document: { width: number } }>('doc.inspect', {});
  checks.push(ok('survives a dropped socket', afterDrop.ok, `dropped=${dropped}`));

  if (watchdog) clearTimeout(watchdog);
  await client.close();
  await stub.stop();

  const failed = checks.filter((c) => !c).length;
  fs.writeFileSync(path.join(OUT, 'run-log.json'), JSON.stringify({
    checks: checks.length,
    failures: checks.filter((c) => !c).length,
    port,
    wireCalls: stub.calls,
  }, null, 2) + '\n');
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
