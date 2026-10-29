// /opt/publish/export-pdfs.ts — export the print and web PDFs from one layout.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const unwrap = (res: unknown, tool: string): unknown => {
  const r = res as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  const text = r.content?.find((c) => c.type === "text")?.text;
  const payload = text === undefined ? undefined : (() => {
    try { return JSON.parse(text) as unknown; } catch { return text; }
  })();
  if (r.isError === true) throw new Error(`${tool} failed: ${JSON.stringify(payload)}`);
  return payload;
};

export interface ExportResult {
  readonly print: { readonly path: string; readonly bytes: number; readonly pages: number };
  readonly web: { readonly path: string; readonly bytes: number; readonly pages: number };
}

export async function exportPdfs(
  root: string, layout: string, printPath: string, webPath: string,
  webStandard: "a2b" | "none" = "a2b",
): Promise<ExportResult> {
  const transport = new StdioClientTransport({ command: "designcraft-cli", args: ["mcp"], cwd: root, stderr: "pipe" });
  transport.stderr?.on("data", () => undefined);
  const client = new Client({ name: "publish-export", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    unwrap(await client.callTool({ name: "open_document", arguments: { path: layout } }), "open_document");
    const exp = async (path: string, standard: "none" | "a2b") => {
      const result = unwrap(await client.callTool({
        name: "execute",
        arguments: { command: "file.exportPdf", params: { path, standard, tagged: true } },
      }), "file.exportPdf") as { bytes?: number; pages?: number };
      return { path, bytes: result.bytes ?? 0, pages: result.pages ?? 0 };
    };
    const print = await exp(printPath, "none");
    const web = await exp(webPath, webStandard);
    return { print, web };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const arg = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const layout = arg("--layout");
  const print = arg("--print");
  const web = arg("--web");
  const root = arg("--root") ?? process.cwd();
  const webStandard = (arg("--webStandard") ?? "a2b") as "a2b" | "none";
  if (layout === undefined || print === undefined || web === undefined) {
    throw new Error("usage: export-pdfs --layout <p> --print <p> --web <p> [--root <dir>] [--webStandard a2b|none]");
  }
  const result = await exportPdfs(root, layout, print, web, webStandard);
  console.log(JSON.stringify(result));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((err: unknown) => {
    console.error((err as Error).message); process.exit(1);
  });
}
