// run_basic.ts — deterministic harness for the "office pipeline" listing.
//
// The listing runs for real: WordCraft authors a DOCX and exports a PDF
// seed, then PdfCraft stamps the metadata, watermarks the page, flattens
// the annotations and encrypts the file. The harness then reads the
// artefacts back and checks them.

import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { buildGovernedStatement } from "./01_office-pipeline.js";

const exec = promisify(execFile);

/** Read a DOCX back through the engine's own reader. */
async function readDocxText(file: string): Promise<string> {
  const { stdout } = await exec("wordcraft-cli", ["text", file]);
  return stdout;
}

const FILES = resolve(process.cwd());
const OUTPUT = resolve(FILES, "output");
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

/** The PDF magic. */
const PDF_MAGIC = Buffer.from("%PDF-", "latin1");

/** A DOCX is a ZIP: "PK\x03\x04". */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

const REQUEST = {
  accountId: "acct-4417",
  statementNumber: "2026-0042",
  issuedAt: "2026-01-31T09:00:00.000Z",
  currency: "USD",
  customer: {
    name: "Northwind Analytics Ltd",
    email: "ap@northwind.example",
    address: "14 Harbour Row, Bristol BS1 4TR",
  },
  lineItems: [
    { sku: "SEAT-PRO", description: "Professional seat, annual", qty: 12, unitPriceCents: 24900 },
    { sku: "SEAT-STD", description: "Standard seat, annual", qty: 40, unitPriceCents: 9900 },
    { sku: "ONBOARD", description: "Onboarding workshop, \"premium\" tier", qty: 2, unitPriceCents: 150000 },
  ],
};

async function main(): Promise<void> {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });

  // The owner password is the pipeline's own input; the harness supplies it.
  process.env.PDF_OWNER_PASSWORD = "harness-owner-password";

  const result = await buildGovernedStatement(REQUEST);

  // --- the two artefacts -------------------------------------------------
  equal("the DOCX is not empty", result.docxBytes > 1_000, true);
  ok("the PDF is not empty", result.pdfBytes > 1_000, `${result.pdfBytes} bytes`);
  equal("the DOCX and the PDF are both returned", result.pdfBytes > 0 && result.docxBytes > 0, true);

  // --- the bytes on disk -------------------------------------------------
  const docx = readFileSync(resolve(result.workingDir, "statement.docx"));
  const pdf = readFileSync(resolve(result.workingDir, "statement.pdf"));

  ok("the DOCX is a ZIP package", docx.subarray(0, 4).equals(ZIP_MAGIC));
  ok("the PDF has the PDF magic", pdf.subarray(0, 5).equals(PDF_MAGIC));

  // --- the DOCX is a real Word package -----------------------------------
  const docxParts = docx.toString("latin1");
  ok("the DOCX carries the document part", docxParts.includes("word/document.xml"));
  ok("the DOCX carries the styles part", docxParts.includes("word/styles.xml"));

  // --- the DOCX carries the statement ------------------------------------
  // The package is deflated, so the content is read back through the
  // engine's own reader rather than by grepping the bytes.
  const docxText = await readDocxText(resolve(result.workingDir, "statement.docx"));
  ok("the DOCX carries the statement number", docxText.includes("2026-0042"), docxText.slice(0, 120));
  ok("the DOCX carries the customer block", docxText.includes("Northwind Analytics Ltd"));
  ok(
    "the DOCX carries the CSV-built table",
    docxText.includes("SEAT-PRO") && docxText.includes("USD 2988.00"),
    docxText.slice(-200),
  );
  ok(
    "the DOCX keeps the quoted description intact",
    docxText.includes('"premium"'),
    docxText.slice(-200),
  );
  ok(
    "the DOCX carries a footer part for the page number",
    docxParts.includes("word/footer"),
    docxParts.match(/word\/footer\d*\.xml/)?.[0] ?? "none",
  );

  // --- the PDF is encrypted, which is visible in the trailer --------------
  const pdfText = pdf.toString("latin1");
  ok("the PDF is encrypted", pdfText.includes("/Encrypt"), pdfText.slice(-400));

  // --- the timings are reported ------------------------------------------
  ok("the authoring stage is timed", result.timings.authoringMs >= 0);
  ok("the governance stage is timed", result.timings.governanceMs >= 0);
  ok(
    "the total is at least the sum of the stages",
    result.timings.totalMs >= result.timings.authoringMs + result.timings.governanceMs,
    `${result.timings.totalMs} vs ${result.timings.authoringMs}+${result.timings.governanceMs}`,
  );

  // --- the working directory is the isolated one --------------------------
  ok("the working directory exists", existsSync(result.workingDir));
  ok(
    "the working directory is per-job",
    result.workingDir.includes("saas-office"),
    result.workingDir,
  );
  ok(
    "the artefacts live in the working directory",
    statSync(resolve(result.workingDir, "statement.docx")).size === result.docxBytes,
  );

  // --- the artefacts are kept next to the code ---------------------------
  // The pipeline itself writes into a per-job temporary directory; the
  // harness copies the two deliverables into the project's output
  // directory, which is what the repository keeps.
  const kept = resolve(WORK, "kept");
  mkdirSync(kept, { recursive: true });
  copyFileSync(resolve(result.workingDir, "statement.docx"), resolve(kept, "statement.docx"));
  copyFileSync(resolve(result.workingDir, "statement.pdf"), resolve(kept, "statement.pdf"));
  ok(
    "the DOCX was kept in the output directory",
    statSync(resolve(kept, "statement.docx")).size === result.docxBytes,
  );
  ok(
    "the PDF was kept in the output directory",
    statSync(resolve(kept, "statement.pdf")).size === result.pdfBytes,
  );

  console.log(`\n${passed} assertions passed`);
}

await main();
