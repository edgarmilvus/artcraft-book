#!/usr/bin/env node
/**
 * run_ex4.ts — the harness for "The Single-Source-of-Truth Publish".
 *
 * The harness builds the canonical source (a manifest, three Markdown files
 * and two PNG assets) with no dependency outside Node's standard library,
 * runs `02_publish.ts` for real against the four engines, and then checks
 * the artefacts and the engines' own reports.
 *
 * Every check prints one `PASS <label>` line; the run ends with the number
 * of assertions that passed. No API key and no network are involved.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

/* -------------------------------------------------------------------------- */
/* harness plumbing                                                            */
/* -------------------------------------------------------------------------- */

const HERE = dirname(resolve(process.argv[1] ?? "."));
const FILES = HERE;
const WORK = join(FILES, "..", "output", "work");
const FIXTURES = join(WORK, "fixtures");
const OUT = join(WORK, "out");
const LOGS = join(WORK, "logs");
const SOLUTION = join(FILES, "04_the-single-source-of-truth-publishing-pipeline-designcraft-pdfcraft-and-wordcraft-acting-as-one.ts");
const CONTRACT = join(FILES, "01_framework.json");

const passed: string[] = [];
const failed: Array<[string, string]> = [];

function check(label: string, condition: boolean, detail = ""): boolean {
  if (condition) {
    passed.push(label);
    console.log(`PASS ${label}`);
  } else {
    failed.push([label, detail]);
    console.log(`FAIL ${label} ${detail}`);
  }
  return condition;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what}: expected an object, got ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what}: expected an array, got ${describe(value)}`);
  return value;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== "string") throw new Error(`${what}: expected a string, got ${describe(value)}`);
  return value;
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== "number") throw new Error(`${what}: expected a number, got ${describe(value)}`);
  return value;
}

/* -------------------------------------------------------------------------- */
/* a minimal PNG writer (no image library is available to the harness)         */
/* -------------------------------------------------------------------------- */

const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    table.push(value >>> 0);
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] as number);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function writePng(
  path: string,
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number],
): void {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // the "none" filter
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      offset += 3;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
}

interface PngSize {
  width: number;
  height: number;
}

function readPngSize(path: string): PngSize {
  const bytes = readFileSync(path);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/* -------------------------------------------------------------------------- */
/* a minimal MCP client, for the engines' own reports                          */
/* -------------------------------------------------------------------------- */

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

class Mcp {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = "";
  private readonly child: ChildProcessWithoutNullStreams;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        newline = this.buffer.indexOf("\n");
        if (line.length === 0) continue;
        this.dispatch(line);
      }
    });
  }

  static async spawn(command: string, args: string[]): Promise<Mcp> {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const client = new Mcp(child);
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "run-ex4", version: "1.0" },
    });
    client.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
    );
    return client;
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    const promise = new Promise<unknown>((resolveCall, rejectCall) => {
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall });
    });
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
    return promise;
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
    if (typeof id !== "number") return;
    const call = this.pending.get(id);
    if (call === undefined) return;
    this.pending.delete(id);
    if (record["error"] !== undefined) {
      call.reject(new Error(JSON.stringify(record["error"])));
      return;
    }
    call.resolve(record["result"]);
  }

  async tool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.request("tools/call", { name, arguments: args });
    const record = asRecord(result, "mcp result");
    if (record["isError"] === true) {
      throw new Error(`engine rejected ${name}: ${JSON.stringify(record["content"]).slice(0, 300)}`);
    }
    const blocks = asArray(record["content"] ?? [], "mcp content");
    for (const block of blocks) {
      const entry = asRecord(block, "mcp content block");
      if (entry["type"] === "text" && typeof entry["text"] === "string") {
        try {
          return JSON.parse(entry["text"]) as unknown;
        } catch {
          return entry["text"];
        }
      }
    }
    return result;
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    await new Promise<void>((resolveCall) => {
      const timer = setTimeout(() => {
        this.child.kill();
        resolveCall();
      }, 4000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolveCall();
      });
    });
  }
}

/* -------------------------------------------------------------------------- */
/* the fixtures                                                                */
/* -------------------------------------------------------------------------- */

/** The canonical manifest carries a comment block; the reader tolerates it. */
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

const EXEC_SUMMARY = `The threat-modeling pipeline turns one canonical source into a
print-ready brochure, a reviewable Word document and a pitch page, without
any of the three drifting apart.`;

const CHAPTER_ONE = `# Introduction

Threat modeling is a discipline, not a document. The pipeline described here
starts from one canonical manifest and derives every artefact from it.

![The pipeline in practice](fig:fig-pipeline)

The framework is described in [[chap:ch-threats]], which carries the worked
example of a small service.

## Why one source

Every artefact is generated from the same iteration over the chapter list, so
a difference in page count is attributable to the engines' typography and not
to different content.
`;

const CHAPTER_TWO = `# Worked Example

A worked example of the framework, from the trust boundaries of a small
service to the abuse cases that follow from them.

## Trust boundaries

Every trust boundary is drawn once and referenced everywhere.

## Abuse cases

An abuse case is a story about a person who wants something the system should
not give them.
`;

function buildFixtures(): void {
  mkdirSync(join(FIXTURES, "content"), { recursive: true });
  mkdirSync(join(FIXTURES, "assets"), { recursive: true });

  writeFileSync(
    join(FIXTURES, "content", "00-exec-summary.md"),
    `# Threat Modeling Framework\n\n## Executive Summary\n\n${EXEC_SUMMARY}\n\n## Scope\n\nThis paragraph is not part of the summary.\n`,
    "utf-8",
  );
  writeFileSync(join(FIXTURES, "content", "01-intro.md"), CHAPTER_ONE, "utf-8");
  writeFileSync(join(FIXTURES, "content", "02-threats.md"), CHAPTER_TWO, "utf-8");

  // A brand plate for the hero image.
  writePng(join(FIXTURES, "assets", "hero-plate.png"), 320, 180, (x, y) => [
    12 + Math.floor((x / 320) * 30),
    34 + Math.floor((y / 180) * 40),
    57 + Math.floor((x / 320) * 60),
  ]);
  // A figure with three flat colour fields.
  writePng(join(FIXTURES, "assets", "fig-pipeline.png"), 240, 150, (x, y) => {
    if (y < 50) return [200, 60, 40];
    if (x < 120) return [40, 90, 160];
    return [238, 238, 232];
  });

  // The manifest is the shipped starter contract with its paths rewritten
  // and a second chapter appended, so the fixture exercises a chapter that
  // is referenced from another chapter.
  const contract = stripJsonComments(readFileSync(CONTRACT, "utf-8"));
  const manifest = JSON.parse(contract) as Record<string, unknown>;
  manifest["outputRoot"] = "../out";
  const chapters = manifest["chapters"] as Array<Record<string, unknown>>;
  const figures = chapters[0]?.["figures"] as Array<Record<string, unknown>>;
  if (figures !== undefined) figures[0]!["path"] = "assets/fig-pipeline.png";
  const footnotes = chapters[0]?.["footnotes"] as Array<Record<string, unknown>>;
  if (footnotes !== undefined) footnotes[0]!["text"] = "A footnote carried by the canonical manifest.";
  chapters.push({
    id: "ch-threats",
    number: 2,
    title: "Worked Example",
    markdownPath: "content/02-threats.md",
    columns: 2,
    figures: [],
    footnotes: [],
  });
  const frontMatter = manifest["frontMatter"] as Record<string, unknown>;
  frontMatter["heroBackgroundPath"] = "assets/hero-plate.png";
  writeFileSync(join(FIXTURES, "framework.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

/* -------------------------------------------------------------------------- */
/* running the solution                                                        */
/* -------------------------------------------------------------------------- */

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runPipeline(manifest: string, outDir: string, release?: string): Promise<RunResult> {
  const args = [SOLUTION, "--manifest", manifest, "--output", outDir];
  if (release !== undefined) args.push("--release", release);
  return new Promise<RunResult>((resolveCall) => {
    const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("exit", (code) => {
      resolveCall({ code: code ?? -1, stdout, stderr });
    });
  });
}

function engineOnPath(binary: string): boolean {
  const paths = (process.env["PATH"] ?? "").split(":");
  return paths.some((entry) => existsSync(join(entry, binary)));
}

/* -------------------------------------------------------------------------- */
/* the main run                                                                */
/* -------------------------------------------------------------------------- */

async function main(): Promise<number> {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  mkdirSync(LOGS, { recursive: true });
  buildFixtures();

  // --- the starter contract itself ----------------------------------------
  const contractText = stripJsonComments(readFileSync(CONTRACT, "utf-8"));
  let contract: Record<string, unknown> = {};
  let contractParsed = true;
  try {
    contract = JSON.parse(contractText) as Record<string, unknown>;
  } catch (error) {
    contractParsed = false;
  }
  check("starter_contract_is_json_with_comments", contractParsed);
  check(
    "starter_contract_declares_the_divergence_budget",
    JSON.stringify(contract).includes("divergenceBudget"),
  );
  const contractSource = readFileSync(CONTRACT, "utf-8");
  check(
    "starter_contract_names_the_real_command_surface",
    contractSource.includes("bookmark.add") && contractSource.includes("pdfa_verify"),
  );

  // --- the happy path ------------------------------------------------------
  const run = await runPipeline(join(FIXTURES, "framework.json"), OUT, "2025.11");
  writeFileSync(join(LOGS, "publish.stdout.json"), run.stdout, "utf-8");
  writeFileSync(join(LOGS, "publish.stderr.txt"), run.stderr, "utf-8");
  check("pipeline_exit_code_is_zero", run.code === 0, `code=${run.code} stderr=${run.stderr.slice(-400)}`);

  let summary: Record<string, unknown> = {};
  try {
    summary = JSON.parse(run.stdout) as Record<string, unknown>;
  } catch {
    summary = {};
  }
  const commands = (summary["commands"] as string[] | undefined) ?? [];

  const pdfPath = join(OUT, "framework_brochure.pdf");
  const docxPath = join(OUT, "framework_review.docx");
  const heroPath = join(OUT, "hero_2025.11.png");
  const htmlPath = join(OUT, "summary.html");
  const reportPath = join(OUT, "divergence_report.json");

  check("pipeline_writes_the_brochure_pdf", existsSync(pdfPath));
  check("pipeline_writes_the_review_docx", existsSync(docxPath));
  check("pipeline_writes_the_hero_image", existsSync(heroPath));
  check("pipeline_writes_the_html_summary", existsSync(htmlPath));
  check("pipeline_writes_the_divergence_report", existsSync(reportPath));
  check(
    "pipeline_keeps_the_canonical_pdf_name",
    !existsSync(join(OUT, "framework_brochure.NONCONFORMANT.pdf")),
  );

  check("pipeline_asserts_the_font_with_font_list", commands.includes("font.list"));
  check("pipeline_inserts_the_word_table_of_contents", commands.includes("references.toc"));
  check("pipeline_converts_to_pdfa_with_pdfcraft", commands.includes("pdfa_convert"));
  check("pipeline_repairs_the_alternate_text", commands.includes("accessibility_set_alt"));
  check("pipeline_composites_the_hero_with_photocraft", commands.includes("type.create"));

  // --- the report ----------------------------------------------------------
  let report: Record<string, unknown> = {};
  if (existsSync(reportPath)) {
    report = JSON.parse(readFileSync(reportPath, "utf-8")) as Record<string, unknown>;
  }
  const totals = asRecord(report["totals"] ?? {}, "totals");
  const chapters = asArray(report["chapters"] ?? [], "chapters");
  check(
    "divergence_report_carries_the_budget",
    totals["budget"] === 2 && totals["perChapterBudget"] === 1,
    JSON.stringify(totals),
  );
  check(
    "divergence_report_counts_every_chapter",
    chapters.length === 2,
    `${chapters.length} chapters`,
  );
  const firstChapter = asRecord(chapters[0] ?? {}, "chapter 0");
  check(
    "divergence_report_counts_figures_and_footnotes",
    firstChapter["figures"] === 1 && firstChapter["footnotes"] === 1,
    JSON.stringify(firstChapter),
  );
  check(
    "divergence_report_measures_a_line_divergence",
    typeof firstChapter["lineDelta"] === "number" && (firstChapter["lineDelta"] as number) !== 0,
    JSON.stringify(firstChapter),
  );
  check(
    "divergence_report_is_advisory",
    Array.isArray(report["warnings"]) && (report["warnings"] as unknown[]).length >= 0,
  );
  check(
    "divergence_report_records_the_spelling_issue_count",
    typeof report["spellingIssues"] === "number",
    JSON.stringify(report["spellingIssues"]),
  );

  // --- the brochure, read back through PdfCraft ---------------------------
  if (engineOnPath("pdfcraft-cli")) {
    const pdf = await Mcp.spawn("pdfcraft-cli", ["mcp"]);
    try {
      const opened = asRecord(await pdf.tool("doc_open", { path: pdfPath }), "doc_open");
      const doc = asNumber(opened["doc"], "doc");
      const info = asRecord(await pdf.tool("doc_info", { doc }), "doc_info");
      check("pdf_is_tagged", info["tagged"] === true, JSON.stringify(info["tagged"]));
      const bookmarkList = asRecord(await pdf.tool("bookmark_list", { doc }), "bookmark_list");
      const bookmarkTree = asArray(bookmarkList["bookmarks"] ?? [], "bookmarks");
      check(
        "pdf_carries_one_bookmark_per_chapter",
        bookmarkTree.length === 2,
        JSON.stringify(bookmarkTree).slice(0, 300),
      );

      const verify = asRecord(await pdf.tool("pdfa_verify", { doc, level: "2b" }), "pdfa_verify");
      check(
        "pdf_is_pdfa2b_conformant",
        verify["compliant"] === true,
        JSON.stringify(verify["issues"]).slice(0, 300),
      );
      check(
        "pdf_declares_a_pdfa2b_output_intent",
        JSON.stringify(verify["declared"] ?? {}).includes("PDF/A-2b"),
        JSON.stringify(verify["declared"]),
      );

      const extracted = asRecord(await pdf.tool("text_extract", { doc }), "text_extract");
      const pages = asArray(extracted["pages"] ?? [], "text_extract.pages");
      const body = pages
        .map((page) => asString(asRecord(page, "page")["text"] ?? "", "page text"))
        .join("\n");
      check("pdf_carries_the_chapter_titles", body.includes("Introduction") && body.includes("Worked Example"));
      const squash = (text: string): string => text.replace(/[-\s]/g, "");
      check(
        "pdf_carries_the_footnote_text",
        squash(body).includes(squash("A footnote carried by the canonical manifest.")),
        body.slice(-200),
      );
      check("pdf_carries_the_body_text", body.includes("Threat modeling is a discipline"));

      const figures = asRecord(await pdf.tool("accessibility_figures", { doc }), "accessibility_figures");
      const figureList = asArray(figures["figures"] ?? [], "figures");
      check("pdf_has_a_tagged_figure", figureList.length >= 1, JSON.stringify(figureList));
      check(
        "pdf_figure_alt_text_comes_from_the_caption",
        figureList.length > 0 &&
          figureList.every(
            (entry) =>
              asRecord(entry, "figure")["alt"] === "The threat-modeling pipeline in practice.",
          ),
        JSON.stringify(figureList),
      );

      const a11y = asRecord(
        await pdf.tool("accessibility_check", { doc, all: true, categories: ["alternate_text"] }),
        "accessibility_check",
      );
      check("pdf_alternate_text_category_passes", a11y["failed"] === 0, JSON.stringify(a11y["failed"]));

      const pageCount = asArray(info["pages"] ?? [], "info.pages").length;
      check(
        "pdf_page_count_matches_the_divergence_report",
        pageCount === totals["designcraftPages"],
        `${pageCount} vs ${String(totals["designcraftPages"])}`,
      );
      await pdf.tool("doc_close", { doc });
    } finally {
      await pdf.close();
    }
  }

  // --- the Word document, read back through WordCraft ----------------------
  if (engineOnPath("wordcraft-cli")) {
    const word = await Mcp.spawn("wordcraft-cli", ["mcp"]);
    try {
      await word.tool("open_document", { path: docxPath });
      const inspection = asRecord(await word.tool("inspect_document", {}), "inspect_document");
      const blocks = asArray(inspection["blocks"] ?? [], "blocks");
      const styles = new Set(
        blocks.map((block) => asString(asRecord(block, "block")["style"] ?? "", "block style")),
      );
      check("docx_applies_the_heading_1_style", styles.has("Heading1"), [...styles].join(","));
      check("docx_applies_the_body_style", styles.has("Body"), [...styles].join(","));
      check("docx_applies_the_figure_caption_style", styles.has("FigureCaption"), [...styles].join(","));
      const hasField = blocks.some((block) => {
        const objects = asArray(asRecord(block, "block")["objects"] ?? [], "objects");
        return objects.some((object) => String(asRecord(object, "object")["instr"] ?? "").includes("TOC"));
      });
      check("docx_carries_a_table_of_contents_field", hasField);
      const textPayload = await word.tool("get_text", {});
      const text =
        typeof textPayload === "string"
          ? textPayload
          : asString(asRecord(textPayload, "get_text")["text"] ?? "", "get_text.text");
      check("docx_carries_the_chapter_titles", text.includes("Introduction") && text.includes("Worked Example"));
      check("docx_carries_the_figure_caption", text.includes("The threat-modeling pipeline in practice."));
      const layout = asRecord(
        await word.tool("execute", {
          command: "document.layout",
          params: {},
        }),
        "document.layout",
      );
      const layoutPages = asArray(layout["pages"] ?? [], "layout pages");
      check(
        "docx_page_count_matches_the_divergence_report",
        layoutPages.length === totals["wordcraftPages"],
        `${layoutPages.length} vs ${String(totals["wordcraftPages"])}`,
      );
    } finally {
      await word.close();
    }
  }

  // --- the hero image and the HTML summary --------------------------------
  if (existsSync(heroPath)) {
    const size = readPngSize(heroPath);
    check("hero_is_1920_by_1080", size.width === 1920 && size.height === 1080, JSON.stringify(size));
  }
  if (existsSync(htmlPath)) {
    const html = readFileSync(htmlPath, "utf-8");
    check("summary_carries_the_executive_summary", html.includes("without any of the three drifting apart"));
    check("summary_lists_the_chapter_titles", html.includes(">Introduction</a>") && html.includes(">Worked Example</a>"));
    check("summary_omits_the_body_text", !html.includes("Threat modeling is a discipline"));
    check("summary_omits_the_scope_section", !html.includes("This paragraph is not part of the summary"));
    check("summary_points_at_the_hero_image", html.includes("hero_2025.11.png"));
  }

  // --- the validation gate -------------------------------------------------
  const broken = JSON.parse(stripJsonComments(readFileSync(join(FIXTURES, "framework.json"), "utf-8"))) as Record<
    string,
    unknown
  >;
  const brokenChapters = broken["chapters"] as Array<Record<string, unknown>>;
  const brokenFigures = brokenChapters[0]?.["figures"] as Array<Record<string, unknown>>;
  if (brokenFigures !== undefined) brokenFigures[0]!["id"] = "fig-not-in-the-manifest";
  writeFileSync(join(FIXTURES, "framework.broken.json"), JSON.stringify(broken, null, 2), "utf-8");
  const brokenRun = await runPipeline(join(FIXTURES, "framework.broken.json"), join(WORK, "out-broken"));
  check("validation_failure_on_an_unresolvable_figure", brokenRun.code === 1, `code=${brokenRun.code}`);
  check(
    "validation_failure_is_reported_as_validation",
    brokenRun.stderr.includes("unknown figure"),
    brokenRun.stderr.slice(-300),
  );
  check(
    "validation_failure_writes_no_artefact",
    !existsSync(join(WORK, "out-broken", "framework_brochure.pdf")),
  );

  const releaseRun = await runPipeline(join(FIXTURES, "framework.json"), join(WORK, "out-release"), "2026.01");
  check("validation_failure_on_a_release_mismatch", releaseRun.code === 1, `code=${releaseRun.code}`);

  const missing = JSON.parse(stripJsonComments(readFileSync(join(FIXTURES, "framework.json"), "utf-8"))) as Record<
    string,
    unknown
  >;
  (missing["chapters"] as Array<Record<string, unknown>>)[0]!["markdownPath"] = "content/nope.md";
  writeFileSync(join(FIXTURES, "framework.missing.json"), JSON.stringify(missing, null, 2), "utf-8");
  const missingRun = await runPipeline(join(FIXTURES, "framework.missing.json"), join(WORK, "out-missing"));
  check("validation_failure_on_a_missing_markdown_file", missingRun.code === 1, `code=${missingRun.code}`);

  // --- determinism ---------------------------------------------------------
  const second = await runPipeline(join(FIXTURES, "framework.json"), join(WORK, "out-second"), "2025.11");
  check("second_run_also_succeeds", second.code === 0, `code=${second.code}`);
  const secondReport = JSON.parse(
    readFileSync(join(WORK, "out-second", "divergence_report.json"), "utf-8"),
  ) as Record<string, unknown>;
  check(
    "divergence_report_is_deterministic",
    JSON.stringify(secondReport["chapters"]) === JSON.stringify(report["chapters"]) &&
      JSON.stringify(secondReport["totals"]) === JSON.stringify(report["totals"]),
  );
  check(
    "html_summary_is_deterministic",
    readFileSync(join(WORK, "out-second", "summary.html"), "utf-8") === readFileSync(htmlPath, "utf-8"),
  );

  const publishDir = join(FILES, "..", "output");
  for (const [from, to] of [
    [join(OUT, "framework_brochure.pdf"), "framework_brochure.pdf"],
    [join(OUT, "framework_review.docx"), "framework_review.docx"],
    [join(OUT, "summary.html"), "summary.html"],
    [join(OUT, "divergence_report.json"), "divergence_report.json"],
    [join(OUT, "hero_2025.11.png"), "hero.png"],
  ] as const) copyFileSync(from, join(publishDir, to));

  console.log(`${passed.length} assertions passed`);
  if (failed.length > 0) {
    for (const [label, detail] of failed) {
      console.log(`FAILED ${label} ${detail}`);
    }
    return 1;
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.log(`FAIL harness ${String(error)}`);
    console.log(`${passed.length} assertions passed`);
    process.exitCode = 1;
  });
