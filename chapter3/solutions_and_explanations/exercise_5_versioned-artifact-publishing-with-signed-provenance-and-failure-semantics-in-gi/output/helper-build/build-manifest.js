// /opt/publish/build-manifest.ts — build and shape the signed release manifest.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
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
const sha256 = async (file) => createHash("sha256").update(await fs.readFile(file)).digest("hex");
async function pageCount(root, file) {
    const transport = new StdioClientTransport({
        command: "pdfcraft-cli", args: ["mcp", "--root", root], cwd: root, stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    const client = new Client({ name: "publish-manifest", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    try {
        const opened = unwrap(await client.callTool({ name: "doc_open", arguments: { path: file } }), "doc_open");
        return opened.pages ?? 0;
    }
    finally {
        await client.close().catch(() => undefined);
    }
}
export async function buildManifest(input) {
    const inputs = JSON.parse(await fs.readFile(input.inputs, "utf8"));
    const artifact = async (name, file, standard) => ({
        name,
        sha256: await sha256(file),
        bytes: (await fs.stat(file)).size,
        pages: await pageCount(input.root, path.relative(input.root, file)),
        pdfStandard: standard,
        signatureArmored: (await fs.readFile(`${file}.asc`)).toString("base64"),
    });
    const manifest = {
        schemaVersion: 1,
        releaseVersion: input.release,
        channel: input.channel,
        layoutRef: input.layoutRef,
        generatedAt: new Date().toISOString(),
        artifacts: [
            await artifact("catalog-print.pdf", input.print, input.printStandard ?? "none"),
            await artifact("catalog-web.pdf", input.web, input.webStandard ?? "pdfa2b"),
        ],
        audit: (() => {
            const modifiedLinks = inputs.links.filter((l) => l.status !== "ok").map((l) => l.name ?? l.path ?? l.asset ?? "unknown");
            const missingFonts = inputs.fonts.filter((f) => f.missing || f.styleMissing).map((f) => `${f.family} ${f.style}`);
            return {
                modifiedLinks,
                missingFonts,
                colorSpaceMismatches: inputs.colorMismatches,
                passed: modifiedLinks.length === 0 && missingFonts.length === 0 && inputs.colorMismatches.length === 0,
            };
        })(),
        provenance: {
            ciPipelineId: input.provenance?.ciPipelineId ?? process.env["CI_PIPELINE_ID"] ?? "local-pipeline",
            ciJobId: input.provenance?.ciJobId ?? process.env["CI_JOB_ID"] ?? "local-job",
            commitSha: input.provenance?.commitSha ?? process.env["CI_COMMIT_SHA"] ?? "local-commit",
            runnerId: input.provenance?.runnerId ?? process.env["CI_RUNNER_ID"] ?? "local-runner",
        },
    };
    await fs.mkdir(path.dirname(input.out), { recursive: true });
    await fs.writeFile(input.out, JSON.stringify(manifest, null, 2) + "\n");
    return manifest;
}
async function main() {
    const argv = process.argv.slice(2);
    const arg = (flag) => {
        const i = argv.indexOf(flag);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const root = arg("--root") ?? process.cwd();
    const release = arg("--release");
    const channel = (arg("--channel") ?? "beta");
    const layoutRef = arg("--layoutRef") ?? "local";
    const print = arg("--print");
    const web = arg("--web");
    const inputs = arg("--inputs");
    const out = arg("--out");
    if ([release, print, web, inputs, out].some((v) => v === undefined)) {
        throw new Error("usage: build-manifest --release <v> --channel <c> --layoutRef <r> --print <p> --web <p> --inputs <p> --out <p>");
    }
    await buildManifest({
        root, release: release, channel, layoutRef,
        print: path.resolve(print), web: path.resolve(web),
        inputs: path.resolve(inputs), out: path.resolve(out),
    });
    console.log(JSON.stringify({ written: path.resolve(out) }));
    return 0;
}
if (import.meta.url === `file://${process.argv[1]}`) {
    main().then((code) => process.exit(code)).catch((err) => {
        console.error(err.message);
        process.exit(1);
    });
}
