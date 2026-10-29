// ── Pitfall 2, corrected ────────────────────────────────────────────────
// `command_batch` is NOT a transaction: `stop_on_error: true` halts at the
// first failing step but leaves the earlier steps committed. `failed` in the
// reply is a COUNT, not the index that failed, and the whole payload arrives
// as JSON text inside `content[0].text` — not as fields on the
// `CallToolResult`. The rollback therefore has to read the payload and undo
// exactly the steps that were applied.
type BatchStepResult = { ok: boolean; result?: unknown; error?: string };
type BatchReply = { completed: number; failed: number; results: BatchStepResult[] };

const reply = (await client.callTool({
  name: "command_batch",
  arguments: { steps, stop_on_error: true },
})) as { content?: Array<{ type: string; text?: string }> };

const raw = reply.content?.find((block) => block.type === "text")?.text;
const batch = JSON.parse(raw ?? '{"completed":0,"failed":0,"results":[]}') as BatchReply;

if (batch.failed > 0) {
  // With `stop_on_error`, the applied steps are the leading run of `ok: true`.
  const firstFailure = batch.results.findIndex((step) => !step.ok);
  const applied = firstFailure === -1 ? batch.results.length : firstFailure;
  for (let i = 0; i < applied; i++) {
    await client.callTool({ name: "command_run", arguments: { id: "edit.undo" } });
  }
}
