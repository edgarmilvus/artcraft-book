// Sequential: each iteration waits for the previous one. Total time = sum(durations).
for (const id of ids) {
  await client.callTool({ name: "command_run", arguments: { id, params: {} } });
}

// Concurrent: all iterations are launched, then awaited together.
// Total time = max(durations).
await Promise.all(ids.map((id) =>
  client.callTool({ name: "command_run", arguments: { id, params: {} } })
));
