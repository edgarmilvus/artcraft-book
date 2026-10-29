for (const cmd of commands) {
  client.callTool({ name: "command_run", arguments: cmd }); // ← missing await
}
