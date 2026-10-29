const raw = (await this.client.callTool({ name: tool, arguments: args })) as unknown as McpToolResult;
const text = raw.content.filter((b) => b.type === "text" && typeof b.text === "string")
                        .map((b) => b.text as string).join("\n");
if (raw.isError) throw new Error(`[${tool}] ${text || "unknown MCP error"}`);
if (!text) return {};
try { return JSON.parse(text); } catch { return { raw: text }; }
