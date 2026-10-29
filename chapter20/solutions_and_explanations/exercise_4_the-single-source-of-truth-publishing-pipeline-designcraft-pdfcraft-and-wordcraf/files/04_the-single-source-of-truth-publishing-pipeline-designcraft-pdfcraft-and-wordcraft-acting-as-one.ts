#!/usr/bin/env node
/**
 * publish.ts — the single-source-of-truth publishing pipeline.
 *
 * One canonical manifest (framework.json) drives four engines:
 *
 *   DesignCraft   the A4 brochure — the archival PDF
 *   PdfCraft      the PDF/A-2b and the accessibility gates
 *   WordCraft     the reviewer-facing DOCX
 *   PhotoCraft    the per-release hero image
 *
 * Every stage runs in its own engine process: an engine that dies takes its
 * stage with it and nothing else. The manifest is validated before a single
 * process is spawned, so an unresolvable reference is a *validation* failure
 * and never an engine failure.
 *
 * Exit codes
 *   0  every artefact built and every gate passed
 *   1  the manifest failed validation
 *   2  an engine call failed
 *   3  the brochure is not PDF/A-2b conformant after one conversion pass
 *   4  the brochure still has an accessibility failure after the repair pass
 *
 * Usage
 *   node publish.js --manifest out/manifest.json --release 2025.11
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/* -------------------------------------------------------------------------- */
/* exit codes                                                                 */
/* -------------------------------------------------------------------------- */

const EXIT_OK = 0;
const EXIT_VALIDATION = 1;
const EXIT_ENGINE = 2;
const EXIT_PDFA = 3;
const EXIT_A11Y = 4;

/* -------------------------------------------------------------------------- */
/* page geometry — A4 in points, never millimetres                             */
/* -------------------------------------------------------------------------- */

/** A4 is 210 mm x 297 mm; at 72 pt/in that is 595.276 x 841.89 points. */
const A4_WIDTH_PT = 595.276;
const A4_HEIGHT_PT = 841.89;

const MARGIN_TOP = 48;
const MARGIN_BOTTOM = 48;
const MARGIN_INSIDE = 56;
const MARGIN_OUTSIDE = 40;
/** 3 mm of bleed is 8.504 pt; the convention rounds up to a quarter point. */
const BLEED_PT = 9;
const GUTTER_PT = 24;


/* -------------------------------------------------------------------------- */
/* manifest types                                                              */
/* -------------------------------------------------------------------------- */

interface FigureDef {
  id: string;
  path: string;
  caption: string;
}

interface FootnoteDef {
  id: string;
  text: string;
}

interface ChapterDef {
  id: string;
  number: number;
  title: string;
  markdownPath: string;
  columns: 1 | 2;
  figures: FigureDef[];
  footnotes: FootnoteDef[];
}

interface DivergenceBudget {
  /** Tolerance on the total page-count difference between the two artefacts. */
  totalPages: number;
  /** Tolerance on the per-chapter page-count difference. */
  perChapterPages: number;
}

interface Typography {
  /**
   * The one family used for every run of text. It must be present on the CI
   * runner *and* on the reviewer's workstation: a silent fallback changes
   * the line metrics and with them the page geometry.
   */
  fontFamily: string;
  divergenceBudget: DivergenceBudget;
}

interface Framework {
  release: string;
  codename: string;
  title: string;
  edition: string;
  authors: Array<{ name: string; affiliation: string }>;
  chapters: ChapterDef[];
  frontMatter: {
    executiveSummaryMarkdownPath: string;
    heroBackgroundPath: string;
  };
  outputRoot: string;
  typography: Typography;
}

/** A manifest whose paths have been resolved against the manifest's folder. */
interface ResolvedFigure extends FigureDef {
  file: string;
}

interface ResolvedChapter extends Omit<ChapterDef, "figures"> {
  figures: ResolvedFigure[];
  markdownFile: string;
  markdown: string;
  body: string;
}

interface ResolvedFramework extends Omit<Framework, "chapters" | "frontMatter"> {
  chapters: ResolvedChapter[];
  frontMatter: {
    executiveSummaryMarkdownPath: string;
    executiveSummaryFile: string;
    heroBackgroundPath: string;
    heroBackgroundFile: string;
    executiveSummaryParagraph: string;
  };
}

/* -------------------------------------------------------------------------- */
/* errors                                                                      */
/* -------------------------------------------------------------------------- */

class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineError";
  }
}

/* -------------------------------------------------------------------------- */
/* small helpers                                                               */
/* -------------------------------------------------------------------------- */

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EngineError(`${what}: expected an object, got ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new EngineError(`${what}: expected an array, got ${describe(value)}`);
  }
  return value;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== "string") {
    throw new EngineError(`${what}: expected a string, got ${describe(value)}`);
  }
  return value;
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new EngineError(`${what}: expected a number, got ${describe(value)}`);
  }
  return value;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/* -------------------------------------------------------------------------- */
/* manifest reading                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The canonical manifest carries a comment block that documents the engine
 * surface it targets, so the reader accepts JSON with `//` and `/* *\/`
 * comments. Comment markers inside string literals are left alone.
 */
function stripJsonComments(source: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  let index = 0;
  while (index < source.length) {
    const ch = source.charAt(index);
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      index += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      index += 1;
      continue;
    }
    if (ch === "/" && source.charAt(index + 1) === "/") {
      while (index < source.length && source.charAt(index) !== "\n") index += 1;
      continue;
    }
    if (ch === "/" && source.charAt(index + 1) === "*") {
      index += 2;
      while (index < source.length && !(source.charAt(index) === "*" && source.charAt(index + 1) === "/")) {
        index += 1;
      }
      index += 2;
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

function readManifest(path: string): unknown {
  const source = readFileSync(path, "utf-8");
  try {
    return JSON.parse(stripJsonComments(source)) as unknown;
  } catch (error) {
    throw new ValidationError(`manifest is not valid JSON: ${(error as Error).message}`);
  }
}

function requireString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`${where}.${key} must be a non-empty string`);
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string, where: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`${where}.${key} must be a number`);
  }
  return value;
}

function requireRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${where} must be an array`);
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* markdown                                                                    */
/* -------------------------------------------------------------------------- */

interface MarkdownBlock {
  kind: "heading" | "paragraph" | "list";
  level: number;
  text: string;
}

/** Split a Markdown file into the blocks the pipeline understands. */
function parseMarkdown(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  for (const raw of markdown.split(/\r?\n\r?\n/)) {
    const chunk = raw.trim();
    if (chunk.length === 0) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(chunk.split("\n")[0] ?? "");
    if (heading !== null) {
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]!.trim() });
      continue;
    }
    const lines = chunk.split("\n").map((line) => line.trim());
    if (lines.every((line) => /^([-*+]|\d+[.)])\s+/.test(line))) {
      blocks.push({
        kind: "list",
        level: 0,
        text: lines.map((line) => line.replace(/^([-*+]|\d+[.)])\s+/, "")).join("\n"),
      });
      continue;
    }
    blocks.push({ kind: "paragraph", level: 0, text: lines.join(" ") });
  }
  return blocks;
}

/** The first paragraph under the `## Executive Summary` heading. */
function firstExecutiveSummaryParagraph(markdown: string): string {
  const blocks = parseMarkdown(markdown);
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    if (block.kind === "heading" && /executive summary/i.test(block.text)) {
      for (let next = index + 1; next < blocks.length; next += 1) {
        const candidate = blocks[next]!;
        if (candidate.kind === "heading") break;
        if (candidate.text.trim().length > 0) return candidate.text.trim();
      }
    }
  }
  return "";
}

/**
 * The plain text of a chapter: headings lose their markers, list items keep
 * their bullet, image references are dropped (the pipeline places those
 * images itself, from the manifest) and a chapter reference becomes the
 * referenced chapter's title. The chapter's own leading heading is dropped
 * as well: the manifest already carries the title, and the brochure sets
 * it in the chapter's own frame.
 */
function markdownToPlainText(markdown: string, chapterTitle: string, chapterTitles: Map<string, string>): string {
  const parts: string[] = [];
  let seenOwnTitle = false;
  for (const block of parseMarkdown(markdown)) {
    if (block.kind === "heading") {
      if (!seenOwnTitle && block.text.trim() === chapterTitle.trim()) {
        seenOwnTitle = true;
        continue;
      }
      parts.push(block.text);
      continue;
    }
    if (block.kind === "list") {
      parts.push(block.text.split("\n").map((line) => `• ${line}`).join("\n"));
      continue;
    }
    parts.push(
      block.text
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[\[chap:([^\]]+)\]\]/g, (_match, id: string) => chapterTitles.get(id) ?? id),
    );
  }
  return parts.join("\n\n");
}

/* -------------------------------------------------------------------------- */
/* validation                                                                  */
/* -------------------------------------------------------------------------- */

function resolveUnder(base: string, candidate: string): string {
  return isAbsolute(candidate) ? candidate : resolve(base, candidate);
}

function validateFramework(raw: unknown, baseDir: string): ResolvedFramework {
  const manifest = requireRecord(raw, "framework");
  for (const key of ["release", "codename", "title", "edition", "authors", "chapters", "frontMatter", "outputRoot"]) {
    if (!(key in manifest)) {
      throw new ValidationError(`framework.${key} is required`);
    }
  }

  const authors = requireArray(manifest["authors"], "framework.authors").map((entry, index) => {
    const author = requireRecord(entry, `framework.authors[${index}]`);
    return {
      name: requireString(author, "name", `framework.authors[${index}]`),
      affiliation: requireString(author, "affiliation", `framework.authors[${index}]`),
    };
  });

  const typographyRaw = requireRecord(manifest["typography"] ?? {}, "framework.typography");
  const budgetRaw = requireRecord(typographyRaw["divergenceBudget"] ?? {}, "framework.typography.divergenceBudget");
  const typography: Typography = {
    fontFamily: requireString(typographyRaw, "fontFamily", "framework.typography"),
    divergenceBudget: {
      totalPages: requireNumber(budgetRaw, "totalPages", "framework.typography.divergenceBudget"),
      perChapterPages: requireNumber(budgetRaw, "perChapterPages", "framework.typography.divergenceBudget"),
    },
  };

  const figureIds = new Set<string>();
  const chapterIds = new Set<string>();
  const chapterTitles = new Map<string, string>();
  const chapters: ResolvedChapter[] = [];

  requireArray(manifest["chapters"], "framework.chapters").forEach((entry, index) => {
    const where = `framework.chapters[${index}]`;
    const chapter = requireRecord(entry, where);
    const id = requireString(chapter, "id", where);
    if (chapterIds.has(id)) throw new ValidationError(`duplicate chapter id: ${id}`);
    chapterIds.add(id);

    const markdownPath = requireString(chapter, "markdownPath", where);
    const markdownFile = resolveUnder(baseDir, markdownPath);
    if (!existsSync(markdownFile)) {
      throw new ValidationError(`${where}.markdownPath does not exist: ${markdownPath}`);
    }
    const markdown = readFileSync(markdownFile, "utf-8");

    const figures: ResolvedFigure[] = requireArray(chapter["figures"] ?? [], `${where}.figures`).map(
      (figureEntry, figureIndex) => {
        const figureWhere = `${where}.figures[${figureIndex}]`;
        const figure = requireRecord(figureEntry, figureWhere);
        const figureId = requireString(figure, "id", figureWhere);
        if (figureIds.has(figureId)) {
          throw new ValidationError(`duplicate figure id: ${figureId}`);
        }
        figureIds.add(figureId);
        const path = requireString(figure, "path", figureWhere);
        const file = resolveUnder(baseDir, path);
        if (!existsSync(file)) {
          throw new ValidationError(`${figureWhere}.path does not exist: ${path}`);
        }
        return {
          id: figureId,
          path,
          file,
          caption: requireString(figure, "caption", figureWhere),
        };
      },
    );

    const footnotes: FootnoteDef[] = requireArray(chapter["footnotes"] ?? [], `${where}.footnotes`).map(
      (footnoteEntry, footnoteIndex) => {
        const footnoteWhere = `${where}.footnotes[${footnoteIndex}]`;
        const footnote = requireRecord(footnoteEntry, footnoteWhere);
        return {
          id: requireString(footnote, "id", footnoteWhere),
          text: requireString(footnote, "text", footnoteWhere),
        };
      },
    );

    const columns = chapter["columns"] === 1 ? 1 : 2;
    const title = requireString(chapter, "title", where);

    chapters.push({
      id,
      number: requireNumber(chapter, "number", where),
      title,
      markdownPath,
      markdownFile,
      markdown,
      columns,
      figures,
      footnotes,
      body: "",
    });
    chapterTitles.set(id, title);
  });

  // The body text of every chapter, with the chapter references resolved
  // to the referenced chapter's title.
  for (const chapter of chapters) {
    chapter.body = markdownToPlainText(chapter.markdown, chapter.title, chapterTitles);
  }

  // Referential integrity: every figureRef and chapterRef in the Markdown
  // must resolve. This is the gate that keeps the two artefacts honest.
  for (const chapter of chapters) {
    for (const match of chapter.markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
      const reference = match[1] ?? "";
      const figureId = reference.startsWith("fig:") ? reference.slice(4) : reference;
      if (!figureIds.has(figureId)) {
        throw new ValidationError(
          `${chapter.markdownPath} references unknown figure: ${reference}`,
        );
      }
    }
    for (const match of chapter.markdown.matchAll(/\[\[chap:([^\]]+)\]\]/g)) {
      const reference = match[1] ?? "";
      if (!chapterIds.has(reference)) {
        throw new ValidationError(
          `${chapter.markdownPath} references unknown chapter: ${reference}`,
        );
      }
    }
  }

  const frontRaw = requireRecord(manifest["frontMatter"], "framework.frontMatter");
  const executiveSummaryMarkdownPath = requireString(
    frontRaw,
    "executiveSummaryMarkdownPath",
    "framework.frontMatter",
  );
  const heroBackgroundPath = requireString(frontRaw, "heroBackgroundPath", "framework.frontMatter");
  const executiveSummaryFile = resolveUnder(baseDir, executiveSummaryMarkdownPath);
  const heroBackgroundFile = resolveUnder(baseDir, heroBackgroundPath);
  if (!existsSync(executiveSummaryFile)) {
    throw new ValidationError(`framework.frontMatter.executiveSummaryMarkdownPath does not exist: ${executiveSummaryMarkdownPath}`);
  }
  if (!existsSync(heroBackgroundFile)) {
    throw new ValidationError(`framework.frontMatter.heroBackgroundPath does not exist: ${heroBackgroundPath}`);
  }
  const executiveSummaryMarkdown = readFileSync(executiveSummaryFile, "utf-8");
  const executiveSummaryParagraph = firstExecutiveSummaryParagraph(executiveSummaryMarkdown);
  if (executiveSummaryParagraph.length === 0) {
    throw new ValidationError(
      `framework.frontMatter.executiveSummaryMarkdownPath has no paragraph under "## Executive Summary": ${executiveSummaryMarkdownPath}`,
    );
  }

  return {
    release: requireString(manifest, "release", "framework"),
    codename: requireString(manifest, "codename", "framework"),
    title: requireString(manifest, "title", "framework"),
    edition: requireString(manifest, "edition", "framework"),
    authors,
    chapters,
    frontMatter: {
      executiveSummaryMarkdownPath,
      executiveSummaryFile,
      executiveSummaryParagraph,
      heroBackgroundPath,
      heroBackgroundFile,
    },
    outputRoot: requireString(manifest, "outputRoot", "framework"),
    typography,
  };
}

/* -------------------------------------------------------------------------- */
/* MCP client                                                                  */
/* -------------------------------------------------------------------------- */

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const CALL_TIMEOUT_MS = 180_000;

class McpClient {
  private readonly pending = new Map<number, PendingCall>();
  private nextId = 1;
  private buffer = "";
  private stderrTail = "";
  private exited = false;

  private readonly child: ChildProcessWithoutNullStreams;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      this.drain();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4000);
    });
    child.on("exit", (code) => {
      this.exited = true;
      this.rejectAll(new EngineError(`engine exited with code ${code}: ${this.stderrTail}`));
    });
    child.on("error", (error) => {
      this.exited = true;
      this.rejectAll(error);
    });
  }

  static async spawn(binary: string, args: string[]): Promise<McpClient> {
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    const client = new McpClient(child);
    // Every engine in this pipeline speaks the same protocol, but only
    // PhotoCraft insists on the handshake. Doing it unconditionally costs
    // one round trip and keeps the client uniform.
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "publish-pipeline", version: "1.0" },
    });
    client.notify("notifications/initialized", {});
    return client;
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    const frame = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new EngineError(`${method} timed out after ${CALL_TIMEOUT_MS} ms`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
    });
    if (this.exited) {
      promise.catch(() => undefined);
      return Promise.reject(new EngineError(`engine already exited: ${this.stderrTail}`));
    }
    this.child.stdin.write(frame, (error) => {
      if (error !== null && error !== undefined) {
        const call = this.pending.get(id);
        if (call !== undefined) {
          this.pending.delete(id);
          clearTimeout(call.timer);
          call.reject(error);
        }
      }
    });
    return promise;
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private drain(): void {
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (line.length === 0) continue;
      this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const record = message as Record<string, unknown>;
    const id = record["id"];
    if (typeof id !== "number") return; // a server notification; nothing to do
    const call = this.pending.get(id);
    if (call === undefined) return;
    this.pending.delete(id);
    clearTimeout(call.timer);
    if (record["error"] !== undefined) {
      call.reject(new EngineError(`engine error: ${JSON.stringify(record["error"])}`));
      return;
    }
    call.resolve(record["result"]);
  }

  private rejectAll(error: Error): void {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
  }

  /** Call one tool and decode its payload. */
  async tool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.request("tools/call", { name, arguments: args });
    return decodeToolResult(result);
  }

  /** Run one engine command (DesignCraft and WordCraft's vocabulary). */
  async execute(command: string, params: Record<string, unknown>): Promise<unknown> {
    return this.tool("execute", { command, params });
  }

  async close(): Promise<void> {
    if (!this.exited) {
      this.child.stdin.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.child.kill();
          resolve();
        }, 5000);
        this.child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.rejectAll(new EngineError("engine closed"));
  }
}

function decodeToolResult(result: unknown): unknown {
  if (typeof result !== "object" || result === null) return result;
  const record = result as Record<string, unknown>;
  const blocks = Array.isArray(record["content"]) ? (record["content"] as unknown[]) : [];
  const texts: string[] = [];
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue;
    const entry = block as Record<string, unknown>;
    if (entry["type"] === "text" && typeof entry["text"] === "string") {
      texts.push(entry["text"]);
    }
  }
  if (record["isError"] === true) {
    throw new EngineError(`engine rejected the call: ${texts.join(" | ")}`);
  }
  if (texts.length === 0) return result;
  const payload = texts.join("\n");
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return payload;
  }
}

/* -------------------------------------------------------------------------- */
/* DesignCraft stage — the archival PDF                                        */
/* -------------------------------------------------------------------------- */

interface DesignCraftChapter {
  id: string;
  title: string;
  /** 1-based page the chapter starts on. */
  page: number;
  /** The captions of the chapter's figures, in manifest order. */
  captions: string[];
  /** Pages the chapter occupies in the brochure. */
  pages: number;
  /** Lines the chapter's body occupies in DesignCraft's composer. */
  lines: number;
  figures: number;
  footnotes: number;
  /** The frames the chapter owns, used to attribute pages after the layout. */
  frameIds: number[];
}

interface DesignCraftResult {
  pdfPath: string;
  pages: number;
  chapters: DesignCraftChapter[];
  /** Set when the engine refused the PDF/A-2b export and a plain export was used. */
  pdfaFallback: string | null;
}

interface DesignCraftPage {
  index: number;
  bounds: [number, number, number, number];
  /** "right" for a recto, "left" for a verso. */
  side: string;
  margins: { top: number; bottom: number; inside: number; outside: number };
}

interface DesignCraftItem {
  id: number;
  kind: string;
  bounds: [number, number, number, number];
  story?: number;
}

interface DesignCraftSpread {
  index: number;
  pages: DesignCraftPage[];
  items: DesignCraftItem[];
}

interface DesignCraftInspection {
  pageCount: number;
  spreads: DesignCraftSpread[];
  paragraphStyles: string[];
}

/**
 * The geometry of one page, in the spread coordinates the engine expects.
 * A facing-pages spread holds a verso and a recto, and the inside margin
 * swaps sides between them, so the content rectangle is derived from the
 * page's own bounds and margins rather than assumed.
 */
interface PageGeometry {
  spread: number;
  pageIndex: number;
  pageNumber: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  columnWidth: number;
}

function readInspection(value: unknown): DesignCraftInspection {
  const record = asRecord(value, "designcraft.inspect_document");
  const spreads = asArray(record["spreads"] ?? [], "designcraft.spreads").map((entry) => {
    const spread = asRecord(entry, "designcraft.spread");
    const pages = asArray(spread["pages"] ?? [], "designcraft.spread.pages").map((pageEntry) => {
      const page = asRecord(pageEntry, "designcraft.page");
      const bounds = asArray(page["bounds"] ?? [], "designcraft.page.bounds").map((value) =>
        asNumber(value, "designcraft.page.bounds"),
      );
      const margins = asRecord(page["margins"] ?? {}, "designcraft.page.margins");
      return {
        index: asNumber(page["index"], "designcraft.page.index"),
        bounds: [bounds[0] ?? 0, bounds[1] ?? 0, bounds[2] ?? 0, bounds[3] ?? 0] as [
          number,
          number,
          number,
          number,
        ],
        side: asString(page["side"] ?? "right", "designcraft.page.side"),
        margins: {
          top: asNumber(margins["top"] ?? 0, "designcraft.page.margins.top"),
          bottom: asNumber(margins["bottom"] ?? 0, "designcraft.page.margins.bottom"),
          inside: asNumber(margins["inside"] ?? 0, "designcraft.page.margins.inside"),
          outside: asNumber(margins["outside"] ?? 0, "designcraft.page.margins.outside"),
        },
      };
    });
    const items = asArray(spread["items"] ?? [], "designcraft.spread.items").map((itemEntry) => {
      const item = asRecord(itemEntry, "designcraft.item");
      const bounds = asArray(item["bounds"] ?? [], "designcraft.item.bounds").map((value) =>
        asNumber(value, "designcraft.item.bounds"),
      );
      const story = asOptionalNumber(item["story"]);
      return {
        id: asNumber(item["id"], "designcraft.item.id"),
        kind: asString(item["kind"], "designcraft.item.kind"),
        bounds: [bounds[0] ?? 0, bounds[1] ?? 0, bounds[2] ?? 0, bounds[3] ?? 0] as [
          number,
          number,
          number,
          number,
        ],
        ...(story === undefined ? {} : { story }),
      };
    });
    return { index: asNumber(spread["index"], "designcraft.spread.index"), pages, items };
  });
  return {
    pageCount: asNumber(record["pageCount"] ?? 0, "designcraft.pageCount"),
    spreads,
    paragraphStyles: asStringArray(record["paragraphStyles"]),
  };
}

/** The page whose rectangle contains the origin of an item. */
function pageOfItem(spreads: DesignCraftSpread[], item: DesignCraftItem): DesignCraftPage | null {
  const x = item.bounds[0];
  const y = item.bounds[1];
  for (const spread of spreads) {
    for (const page of spread.pages) {
      if (x >= page.bounds[0] && x < page.bounds[2] && y >= page.bounds[1] && y < page.bounds[3]) {
        return page;
      }
    }
  }
  return null;
}

/** The geometry of the page with the given index, or null when it is absent. */
function geometryOfPage(inspection: DesignCraftInspection, pageIndex: number): PageGeometry | null {
  for (const spread of inspection.spreads) {
    for (const page of spread.pages) {
      if (page.index !== pageIndex) continue;
      const verso = page.side === "left";
      const left = page.bounds[0] + (verso ? page.margins.outside : page.margins.inside);
      const right = page.bounds[2] - (verso ? page.margins.inside : page.margins.outside);
      const top = page.bounds[1] + page.margins.top;
      const bottom = page.bounds[3] - page.margins.bottom;
      return {
        spread: spread.index,
        pageIndex: page.index,
        pageNumber: page.index + 1,
        left,
        right,
        top,
        bottom,
        columnWidth: (right - left - GUTTER_PT) / 2,
      };
    }
  }
  return null;
}

/** The highest page index in the document. */
function lastPageIndex(inspection: DesignCraftInspection): number {
  return inspection.spreads
    .flatMap((spread) => spread.pages)
    .reduce((max, page) => Math.max(max, page.index), 0);
}

async function designcraftStage(
  framework: ResolvedFramework,
  outDir: string,
  commands: string[],
): Promise<DesignCraftResult> {
  const client = await McpClient.spawn("designcraft-cli", ["mcp"]);
  try {
    const run = async (command: string, params: Record<string, unknown>): Promise<unknown> => {
      commands.push(command);
      return client.execute(command, params);
    };

    // --- the document ------------------------------------------------------
    await client.tool("new_document", {
      width: A4_WIDTH_PT,
      height: A4_HEIGHT_PT,
      preset: "A4",
      facingPages: true,
      columns: 2,
      gutter: GUTTER_PT,
      margins: { top: MARGIN_TOP, bottom: MARGIN_BOTTOM, inside: MARGIN_INSIDE, outside: MARGIN_OUTSIDE },
      bleed: BLEED_PT,
      title: "Framework Brochure",
      pages: 1,
    });

    // --- named paragraph styles -------------------------------------------
    const family = framework.typography.fontFamily;
    const styles: Array<{ name: string; chars: Record<string, unknown>; para: Record<string, unknown> }> = [
      { name: "Title", chars: { fontFamily: family, size: 34, fontStyle: "Bold" }, para: { align: "center", spaceAfter: 18 } },
      { name: "Heading 1", chars: { fontFamily: family, size: 20, fontStyle: "Bold" }, para: { spaceBefore: 12, spaceAfter: 6 } },
      { name: "Heading 2", chars: { fontFamily: family, size: 14, fontStyle: "Bold" }, para: { spaceBefore: 10, spaceAfter: 4 } },
      { name: "Body", chars: { fontFamily: family, size: 10.5 }, para: { spaceBefore: 0, spaceAfter: 6 } },
      { name: "FigureCaption", chars: { fontFamily: family, size: 8.5, fontStyle: "Italic" }, para: { spaceBefore: 2, spaceAfter: 8 } },
    ];
    for (const style of styles) {
      await run("style.paragraph.create", {
        name: style.name,
        basedOn: "[Basic Paragraph]",
        chars: style.chars,
        para: style.para,
      });
    }
    // Export the heading styles as H1/H2 so the tagged PDF has a real
    // structure tree; that is what makes the accessibility gate meaningful.
    await run("style.exportTag", { style: "Heading 1", tag: "h1" });
    await run("style.exportTag", { style: "Heading 2", tag: "h2" });

    // --- the cover page ----------------------------------------------------
    // The document is created with one page: the cover. Everything after it
    // is reserved with layout.pages.insert.
    const coverGeometry = geometryOfPage(readInspection(await client.tool("inspect_document", {})), 0);
    if (coverGeometry === null) {
      throw new EngineError("designcraft: the freshly created document has no page");
    }
    const coverTitle = asRecord(
      await run("frame.create", {
        spread: coverGeometry.spread,
        rect: [coverGeometry.left, 300, coverGeometry.right, 420],
        content: "text",
        text: framework.title,
      }),
      "designcraft.frame.create(cover title)",
    );
    const coverTitleStory = asNumber(coverTitle["story"], "designcraft.frame.create(cover title).story");
    await run("text.select", { story: coverTitleStory, anchor: 0, focus: framework.title.length });
    await run("style.paragraph.apply", { name: "Title" });

    const coverLine = `${framework.edition} edition · release ${framework.release} (${framework.codename})\n${framework.authors
      .map((author) => `${author.name}, ${author.affiliation}`)
      .join("; ")}`;
    const coverMeta = asRecord(
      await run("frame.create", {
        spread: coverGeometry.spread,
        rect: [coverGeometry.left, 440, coverGeometry.right, 520],
        content: "text",
        text: coverLine,
      }),
      "designcraft.frame.create(cover meta)",
    );
    const coverMetaStory = asNumber(coverMeta["story"], "designcraft.frame.create(cover meta).story");
    await run("text.select", { story: coverMetaStory, anchor: 0, focus: coverLine.length });
    await run("style.paragraph.apply", { name: "Body" });

    // --- reserve the Contents page ----------------------------------------
    // DesignCraft appends the inserted page to the end of the sequence, so
    // the page reserved here is the one the table of contents will occupy
    // and the chapter pages are reserved after it.
    await run("layout.pages.insert", { count: 1, after: 0 });
    const contentsPage = lastPageIndex(readInspection(await client.tool("inspect_document", {})));

    const chapterResults: DesignCraftChapter[] = [];
    let fontChecked = false;

    for (const chapter of framework.chapters) {
      // One page per chapter, reserved before anything is placed on it.
      const before = readInspection(await client.tool("inspect_document", {}));
      await run("layout.pages.insert", { count: 1, after: lastPageIndex(before) });
      const after = readInspection(await client.tool("inspect_document", {}));
      const chapterPageIndex = lastPageIndex(after);
      const geometry = geometryOfPage(after, chapterPageIndex);
      if (geometry === null) {
        throw new EngineError(`designcraft: page ${chapterPageIndex} disappeared after the insert`);
      }
      const pageNumber = geometry.pageNumber;
      const frameIds: number[] = [];

      const column1X0 = geometry.left;
      const column1X1 = geometry.left + geometry.columnWidth;
      const column2X0 = column1X1 + GUTTER_PT;
      const column2X1 = geometry.right;
      const titleTop = geometry.top + 48;
      const titleBottom = titleTop + 44;
      const bodyTop = titleBottom + 10;
      const bodyBottom = geometry.bottom;

      // The chapter title, in Heading 1.
      const titleFrame = asRecord(
        await run("frame.create", {
          spread: geometry.spread,
          rect: [column1X0, titleTop, column2X1, titleBottom],
          content: "text",
          text: chapter.title,
        }),
        "designcraft.frame.create(title)",
      );
      const titleStory = asNumber(titleFrame["story"], "designcraft.frame.create(title).story");
      frameIds.push(asNumber(titleFrame["id"], "designcraft.frame.create(title).id"));
      await run("text.select", { story: titleStory, anchor: 0, focus: chapter.title.length });
      await run("style.paragraph.apply", { name: "Heading 1" });

      // The font assertion. No silent fallback: a family that is not present
      // changes the line metrics and with them the page geometry.
      if (!fontChecked) {
        const fonts = asArray(await run("font.list", {}), "designcraft.font.list");
        const chosen = fonts
          .map((entry) => asRecord(entry, "designcraft.font"))
          .find((entry) => entry["family"] === family);
        if (chosen === undefined || chosen["missing"] === true) {
          const available = fonts
            .map((entry) => asRecord(entry, "designcraft.font"))
            .filter((entry) => entry["missing"] !== true)
            .map((entry) => String(entry["family"]))
            .sort()
            .join(", ");
          throw new EngineError(
            `Required font family "${family}" is not available to DesignCraft. ` +
              `Install it on the runner and on every reviewer's workstation before running the pipeline. ` +
              `Available families: ${available}`,
          );
        }
        fontChecked = true;
      }

      // The body, in two threaded frames: the second one is linked to the
      // first with story.placeAndLink, so the text flows across the columns.
      const bodyFrame = asRecord(
        await run("frame.create", {
          spread: geometry.spread,
          rect: [column1X0, bodyTop, column1X1, bodyBottom],
          content: "text",
          text: chapter.body,
        }),
        "designcraft.frame.create(body)",
      );
      const bodyStory = asNumber(bodyFrame["story"], "designcraft.frame.create(body).story");
      frameIds.push(asNumber(bodyFrame["id"], "designcraft.frame.create(body).id"));
      await run("text.select", { story: bodyStory, anchor: 0, focus: chapter.body.length });
      await run("style.paragraph.apply", { name: "Body" });

      const figureAreaTop = chapter.figures.length > 0 ? bodyTop + 410 : bodyBottom;
      const continuation = asRecord(
        await run("story.placeAndLink", {
          story: bodyStory,
          spread: geometry.spread,
          rect: [column2X0, bodyTop, column2X1, figureAreaTop],
        }),
        "designcraft.story.placeAndLink",
      );
      frameIds.push(asNumber(continuation["id"], "designcraft.story.placeAndLink.id"));

      // The figures: a graphic frame per figure, the image placed into it,
      // and a caption frame underneath.
      const figureSlots = chapter.figures.length;
      const figureAreaHeight = bodyBottom - figureAreaTop;
      for (let index = 0; index < chapter.figures.length; index += 1) {
        const figure = chapter.figures[index]!;
        const slotTop = figureAreaTop + (figureAreaHeight * index) / figureSlots;
        const slotBottom = figureAreaTop + (figureAreaHeight * (index + 1)) / figureSlots;
        const imageBottom = slotBottom - 26;
        const graphicFrame = asRecord(
          await run("frame.create", {
            spread: geometry.spread,
            rect: [column2X0, slotTop, column2X1, imageBottom],
            content: "graphic",
          }),
          "designcraft.frame.create(figure)",
        );
        const graphicId = asNumber(graphicFrame["id"], "designcraft.frame.create(figure).id");
        frameIds.push(graphicId);
        await client.tool("place_image", { frame: graphicId, path: figure.file });

        const captionFrame = asRecord(
          await run("frame.create", {
            spread: geometry.spread,
            rect: [column2X0, imageBottom + 2, column2X1, slotBottom],
            content: "text",
            text: figure.caption,
          }),
          "designcraft.frame.create(caption)",
        );
        const captionStory = asNumber(captionFrame["story"], "designcraft.frame.create(caption).story");
        frameIds.push(asNumber(captionFrame["id"], "designcraft.frame.create(caption).id"));
        await run("text.select", { story: captionStory, anchor: 0, focus: figure.caption.length });
        await run("style.paragraph.apply", { name: "FigureCaption" });
      }

      // The footnotes, as real footnotes at the foot of the page.
      for (const footnote of chapter.footnotes) {
        await run("text.select", { story: bodyStory, anchor: chapter.body.length, focus: chapter.body.length });
        await run("footnote.insert", { text: footnote.text });
      }

      // A top-level bookmark per chapter.
      await run("bookmark.add", { name: chapter.title, page: pageNumber });

      // The composer tells us how many lines the chapter's body occupies.
      // The Word document's own line count is the other half of the
      // divergence measurement.
      const story = asRecord(
        await client.tool("get_story", { story: bodyStory }),
        "designcraft.get_story",
      );

      chapterResults.push({
        id: chapter.id,
        title: chapter.title,
        page: pageNumber,
        pages: 1,
        captions: chapter.figures.map((figure) => figure.caption),
        lines: asNumber(story["lines"] ?? 0, "designcraft.get_story.lines"),
        figures: chapter.figures.length,
        footnotes: chapter.footnotes.length,
        frameIds,
      });
    }

    // --- the running header ------------------------------------------------
    await run("variables.define", {
      name: "ChapterRunning",
      type: "runningHeader",
      style: "Heading 1",
      use: "lastOnPage",
    });

    // --- the table of contents ---------------------------------------------
    // Generated *after* the pages are assembled: the page numbers are not
    // known until the layout is final.
    await run("toc.generate", {
      styles: ["Heading 1", "Heading 2"],
      title: "Contents",
      pageNumbers: true,
      page: contentsPage + 1,
    });

    // --- the export --------------------------------------------------------
    const pdfPath = join(outDir, "framework_brochure.pdf");
    const exportParams: Record<string, unknown> = {
      path: pdfPath,
      pages: "1-",
      spreads: false,
      bleed: true,
      marks: { crop: true, bleed: true, pageInfo: true, weight: 0.25, offset: 6 },
      compressImages: true,
      tagged: true,
    };
    let pdfaFallback: string | null = null;
    try {
      await run("file.exportPdf", { ...exportParams, standard: "a2b" });
    } catch (error) {
      // DesignCraft's own PDF/A-2b writer refuses a document that carries a
      // raster image (it cannot assert the image's interpolation flag).
      // The conformance gate belongs to PdfCraft anyway, so the brochure is
      // exported plainly and converted there — the run is not silently
      // downgraded, the fallback is recorded in the report.
      pdfaFallback = (error as Error).message;
      await run("file.exportPdf", exportParams);
    }

    // --- the per-chapter metrics ------------------------------------------
    // The layout is final now, so the pages each chapter occupies can be
    // read back from the document itself.
    const finalInspection = readInspection(await client.tool("inspect_document", {}));
    const pageCount = finalInspection.pageCount;
    const allItems = finalInspection.spreads.flatMap((spread) => spread.items);
    for (const chapter of chapterResults) {
      const pages = new Set<number>();
      for (const item of allItems) {
        if (!chapter.frameIds.includes(item.id)) continue;
        const page = pageOfItem(finalInspection.spreads, item);
        if (page !== null) pages.add(page.index);
      }
      chapter.pages = Math.max(1, pages.size);
    }

    return { pdfPath, pages: pageCount, chapters: chapterResults, pdfaFallback };
  } finally {
    await client.close();
  }
}

/* -------------------------------------------------------------------------- */
/* WordCraft stage — the reviewer-facing DOCX                                   */
/* -------------------------------------------------------------------------- */

interface WordCraftChapter {
  id: string;
  title: string;
  pages: number;
  lines: number;
  figures: number;
  footnotes: number;
}

interface WordCraftResult {
  docxPath: string;
  pages: number;
  chapters: WordCraftChapter[];
  spellingIssues: number;
}

interface WordCraftBlock {
  index: number;
  style: string;
  text: string;
}

interface WordCraftLayoutPage {
  firstBlock: number;
  number: number;
  lines: number;
}

async function wordcraftStage(
  framework: ResolvedFramework,
  outDir: string,
  commands: string[],
): Promise<WordCraftResult> {
  const client = await McpClient.spawn("wordcraft-cli", ["mcp"]);
  try {
    const run = async (command: string, params: Record<string, unknown>): Promise<unknown> => {
      commands.push(command);
      return client.execute(command, params);
    };

    await client.tool("new_document", { template: "blank" });
    await run("layout.size", { name: "A4" });
    await run("layout.margins", { top: MARGIN_TOP, bottom: MARGIN_BOTTOM, left: MARGIN_INSIDE, right: MARGIN_OUTSIDE });
    await run("layout.orientation", { value: "portrait" });

    // One styles.create per style — WordCraft creates one style per call —
    // and one styles.modify to give it its formatting. The built-in styles
    // (Title, Heading 1, …) already exist and are modified, not created.
    const styles: Array<{ name: string; chr: Record<string, unknown>; para: Record<string, unknown> }> = [
      { name: "Title", chr: { size: 32, bold: true }, para: { align: "center", spaceAfter: 18 } },
      { name: "Heading 1", chr: { size: 20, bold: true }, para: { spaceBefore: 24, spaceAfter: 12 } },
      { name: "Heading 2", chr: { size: 15, bold: true }, para: { spaceBefore: 16, spaceAfter: 8 } },
      { name: "Body", chr: { size: 11 }, para: { align: "justify", lineSpacing: { rule: "multiple", value: 1.15 } } },
      { name: "FigureCaption", chr: { size: 9, italic: true }, para: { align: "center" } },
    ];
    const existing = new Set(
      asArray(await run("styles.list", {}), "wordcraft.styles.list").map((entry) => {
        const style = asRecord(entry, "wordcraft.style");
        return asString(style["name"], "wordcraft.style.name");
      }),
    );
    for (const style of styles) {
      if (!existing.has(style.name)) {
        await run("styles.create", { name: style.name });
      }
      await run("styles.modify", { style: style.name, chr: style.chr, para: style.para });
    }

    // The reserved Contents section, before chapter 1.
    await client.tool("type_text", { text: "Contents" });
    await run("para.style", { style: "Heading 1" });
    await run("text.newParagraph", {});
    await run("references.toc", { levels: 3, title: "Contents" });
    await run("text.newParagraph", {});
    await run("text.pageBreak", {});

    for (const chapter of framework.chapters) {
      await client.tool("type_text", { text: chapter.title });
      await run("para.style", { style: "Heading 1" });
      await run("text.newParagraph", {});

      await client.tool("type_text", { text: chapter.body });
      await run("para.style", { style: "Body" });
      await run("text.newParagraph", {});

      for (const figure of chapter.figures) {
        await run("insert.picture", { path: figure.file, width: 320, alt: figure.caption });
        await run("text.newParagraph", {});
        await client.tool("type_text", { text: figure.caption });
        await run("para.style", { style: "FigureCaption" });
        await run("text.newParagraph", {});
      }

      for (const footnote of chapter.footnotes) {
        await run("references.footnote", { text: footnote.text });
      }
    }

    // The spell check is advisory: the DOCX is a review artefact, not the
    // archival one, so the issue count is recorded and the build continues.
    await run("review.spelling", {});
    const issues = await run("review.issues", {});
    const spellingIssues = Array.isArray(issues) ? issues.length : 0;

    const layout = asRecord(await run("document.layout", {}), "wordcraft.document.layout");
    const layoutPages = asArray(layout["pages"] ?? [], "wordcraft.document.layout.pages").map((entry) => {
      const page = asRecord(entry, "wordcraft.layout.page");
      return {
        firstBlock: asNumber(page["firstBlock"] ?? 0, "wordcraft.layout.page.firstBlock"),
        number: asNumber(page["number"], "wordcraft.layout.page.number"),
        lines: asNumber(page["lines"] ?? 0, "wordcraft.layout.page.lines"),
      };
    });

    const inspection = asRecord(await client.tool("inspect_document", {}), "wordcraft.inspect_document");
    const blocks: WordCraftBlock[] = asArray(inspection["blocks"] ?? [], "wordcraft.blocks").map((entry) => {
      const block = asRecord(entry, "wordcraft.block");
      return {
        index: asNumber(block["index"], "wordcraft.block.index"),
        style: asString(block["style"] ?? "", "wordcraft.block.style"),
        text: asString(block["text"] ?? "", "wordcraft.block.text"),
      };
    });

    // The page a block sits on: the last page whose first block is at or
    // before the block's index.
    const pageOfBlock = (blockIndex: number): number => {
      let best = 1;
      for (const page of layoutPages) {
        if (page.firstBlock <= blockIndex) best = page.number;
      }
      return best;
    };

    // The chapter's own page count and line count: the pages from its
    // heading up to the next chapter's heading, and the lines those pages
    // carry. This is the *approximate* WordCraft measurement the divergence
    // report is built from — the two engines break lines differently, and
    // that is exactly what the report is for.
    const startPages: number[] = [];
    const chapters: WordCraftChapter[] = framework.chapters.map((chapter) => {
      const heading = blocks.find(
        (block) => block.style === "Heading1" && block.text.replace(/[\f]/g, "").trim() === chapter.title,
      );
      const startPage = heading === undefined ? 1 : pageOfBlock(heading.index);
      startPages.push(startPage);
      return {
        id: chapter.id,
        title: chapter.title,
        pages: 1,
        lines: 0,
        figures: chapter.figures.length,
        footnotes: chapter.footnotes.length,
      };
    });

    for (let index = 0; index < chapters.length; index += 1) {
      const chapter = chapters[index]!;
      const start = startPages[index] ?? 1;
      const nextStart = startPages[index + 1];
      const last = nextStart === undefined ? layoutPages.length : nextStart - 1;
      chapter.pages = Math.max(1, last - start + 1);
      chapter.lines = layoutPages
        .filter((page) => page.number >= start && page.number <= last)
        .reduce((total, page) => total + page.lines, 0);
    }

    const docxPath = join(outDir, "framework_review.docx");
    await run("file.saveAs", { path: docxPath });

    return {
      docxPath,
      pages: layoutPages.length,
      chapters,
      spellingIssues,
    };
  } finally {
    await client.close();
  }
}

/* -------------------------------------------------------------------------- */
/* PhotoCraft stage — the release hero image                                    */
/* -------------------------------------------------------------------------- */

interface HeroResult {
  heroPath: string;
  width: number;
  height: number;
}

async function heroStage(
  framework: ResolvedFramework,
  outDir: string,
  commands: string[],
): Promise<HeroResult> {
  const heroPath = join(outDir, `hero_${framework.release}.png`);
  const client = await McpClient.spawn("photocraft-cli", [
    "mcp",
    "--automation-read-root",
    dirname(framework.frontMatter.heroBackgroundFile),
    "--automation-write-root",
    outDir,
  ]);
  try {
    await client.tool("doc_new", {
      width: 1920,
      height: 1080,
      mode: "rgb",
      depth: 8,
      background: "#0b2239",
    });
    await client.tool("doc_place", { path: framework.frontMatter.heroBackgroundFile, fit: true });
    // The codename is centred in a full-width box: a paragraph frame with a
    // centred alignment is the only way to centre a run whose width is not
    // known before it is set.
    commands.push("type.create");
    await client.tool("command_run", {
      id: "type.create",
      params: {
        x: 0,
        y: 0,
        box: [0, 420, 1920, 240],
        align: "center",
        text: framework.codename,
        font: "Source Serif 4",
        size: 150,
        color: "#ffffff",
      },
    });
    await client.tool("doc_save", { path: heroPath, format: "png" });
    return { heroPath, width: 1920, height: 1080 };
  } finally {
    await client.close();
  }
}

/* -------------------------------------------------------------------------- */
/* PdfCraft stage — the PDF/A and accessibility gates                           */
/* -------------------------------------------------------------------------- */

interface PdfaIssue {
  clause: string;
  message: string;
  fixable: boolean;
}

interface PdfaReport {
  compliant: boolean;
  issues: PdfaIssue[];
  level: string;
}

interface AccessibilityRule {
  rule: string;
  category: string;
  status: string;
  findings: Array<{ message: string; page: number | null }>;
}

interface GateResult {
  pdfa: PdfaReport;
  converted: boolean;
  accessibility: AccessibilityRule[];
  altRepaired: number;
  remainingAlternateTextFailures: AccessibilityRule[];
  nonConformantPath: string | null;
}

function readPdfa(value: unknown): PdfaReport {
  const record = asRecord(value, "pdfcraft.pdfa_verify");
  const issues = asArray(record["issues"] ?? [], "pdfcraft.pdfa_verify.issues").map((entry) => {
    const issue = asRecord(entry, "pdfcraft.issue");
    return {
      clause: asString(issue["clause"] ?? "", "pdfcraft.issue.clause"),
      message: asString(issue["message"] ?? "", "pdfcraft.issue.message"),
      fixable: issue["fixable"] === true,
    };
  });
  return {
    compliant: record["compliant"] === true,
    issues,
    level: asString(record["level"] ?? "", "pdfcraft.pdfa_verify.level"),
  };
}

function readAccessibility(value: unknown): AccessibilityRule[] {
  const record = asRecord(value, "pdfcraft.accessibility_check");
  return asArray(record["results"] ?? [], "pdfcraft.accessibility_check.results").map((entry) => {
    const rule = asRecord(entry, "pdfcraft.rule");
    return {
      rule: asString(rule["rule"] ?? "", "pdfcraft.rule.rule"),
      category: asString(rule["category"] ?? "", "pdfcraft.rule.category"),
      status: asString(rule["status"] ?? "", "pdfcraft.rule.status"),
      findings: asArray(rule["findings"] ?? [], "pdfcraft.rule.findings").map((findingEntry) => {
        const finding = asRecord(findingEntry, "pdfcraft.finding");
        const page = asOptionalNumber(finding["page"]);
        return {
          message: asString(finding["message"] ?? "", "pdfcraft.finding.message"),
          page: page === undefined ? null : page,
        };
      }),
    };
  });
}

async function pdfcraftGate(
  framework: ResolvedFramework,
  designChapters: DesignCraftChapter[],
  pdfPath: string,
  outDir: string,
  commands: string[],
): Promise<GateResult> {
  const client = await McpClient.spawn("pdfcraft-cli", ["mcp"]);
  const nonConformantPath = join(outDir, "framework_brochure.NONCONFORMANT.pdf");
  try {
    const opened = asRecord(await client.tool("doc_open", { path: pdfPath }), "pdfcraft.doc_open");
    const doc = asNumber(opened["doc"], "pdfcraft.doc_open.doc");
    commands.push("doc_open");

    // The document's title is set before the conversion: the PDF/A
    // identification the conversion writes must agree with the document
    // information, or the file stops being conformant.
    await client.tool("doc_set_info", { doc, key: "Title", value: framework.title });
    commands.push("doc_set_info");

    // --- PDF/A ------------------------------------------------------------
    let verify = readPdfa(await client.tool("pdfa_verify", { doc, level: "2b" }));
    commands.push("pdfa_verify");
    let converted = false;
    if (!verify.compliant) {
      const fixable = verify.issues.filter((issue) => issue.fixable);
      if (fixable.length > 0) {
        await client.tool("pdfa_convert", { doc, level: "2b" });
        commands.push("pdfa_convert");
        converted = true;
        verify = readPdfa(await client.tool("pdfa_verify", { doc, level: "2b" }));
        commands.push("pdfa_verify");
      }
    }

    // --- accessibility ----------------------------------------------------
    // Every figure the brochure carries was placed by this pipeline, on a
    // known page, with a caption from the manifest. The tagged figures the
    // PDF reports are matched back to those captions by page, and the alt
    // text is written from the caption.
    const placed: Array<{ page: number; caption: string }> = [];
    for (const chapter of designChapters) {
      for (const caption of chapter.captions) {
        placed.push({ page: chapter.page, caption });
      }
    }

    let rules = readAccessibility(await client.tool("accessibility_check", { doc, all: true }));
    commands.push("accessibility_check");
    let altRepaired = 0;

    const alternateTextFailures = (list: AccessibilityRule[]): AccessibilityRule[] =>
      list.filter((rule) => rule.category === "alternate_text" && rule.status === "failed");

    if (alternateTextFailures(rules).length > 0) {
      const figures = asRecord(await client.tool("accessibility_figures", { doc }), "pdfcraft.accessibility_figures");
      const list = asArray(figures["figures"] ?? [], "pdfcraft.accessibility_figures.figures");
      const used = new Set<number>();
      for (let index = 0; index < list.length; index += 1) {
        const figure = asRecord(list[index], "pdfcraft.figure");
        const number = asNumber(figure["figure"], "pdfcraft.figure.figure");
        const page = asOptionalNumber(figure["page"]) ?? 0;
        // The nearest figure that has not been matched yet; when every
        // figure is already matched, the nearest one wins again. A facing
        // page carries a second, undrawn copy of the same figure, and it
        // must describe the same picture.
        let best = -1;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let candidate = 0; candidate < placed.length; candidate += 1) {
          if (used.has(candidate)) continue;
          const distance = Math.abs(placed[candidate]!.page - page);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = candidate;
          }
        }
        if (best < 0) {
          for (let candidate = 0; candidate < placed.length; candidate += 1) {
            const distance = Math.abs(placed[candidate]!.page - page);
            if (distance < bestDistance) {
              bestDistance = distance;
              best = candidate;
            }
          }
        }
        const alt = best < 0 ? "Figure" : placed[best]!.caption;
        if (best >= 0) used.add(best);
        await client.tool("accessibility_set_alt", { doc, figure: number, alt });
        commands.push("accessibility_set_alt");
        altRepaired += 1;
      }
      rules = readAccessibility(await client.tool("accessibility_check", { doc, all: true }));
      commands.push("accessibility_check");
    }

    const remaining = alternateTextFailures(rules);

    if (!verify.compliant || remaining.length > 0) {
      // A non-conformant brochure must never keep the canonical name.
      await client.tool("doc_save", { doc, path: nonConformantPath });
      commands.push("doc_save");
      await client.tool("doc_close", { doc, discard_changes: true });
      return {
        pdfa: verify,
        converted,
        accessibility: rules,
        altRepaired,
        remainingAlternateTextFailures: remaining,
        nonConformantPath,
      };
    }

    // Keep the canonical name.
    await client.tool("doc_save", { doc });
    commands.push("doc_save");
    await client.tool("doc_close", { doc });
    return {
      pdfa: verify,
      converted,
      accessibility: rules,
      altRepaired,
      remainingAlternateTextFailures: [],
      nonConformantPath: null,
    };
  } finally {
    await client.close();
  }
}

/* -------------------------------------------------------------------------- */
/* the HTML summary and the divergence report                                   */
/* -------------------------------------------------------------------------- */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function writeHtmlSummary(framework: ResolvedFramework, hero: HeroResult, outDir: string): string {
  const summaryPath = join(outDir, "summary.html");
  const navigation = framework.chapters
    .map(
      (chapter) =>
        `      <li><a href="#ch-${escapeHtml(chapter.id)}">${escapeHtml(chapter.title)}</a></li>`,
    )
    .join("\n");
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(framework.title)} — ${escapeHtml(framework.release)}</title>
    <style>
      body { font-family: "Source Serif 4", Georgia, serif; margin: 0; color: #14202e; }
      header { background: #0b2239; color: #ffffff; padding: 48px 32px; }
      main { max-width: 52rem; margin: 0 auto; padding: 32px; }
      nav ul { list-style: none; padding: 0; }
      nav li { margin: 0.25rem 0; }
    </style>
  </head>
  <body>
    <header>
      <img src="${escapeHtml(basename(hero.heroPath))}" alt="${escapeHtml(framework.title)} — release ${escapeHtml(framework.release)}" width="${hero.width}" height="${hero.height}" />
      <h1>${escapeHtml(framework.title)}</h1>
      <p>${escapeHtml(framework.edition)} edition · release ${escapeHtml(framework.release)} (${escapeHtml(framework.codename)})</p>
    </header>
    <main>
      <section>
        <h2>Executive Summary</h2>
        <p>${escapeHtml(framework.frontMatter.executiveSummaryParagraph)}</p>
      </section>
      <nav aria-label="Chapters">
        <h2>Chapters</h2>
        <ul>
${navigation}
        </ul>
      </nav>
    </main>
  </body>
</html>
`;
  writeFileSync(summaryPath, html, "utf-8");
  return summaryPath;
}

interface DivergenceChapter {
  id: string;
  title: string;
  designcraftPages: number;
  wordcraftPages: number;
  figures: number;
  footnotes: number;
  lineDelta: number;
}

interface DivergenceReport {
  release: string;
  codename: string;
  generatedFrom: string;
  chapters: DivergenceChapter[];
  totals: {
    designcraftPages: number;
    wordcraftPages: number;
    delta: number;
    budget: number;
    perChapterBudget: number;
  };
  spellingIssues: number;
  warnings: string[];
}

function buildDivergenceReport(
  framework: ResolvedFramework,
  design: DesignCraftResult,
  word: WordCraftResult,
  manifestPath: string,
): DivergenceReport {
  const budget = framework.typography.divergenceBudget;
  const chapters: DivergenceChapter[] = framework.chapters.map((chapter, index) => {
    const designChapter = design.chapters[index];
    const wordChapter = word.chapters[index];
    const designPages = designChapter === undefined ? 0 : designChapter.pages;
    const wordPages = wordChapter === undefined ? 0 : wordChapter.pages;
    const designLines = designChapter === undefined ? 0 : designChapter.lines;
    const wordLines = wordChapter === undefined ? 0 : wordChapter.lines;
    return {
      id: chapter.id,
      title: chapter.title,
      designcraftPages: designPages,
      wordcraftPages: wordPages,
      figures: chapter.figures.length,
      footnotes: chapter.footnotes.length,
      lineDelta: designLines - wordLines,
    };
  });

  const delta = design.pages - word.pages;
  const warnings: string[] = [];
  if (Math.abs(delta) > budget.totalPages) {
    warnings.push(
      `Page-count divergence between the PDF (${design.pages}) and the DOCX (${word.pages}) is ${delta} pages, ` +
        `which exceeds the ±${budget.totalPages} page budget.`,
    );
  }
  for (const chapter of chapters) {
    if (Math.abs(chapter.designcraftPages - chapter.wordcraftPages) > budget.perChapterPages) {
      warnings.push(
        `Chapter "${chapter.title}" diverges by ${chapter.designcraftPages - chapter.wordcraftPages} pages, ` +
          `which exceeds the ±${budget.perChapterPages} page budget.`,
      );
    }
  }

  return {
    release: framework.release,
    codename: framework.codename,
    generatedFrom: manifestPath,
    chapters,
    totals: {
      designcraftPages: design.pages,
      wordcraftPages: word.pages,
      delta,
      budget: budget.totalPages,
      perChapterBudget: budget.perChapterPages,
    },
    spellingIssues: word.spellingIssues,
    warnings,
  };
}

function writeReviewReadme(framework: ResolvedFramework, outDir: string, report: DivergenceReport): string {
  const readmePath = join(outDir, "framework_review.README.md");
  const body = `# ${framework.title} — reviewer copy

This document is a *derivation* of \`framework.json\`, not a transcription of
the Markdown sources. The archival artefact is \`framework_brochure.pdf\`.

## Before you review

The table of contents is a live field. No headless engine can guarantee that
every Word viewer renders a freshly inserted table of contents, so the field
is refreshed when the document is opened: press **F9** (or select the table and
press F9) to rebuild it with the current page numbers.

## Divergence from the PDF

The PDF and this document are typeset by two different engines with two
different hyphenation dictionaries, so they do not break lines the same way.
The difference is measured, not prevented:

* PDF pages: ${report.totals.designcraftPages}
* DOCX pages: ${report.totals.wordcraftPages}
* Difference: ${report.totals.delta} (budget ±${report.totals.budget})
${
  report.warnings.length > 0
    ? `\nWarnings:\n${report.warnings.map((warning) => `* ${warning}`).join("\n")}\n`
    : "\nThe difference is inside the budget.\n"
}
## Spelling

The pipeline ran the proofing pass and recorded ${report.spellingIssues} issue(s). The
count is advisory: this document is a review artefact, not the archival one.
`;
  writeFileSync(readmePath, body, "utf-8");
  return readmePath;
}

/* -------------------------------------------------------------------------- */
/* the pipeline                                                                 */
/* -------------------------------------------------------------------------- */

interface Options {
  manifest: string;
  release: string | null;
  output: string | null;
}

function parseOptions(argv: string[]): Options {
  const valueOf = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    if (index < 0) return null;
    return argv[index + 1] ?? null;
  };
  const manifest = valueOf("--manifest");
  if (manifest === null) {
    throw new ValidationError("usage: publish.js --manifest <path> [--release <release>] [--output <dir>]");
  }
  return { manifest, release: valueOf("--release"), output: valueOf("--output") };
}

async function run(): Promise<number> {
  let options: Options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ stage: "validate", error: (error as Error).message })}\n`);
    return EXIT_VALIDATION;
  }

  const manifestPath = resolve(options.manifest);
  const baseDir = dirname(manifestPath);

  let framework: ResolvedFramework;
  try {
    framework = validateFramework(readManifest(manifestPath), baseDir);
    if (options.release !== null && framework.release !== options.release) {
      throw new ValidationError(
        `--release ${options.release} does not match the manifest release ${framework.release}`,
      );
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ stage: "validate", error: (error as Error).message })}\n`);
    return EXIT_VALIDATION;
  }

  const outDir = options.output === null ? resolve(baseDir, framework.outputRoot) : resolve(options.output);
  mkdirSync(outDir, { recursive: true });

  const commands: string[] = [];
  let design: DesignCraftResult;
  let word: WordCraftResult;
  let hero: HeroResult;
  try {
    design = await designcraftStage(framework, outDir, commands);
    word = await wordcraftStage(framework, outDir, commands);
    hero = await heroStage(framework, outDir, commands);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ stage: "engine", error: (error as Error).message })}\n`);
    return EXIT_ENGINE;
  }

  const gate = await pdfcraftGate(framework, design.chapters, design.pdfPath, outDir, commands);

  const report = buildDivergenceReport(framework, design, word, manifestPath);
  writeFileSync(join(outDir, "divergence_report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  writeHtmlSummary(framework, hero, outDir);
  writeReviewReadme(framework, outDir, report);

  const summary = {
    release: framework.release,
    codename: framework.codename,
    artefacts: {
      pdf: design.pdfPath,
      docx: word.docxPath,
      hero: hero.heroPath,
      summary: join(outDir, "summary.html"),
      divergenceReport: join(outDir, "divergence_report.json"),
    },
    pdfa: {
      compliant: gate.pdfa.compliant,
      level: gate.pdfa.level,
      converted: gate.converted,
      issues: gate.pdfa.issues.map((issue) => `${issue.clause}: ${issue.message}`),
      // Set when DesignCraft's own PDF/A writer refused the export and
      // the conversion was left to PdfCraft.
      designCraftPdfAFallback: design.pdfaFallback,
    },
    accessibility: {
      altRepaired: gate.altRepaired,
      remainingAlternateTextFailures: gate.remainingAlternateTextFailures.length,
    },
    spellingIssues: word.spellingIssues,
    pages: { designcraft: design.pages, wordcraft: word.pages },
    commands,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  if (!gate.pdfa.compliant) {
    process.stderr.write(
      `${JSON.stringify({ stage: "pdfa", nonConformant: gate.nonConformantPath, issues: gate.pdfa.issues })}\n`,
    );
    return EXIT_PDFA;
  }
  if (gate.remainingAlternateTextFailures.length > 0) {
    process.stderr.write(
      `${JSON.stringify({ stage: "accessibility", failures: gate.remainingAlternateTextFailures })}\n`,
    );
    return EXIT_A11Y;
  }
  return EXIT_OK;
}

run()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ stage: "unhandled", error: String(error) })}\n`);
    process.exitCode = EXIT_ENGINE;
  });
