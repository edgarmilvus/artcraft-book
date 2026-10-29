// =====================================================================
// Exercise 1 — Contract Lifecycle Compiler
// Transport A: MCP over stdio (wordcraft-cli mcp, pdfcraft-cli mcp)
// Transport B (fallback): TCP control channel with mandatory auth first
//   frame — only used on workstations where the desktop app is running.
// =====================================================================
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ---------------- contracts -------------------------------------------------
interface CRMRow {
  crm_record_id: string;
  client_legal_name: string;
  entity_type: "LLC" | "Inc." | "GmbH" | "SARL" | "Pvt Ltd";
  jurisdiction: string;
  scope_reference: string;
  retainer_amount: number;
  retainer_currency: "USD" | "EUR" | "GBP";
  effective_date: string;
  partner_of_record: string;
  partner_initials: string;
}

interface SealedEngagement {
  crm_record_id: string;
  docx_path: string;
  pdf_path: string;
  docx_revision_index: number;
  pdf_revision_count: number;
  pdf_sha256: string;
  pipeline_started_utc: string;
  pipeline_finished_utc: string;
  human_override: boolean;
  status: "sealed" | "sealed_revised" | "failed";
  failure?: { tool: string; params: object; error_message: string };
  // extra fields written into the JSON audit
  row_hash?: string;
  source_row?: CRMRow;
  revision_diff?: { revision_1_bytes: number | null } | null;
}

// ---------------- helpers ---------------------------------------------------
const sha256 = (x: Buffer | string) =>
  createHash("sha256").update(x).digest("hex");

/** A locale-independent money format: 1 234 500.00 — never "1,234,500". */
function money(amount: number): string {
  const [whole = "0", cents = "00"] = amount.toFixed(2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${grouped}.${cents}`;
}

/**
 * A minimal RFC 4180 CSV reader.
 *
 * The nightly export is a flat file with a header row; the pipeline only
 * needs the quoted-field rule, so the parser is twenty lines rather than a
 * dependency. Quoted fields may contain commas, newlines and doubled
 * quotes.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Read the nightly export into typed rows. */
export function readCrmRows(csv: string): CRMRow[] {
  const table = parseCsv(csv);
  const header = table.shift() ?? [];
  const at = (name: string): number => header.indexOf(name);
  return table
    .filter((r) => r.length > 0 && r[0]!.trim().length > 0)
    .map((r) => ({
      crm_record_id: r[at("crm_record_id")] ?? "",
      client_legal_name: r[at("client_legal_name")] ?? "",
      entity_type: (r[at("entity_type")] ?? "LLC") as CRMRow["entity_type"],
      jurisdiction: r[at("jurisdiction")] ?? "",
      scope_reference: r[at("scope_reference")] ?? "",
      retainer_amount: Number(r[at("retainer_amount")] ?? 0),
      retainer_currency: (r[at("retainer_currency")] ?? "USD") as CRMRow["retainer_currency"],
      effective_date: r[at("effective_date")] ?? "",
      partner_of_record: r[at("partner_of_record")] ?? "",
      partner_initials: r[at("partner_initials")] ?? "",
    }));
}

// Entity fonts differ per legal form, per the studio's house style.
const ENTITY_FONT: Record<CRMRow["entity_type"], string> = {
  "LLC": "Sabon", "Inc.": "Helvetica Neue",
  "GmbH": "Garamond", "SARL": "Didot", "Pvt Ltd": "Optima",
};

function scopeParagraph(row: CRMRow): string {
  return (
    `Pursuant to correspondence referencing ${row.scope_reference}, the parties agree that ` +
    `services shall be rendered under the Standard Terms (see footnote). A retainer of ` +
    `${row.retainer_currency} ${money(row.retainer_amount)} is due on ` +
    `${row.effective_date}, in consideration of which the Firm undertakes to represent ` +
    `${row.client_legal_name}, a ${row.entity_type} organised under the laws of ` +
    `${row.jurisdiction}. Engagement executed by ${row.partner_of_record}.`
  );
}

// ---------------- MCP wrapper ----------------------------------------------
class McpClient {
  private client: Client;
  private transport: StdioClientTransport;
  constructor(binary: string, args: string[], cwd?: string) {
    this.transport = new StdioClientTransport({
      command: binary,
      args,
      ...(cwd ? { cwd } : {}),
      env: process.env as Record<string, string>,
    });
    this.client = new Client({ name: "engagement-compiler", version: "1.0.0" },
                             { capabilities: {} });
  }
  async connect() { await this.client.connect(this.transport); }
  async close()   { await this.client.close(); }
  /**
   * Call an MCP tool and coerce its single text content block to JSON.
   *
   * A failing tool answers with `isError: true` and a plain sentence, so
   * the flag is checked before the parse — otherwise the error message
   * would be reported as a JSON syntax error.
   */
  async call<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const res: any = await this.client.callTool({ name, arguments: args });
    const block = (res.content ?? []).find((c: any) => c.type === "text");
    if (res.isError) {
      throw new Error(`MCP tool ${name} failed: ${block?.text ?? "<no detail>"}`);
    }
    if (!block) throw new Error(`MCP tool ${name} produced no text result`);
    try { return JSON.parse(block.text); } catch { return block.text as unknown as T; }
  }
}

// Custom exception so we can name the exact tool that failed, per the contract.
class StepFailure extends Error {
  constructor(public step: string, public params: object, message: string) {
    super(message);
  }
}

// ---------------- the compiler ---------------------------------------------
export async function sealRow(
  row: CRMRow,
  wc: McpClient,
  pc: McpClient,
  outDir: string
): Promise<SealedEngagement> {
  const rowHash   = sha256(JSON.stringify(row));
  const auditPrev = join(outDir, `${row.crm_record_id}.audit.json`);
  const pdfPrev   = join(outDir, `${row.crm_record_id}.pdf`);

  // ---- 1) Idempotency: same row hash + sealed PDF ⇒ pure no-op ----
  let suffix = ""; let isRevision = false;
  if (existsSync(auditPrev) && existsSync(pdfPrev)) {
    const prev = JSON.parse(readFileSync(auditPrev, "utf8"));
    const prevHash = prev.row_hash ?? sha256(JSON.stringify(prev.source_row));
    if (prevHash === rowHash) return { ...prev, status: "sealed" };
    isRevision = true; suffix = "-rev2";
  }

  const docxPath = join(outDir, `${row.crm_record_id}${suffix}.docx`);
  const pdfPath  = join(outDir, `${row.crm_record_id}${suffix}.pdf`);
  const auditPath = join(outDir, `${row.crm_record_id}${suffix}.audit.json`);
  const startedUtc = new Date().toISOString();
  let failure: SealedEngagement["failure"] | undefined;

  // ---- 2) WordCraft composition: ONE atomic batch per contract ----
  await wc.call("new_document", { template: "blank" });

  const commands = [
    { command: "layout.margins", params: { preset: "narrow" } },
    { command: "layout.size",    params: { name: "Letter" } },
    // Style derived per-entity: create then specialise the character face.
    { command: "styles.create",  params: { name: "EngagementParty", fromSelection: false } },
    { command: "styles.modify",  params: { style: "EngagementParty",
                                           chr: { font: ENTITY_FONT[row.entity_type] } } },
    // Retainer schedule rendered as a real table via the spreadsheet importer.
    { command: "insert.spreadsheet", params: { csv: [
        `Line item,Value,Notes`,
        `Retainer,${row.retainer_currency} ${money(row.retainer_amount)},Payable on ${row.effective_date}`,
        `Entity,${row.entity_type},${row.jurisdiction}`,
        `Scope ref,${row.scope_reference},Governed by Standard Terms`,
      ].join("\n") } },
    // `insert.spreadsheet` leaves the caret *inside the first cell* — the
    // next command would type into the table, so the caret is moved to the
    // empty paragraph the body keeps after a trailing table.
    { command: "caret.docEnd", params: {} },
    { command: "text.newParagraph", params: {} },
    // Scope paragraph body, in the derived character style.
    { command: "text.insert", params: { text: scopeParagraph(row) } },
    { command: "format.charStyle", params: { style: "EngagementParty" } },
    // Standard Terms footnote. The command moves the caret into the
    // footnote story, so it has to come after the body content.
    { command: "references.footnote", params: {
        text: `Standard Terms (v2026-01) incorporated by reference; CRM ${row.crm_record_id}.` } },
    // The header is written last for the same reason: `insert.header` moves
    // the caret into the header story.
    { command: "insert.header",  params: {
        text: `${row.client_legal_name} — ${row.jurisdiction} — ${row.effective_date}` } },
  ];

  const batch = await wc.call<any>("batch", { commands, keepGoing: false });
  if (!Array.isArray(batch) || batch.some((step: any) => step?.ok === false)) {
    throw new Error(`WordCraft batch failed: ${JSON.stringify(batch)}`);
  }

  // Capture the document revision index from the post-batch inspection.
  const inspect = await wc.call<any>("inspect_document", {});
  const docx_revision_index: number =
    inspect?.properties?.revision ?? inspect?.blocks?.length ?? commands.length;

  // Save the DOCX and emit PDF from the same provenance chain (not doc_create_multiple!).
  await wc.call("save_document", { path: docxPath });
  await wc.call("execute", { command: "file.exportPdf", params: { path: pdfPath } });

  // ---- 3) PdfCraft governance chain (in strict order) ----
  let pdf_revision_count = 0;
  let revisionDiffNote: { revision_1_bytes: number | null } | null = null;
  const opened = await pc.call<{ doc: number }>("doc_open", { path: pdfPath });
  const docId = opened.doc;

  try {
    // (a) Metadata — including the CRM record id.
    await pc.call("doc_set_info", { doc: docId, key: "Title",    value: `Engagement Letter — ${row.client_legal_name}` });
    await pc.call("doc_set_info", { doc: docId, key: "Author",   value: row.partner_of_record });
    await pc.call("doc_set_info", { doc: docId, key: "Keywords",
      value: `crm:${row.crm_record_id};jurisdiction:${row.jurisdiction};scope:${row.scope_reference}` });
    await pc.call("doc_set_info", { doc: docId, key: "Identifier", value: row.crm_record_id });

    // (b) PDF/A-3b conversion.
    const pdfa = await pc.call<any>("pdfa_convert", { doc: docId, level: "3b" });
    if (pdfa?.error) throw new StepFailure("pdfa_convert", { doc: docId, level: "3b" }, pdfa.error);

    // (c) Confidential watermark.
    await pc.call("doc_watermark", {
      doc: docId,
      text: `CONFIDENTIAL — ${row.partner_initials} ${row.effective_date.slice(0, 10)}`,
      rotation: 45, opacity: 0.15,
    });

    // (d) Password-protect with a permissions password (form-fill only).
    const prot = await pc.call<any>("doc_protect", {
      doc: docId,
      permissions_password: process.env.CRM_PERMS_PWD ?? "change-me-perms",
      changes: "fill-sign",         // ← Acrobat's "Fill in existing form fields and sign"
      printing: "high", copy: false, accessibility: true,
      compatibility: "aes-256", encrypt_metadata: true,
    });
    if (prot?.error) throw new StepFailure("doc_protect", { doc: docId }, prot.error);

    // (e) Full rewrite — needed after pdfa_convert + doc_protect.
    const saved = await pc.call<any>("doc_save",
      { doc: docId, path: pdfPath, full: true });
    if (saved?.error) throw new StepFailure("doc_save",
      { doc: docId, path: pdfPath, full: true }, saved.error);

    // (f) Revision count.
    const revs = await pc.call<any>("doc_revisions", { doc: docId });
    pdf_revision_count = (revs?.revisions ?? []).length;

    // (g) If this was a revision, produce the -rev2 diff proof.
    if (isRevision) {
      const prior = await pc.call<{ doc: number }>("doc_open", { path: pdfPrev });
      await pc.call("doc_compare",       { doc: docId, other: prior.doc, visual: true });
      await pc.call("doc_compare_report",{ doc: docId, other: prior.doc,
        path: join(outDir, `${row.crm_record_id}-rev2.diff.pdf`) });
      // Also snapshot the *first* saved revision of the newly sealed file,
      // so the audit can quote its byte length (doc_open_revision is the
      // only way to materialise a specific revision as its own document).
      const rev1 = await pc.call<any>("doc_open_revision",
                                      { doc: docId, revision: 1 });
      revisionDiffNote = { revision_1_bytes: rev1?.bytes ?? null };
      await pc.call("doc_close", { doc: prior.doc, discard_changes: true });
    }
  } catch (err: any) {
    // The DOCX is left in place — the partner must still be able to review it.
    if (err instanceof StepFailure) {
      failure = { tool: err.step, params: err.params, error_message: err.message };
    } else {
      failure = { tool: "unknown_governance_step", params: { doc: docId },
                  error_message: String(err?.message ?? err) };
    }
    await pc.call("doc_close", { doc: docId, discard_changes: true }).catch(() => {});
  }

  const pdf_sha256 = existsSync(pdfPath) ? sha256(readFileSync(pdfPath)) : "";
  const finishedUtc = new Date().toISOString();

  const audit: SealedEngagement = {
    crm_record_id: row.crm_record_id,
    docx_path: docxPath, pdf_path: pdfPath,
    docx_revision_index, pdf_revision_count, pdf_sha256,
    pipeline_started_utc: startedUtc, pipeline_finished_utc: finishedUtc,
    human_override: false,
    status: failure ? "failed" : (isRevision ? "sealed_revised" : "sealed"),
    row_hash: rowHash, source_row: row,
    revision_diff: revisionDiffNote,
    ...(failure ? { failure } : {}),
  };

  writeFileSync(auditPath, JSON.stringify(audit, null, 2));
  return audit;
}

// ---------------- driver ---------------------------------------------------
export async function main() {
  const csvPath = process.env.CRM_CSV ?? "/work/crm-in/salesforce.csv";
  const outDir  = process.env.CRM_OUT ?? "/work/crm-out";
  mkdirSync(outDir, { recursive: true });

  const rows = readCrmRows(readFileSync(csvPath, "utf8"));

  // NOTE (Transport B fallback):
  //   On a workstation where `wordcraft --control 7979` is already running,
  //   replace StdioClientTransport with a loopback TCP client whose very
  //   first frame MUST be:
  //     {"id":"auth","method":"auth","params":{"token":"<64 hex chars>"}}
  //   Any other first frame causes the socket to be closed. Same for pdfcraft
  //   on a distinct port. The tool-call payloads are the JSON-RPC objects
  //   {"id":n,"method":"engine.execute","params":{"command":…}} for the CLI
  //   surface, or the MCP `tools/call` frame where the desktop speaks MCP.

  // `wordcraft-cli mcp` takes no directory flag: the working directory is
  // the boundary. `pdfcraft-cli mcp --root DIR` *enforces* its directory.
  const wc = new McpClient("wordcraft-cli", ["mcp"], outDir);
  const pc = new McpClient("pdfcraft-cli", ["mcp", "--root", outDir], outDir);
  await wc.connect(); await pc.connect();

  const results: SealedEngagement[] = [];
  for (const row of rows) {
    try { results.push(await sealRow(row, wc, pc, outDir)); }
    catch (e) { console.error(`[!] ${row.crm_record_id} hard failure:`, e); }
  }

  await wc.close(); await pc.close();
  writeFileSync(join(outDir, "_run_summary.json"), JSON.stringify({
    total: results.length,
    sealed: results.filter(r => r.status !== "failed").length,
    failed: results.filter(r => r.status === "failed").length,
  }, null, 2));
  return results;
}

if (process.argv[1]?.endsWith("01_solutions_and_explanations.ts")) {
  main().catch(e => { console.error(e); process.exit(1); });
}
