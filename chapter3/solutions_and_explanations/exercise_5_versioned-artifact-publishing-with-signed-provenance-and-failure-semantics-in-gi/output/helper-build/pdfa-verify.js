// /opt/publish/pdfa-verify.ts — verify a PDF against PDF/A and write the report.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import * as path from "node:path";
const unwrap = (res, tool) => {
    const r = res;
    const text = r.content?.find((c) => c.type === "text")?.text;
    const payload = text === undefined ? undefined : (() => {
        try {
            return JSON.parse(text);
        }
        catch {
            return text;
        }
    })();
    if (r.isError === true)
        throw new Error(`${tool} failed: ${JSON.stringify(payload)}`);
    return payload;
};
export async function verifyPdfa(root, pdf, level, reportPath) {
    const transport = new StdioClientTransport({
        command: "pdfcraft-cli", args: ["mcp", "--root", root], cwd: root, stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    const client = new Client({ name: "publish-pdfa", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    try {
        const opened = unwrap(await client.callTool({ name: "doc_open", arguments: { path: pdf } }), "doc_open");
        const doc = opened.doc ?? 1;
        const raw = unwrap(await client.callTool({
            name: "pdfa_verify", arguments: { doc, level },
        }), "pdfa_verify");
        const report = {
            level: `PDF/A-${level}`,
            compliant: raw.compliant === true,
            declared: raw.declared ?? null,
            issues: raw.issues ?? [],
        };
        await fs.mkdir(path.dirname(reportPath), { recursive: true });
        await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
        return report;
    }
    finally {
        await client.close().catch(() => undefined);
    }
}
async function main() {
    const argv = process.argv.slice(2);
    const arg = (flag) => {
        const i = argv.indexOf(flag);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const pdf = arg("--pdf");
    const report = arg("--report");
    const level = (arg("--level") ?? "2b");
    const root = arg("--root") ?? process.cwd();
    if (pdf === undefined || report === undefined)
        throw new Error("usage: pdfa-verify --pdf <p> --report <p> [--level 2b|3b]");
    const result = await verifyPdfa(root, pdf, level, report);
    console.log(JSON.stringify({ compliant: result.compliant, issues: result.issues.length }));
    return result.compliant ? 0 : 1;
}
if (import.meta.url === `file://${process.argv[1]}`) {
    main().then((code) => process.exit(code)).catch((err) => {
        console.error(err.message);
        process.exit(1);
    });
}
