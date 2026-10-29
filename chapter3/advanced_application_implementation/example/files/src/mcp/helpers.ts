// src/mcp/helpers.ts
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";

/**
 * Race a promise against a deadline. Rejects with a caller-supplied
 * message so that the timeout is distinguishable from an underlying
 * protocol error in log aggregation.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e: unknown) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * Craft MCP servers deliver JSON payloads inside one text content block.
 * Binary artifacts are usually base64 under `data`; a plain text block
 * is returned as `{ text: "..." }`.
 */
export function extractJson(content: readonly ContentBlock[] | undefined): unknown {
  const text = extractText(content);
  if (text === undefined) return {};
  try { return JSON.parse(text); }
  catch { return { text }; }
}

export function extractText(content: readonly ContentBlock[] | undefined): string | undefined {
  if (!content) return undefined;
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") return block.text;
  }
  return undefined;
}

/** Classify a tool error string as retryable. Anything 5xx-ish or
 *  timeout-ish is retryable; shape/permission errors are not. */
export function isRetryableToolError(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes("timeout") || m.includes("busy") || m.includes("temporarily");
}
