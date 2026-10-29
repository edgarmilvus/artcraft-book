/**
 * Harness for the router's four rules, independent of any model.
 * Rules 1–3 never touch an engine; rule 4 makes one real doc_new call.
 */
import { strict as assert } from 'node:assert';
import { ClientPool } from './src/pool.js';
import { Session } from './src/session.js';
import { ToolRouter, type ToolCall } from './src/router.js';

const router = new ToolRouter(new ClientPool());
const session = await Session.create('tenant-router-test', false);

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${err instanceof Error ? err.message : err}`);
  }
}

const call = (c: Record<string, unknown>) => c as unknown as ToolCall;

console.log('router rules\n');

await check('rule 1: ui_screenshot is refused without the entitlement', async () => {
  const r = await router.dispatch(session, call({ app: 'photocraft', tool: 'ui_screenshot', args: {} }));
  assert.equal(r.ok, false);
  assert.match(r.error!, /not provisioned for Visual Attach/);
});

await check('rule 2: schema violation is rejected before routing', async () => {
  const r = await router.dispatch(session, call({ app: 'photocraft', tool: 'doc_new', args: { width: -5 } }));
  assert.equal(r.ok, false);
  assert.match(r.error!, /invalid arguments for doc_new/);
});

await check('rule 2: an undeclared tool name is rejected, not a crash', async () => {
  const r = await router.dispatch(session, call({ app: 'photocraft', tool: 'rm_rf', args: {} }));
  assert.equal(r.ok, false);
  assert.match(r.error!, /unknown tool rm_rf/);
});

await check('rule 3: ambiguous tool with no app is refused', async () => {
  const r = await router.dispatch(session, call({ app: null, tool: 'execute', args: { command: 'layer.flatten' } }));
  assert.equal(r.ok, false);
  assert.match(r.error!, /cannot route execute/);
});

await check('rule 4: doc_new is routed to its default app and executed', async () => {
  const r = await router.dispatch(session, call({ app: null, tool: 'doc_new', args: { width: 640, height: 480 } }));
  assert.equal(r.ok, true, r.error ?? '');
  assert.equal(r.app, 'photocraft');
  const reply = r.result as { content: Array<{ text: string }> };
  assert.match(reply.content[0]!.text, /"document":\d+/);
});

await check('every dispatch produced an audit record', () => {
  assert.equal(session.auditTrail.length, 5);
  assert.deepEqual(
    session.auditTrail.map((r) => r.ok),
    [false, false, false, false, true],
  );
});

await session.dispose();
console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
