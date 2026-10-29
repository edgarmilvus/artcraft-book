for (const layer of plan.layers) {
  await mcp.callTool({ name: 'command_run', arguments: { id: layer.command, params: layer.params } });
}
