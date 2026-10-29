async function connectPhotoCraft(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "photocraft-cli",
    args: [
      "mcp",
      "--automation-read-root", WORKSPACE,
      "--automation-write-root", WORKSPACE,
    ],
    env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? "warn" },
  });

  const client = new Client(
    { name: "artcraft-bridge", version: "0.1.0" },
    { capabilities: {} },
  );

  await client.connect(transport);
  return client;
}
