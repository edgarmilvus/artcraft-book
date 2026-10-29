// run_ex3.ts — deterministic harness for the exercise 3 solution.
//
// The report is really authored, really rendered and really sealed; the
// only thing the harness replaces is the vision model, with a scripted
// auditor that fails the first pass and passes the second.

import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  run,
  type BibEntry,
  type ChartInput,
  type VisionAuditResponse,
} from "./03_multimodal-financial-report-assembly-with-live-chart-ingestion.js";

const exec = promisify(execFile);

const FILES = resolve(process.cwd());
const OUTPUT = resolve(FILES, "..", "output");
const WORK = resolve(OUTPUT, "work");

let passed = 0;
function ok(label: string, condition: boolean, detail = ""): void {
  if (!condition) {
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    process.exit(1);
  }
  passed += 1;
  console.log(`PASS ${label}`);
}

function equal<T>(label: string, actual: T, expected: T): void {
  ok(label, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

/** A minimal, valid PNG — a solid 64×32 red block. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAXklEQVR42u3QMQEAAAjDMPBv+heGA" +
  "WjSFRaOvAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAPA8AGnQAAAY1gL0AAAAAElFTkSuQmCC";

/** Call one PdfCraft tool in a fresh session. */
async function pdfTool(
  tool: string,
  args: Record<string, unknown>,
  root: string,
  openPath?: string,
): Promise<any> {
  const client = new Client({ name: "cap17-harness", version: "1.0.0" }, { capabilities: {} });
  await client.connect(
    new StdioClientTransport({ command: "pdfcraft-cli", args: ["mcp", "--root", root] }),
  );
  try {
    if (openPath) {
      await client.callTool({ name: "doc_open", arguments: { path: openPath } });
    }
    const reply = await client.callTool({ name: tool, arguments: args });
    const text = (reply as { content?: Array<{ type: string; text?: string }> }).content?.[0]?.text ?? "{}";
    return JSON.parse(text);
  } finally {
    await client.close();
  }
}

/** Build the studio template, with the four styles the pipeline demands. */
async function buildTemplate(templatePath: string): Promise<void> {
  const client = new Client({ name: "cap17-harness", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command: "wordcraft-cli", args: ["mcp"], cwd: WORK }));
  try {
    await client.callTool({ name: "new_document", arguments: { template: "blank" } });
    for (const style of ["TableText", "Caption"]) {
      await client.callTool({
        name: "execute",
        arguments: { command: "styles.create", params: { name: style } },
      });
    }
    await client.callTool({
      name: "execute",
      arguments: { command: "text.insert", params: { text: "Q3 2026 Sector Pulse" } },
    });
    await client.callTool({ name: "save_document", arguments: { path: templatePath } });
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });

  const submission = resolve(WORK, "submission");
  const reports = resolve(WORK, "reports");
  mkdirSync(submission, { recursive: true });
  mkdirSync(reports, { recursive: true });

  // --- the fixtures -------------------------------------------------------
  const templatePath = resolve(submission, "sector_pulse_template.docx");
  await buildTemplate(templatePath);
  ok("the template was written", existsSync(templatePath));

  const chartPath = resolve(submission, "revenue.png");
  writeFileSync(chartPath, Buffer.from(PNG_BASE64, "base64"));

  const charts: ChartInput[] = [
    {
      section_number: 1,
      section_title: "Revenue",
      chart_png_path: chartPath,
      caption: "Revenue bar chart, Q3 2026",
      alt_text: "Revenue bar chart, Q3 2026, with 12% YoY growth",
      citation_keys: ["smith2025capex"],
    },
    {
      section_number: 2,
      section_title: "EBITDA margin",
      chart_png_path: chartPath,
      caption: "EBITDA margin bridge",
      alt_text: "",
      citation_keys: ["smith2025capex"],
    },
  ];

  const bib: BibEntry[] = [
    { key: "smith2025capex", author: "Smith, J.", year: 2025, title: "Capex outlook", venue: "JPM" },
  ];

  // --- the signing identity ------------------------------------------------
  const signingId = resolve(reports, "studio-seal.p12");
  const signingPassword = "harness-seal-password";
  await pdfTool("sign_id_create", {
    name: "Studio Corporate Seal",
    password: signingPassword,
    path: signingId,
    organization: "Sector Pulse Studio",
    country: "US",
    email: "seal@sectorpulse.example",
  }, WORK);
  ok("the studio seal was created", existsSync(signingId));

  // --- the scripted vision auditor ----------------------------------------
  // It fails the first pass and passes the second — the correction loop
  // therefore runs exactly two iterations.
  let auditCalls = 0;
  const auditor = async (): Promise<VisionAuditResponse> => {
    auditCalls += 1;
    if (auditCalls === 1) {
      return { cv_safe: false, offending_chart: "Revenue", recommended_fix: "highlight_cell" };
    }
    return { cv_safe: true, offending_chart: null, recommended_fix: null };
  };

  // --- the run -------------------------------------------------------------
  const paths = {
    templatePath,
    chartsPath: resolve(submission, "charts.json"),
    bibPath: resolve(submission, "bibliography.bib.json"),
    docxPath: resolve(reports, "sector-pulse.docx"),
    pdfPath: resolve(reports, "sector-pulse.pdf"),
    sealedPath: resolve(reports, "sector-pulse.sealed.pdf"),
    manifestPath: resolve(reports, "sector-pulse.manifest.json"),
    reportsDir: reports,
  };

  const manifest = await run(paths, charts, bib, auditor, signingId, signingPassword);

  // --- the loop ------------------------------------------------------------
  equal("the report is sealed", manifest.status, "sealed");
  equal("the loop ran two iterations", manifest.vision_iterations, 2);
  equal("the auditor was called twice", auditCalls, 2);
  equal("the TOC was updated twice", manifest.update_toc_calls, 2);
  equal("the transcript has two entries", manifest.vision_transcript.length, 2);

  // --- the artefacts -------------------------------------------------------
  ok("the DOCX was written", existsSync(paths.docxPath));
  ok("the PDF was written", existsSync(paths.pdfPath));
  ok("the sealed PDF was written", existsSync(paths.sealedPath));
  ok("the manifest was written", existsSync(paths.manifestPath));

  const { stdout: docxText } = await exec("wordcraft-cli", ["text", paths.docxPath]);
  ok("the section title was typeset", docxText.includes("Revenue"), docxText.slice(0, 200));
  ok("the caption was typeset", docxText.includes("Figure 1"), docxText.slice(0, 300));
  ok("the citation was typeset", docxText.includes("(Smith, 2025)"), docxText.slice(0, 300));
  ok("the bibliography was typeset", docxText.includes("Capex outlook"), docxText.slice(-300));
  ok("the contents were generated", docxText.includes("Contents"), docxText.slice(0, 200));

  // --- the seal ------------------------------------------------------------
  const signatures = await pdfTool("sign_list", { doc: 1 }, WORK, paths.sealedPath);
  equal("the sealed PDF carries one signature", signatures.count, 1);
  equal(
    "the signature belongs to the studio",
    signatures.signatures[0]?.certificate.name,
    "Studio Corporate Seal",
  );
  ok("the PDF/A gate passed", manifest.pdfa.compliant === true, JSON.stringify(manifest.pdfa));

  for (const [from, to] of [
    [paths.docxPath, "sector-pulse.docx"],
    [paths.pdfPath, "sector-pulse.pdf"],
    [paths.sealedPath, "sector-pulse.sealed.pdf"],
    [paths.manifestPath, "sector-pulse.manifest.json"],
  ] as const) {
    copyFileSync(from, resolve(OUTPUT, to));
  }

  console.log(`\n${passed} assertions passed`);
}

await main();
