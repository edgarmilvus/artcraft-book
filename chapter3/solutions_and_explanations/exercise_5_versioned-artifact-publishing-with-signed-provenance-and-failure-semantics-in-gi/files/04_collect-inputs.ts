// /opt/publish/collect-inputs.ts — provenance collector feeding the CI job.
// Compiled to JS, runs inside the same image as the container.
//
// TRANSPORT NOTE (verified): the MCP server does not answer a hand-rolled
// JSON-RPC line protocol — it answers `tools/call` after an `initialize`
// handshake. This collector goes through the official SDK, which is also what
// makes the `isError` flag visible.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";

interface ColInputs {
  links: readonly {
    asset?: string; name?: string; status: "ok" | "modified" | "missing" | "embedded";
    pixels?: [number, number]; path?: string;
  }[];
  fonts: readonly {
    family: string; style: string; missing: boolean; styleMissing: boolean;
    source?: string | null;
  }[];
  colorMismatches: readonly { imagePath: string; from: string; to: string }[];
}

const OUT_INTENT = "Coated FOGRA39";

async function withDesigncraft<T>(
  root: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  // designcraft-cli takes no `--automation-*` flags: the sandbox is the cwd.
  const transport = new StdioClientTransport({
    command: "designcraft-cli",
    args: ["mcp"],
    cwd: root,
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => undefined);
  const client = new Client({ name: "publish-inputs", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function unwrap<T>(res: unknown, tool: string): T {
  // `callTool` returns a union (content | toolResult), so the payload is
  // inspected, not assumed.
  const r = res as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  const text = r.content?.find((c) => c.type === "text")?.text;
  let payload: unknown = undefined;
  if (text !== undefined) {
    try { payload = JSON.parse(text) as unknown; } catch { payload = text; }
  }
  if (r.isError === true) throw new Error(`${tool} failed: ${JSON.stringify(payload)}`);
  return payload as T;
}

export async function collect(root: string, layoutPath: string): Promise<ColInputs> {
  return withDesigncraft(root, async (client) => {
    unwrap(await client.callTool({ name: "open_document", arguments: { path: layoutPath } }), "open_document");

    // `execute` returns the registry command's own payload — an array here,
    // not a `{links: …}` envelope.
    const links = unwrap<ColInputs["links"]>(
      await client.callTool({ name: "execute", arguments: { command: "links.list", params: {} } }),
      "links.list",
    );
    const fonts = unwrap<ColInputs["fonts"]>(
      await client.callTool({ name: "execute", arguments: { command: "font.list", params: {} } }),
      "font.list",
    );

    // Colour-space check: any placed image is authored in sRGB and is about to
    // be exported into a CMYK output intent without an explicit conversion.
    const colorMismatches = (Array.isArray(links) ? links : [])
      .filter((l) => l.status === "ok" && typeof l.path === "string")
      .filter((l) => /\.(png|jpe?g|webp)$/i.test(l.path ?? ""))
      .map((l) => ({ imagePath: l.path ?? "", from: "sRGB", to: OUT_INTENT }));

    return {
      links: Array.isArray(links) ? links : [],
      fonts: Array.isArray(fonts) ? fonts : [],
      colorMismatches,
    };
  });
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const layout = arg("--layout");
  const outPath = arg("--out");
  const root = arg("--root") ?? process.cwd();
  if (!layout || !outPath) throw new Error("usage: collect-inputs --layout <p> --out <p> [--root <dir>]");
  const inputs = await collect(root, layout);
  await fs.writeFile(outPath, JSON.stringify(inputs, null, 2));
  console.log(JSON.stringify({
    links: inputs.links.length,
    missing: inputs.links.filter((l) => l.status === "missing").length,
    fonts: inputs.fonts.length,
    fontsMissing: inputs.fonts.filter((f) => f.missing).length,
    colorMismatches: inputs.colorMismatches.length,
  }));
}

if (process.argv[1] !== undefined &&
    import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err: unknown) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
