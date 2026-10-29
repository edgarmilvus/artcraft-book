this.transport = new StdioClientTransport({
  command: "filmcraft-cli",
  args: ["mcp",
    "--automation-read-root", projectRoot,
    "--automation-write-root", projectRoot],
});
