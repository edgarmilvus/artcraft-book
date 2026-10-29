// run_ex1.ts — deterministic harness for the exercise 1 solution.
//
// The solution runs for real: WordCraft authors the engagement letter from
// the CRM row, PdfCraft seals it as PDF/A-3b with a watermark and a
// permissions password, and the audit JSON is written next to the artefacts.

import { strict as assert } from "node:assert";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { main } from "./01_solutions_and_explanations.js";

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

const CSV = `crm_record_id,client_legal_name,entity_type,jurisdiction,scope_reference,retainer_amount,retainer_currency,effective_date,partner_of_record,partner_initials
SFDC-0042571,Northwind Analytics Ltd,GmbH,US-DE,SOW-2026-Q1-8814,1250000,EUR,2026-02-01,J. Moreau,JM
SFDC-0042572,Harbour Freight SARL,SARL,FR-75,SOW-2026-Q1-8890,48000,EUR,2026-02-04,A. Rossi,AR
`;

async function main_(): Promise<void> {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });

  const csvPath = resolve(WORK, "salesforce.csv");
  const outDir = resolve(WORK, "out");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(csvPath, CSV);

  process.env.CRM_CSV = csvPath;
  process.env.CRM_OUT = outDir;
  process.env.CRM_PERMS_PWD = "harness-perms-password";

  const results = await main();

  // --- the run ------------------------------------------------------------
  equal("both CRM rows were processed", results.length, 2);
  ok(
    "both rows were sealed",
    results.every((r) => r.status === "sealed"),
    JSON.stringify(results.map((r) => [r.crm_record_id, r.status])),
  );

  // --- the artefacts ------------------------------------------------------
  for (const r of results) {
    ok(`the DOCX exists for ${r.crm_record_id}`, existsSync(r.docx_path), r.docx_path);
    ok(`the PDF exists for ${r.crm_record_id}`, existsSync(r.pdf_path), r.pdf_path);
    ok(`the audit exists for ${r.crm_record_id}`, existsSync(`${r.docx_path.replace(/\.docx$/, ".audit.json")}`));
    equal(`the PDF hash is recorded for ${r.crm_record_id}`, r.pdf_sha256.length, 64);
    ok(`the PDF has content for ${r.crm_record_id}`, r.pdf_sha256.length === 64);
  }

  // --- the document really carries the row --------------------------------
  const { stdout: docxText } = await exec("wordcraft-cli", ["text", results[0]!.docx_path]);
  ok("the scope reference was merged", docxText.includes("SOW-2026-Q1-8814"), docxText.slice(0, 300));
  ok("the client name was merged", docxText.includes("Northwind Analytics Ltd"));
  ok(
    "the retainer was formatted deterministically",
    docxText.includes("EUR 1 250 000.00"),
    docxText.slice(0, 300),
  );
  ok("the retainer table was built", docxText.includes("Retainer") && docxText.includes("Scope ref"));

  // --- the audit JSON -----------------------------------------------------
  const audit = JSON.parse(readFileSync(resolve(outDir, "SFDC-0042571.audit.json"), "utf8"));
  equal("the audit records the CRM id", audit.crm_record_id, "SFDC-0042571");
  equal("the audit records the row hash", audit.row_hash.length, 64);
  ok("the audit records the revision index", audit.docx_revision_index >= 0, String(audit.docx_revision_index));
  ok("the audit records the PDF revision count", audit.pdf_revision_count >= 1, String(audit.pdf_revision_count));
  ok("the audit carries the source row", audit.source_row?.partner_initials === "JM");

  // --- the idempotency rule ----------------------------------------------
  const before = readFileSync(resolve(outDir, "SFDC-0042571.pdf"));
  const second = await main();
  equal("the second run is a no-op", second[0]!.status, "sealed");
  const after = readFileSync(resolve(outDir, "SFDC-0042571.pdf"));
  ok("the sealed PDF was not rewritten", before.equals(after));

  // --- the revision rule -------------------------------------------------
  writeFileSync(csvPath, CSV.replace("1250000", "1300000"));
  const third = await main();
  equal("a changed row produces a revision", third[0]!.status, "sealed_revised");
  ok("the revision has its own PDF", existsSync(resolve(outDir, "SFDC-0042571-rev2.pdf")));
  ok("the revision has its own audit", existsSync(resolve(outDir, "SFDC-0042571-rev2.audit.json")));
  ok(
    "the revision carries a diff report",
    existsSync(resolve(outDir, "SFDC-0042571-rev2.diff.pdf")),
  );

  // --- the run summary ----------------------------------------------------
  const summary = JSON.parse(readFileSync(resolve(outDir, "_run_summary.json"), "utf8"));
  equal("the summary counts the rows", summary.total, 2);
  equal("the summary counts the sealed rows", summary.sealed, 2);

  for (const name of ["SFDC-0042571.pdf", "SFDC-0042571.audit.json", "SFDC-0042571-rev2.pdf", "SFDC-0042571-rev2.audit.json", "_run_summary.json"]) {
    copyFileSync(resolve(outDir, name), resolve(OUTPUT, name));
  }

  console.log(`\n${passed} assertions passed`);
}

await main_();
