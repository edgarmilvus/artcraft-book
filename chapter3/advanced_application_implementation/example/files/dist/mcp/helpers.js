/**
 * Race a promise against a deadline. Rejects with a caller-supplied
 * message so that the timeout is distinguishable from an underlying
 * protocol error in log aggregation.
 */
export function withTimeout(p, ms, msg) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(msg)), ms);
        p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
}
/**
 * Craft MCP servers deliver JSON payloads inside one text content block.
 * Binary artifacts are usually base64 under `data`; a plain text block
 * is returned as `{ text: "..." }`.
 */
export function extractJson(content) {
    const text = extractText(content);
    if (text === undefined)
        return {};
    try {
        return JSON.parse(text);
    }
    catch {
        return { text };
    }
}
export function extractText(content) {
    if (!content)
        return undefined;
    for (const block of content) {
        if (block.type === "text" && typeof block.text === "string")
            return block.text;
    }
    return undefined;
}
/** Classify a tool error string as retryable. Anything 5xx-ish or
 *  timeout-ish is retryable; shape/permission errors are not. */
export function isRetryableToolError(msg) {
    const m = msg.toLowerCase();
    return m.includes("timeout") || m.includes("busy") || m.includes("temporarily");
}
//# sourceMappingURL=helpers.js.map