async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // `console.error` is safe here: it goes to stderr, which the host
  // surfaces as a log line, not as a protocol frame on stdout.
  console.error(`[bridge] ready — workspace=${WORKSPACE}`);
}

main().catch((err) => {
  console.error("[bridge] fatal:", err);
  process.exit(1);
});
