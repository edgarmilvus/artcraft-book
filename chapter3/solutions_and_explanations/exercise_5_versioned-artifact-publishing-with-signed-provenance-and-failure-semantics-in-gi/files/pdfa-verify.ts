// /opt/publish/pdfa-verify.ts — verify a PDF against PDF/A and write the report.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import * as path from "node:path";

const unwrap = (res: unknown, tool: string): unknown => {
  const r = res as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  const text = r.content?.find((c) => c.type === "text")?.text;
  const payload = text === undefined ? undefined : (() => {
    try { return JSON.parse(text) as unknown; } catch { return text; }
  })();
  if (r.isError === true) throw new Error(`${tool} failed: ${JSON.stringify(payload)}`);
  return payload;
};

export interface PdfaReport {
  readonly level: string;
  readonly compliant: boolean;
  readonly declared: unknown;
  readonly issues: readonly { clause?: string; message?: string; page?: number; fixable?: boolean }[];
}

export async function verifyPdfa(
  root: string, pdf: string, level: "2b" | "3b", reportPath: string,
): Promise<PdfaReport> {
  const transport = new StdioClientTransport({
    command: "pdfcraft-cli", args: ["mcp", "--root", root], cwd: root, stderr: "pipe",
  });
  transport.stderr?.on("data", () => undefined);
  const client = new Client({ name: "publish-pdfa", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    const opened = unwrap(await client.callTool({ name: "doc_open", arguments: { path: pdf } }), "doc_open") as { doc?: number };
    const doc = opened.doc ?? 1;
    const raw = unwrap(await client.callTool({
      name: "pdfa_verify", arguments: { doc, level },
    }), "pdfa_verify") as {
      compliant?: boolean; declared?: unknown;
      issues?: readonly { clause?: string; message?: string; page?: number; fixable?: boolean }[];
    };
    const report: PdfaReport = {
      level: `PDF/A-${level}`,
      compliant: raw.compliant === true,
      declared: raw.declared ?? null,
      issues: raw.issues ?? [],
    };
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    return report;
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
  const pdf = arg("--pdf");
  const report = arg("--report");
  const level = (arg("--level") ?? "2b") as "2b" | "3b";
  const root = arg("--root") ?? process.cwd();
  if (pdf === undefined || report === undefined) throw new Error("usage: pdfa-verify --pdf <p> --report <p> [--level 2b|3b]");
  const result = await verifyPdfa(root, pdf, level, report);
  console.log(JSON.stringify({ compliant: result.compliant, issues: result.issues.length }));
  return result.compliant ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((err: unknown) => {
    console.error((err as Error).message); process.exit(1);
  });
}
