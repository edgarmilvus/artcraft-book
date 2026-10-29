import { z } from "zod";
import type { ToolOutcome } from "../contracts.js";
export interface MCPClientOptions {
    /** Executable name, e.g. "photocraft-cli". */
    readonly binary: string;
    /** Subcommand that starts the MCP stdio server, e.g. "mcp". */
    readonly subcommand: readonly string[];
    /** Filesystem sandbox passed straight through to the CLI. */
    readonly readRoot: string;
    readonly writeRoot: string;
    /** Hard cap for a single tool round-trip. Default 120s. */
    readonly callTimeoutMs?: number;
    /**
     * How the CLI is told about its sandbox. PhotoCraft, PdfCraft and WordCraft
     * take `--automation-*` flags; DesignCraft and LightCraft take none and
     * resolve relative paths against the process cwd, so they must be spawned
     * with `cwd: writeRoot` instead. Getting this wrong is not a warning: the
     * CLI exits with a usage error before the MCP handshake.
     */
    readonly rootMode?: "flags" | "cwd";
}
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
export declare class CraftMCPClient {
    private readonly opts;
    private client;
    private transport;
    private readonly timeoutMs;
    private disposed;
    constructor(opts: MCPClientOptions);
    /** True when the transport is live and has not been disposed. */
    get connected(): boolean;
    /**
     * Spawn the CLI subprocess and negotiate the MCP handshake.
     * Idempotent: a second call is a no-op if already connected.
     * Warm-start contract — call once per worker, not once per request.
     */
    connect(): Promise<void>;
    /**
     * Invoke an MCP tool by name with Zod-validated arguments, parse the
     * returned content block through the result schema, and return the
     * typed value. Throws on transport failure; returns a ToolOutcome for
     * protocol-level errors so callers can attach retry policy.
     */
    call<TArgs, TResult>(tool: string, args: TArgs, argsSchema: z.ZodType<TArgs>, resultSchema: z.ZodType<TResult>): Promise<ToolOutcome<TResult>>;
    /** Deterministic teardown. Safe to call multiple times. */
    disconnect(): Promise<void>;
}
