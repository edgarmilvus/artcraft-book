const parts = (res as { content?: unknown }).content;
if (!Array.isArray(parts) || parts[0]?.type !== "text") {
  throw new Error("MCP response did not carry a text part");
}
