// src/index.ts
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CraftMCPClient } from "./mcp/client.js";
import { DesignBriefSchema } from "./contracts.js";
import { runBannerPipeline } from "./pipeline/banner.js";
import { createLogger } from "./logger.js";
const log = createLogger("bootstrap");
const PORT = Number(process.env["PORT"] ?? 8080);
const IN_DIR = process.env["CRAFT_IN_ROOT"] ?? "/work/in";
const OUT_DIR = process.env["CRAFT_OUT_ROOT"] ?? "/work/out";
let pool = null;
async function bootPool() {
    const photocraft = new CraftMCPClient({
        binary: process.env["PHOTOCRAFT_CLI"] ?? "photocraft-cli",
        subcommand: ["mcp"],
        readRoot: IN_DIR,
        writeRoot: OUT_DIR,
    });
    const designcraft = new CraftMCPClient({
        binary: process.env["DESIGNCRAFT_CLI"] ?? "designcraft-cli",
        subcommand: ["mcp"],
        readRoot: IN_DIR,
        writeRoot: OUT_DIR,
        // designcraft-cli mcp takes no `--automation-*` flags: it resolves
        // relative paths against cwd, so the sandbox is the working directory.
        rootMode: "cwd",
    });
    // Warm-start both sessions in parallel. If either fails, we fail the
    // whole worker: a partially warm pool produces non-deterministic latency.
    await Promise.all([photocraft.connect(), designcraft.connect()]);
    log.info("warm pool ready");
    return { photocraft, designcraft };
}
async function handleRender(req, res) {
    if (req.method !== "POST" || req.url !== "/v1/render") {
        res.writeHead(404).end("not found");
        return;
    }
    let body = "";
    for await (const chunk of req)
        body += chunk;
    let parsedJson;
    try {
        parsedJson = JSON.parse(body);
    }
    catch {
        res.writeHead(400).end("invalid JSON");
        return;
    }
    const briefParse = DesignBriefSchema.safeParse(parsedJson);
    if (!briefParse.success) {
        res.writeHead(422).end(briefParse.error.message);
        return;
    }
    if (!pool) {
        res.writeHead(503).end("worker not ready");
        return;
    }
    try {
        const artifact = await runBannerPipeline(briefParse.data, {
            photocraft: pool.photocraft,
            designcraft: pool.designcraft,
            inDir: IN_DIR,
            outDir: OUT_DIR,
        });
        res.writeHead(201, { "content-type": "application/json" })
            .end(JSON.stringify(artifact));
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg }, "render failed");
        res.writeHead(500, { "content-type": "application/json" })
            .end(JSON.stringify({ error: msg }));
    }
}
async function main() {
    // Every directory the pipeline writes into must exist before the first
    // command runs: no Craft engine creates parent directories, so a missing
    // `stage-a/` turns `doc_save` into an I/O NotFound after a full render.
    for (const dir of [IN_DIR, OUT_DIR, join(OUT_DIR, "stage-a"), join(OUT_DIR, "banners")]) {
        await mkdir(dir, { recursive: true });
    }
    pool = await bootPool();
    const server = createServer((req, res) => {
        handleRender(req, res).catch((e) => {
            log.error({ err: e }, "unhandled request error");
            res.writeHead(500).end();
        });
    });
    server.listen(PORT, () => log.info({ port: PORT }, "worker listening"));
    const shutdown = async (signal) => {
        log.info({ signal }, "shutting down");
        server.close();
        if (pool)
            await Promise.all([pool.photocraft.disconnect(), pool.designcraft.disconnect()]);
        process.exit(0);
    };
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
}
void main();
//# sourceMappingURL=index.js.map