/**
 * Live run of the chapter 5 brief: the same call `run_advanced.ts` makes,
 * minus the scripted model, so the loop drives a real endpoint.
 *
 *   OPENAI_COMPATIBLE_API_KEY=… OPENAI_COMPATIBLE_BASE_URL=… \
 *   OPENAI_COMPATIBLE_MODEL=… npx tsx run_live.ts
 *
 * Not printed in the book: the chapter shows `runBrief` called directly.
 */
import { runBrief } from './src/agent-loop.js';

const outcome = await runBrief(
  'tenant-live',
  'Design a 1200x600 launch banner with the headline Q3 LAUNCH and save it as brief.png.',
  ['photocraft'],
  false,
);

console.log(JSON.stringify(outcome, null, 2));
if (outcome.outputs.length === 0) {
  console.error('the model finished without saving a document');
  process.exit(1);
}
