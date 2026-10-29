/**
 * Harness for the Next.js route handler.
 *
 * `next/server` is a real dependency, so the handler runs unchanged; the
 * request object is the only thing faked. Without ANTHROPIC_API_KEY the
 * model call fails, which is exactly the error path the SSE stream must
 * report instead of hanging the connection.
 */
import { POST } from './src/app/api/briefs/route.js';
import { strict as assert } from 'node:assert';

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

function request(body: unknown, tenant?: string) {
  return {
    headers: new Headers(tenant ? { 'x-tenant-id': tenant } : {}),
    json: async () => body,
  } as never;
}

const VALID = { brief: 'Make a banner', apps: ['photocraft'] };

console.log('route handler\n');

await check('rejects a request with no tenant', async () => {
  const res = await POST(request(VALID));
  assert.equal(res.status, 401);
  assert.equal(await res.text(), 'missing tenant');
});

await check('rejects a body with no brief', async () => {
  const res = await POST(request({ apps: ['photocraft'] }, 'tenant-42'));
  assert.equal(res.status, 400);
  const payload = (await res.json()) as { error: { fieldErrors: Record<string, string[]> } };
  assert.ok(payload.error.fieldErrors.brief, JSON.stringify(payload));
});

await check('rejects an unknown app id', async () => {
  const res = await POST(request({ brief: 'x', apps: ['notacraft'] }, 'tenant-42'));
  assert.equal(res.status, 400);
});

await check('streams status then a terminal event', async () => {
  const res = await POST(request(VALID, 'tenant-42'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');

  const text = await res.text();
  const events = text
    .split('\n\n')
    .filter(Boolean)
    .map((chunk) => {
      const [eventLine, dataLine] = chunk.split('\n');
      return {
        event: eventLine!.replace('event: ', ''),
        data: JSON.parse(dataLine!.replace('data: ', '')) as Record<string, unknown>,
      };
    });

  assert.ok(events.length >= 2, text);
  assert.deepEqual(events[0], { event: 'status', data: { phase: 'starting' } });
  assert.match(events.at(-1)!.event, /^(result|error)$/);
});

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
