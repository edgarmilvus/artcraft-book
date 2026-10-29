import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
/**
 * Race a promise against a deadline. Rejects with a caller-supplied
 * message so that the timeout is distinguishable from an underlying
 * protocol error in log aggregation.
 */
export declare function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T>;
/**
 * Craft MCP servers deliver JSON payloads inside one text content block.
 * Binary artifacts are usually base64 under `data`; a plain text block
 * is returned as `{ text: "..." }`.
 */
export declare function extractJson(content: readonly ContentBlock[] | undefined): unknown;
export declare function extractText(content: readonly ContentBlock[] | undefined): string | undefined;
/** Classify a tool error string as retryable. Anything 5xx-ish or
 *  timeout-ish is retryable; shape/permission errors are not. */
export declare function isRetryableToolError(msg: string): boolean;
