// llm-route.ts — runs the Next.js route handler without a server.
//
// The handler is the book listing; this file only builds the Request and
// calls it, the way Next would. It is not printed in the book.
//
//   OPENAI_COMPATIBLE_API_KEY=… OPENAI_COMPATIBLE_BASE_URL=… \
//   OPENAI_COMPATIBLE_MODEL=… npx tsx examples/llm-route.ts
import { POST } from '../app/api/studio/layered-render/route.js';

const brief = process.env.BRIEF ?? 'flash sale banner for a stoneware mug';

const response = await POST(
  new Request('http://localhost/api/studio/layered-render', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ brief, outputName: 'studio-live' }),
  }),
);

const body = await response.text();
console.log(body.slice(0, 600));
if (!response.ok) {
  console.error(`route returned ${response.status}`);
  process.exit(1);
}
console.log('route ok');
