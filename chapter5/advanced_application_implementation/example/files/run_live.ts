/**
 * Live run of the chapter 5 brief: the same call `run_advanced.ts` makes,
 * minus the scripted model, so the loop drives a real endpoint.
 *
 *   OPENAI_COMPATIBLE_API_KEY=… OPENAI_COMPATIBLE_BASE_URL=… \
 *   OPENAI_COMPATIBLE_MODEL=… npx tsx run_live.ts
 *
 * Not printed in the book: the chapter shows `runBrief` called directly.
 * A real model can spend all its turns exploring and never save, so the
 * harness asks once more before calling it a failure.
 */
import { runBrief } from './src/agent-loop.js';

const brief =
  'Design a 1200x600 launch banner with the headline Q3 LAUNCH and save it as brief.png.';

// The second attempt is deliberately smaller: if the model spent the first
// budget exploring, repeating the same brief spends a second one the same way.
const minimal =
  'Create a 1200x600 document and save it as brief.png. Nothing else.';

let outcome = await runBrief('tenant-live', brief, ['photocraft'], false);
if (outcome.outputs.length === 0) {
  console.error('the model finished without saving a document; retrying with a minimal brief');
  outcome = await runBrief('tenant-live', minimal, ['photocraft'], false);
}

console.log(JSON.stringify(outcome, null, 2));
if (outcome.outputs.length === 0) {
  console.error('two attempts, no document saved');
  process.exit(1);
}
