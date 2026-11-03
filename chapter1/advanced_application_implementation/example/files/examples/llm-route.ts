// llm-route.ts — runs the streaming brief route without a server.
//
// The handler is the book listing (FILE 9/9); this file only builds the
// Request and drains the stream, the way Next would. Not printed in the book.
//
//   OPENAI_COMPATIBLE_API_KEY=… OPENAI_COMPATIBLE_BASE_URL=… \
//   OPENAI_COMPATIBLE_MODEL=… npx tsx examples/llm-route.ts
import { POST } from '../app/api/art/brief/route.js';

// A reasoning model spends its output budget before it writes a word, so the
// route's 700-token default is not enough for one. Give the stream room.
if (!process.env.OPENAI_COMPATIBLE_MAX_OUTPUT_TOKENS) {
  process.env.OPENAI_COMPATIBLE_MAX_OUTPUT_TOKENS = '4096';
}

const response = await POST(
  new Request('http://localhost/api/art/brief', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: 'A 1200x600 launch banner for a stoneware mug, autumn palette.',
    }),
  }),
);

const text = await response.text();
console.log(text.slice(0, 800));
if (!response.ok || text.trim().length === 0) {
  console.error(`route returned ${response.status} with ${text.length} characters`);
  process.exit(1);
}
console.log('route ok');
