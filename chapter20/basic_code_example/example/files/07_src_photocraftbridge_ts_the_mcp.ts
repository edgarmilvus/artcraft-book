/**
 * The PhotoCraft bridge: it owns the lifecycle of the MCP subprocess and
 * nothing else.
 *
 * The engine is spawned over stdio, driven through the official
 * meta-tools — `doc_new` to create the canvas, `command_run` for every
 * drawing step, `doc_save` to export — and always torn down in a
 * `finally` block, so a crash half-way through a render can never leave
 * a running engine behind.
 *
 * The engine is granted exactly one directory, the run's output folder,
 * as its automation read and write root. Every path the bridge hands
 * it is therefore relative, and no path can escape the folder the
 * studio owns.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolResultSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { join } from "node:path";

/** The data-only description of a hero banner the renderer needs. */
export interface HeroRenderSpec {
  readonly width: number;
  readonly height: number;
  readonly headline: string;
  readonly subhead: string;
  readonly background: string;
  readonly accent: string;
  /** The directory the engine may read and write; its write root. */
  readonly outDir: string;
  /** The file name inside `outDir`; the extension selects the format. */
  readonly outFile: string;
}

/** What the renderer produced. */
export interface HeroRenderResult {
  /** The absolute path of the rendered file. */
  readonly path: string;
  /** The path the engine was given, relative to its write root. */
  readonly relativePath: string;
  /** Everything the engine complained about, in the order it said it. */
  readonly warnings: readonly string[];
  /** The meta-tools that were called, in order: the audit trail. */
  readonly calls: readonly string[];
}

/**
 * The price of one banner in budget units: one `doc_new`, three
 * `command_run` steps and one `doc_save`. The pipeline reserves these
 * units before the engine is spawned, so a run that cannot pay is
 * refused before any work happens.
 */
export const HERO_RENDER_COST = 5;

/** The typeface of the headline, as the engine's font registry names it. */
const HEADLINE_FONT = "Arial Black";

/** The typeface of the subhead. */
const SUBHEAD_FONT = "Inter";

/**
 * Renders one hero banner.
 *
 * The steps are fixed, and so is their order: the canvas first, the
 * accent band under the type, the two type layers, and the export
 * last.
 */
export async function renderHeroBanner(
  binary: string,
  spec: HeroRenderSpec,
): Promise<HeroRenderResult> {
  const transport = new StdioClientTransport({
    command: binary,
    args: [
      "mcp",
      "--automation-read-root",
      spec.outDir,
      "--automation-write-root",
      spec.outDir,
    ],
    env: childEnv(),
  });

  const client = new Client(
    { name: "studio-hello", version: "0.1.0" },
    { capabilities: {} },
  );

  await client.connect(transport);

  const calls: string[] = [];
  const warnings: string[] = [];

  try {
    // 1. The canvas. `doc_new` is a meta-tool: it answers
    //    `{ document: 0 }`, the index of the document it opened.
    calls.push("doc_new");
    await runMetaTool(
      client,
      {
        name: "doc_new",
        arguments: {
          width: spec.width,
          height: spec.height,
          mode: "rgb",
          depth: 8,
          background: spec.background,
        },
      },
      warnings,
    );

    // 2. The accent band, a live shape under the type.
    calls.push("command_run:shape.create");
    await runMetaTool(
      client,
      {
        name: "command_run",
        arguments: {
          id: "shape.create",
          params: {
            kind: "rect",
            rect: [
              0,
              Math.round(spec.height * 0.28),
              spec.width,
              Math.round(spec.height * 0.48),
            ],
            fill: spec.accent,
          },
        },
      },
      warnings,
    );

    // 3. The headline. `type.create` anchors point text on its
    //    baseline, and the coordinates are image pixels with the
    //    origin in the top-left corner.
    calls.push("command_run:type.create");
    await runMetaTool(
      client,
      {
        name: "command_run",
        arguments: {
          id: "type.create",
          params: {
            x: 80,
            y: Math.round(spec.height * 0.55),
            text: spec.headline,
            size: 96,
            font: HEADLINE_FONT,
            color: "#0a0a0a",
          },
        },
      },
      warnings,
    );

    // 4. The subhead.
    calls.push("command_run:type.create");
    await runMetaTool(
      client,
      {
        name: "command_run",
        arguments: {
          id: "type.create",
          params: {
            x: 80,
            y: Math.round(spec.height * 0.72),
            text: spec.subhead,
            size: 36,
            font: SUBHEAD_FONT,
            color: "#334155",
          },
        },
      },
      warnings,
    );

    // 5. The export. The format is a lower-case extension; the path
    //    is relative to the write root the engine was granted.
    calls.push("doc_save");
    await runMetaTool(
      client,
      {
        name: "doc_save",
        arguments: { path: spec.outFile, format: "png" },
      },
      warnings,
    );
  } finally {
    // The child process owns real operating-system resources: the
    // transport is closed whether the render succeeded or not.
    await client.close();
  }

  return {
    path: join(spec.outDir, spec.outFile),
    relativePath: spec.outFile,
    warnings,
    calls,
  };
}

/**
 * Calls one meta-tool and turns its answer into either a warning or
 * an error. The engine answers with a JSON document in a text block,
 * and every block is inspected so that nothing is lost.
 */
async function runMetaTool(
  client: Client,
  call: { name: string; arguments: Record<string, unknown> },
  warnings: string[],
): Promise<void> {
  const response = (await client.callTool(
    call,
    CallToolResultSchema,
  )) as CallToolResult;

  const texts: string[] = [];
  for (const block of response.content) {
    if (block.type === "text") {
      texts.push(block.text);
    }
  }
  const detail = texts.join(" ");

  if (response.isError === true) {
    throw new Error(`photocraft ${call.name} failed: ${detail}`);
  }
  warnings.push(...readWarnings(detail));
}

/**
 * Reads the `warnings` array out of an engine answer. The answer is
 * JSON when the engine has something to say and free text when it does
 * not, so the parser never assumes a shape it has not seen.
 */
function readWarnings(payload: string): string[] {
  if (payload.trim() === "") {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || !("warnings" in parsed)) {
    return [];
  }
  const warnings = (parsed as { warnings?: unknown }).warnings;
  if (!Array.isArray(warnings)) {
    return [];
  }
  return warnings.filter((entry): entry is string => typeof entry === "string");
}

/**
 * The environment of the child process. It is deliberately narrow: the
 * engine needs a path to find its libraries, a home directory to find
 * its fonts and a temporary directory to work in — and nothing else.
 * A studio that hands its secrets to a subprocess hands them to every
 * process the subprocess starts.
 */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  // Force CPU-only rendering, so the banner is the same file on a
  // workstation with a graphics card and on a build machine without one.
  env["PHOTOCRAFT_GPU"] = "0";
  return env;
}
