// run_ex4.ts — acceptance harness for the print/digital dual export.
//
// It tests canonical JSON + HMAC, the PDF timestamp normaliser and the
// transactional preflight gate. The success path produces a real print PDF,
// a real EPUB (zip) and a signed qa-manifest.json; the failure paths prove that
// both artefacts are deleted together.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  canonicalize,
  errorsOnly,
  normalisePdfDates,
  runDualExport,
  sha256Of,
  signManifest,
  type ExportJob,
  type QAManifest,
} from "./04_print-and-digital-dual-export-with-a-preflight-gate.js";

const HERE = process.cwd();
const OUTPUT = resolve(HERE, "..", "output");
const STAMP = "2026-10-24T02:00:00Z";

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

function pdf(): Buffer {
  const content = "BT /F1 24 Tf 72 720 Td (The Book) Tj ET";
  const pages = 12;
  const objects: string[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  const kids = Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(" ");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  for (let i = 0; i < pages; i += 1) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 15 0 R >> >> /Contents 16 0 R >>`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  objects.push("<< /Title (The Book) /CreationDate (D:20200101000000Z) /ModDate (D:20200101000000Z) >>");
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R /ID[(oldoldold)(oldoldold)] >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

function epub(path: string): void {
  const dir = resolve(path, "..");
  mkdirSync(dir, { recursive: true });
  execFileSync("python3", ["-c", `
import zipfile, sys
path = sys.argv[1]
with zipfile.ZipFile(path, 'w') as z:
    z.writestr(zipfile.ZipInfo('mimetype'), 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
    z.writestr('META-INF/container.xml', '''<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>''')
    z.writestr('OEBPS/content.opf', '''<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:isbn:9780000000000</dc:identifier><dc:title>The Book</dc:title><dc:language>en</dc:language></metadata><manifest><item id="c" href="content.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>''')
    z.writestr('OEBPS/content.xhtml', '''<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>The Book</title></head><body><h1>Chapter One</h1><p>Reflowable text.</p></body></html>''')
`, path], { stdio: "pipe" });
}

const JOB: ExportJob = {
  docName: "book", pageRange: "1-12",
  print: { path: "print/book-x4.pdf", minPpi: 300, standard: "x4", flatten: "high", bleed: true },
  digital: { path: "digital/book.epub", minPpi: 150, language: "en", cover: true },
  toc: { entries: [{ style: "HEAD-H1", level: 1 }, { style: "HEAD-H2", level: 2 }], title: "Contents" },
  metadata: { title: "The Book", author: "Ada Lovelace", isbn: "9780000000000", edition: "2026" },
  deterministicTimestamp: STAMP,
};

function fakeDC(options: {
  printIssues?: any[];
  digitalIssues?: any[];
  pdfThrows?: boolean;
  epubThrows?: boolean;
} = {}): any {
  const calls: string[] = [];
  const altText: string[] = [];
  const doc = {
    spreads: [
      { items: [
        { id: 1, kind: "graphic", origin: "master" },
        { id: 2, kind: "graphic", origin: "page", label: "Figure 1" },
        { id: 3, kind: "graphic", origin: "page", altText: "A known plate" },
      ] },
    ],
    stories: [
      { paragraphStyles: ["HEAD-H1", "BODY-CANONICAL", "HEAD-H2", "HEAD-H1"] },
    ],
  };
  return {
    calls,
    altText,
    call: async (name: string, args: any = {}) => {
      calls.push(name);
      if (name === "save_document") {
        mkdirSync(resolve(args.path, ".."), { recursive: true });
        writeFileSync(args.path, "DESIGNCRAFT SNAPSHOT\n");
        return {};
      }
      if (name === "inspect_document") return doc;
      return {};
    },
    execute: async (name: string, args: any = {}) => {
      calls.push(name);
      if (name === "file.exportPdf") {
        if (options.pdfThrows) throw new Error("PDF export failed");
        mkdirSync(resolve(args.path, ".."), { recursive: true });
        writeFileSync(args.path, pdf());
        return {};
      }
      if (name === "file.exportEpub") {
        if (options.epubThrows) throw new Error("EPUB export failed");
        epub(args.path);
        return {};
      }
      if (name === "preflight.run") {
        return { issues: args.minPpi === 300 ? (options.printIssues ?? []) : (options.digitalIssues ?? []) };
      }
      if (name === "object.altText") { altText.push(args.text); return {}; }
      if (name === "toc.entries") return [{}, {}, {}];
      return {};
    },
    batch: async () => ({}),
  };
}

async function main(): Promise<void> {
  for (const dir of ["work", "print-fail", "digital-fail", "export-fail"]) {
    rmSync(resolve(OUTPUT, dir), { recursive: true, force: true });
  }
  for (const file of ["sample.pdf", "book-print.pdf", "book.epub", "qa-manifest.json",
    "rejected-print.json", "rejected-digital.json", "report.json"]) {
    rmSync(resolve(OUTPUT, file), { force: true });
  }
  mkdirSync(OUTPUT, { recursive: true });

  console.log("\n# canonical JSON and HMAC");
  equal("canonical: key order", canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  equal("canonical: nested key order", canonicalize({ a: { y: 1, x: 2 } }), '{"a":{"x":2,"y":1}}');
  ok("canonical: arrays keep order", canonicalize([1, 2]) !== canonicalize([2, 1]));
  const manifest: QAManifest = {
    schemaVersion: 1, job: JOB, generatedAt: STAMP, artefacts: [], preflight: [],
  };
  const signature = signManifest(manifest, "secret");
  equal("hmac: sha256 hex", signature.length, 64);
  equal("hmac: deterministic", signManifest(manifest, "secret"), signature);
  ok("hmac: a different key differs", signManifest(manifest, "other") !== signature);
  ok("hmac: a nested change breaks it", signManifest({ ...manifest, generatedAt: "2027-01-01T00:00:00Z" }, "secret") !== signature);
  equal("errors: only errors survive", errorsOnly([
    { severity: "error", kind: "ppi", message: "120 ppi" },
    { severity: "warning", kind: "font", message: "not embedded" },
    { severity: "info", kind: "bleed", message: "3 mm" },
  ]).length, 1);

  console.log("\n# PDF timestamp normaliser");
  const sample = resolve(OUTPUT, "sample.pdf");
  writeFileSync(sample, pdf());
  await normalisePdfDates(sample, STAMP);
  const normalised = readFileSync(sample).toString("latin1");
  ok("pdf: creation date pinned", normalised.includes("/CreationDate(D:20261024020000Z)"));
  ok("pdf: mod date pinned", normalised.includes("/ModDate(D:20261024020000Z)"));
  ok("pdf: old dates gone", !normalised.includes("D:20200101000000Z"));
  ok("pdf: ID rewritten", !normalised.includes("oldoldold"));
  equal("hash: sha256 length", (await sha256Of(sample)).sha256.length, 64);

  console.log("\n# successful dual export");
  const work = resolve(OUTPUT, "work");
  mkdirSync(work, { recursive: true });
  const dc = fakeDC();
  const success = await runDualExport(JOB, work, work, "secret", dc);
  equal("success: no rejection", success.rejectedAt, undefined);
  equal("success: two artefacts", success.artefacts.length, 2);
  equal("success: print channel", success.artefacts[0]!.channel, "print");
  equal("success: digital channel", success.artefacts[1]!.channel, "digital");
  ok("success: print PDF exists", existsSync(resolve(work, JOB.print.path)));
  ok("success: EPUB exists", existsSync(resolve(work, JOB.digital.path)));
  ok("success: print bytes non-trivial", readFileSync(resolve(work, JOB.print.path)).length > 500);
  ok("success: print PDF declares twelve pages", readFileSync(resolve(work, JOB.print.path), "latin1").includes("/Count 12"));
  equal("success: EPUB zip magic", readFileSync(resolve(work, JOB.digital.path)).subarray(0, 2).toString(), "PK");
  ok("success: manifest signed", typeof success.signature === "string" && success.signature.length === 64);
  ok("success: manifest persisted", existsSync(resolve(work, "qa-manifest.json")));
  equal("success: alt text set on the non-master figure", dc.altText.length, 1);
  ok("success: alt text names the figure", dc.altText[0] === "Figure 1");
  ok("success: toc generated", dc.calls.includes("toc.generate"));
  equal("success: both preflights ran", success.preflight.length, 2);
  equal("success: print threshold", success.preflight[0]!.minPpi, 300);
  equal("success: digital threshold", success.preflight[1]!.minPpi, 150);
  const pdfText = readFileSync(resolve(work, JOB.print.path), "latin1");
  ok("success: exported PDF is date-pinned", pdfText.includes("D:20261024020000Z"));
  equal("success: print hash matches bytes",
    success.artefacts[0]!.sha256, createHash("sha256").update(readFileSync(resolve(work, JOB.print.path))).digest("hex"));

  console.log("\n# transactional failures");
  const printFailRoot = resolve(OUTPUT, "print-fail");
  mkdirSync(printFailRoot, { recursive: true });
  const printFail = await runDualExport(JOB, printFailRoot, printFailRoot, "secret", fakeDC({
    printIssues: [{ severity: "error", kind: "resolution", message: "image is 120 ppi", page: 3 }],
  }));
  equal("print fail: rejected at print preflight", printFail.rejectedAt?.stage, "print-preflight");
  equal("print fail: no artefacts", printFail.artefacts.length, 0);
  ok("print fail: PDF deleted", !existsSync(resolve(printFailRoot, JOB.print.path)));
  ok("print fail: rejected manifest is signed", printFail.signature!.length === 64);
  writeFileSync(resolve(OUTPUT, "rejected-print.json"), JSON.stringify(printFail, null, 2));

  const digitalFailRoot = resolve(OUTPUT, "digital-fail");
  mkdirSync(digitalFailRoot, { recursive: true });
  const digitalFail = await runDualExport(JOB, digitalFailRoot, digitalFailRoot, "secret", fakeDC({
    digitalIssues: [{ severity: "error", kind: "font", message: "cover font not embedded", page: 1 }],
  }));
  equal("digital fail: rejected at digital preflight", digitalFail.rejectedAt?.stage, "digital-preflight");
  ok("digital fail: print PDF also deleted", !existsSync(resolve(digitalFailRoot, JOB.print.path)));
  ok("digital fail: EPUB deleted", !existsSync(resolve(digitalFailRoot, JOB.digital.path)));
  writeFileSync(resolve(OUTPUT, "rejected-digital.json"), JSON.stringify(digitalFail, null, 2));

  console.log("\n# export failures are atomic");
  const exportFailRoot = resolve(OUTPUT, "export-fail");
  mkdirSync(exportFailRoot, { recursive: true });
  const exportFail = await runDualExport(JOB, exportFailRoot, exportFailRoot, "secret", fakeDC({ epubThrows: true }));
  equal("epub fail: rejected at digital preflight", exportFail.rejectedAt?.stage, "digital-preflight");
  ok("epub fail: print PDF rolled back", !existsSync(resolve(exportFailRoot, JOB.print.path)));

  writeFileSync(resolve(OUTPUT, "book-print.pdf"), readFileSync(resolve(work, JOB.print.path)));
  writeFileSync(resolve(OUTPUT, "book.epub"), readFileSync(resolve(work, JOB.digital.path)));
  writeFileSync(resolve(OUTPUT, "qa-manifest.json"), readFileSync(resolve(work, "qa-manifest.json")));
  for (const artefact of ["book-print.pdf", "book.epub", "qa-manifest.json", "rejected-print.json", "rejected-digital.json"]) {
    ok(`output: ${artefact}`, existsSync(resolve(OUTPUT, artefact)));
  }

  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 4,
    engine: "DesignCraft dual export (scripted engine, real PDF/EPUB)",
    assertions: passed + 1,
    artefactCount: success.artefacts.length,
    preflight: success.preflight.length,
    signature: success.signature,
    artefacts: ["book-print.pdf", "book.epub", "qa-manifest.json", "rejected-print.json", "rejected-digital.json"],
    result: "print + digital exported with two preflight gates; print, digital and export failures all roll both files back",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
