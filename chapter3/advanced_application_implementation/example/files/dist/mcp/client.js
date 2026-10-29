// src/mcp/client.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { createLogger } from "../logger.js";
import { extractJson, extractText, isRetryableToolError, withTimeout, } from "./helpers.js";
const log = createLogger("mcp");
/**
 * A long-lived MCP session against a single Craft CLI.
 *
 * Lifecycle:
 *   const pc = new CraftMCPClient({binary: "photocraft-cli", ...});
 *   await pc.connect();                       // cold start once
 *   await pc.call("doc_new", args, Schema);   // warm calls thereafter
 *   ...
 *   await pc.disconnect();                    // teardown
 *
 * The instance is NOT thread-safe. Each Node.js worker holds its own.
 */
export class CraftMCPClient {
    opts;
    client = null;
    transport = null;
    timeoutMs;
    disposed = false;
    constructor(opts) {
        this.opts = opts;
        this.timeoutMs = opts.callTimeoutMs ?? 120_000;
    }
    /** True when the transport is live and has not been disposed. */
    get connected() {
        return this.client !== null && !this.disposed;
    }
    /**
     * Spawn the CLI subprocess and negotiate the MCP handshake.
     * Idempotent: a second call is a no-op if already connected.
     * Warm-start contract — call once per worker, not once per request.
     */
    async connect() {
        if (this.client)
            return;
        if (this.disposed)
            throw new Error("CraftMCPClient has been disposed");
        const rootMode = this.opts.rootMode ?? "flags";
        const args = rootMode === "flags"
            ? [
                ...this.opts.subcommand,
                "--automation-read-root", this.opts.readRoot,
                "--automation-write-root", this.opts.writeRoot,
            ]
            : [...this.opts.subcommand];
        // `exactOptionalPropertyTypes` forbids passing `cwd: undefined`, so the
        // key is only present in cwd mode.
        const transport = new StdioClientTransport({
            command: this.opts.binary,
            args,
            stderr: "pipe",
            ...(rootMode === "cwd" ? { cwd: this.opts.writeRoot } : {}),
        });
        // `stderr: "pipe"` is only safe if somebody reads the pipe: the CLI
        // writes a banner line on startup and a full 64 KB pipe would block it.
        const childErr = transport.stderr;
        if (childErr) {
            childErr.on("data", (chunk) => {
                log.debug({ binary: this.opts.binary, line: chunk.toString("utf8").trim() }, "cli stderr");
            });
        }
        const client = new Client({ name: "bannerforge-orchestrator", version: "1.4.0" }, { capabilities: {} });
        await client.connect(transport);
        this.client = client;
        this.transport = transport;
        log.info({ binary: this.opts.binary, readRoot: this.opts.readRoot }, "MCP session established (warm)");
    }
    /**
     * Invoke an MCP tool by name with Zod-validated arguments, parse the
     * returned content block through the result schema, and return the
     * typed value. Throws on transport failure; returns a ToolOutcome for
     * protocol-level errors so callers can attach retry policy.
     */
    async call(tool, args, argsSchema, resultSchema) {
        if (!this.client || this.disposed) {
            return { ok: false, error: "MCP client not connected", retryable: true };
        }
        // 1. Validate arguments BEFORE they touch the wire. This is the
        //    strict-type-discipline boundary: any caller mistake becomes a
        //    synchronous, deterministic error, not a JSON-RPC 500.
        const parsedArgs = argsSchema.safeParse(args);
        if (!parsedArgs.success) {
            return {
                ok: false,
                error: `invalid argument shape for ${tool}: ${parsedArgs.error.message}`,
                retryable: false,
            };
        }
        try {
            // 2. Round-trip with a hard deadline. Craft MCP servers accept
            //    long-running filters; on timeout we must abort rather than
            //    let the worker hold a poisoned session forever.
            const response = await withTimeout(this.client.callTool({ name: tool, arguments: parsedArgs.data }), this.timeoutMs, `tool ${tool} exceeded ${this.timeoutMs}ms`);
            if (response.isError) {
                const text = extractText(response.content)
                    ?? "unknown tool error";
                log.warn({ tool, text }, "MCP tool returned isError");
                return { ok: false, error: text, retryable: isRetryableToolError(text) };
            }
            // 3. Parse the result. Craft tools emit JSON payloads inside a
            //    single text content block; binaries are surfaced as base64
            //    under a data field. We JSON.parse then Zod.parse.
            const payload = extractJson(response.content);
            const parsed = resultSchema.safeParse(payload);
            if (!parsed.success) {
                return {
                    ok: false,
                    error: `unexpected result shape from ${tool}: ${parsed.error.message}`,
                    retryable: false,
                };
            }
            return { ok: true, value: parsed.data };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.error({ tool, err: message }, "MCP call failed");
            return { ok: false, error: message, retryable: true };
        }
    }
    /** Deterministic teardown. Safe to call multiple times. */
    async disconnect() {
        this.disposed = true;
        if (this.transport) {
            try {
                await this.transport.close();
            }
            catch { /* already dead */ }
        }
        if (this.client) {
            try {
                await this.client.close();
            }
            catch { /* already dead */ }
        }
        this.client = null;
        this.transport = null;
        log.info({ binary: this.opts.binary }, "MCP session closed");
    }
}
//# sourceMappingURL=client.js.map