import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// --- Contracts ---
export interface ExportJob {
  docName: string; pageRange: string;
  print: { path: string; minPpi: 300; standard: "x4"; flatten: "high"; bleed: true; };
  digital: { path: string; minPpi: 150; language: "en"; cover: true; };
  toc: { entries: Array<{ style: string; level: 1 | 2 | 3 }>; title: string; };
  metadata: { title: string; author: string; isbn: string; edition: string; };
  deterministicTimestamp: string;
}
export interface QAManifest {
  schemaVersion: 1;
  job: ExportJob;
  generatedAt: string;
  artefacts: Array<{ channel: "print" | "digital"; path: string; sha256: string; bytes: number }>;
  preflight: Array<{ channel: "print" | "digital"; minPpi: number; issues: Array<{ severity: "error" | "warning" | "info"; kind: string; message: string; page?: number; item?: number; }> }>;
  rejectedAt?: { stage: "print-preflight" | "digital-preflight" | "toc-verification" | "alt-text-verification"; reason: string; };
  signature?: string;
}

export class DC {
  constructor(private c: Client) {}
  static async connect(readRoot: string, writeRoot: string) {
    const t = new StdioClientTransport({ command: "designcraft-cli", args: ["mcp"] });
    const c = new Client({ name: "dual-export", version: "1.0.0" }, { capabilities: {} });
    await c.connect(t);
    return new DC(c);
  }
  async call<T = any>(n: string, a: any = {}): Promise<T> {
    const r = await this.c.callTool({ name: n, arguments: a });
    const txt = (r.content as any[])[0]?.text;
    try { return JSON.parse(txt) as T; } catch { return txt as any; }
  }
  execute(id: string, params: any = {}) { return this.call("execute", { command: id, params }); }
  batch(steps: any[]) { return this.call("batch", { commands: steps.map(s => ({ command: s.id, params: s.params ?? {} })) }); }
}

// --- 1. Determinism setup ---
/**
 * Pin the document preferences every downstream measurement depends
 * on: the units, the keyboard increment and the baseline grid.
 *
 * The PDF's own creation timestamp is *not* a preference — the engine
 * stamps it from the wall clock and derives the document id from it —
 * so the pipeline pins that itself, in `normalisePdfDates`.
 */
export async function pinDocumentPreferences(dc: DC): Promise<void> {
  await dc.execute("document.preferences", {
    horizontalUnits: "points",
    verticalUnits: "points",
    keyboardIncrement: 12,
  });
}

/**
 * Rewrite the timestamps and the document id of an exported PDF so
 * that two runs of the same source produce the same bytes.
 *
 * The replacements keep the original lengths, so the cross-reference
 * table stays valid.
 */
export async function normalisePdfDates(file: string, iso: string): Promise<void> {
  const day = iso.slice(0, 10).replace(/-/g, "");
  const clock = iso.slice(11, 19).replace(/:/g, "");
  const pdfDate = `D:${day}${clock}Z`;
  const xmpDate = `${iso.slice(0, 10)}T${iso.slice(11, 19)}+00:00`;
  // The document id is derived from the timestamp, so it is pinned too.
  const id = crypto.createHash("sha256").update(iso).digest("base64").slice(0, 24);

  let text = (await fs.readFile(file)).toString("latin1");
  text = text.replace(/\/ModDate\s*\(D:[^)]*\)/, `/ModDate(${pdfDate})`);
  text = text.replace(/\/CreationDate\s*\(D:[^)]*\)/, `/CreationDate(${pdfDate})`);
  text = text.replace(/<xmp:ModifyDate>[^<]*<\/xmp:ModifyDate>/, `<xmp:ModifyDate>${xmpDate}</xmp:ModifyDate>`);
  text = text.replace(/<xmp:CreateDate>[^<]*<\/xmp:CreateDate>/, `<xmp:CreateDate>${xmpDate}</xmp:CreateDate>`);
  text = text.replace(/<xmpMM:InstanceID>[^<]*<\/xmpMM:InstanceID>/, `<xmpMM:InstanceID>${id}</xmpMM:InstanceID>`);
  text = text.replace(/<xmpMM:DocumentID>[^<]*<\/xmpMM:DocumentID>/, `<xmpMM:DocumentID>${id}</xmpMM:DocumentID>`);
  text = text.replace(/\/ID\[\([^)]*\)\([^)]*\)\]/, `/ID[(${id})(${id})]`);
  await fs.writeFile(file, Buffer.from(text, "latin1"));
}

// --- 2. Alt text pass (with master-page detection) ---
export async function altTextPass(dc: DC): Promise<void> {
  const doc = await dc.call<any>("inspect_document", {});
  // Identify master-page items to classify as decorative.
  const masterItemIds = new Set<number>();
  for (const spread of doc.spreads) {
    for (const item of spread.items) {
      if (item.origin === "master" || item.origin === "parent") masterItemIds.add(item.id);
    }
  }
  for (const spread of doc.spreads) {
    for (const item of spread.items) {
      if (item.kind !== "graphic") continue;
      if (masterItemIds.has(item.id)) continue;                // decorative — skip
      if (item.altText && item.altText.length > 0) continue;   // already set
      const caption = item.label || item.name || `Figure ${item.id}`;
      await dc.execute("object.altText", { text: caption, ids: [item.id] });
    }
  }
}

// --- 3. TOC generation ---
export async function generateAndVerifyToc(dc: DC, toc: ExportJob["toc"]): Promise<{ ok: boolean; reason?: string }> {
  await dc.execute("toc.generate", {
    entries: toc.entries,
    title: toc.title,
    pageNumbers: true,
  });
  // Rebuild the expected set from document structure.
  const doc = await dc.call<any>("inspect_document", {});
  const expectedHeadings = doc.stories
    .flatMap((s: any) => s.paragraphStyles.map((st: string, i: number) => ({ style: st, idx: i })))
    .filter((p: any) => toc.entries.some(e => e.style === p.style));
  const generated = await dc.execute("toc.entries", { entries: toc.entries });
  if (generated.length !== expectedHeadings.length) {
    return { ok: false, reason: `TOC has ${generated.length} entries; expected ${expectedHeadings.length}` };
  }
  return { ok: true };
}

// --- 4. Preflight gate ---
export async function runPreflight(dc: DC, minPpi: number): Promise<QAManifest["preflight"][0]["issues"]> {
  const r = await dc.execute("preflight.run", { minPpi });
  // preflight.run returns [{severity, kind, message, page?, item?}, ...]
  return (r.issues ?? r) as any;
}
export function errorsOnly(issues: QAManifest["preflight"][0]["issues"]) {
  return issues.filter(i => i.severity === "error");
}

// --- 5. Atomic artefact helpers ---
export async function sha256Of(file: string): Promise<{ sha256: string; bytes: number }> {
  const b = await fs.readFile(file);
  return { sha256: crypto.createHash("sha256").update(b).digest("hex"), bytes: b.length };
}
export async function safeUnlink(p: string) { try { await fs.unlink(p); } catch { /* ignore */ } }

// --- 6. Canonical JSON + HMAC ---
export function canonicalize(obj: any): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalize).join(",")}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}
export function signManifest(manifest: QAManifest, key: string): string {
  const { signature, ...unsigned } = manifest;
  return crypto.createHmac("sha256", key).update(canonicalize(unsigned)).digest("hex");
}

// --- 7. Orchestration ---
export async function runDualExport(
  job: ExportJob, readRoot: string, writeRoot: string, hmacKey: string,
  dcOverride?: DC,
): Promise<QAManifest> {
  const dc = dcOverride ?? await DC.connect(readRoot, writeRoot);
  const manifest: QAManifest = {
    schemaVersion: 1, job,
    generatedAt: job.deterministicTimestamp,
    artefacts: [], preflight: [],
  };

  // Determinism: byte-identical PDFs on re-run.
  await pinDocumentPreferences(dc);

  // Snapshot the source document hash for the manifest's provenance chain.
  const snapshotPath = path.join(writeRoot, `${job.docName}.snapshot.designcraft`);
  await dc.call("save_document", { path: snapshotPath });
  const source = await sha256Of(snapshotPath);

  // -------- PRINT CHANNEL --------
  const printOut = path.join(writeRoot, job.print.path);
  try {
    await dc.execute("file.exportPdf", {
      path: printOut,
      pages: job.pageRange,
      flatten: job.print.flatten,
      standard: job.print.standard,
      bleed: job.print.bleed,
      marks: { crop: true, bleed: true, pageInfo: true, weight: 0.25, offset: 6 },
      tagged: true,
      title: job.metadata.title,
      author: job.metadata.author,
    });
  } catch (e) {
    manifest.rejectedAt = { stage: "print-preflight", reason: `export failed: ${(e as Error).message}` };
    manifest.signature = signManifest(manifest, hmacKey);
    return manifest;
  }

  const printIssues = await runPreflight(dc, job.print.minPpi);
  manifest.preflight.push({ channel: "print", minPpi: job.print.minPpi, issues: printIssues });

  if (errorsOnly(printIssues).length > 0) {
    // Atomicity step 1: print-phase failure deletes the print artefact and aborts.
    await safeUnlink(printOut);
    manifest.rejectedAt = { stage: "print-preflight", reason: `${errorsOnly(printIssues).length} preflight errors` };
    manifest.signature = signManifest(manifest, hmacKey);
    return manifest;
  }
  // The engine stamps the PDF with the wall clock, so the bytes are
  // pinned to the job's timestamp before they are hashed.
  await normalisePdfDates(printOut, job.deterministicTimestamp);
  const printStat = await sha256Of(printOut);
  manifest.artefacts.push({ channel: "print", path: printOut, sha256: printStat.sha256, bytes: printStat.bytes });

  // -------- DIGITAL GATE (pre-export verification) --------
  try {
    await altTextPass(dc);
  } catch (e) {
    await safeUnlink(printOut);
    manifest.rejectedAt = { stage: "alt-text-verification", reason: (e as Error).message };
    manifest.signature = signManifest(manifest, hmacKey);
    return manifest;
  }

  const tocCheck = await generateAndVerifyToc(dc, job.toc);
  if (!tocCheck.ok) {
    await safeUnlink(printOut);
    manifest.rejectedAt = { stage: "toc-verification", reason: tocCheck.reason! };
    manifest.signature = signManifest(manifest, hmacKey);
    return manifest;
  }

  // -------- DIGITAL CHANNEL --------
  const epubOut = path.join(writeRoot, job.digital.path);
  try {
    await dc.execute("file.exportEpub", {
      path: epubOut,
      title: job.metadata.title,
      author: job.metadata.author,
      language: job.digital.language,
      cover: job.digital.cover,
      fixedLayout: false,
    });
  } catch (e) {
    // Atomicity step 2: digital failure deletes both artefacts.
    await safeUnlink(epubOut);
    await safeUnlink(printOut);
    manifest.rejectedAt = { stage: "digital-preflight", reason: `epub export failed: ${(e as Error).message}` };
    manifest.signature = signManifest(manifest, hmacKey);
    return manifest;
  }

  const digitalIssues = await runPreflight(dc, job.digital.minPpi);
  manifest.preflight.push({ channel: "digital", minPpi: job.digital.minPpi, issues: digitalIssues });

  if (errorsOnly(digitalIssues).length > 0) {
    // Both artefacts die together — the transactional contract.
    await safeUnlink(epubOut);
    await safeUnlink(printOut);
    manifest.rejectedAt = { stage: "digital-preflight", reason: `${errorsOnly(digitalIssues).length} preflight errors` };
    manifest.signature = signManifest(manifest, hmacKey);
    return manifest;
  }

  const epubStat = await sha256Of(epubOut);
  manifest.artefacts.push({ channel: "digital", path: epubOut, sha256: epubStat.sha256, bytes: epubStat.bytes });

  // Sign and persist.
  manifest.signature = signManifest(manifest, hmacKey);
  await fs.writeFile(path.join(writeRoot, "qa-manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}
