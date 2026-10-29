// run_nimbus.ts — deterministic harness for the NimbusContracts pipeline.
//
// The pipeline runs for real: WordCraft merges a tenant template, PdfCraft
// stamps the metadata, watermarks the pages, redacts the patterns, strips
// the hidden information and signs the result. The harness then reads the
// artefacts back and checks them.

import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { createNimbusPipeline, type NimbusPipelineHandle } from "./nimbus-factory.js";
import type { PipelineAuditEvent } from "./nimbus-pipeline.js";

const exec = promisify(execFile);

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

const TENANT = "t_northwind";
const TEMPLATE_ID = "MSA-v7";
const IDEMPOTENCY_KEY = "idem-2026-0042-nimbus";

/**
 * Open the sealed PDF in a fresh PdfCraft session and call one tool on it.
 *
 * Each call gets its own session, so the document is opened first and the
 * tool then addresses the handle it was given (id 1 in a fresh session).
 */
async function pdfTool(
  tool: string,
  args: Record<string, unknown>,
  openPath?: string,
): Promise<unknown> {
  const client = new Client({ name: "cap17-harness", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command: "pdfcraft-cli", args: ["mcp", "--root", WORK] }));
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

/** Call a WordCraft command over stdio and return its parsed JSON payload. */
async function wordCommand(
  command: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const client = new Client({ name: "cap17-harness", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command: "wordcraft-cli", args: ["mcp"], cwd: WORK }));
  try {
    const reply = await client.callTool({ name: "execute", arguments: { command, params } });
    const text = (reply as { content?: Array<{ type: string; text?: string }> }).content?.[0]?.text ?? "{}";
    return JSON.parse(text);
  } finally {
    await client.close();
  }
}

/** Build the tenant template the pipeline will merge into. */
async function buildTemplate(templatePath: string): Promise<void> {
  const client = new Client({ name: "cap17-harness", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command: "wordcraft-cli", args: ["mcp"], cwd: WORK }));
  try {
    await client.callTool({ name: "new_document", arguments: { template: "blank" } });
    await client.callTool({
      name: "batch",
      arguments: {
        keepGoing: false,
        commands: [
          { command: "para.style", params: { style: "Heading 1" } },
          { command: "text.insert", params: { text: "Master Services Agreement — {{vendor_name}}" } },
          { command: "text.newParagraph", params: {} },
          { command: "para.style", params: { style: "Normal" } },
          { command: "text.insert", params: { text: "This agreement is between the platform and {{customer_name}}." } },
          { command: "text.newParagraph", params: {} },
          { command: "text.insert", params: { text: "Account reference: {{account_reference}}" } },
          { command: "text.newParagraph", params: {} },
          { command: "text.insert", params: { text: "Direct dial: {{support_phone}}" } },
        ],
      },
    });
    await client.callTool({ name: "save_document", arguments: { path: templatePath } });
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });

  const templateRoot = resolve(WORK, "templates");
  const outputRoot = resolve(WORK, "out");
  mkdirSync(resolve(templateRoot, TENANT), { recursive: true });
  mkdirSync(outputRoot, { recursive: true });

  // --- the tenant template ----------------------------------------------
  const templatePath = resolve(templateRoot, TENANT, `${TEMPLATE_ID}.docx`);
  await buildTemplate(templatePath);
  ok("the tenant template was written", existsSync(templatePath));

  // --- the platform signing identity -------------------------------------
  // The keystore lives *inside* PdfCraft's `--root`: the server refuses a
  // signing identity that sits outside the directory it was given.
  const signingIdPath = resolve(outputRoot, "authority.p12");
  const signingIdPassword = "harness-p12-password";
  await pdfTool("sign_id_create", {
    name: "Nimbus Signing Authority",
    password: signingIdPassword,
    path: signingIdPath,
    organization: "Acme",
    country: "US",
    email: "signing@acme.example",
  });
  ok("the signing identity was created", existsSync(signingIdPath));

  // --- run the pipeline ---------------------------------------------------
  const events: PipelineAuditEvent[] = [];
  let handle: NimbusPipelineHandle | undefined;
  try {
    handle = await createNimbusPipeline({
      wordcraftBinary: "wordcraft-cli",
      pdfcraftBinary: "pdfcraft-cli",
      readRoot: outputRoot,
      writeRoot: outputRoot,
      templateRoot,
      outputRoot,
      signingIdPath,
      signingIdPassword,
      emitAudit: async (event) => {
        events.push(event);
      },
    });

    const result = await handle.pipeline.run({
      tenantId: TENANT,
      templateId: TEMPLATE_ID,
      mergeFields: [
        { key: "vendor_name", value: "Northwind Analytics Ltd" },
        { key: "customer_name", value: "Harbour Freight GmbH" },
        { key: "account_reference", value: "ACCT-7781" },
        { key: "support_phone", value: "555-0100" },
        { key: "document_title", value: "MSA — Northwind / Harbour Freight" },
        {
          key: "payment_schedule_csv",
          value: "Kickoff,2026-02-01,12000.00\nMid-term review,2026-05-01,8000.00",
        },
      ],
      classification: "confidential",
      redactPatterns: ["555-0100"],
      requireSignature: true,
      encryptAtRest: false,
      documentAuthor: "Nimbus Contracts Platform",
      auditAnnotations: [
        { author: "Nimbus Contracts Platform", text: "Countersigned by the platform." },
      ],
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    // --- the receipt ------------------------------------------------------
    equal("the pipeline reports one page", result.pageCount, 1);
    equal("the artefact is signed", result.signatureStatus, "signed");
    equal("one audit event was emitted", events.length, 1);
    equal("the audit event carries the tenant", events[0]?.tenantId, TENANT);
    equal("the audit event carries the classification", events[0]?.classification, "confidential");
    equal("the audit event records the redaction", events[0]?.redactionCount, 1);
    equal("the audit event records the signature state", events[0]?.signatureState, "signed");

    // --- the artefacts ----------------------------------------------------
    ok("the final PDF exists", existsSync(result.pdfPath), result.pdfPath);
    const pdf = readFileSync(result.pdfPath);
    ok("the final PDF has the PDF magic", pdf.subarray(0, 5).equals(PDF_MAGIC));
    ok("the final PDF is not empty", pdf.length > 1_000, `${pdf.length} bytes`);
    equal(
      "the reported hash is the hash of the bytes on disk",
      result.pdfSha256,
      createHash("sha256").update(pdf).digest("hex"),
    );
    ok("the intermediate DOCX was cleaned up", !existsSync(result.docxPath), result.docxPath);

    // --- the merge really happened ----------------------------------------
    // The merged DOCX is deleted on success, so the text is read back out
    // of the governed PDF.
    const extracted = (await pdfTool("text_extract", { doc: 1 }, result.pdfPath)) as {
      pages: Array<{ text: string }>;
    };
    const pageText = extracted.pages.map((p) => p.text).join("\n");
    ok("the vendor name was merged", pageText.includes("Northwind Analytics Ltd"), pageText.slice(0, 300));
    ok("the customer name was merged", pageText.includes("Harbour Freight GmbH"), pageText.slice(0, 300));
    ok("the account reference was merged", pageText.includes("ACCT-7781"), pageText.slice(0, 300));

    // --- the redaction really happened ------------------------------------
    ok("the redacted phone number is gone", !pageText.includes("555-0100"), pageText.slice(0, 300));
    ok(
      "the watermark was applied",
      pageText.includes("CONFIDENTIAL"),
      pageText.slice(0, 300),
    );
    ok(
      "the payment schedule table was assembled",
      pageText.includes("Kickoff") && pageText.includes("12000.00"),
      pageText.slice(-300),
    );
    ok(
      "the table of contents was generated",
      pageText.includes("Contents"),
      pageText.slice(-300),
    );

    // --- the signature really happened -------------------------------------
    const signatures = (await pdfTool("sign_list", { doc: 1 }, result.pdfPath)) as {
      count: number;
      signatures: Array<{ certificate: { name: string } }>;
    };
    equal("the PDF carries one signature", signatures.count, 1);
    equal(
      "the signature belongs to the platform authority",
      signatures.signatures[0]?.certificate.name,
      "Nimbus Signing Authority",
    );

    // --- the post-signature annotation is an incremental update ------------
    const revisions = (await pdfTool("doc_revisions", { doc: 1 }, result.pdfPath)) as {
      revisions: Array<{ revision: number; signed_by: string[] }>;
    };
    ok("the PDF carries at least two revisions", revisions.revisions.length >= 2, JSON.stringify(revisions.revisions));
    ok(
      "the signature anchors a revision",
      revisions.revisions.some((r) => r.signed_by.length > 0),
      JSON.stringify(revisions.revisions),
    );
  } finally {
    await handle?.shutdown();
  }

  console.log(`\n${passed} assertions passed`);
}

await main();
