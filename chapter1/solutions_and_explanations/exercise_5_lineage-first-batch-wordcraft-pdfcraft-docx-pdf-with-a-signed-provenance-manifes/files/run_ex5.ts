// run_ex5.ts — acceptance harness for Chapter 1, Exercise 5.
//
// Runs the lineage-first batch twice against the real engines:
//
//   pass 1  generate + restyle + export + stamp + sign  -> stages "ok"
//   pass 2  same inputs, artefacts already carry the digest -> stages "skipped"
//
// A deliberately corrupt DOCX sits in the same batch and must fail only its own
// row (restyle "failed", export/sign "skipped") without aborting the run.
//
//   npx tsx run_ex5.ts
//
// Engine behaviour this harness works around:
//   * WordCraft has no character-style creation primitive: styles.create always
//     yields a paragraph style, so the banner uses a named paragraph style and
//     is verified in word/header1.xml.
//   * applying a paragraph style inside the header also restyles the body
//     paragraph at the cursor; the restyle plan is re-applied after
//     insert.closeHeader to repair the body.
//   * select.collapse collapses to the start, so caret.end positions the
//     provenance fields at the end of the provenance paragraph.
//   * file.properties has no custom property; source_sha256 rides in keywords.
//   * PdfCraft text extraction maps the 'r' glyph to U+FFFC, so assertions use
//     words that survive ("Specification", "Deployment", "validation").
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BROKEN_BYTES,
  DOC,
  INPUTS,
  MODEL_ID,
  P12_IDENTITY,
  P12_PASSWORD,
  P12_REL,
  REL,
  RUN_ID,
  canSkip,
  classify,
  keywordsFor,
  manifestEntry,
  provenanceFor,
  provenanceLines,
  restyleCommands,
  sha256,
  skippedStages,
  type DocBlock,
  type Manifest,
  type ManifestEntry,
  type Provenance,
  type RestyleStep,
  type StageResult,
} from './05_lineage-first-batch-wordcraft-pdfcraft-docx-pdf-with-a-signed-provenance-manifest.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');
const OUT = resolve(HERE, '..', 'output');
const CLI = process.env.CRAFT_CLI_BIN ?? resolve(REPO, 'tools/craft-cli/bin');

const INPUT = join(OUT, 'input');
const CORRECTED = join(OUT, 'corrected');
const PDF = join(OUT, 'pdf');
const SIGNED = join(OUT, 'signed');
const PROVENANCE = join(OUT, 'provenance');
const CERTS = join(OUT, 'certs');
const MANIFEST = join(OUT, 'manifest.json');

process.chdir(HERE);

// ── clean slate ─────────────────────────────────────────────────────────────
for (const dir of [INPUT, CORRECTED, PDF, SIGNED, PROVENANCE, CERTS]) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}
for (const stale of ['manifest.json', 'manifest-pass1.json', 'manifest-pass2.json', 'run-log.json', 'run_ex5.log']) {
  rmSync(join(OUT, stale), { force: true });
}

const transcript: string[] = [];
const say = (line: string): void => {
  transcript.push(line);
  console.log(line);
};

let checks = 0;
const failures: string[] = [];
const check = (label: string, condition: boolean, detail = ''): void => {
  checks += 1;
  if (!condition) failures.push(label);
  say(`${condition ? ' ok ' : 'FAIL'} ${label.padEnd(58)}${detail}`);
};
const equal = (label: string, actual: unknown, expected: unknown): void =>
  check(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const exists = (path: string): boolean => existsSync(path);
const sha256File = (path: string): string => sha256(readFileSync(path));
const readXml = (docx: string, part: string): string =>
  execFileSync('unzip', ['-p', docx, part], { encoding: 'utf8' });
const readXmlSafe = (docx: string, part: string): string => {
  try { return readXml(docx, part); } catch { return ''; }
};
const bytesOf = (path: string): number => readFileSync(path).length;
const pngMagic = (path: string): boolean =>
  readFileSync(path).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const msg = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ── MCP plumbing ─────────────────────────────────────────────────────────────
type ToolResult = { isError: boolean; text?: string; data: any; images: any[] };

const connect = async (cmd: string): Promise<Client> => {
  const client = new Client({ name: 'cap1-exercise5', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: join(CLI, cmd),
    args: ['mcp', '--automation-read-root', OUT, '--automation-write-root', OUT],
  }));
  return client;
};

const callOn = (client: Client) => async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
  const result: any = await client.callTool({ name, arguments: args });
  const text = result.content?.find((c: any) => c.type === 'text')?.text;
  const images = result.content?.filter((c: any) => c.type === 'image') ?? [];
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { isError: Boolean(result.isError), text, data, images };
};

const savePng = (result: ToolResult, path: string): boolean => {
  if (!result.images[0]) return false;
  writeFileSync(path, Buffer.from(result.images[0].data, 'base64'));
  return true;
};

const wc = await connect('wordcraft-cli');
const pc = await connect('pdfcraft-cli');
const w = callOn(wc);
const p = callOn(pc);
const wcmd = (command: string, params: Record<string, unknown> = {}): Promise<ToolResult> =>
  w('execute', { command, params });

const quirks: string[] = [];
const evidence: {
  blocks: number;
  plan: RestyleStep[];
  styledAfter: string[];
  provenanceBlock: string;
  signatureCount: number;
  signatureAlgorithm: string;
  pdfTitle: string;
  pdfKeywords: string;
  pdfText: string;
  stamp: boolean;
} = {
  blocks: 0,
  plan: [],
  styledAfter: [],
  provenanceBlock: '',
  signatureCount: 0,
  signatureAlgorithm: '',
  pdfTitle: '',
  pdfKeywords: '',
  pdfText: '',
  stamp: false,
};

// ── fixtures: one generated DOCX + one corrupt DOCX ─────────────────────────
const generateInput = async (): Promise<void> => {
  const created = await w('new_document', { template: 'blank' });
  if (created.isError) throw new Error(`new_document: ${created.text}`);
  for (let i = 0; i < DOC.paragraphs.length; i += 1) {
    if (i > 0) {
      const para = await wcmd('text.newParagraph');
      if (para.isError) throw new Error(`text.newParagraph: ${para.text}`);
    }
    const typed = await w('type_text', { text: DOC.paragraphs[i].text, paragraphs: false });
    if (typed.isError) throw new Error(`type_text: ${typed.text}`);
  }
  const saved = await w('save_document', { path: join(INPUT, 'doc-alpha.docx') });
  if (saved.isError) throw new Error(`save_document input: ${saved.text}`);
};

const writeBrokenInput = (): void => {
  writeFileSync(join(INPUT, 'doc-broken.docx'), BROKEN_BYTES);
};

// ── provenance card, rendered by VectorCraft ────────────────────────────────
const renderProvenancePng = async (provenance: Provenance, pngPath: string): Promise<void> => {
  const vc = await connect('vectorcraft-cli');
  try {
    const v = callOn(vc);
    const vcmd = (command: string, params: Record<string, unknown> = {}): Promise<ToolResult> =>
      v('run_command', { command, params });
    const doc = await vcmd('file.new', {
      width: 760, height: 300, units: 'Pixels', colorMode: 'rgb', artboards: 1, backgroundContents: 'white',
    });
    if (doc.isError) throw new Error(`vectorcraft file.new: ${doc.text}`);
    for (const [index, line] of provenanceLines(provenance).entries()) {
      const made = await vcmd('text.create', {
        x: 24, y: 30 + index * 26, text: line, size: 12, color: '#0f172a',
      });
      if (made.isError) throw new Error(`vectorcraft text.create: ${made.text}`);
    }
    const exported = await vcmd('document.export', { path: pngPath, format: 'png', background: 'white' });
    if (exported.isError) throw new Error(`vectorcraft document.export: ${exported.text}`);
  } finally {
    await vc.close();
  }
};

// ── one pipeline pass ───────────────────────────────────────────────────────
interface PassResult {
  manifest: Manifest;
  good: ManifestEntry;
  broken: ManifestEntry;
  restyled: boolean;
}

const runPass = async (pass: number): Promise<PassResult> => {
  const startedAt = new Date().toISOString();
  const entries: ManifestEntry[] = [];
  let restyled = false;

  for (const spec of INPUTS) {
    const inputPath = join(OUT, REL.input(spec.base));
    const correctedPath = join(OUT, REL.corrected(spec.base));
    const pdfPath = join(OUT, REL.pdf(spec.base));
    const signedPath = join(OUT, REL.signed(spec.base));
    const sourceSha256 = sha256File(inputPath);
    const entry = manifestEntry(spec.base, sourceSha256);

    // ── failure isolation: a corrupt input fails its own row only ───────────
    if (spec.broken) {
      const opened = await w('open_document', { path: inputPath });
      if (!opened.isError) {
        entry.errors.push('restyle:corrupt input opened unexpectedly');
      } else {
        entry.errors.push(`restyle:${String(opened.text).trim()}`);
      }
      entry.stages.restyle = 'failed';
      entries.push(entry);
      continue;
    }

    // ── idempotency: master digest + signed artefact already present ────────
    const coreXml = exists(correctedPath) ? readXml(correctedPath, 'docProps/core.xml') : '';
    if (canSkip(exists(correctedPath), exists(signedPath), coreXml, sourceSha256)) {
      entry.stages = skippedStages();
      entries.push(entry);
      continue;
    }

    // ── stage 1: restyle (named styles only) + props + corrected master ─────
    try {
      const opened = await w('open_document', { path: inputPath });
      if (opened.isError) throw new Error(String(opened.text));

      const inspected = await w('inspect_document');
      const blocks: DocBlock[] = (inspected.data?.blocks ?? []).filter((b: DocBlock) => b.type === 'paragraph');
      evidence.blocks = blocks.length;
      const plan = classify(blocks);
      evidence.plan = plan;
      if (plan.length === 0) throw new Error('classifier produced no heading steps');

      const batch = await w('batch', { keepGoing: false, commands: restyleCommands(plan) });
      if (batch.isError) throw new Error(`batch: ${batch.text}`);

      // Named banner style. styles.create yields a paragraph style; WordCraft
      // has no character-style creation primitive.
      quirks.push('styles.create only creates paragraph styles (there is no character-style primitive), so the banner is a named paragraph style verified in word/header1.xml');
      const styles = await wcmd('styles.list');
      if (!String(styles.text).includes('"Classification"')) {
        const created = await wcmd('styles.create', { name: 'Classification' });
        if (created.isError) throw new Error(`styles.create: ${created.text}`);
      }
      const header = await wcmd('insert.editHeader');
      if (header.isError) throw new Error(`insert.editHeader: ${header.text}`);
      const banner = await w('type_text', { text: DOC.banner, paragraphs: false });
      if (banner.isError) throw new Error(`type_text banner: ${banner.text}`);
      const bannerStyle = await wcmd('para.style', { style: 'Classification' });
      if (bannerStyle.isError) throw new Error(`para.style banner: ${bannerStyle.text}`);
      const closed = await wcmd('insert.closeHeader');
      if (closed.isError) throw new Error(`insert.closeHeader: ${closed.text}`);

      // Engine quirk: the header style also landed on the body paragraph at the
      // cursor. Re-apply the plan so the body keeps its named heading styles.
      quirks.push('a paragraph style applied inside the header also lands on the body paragraph at the cursor; the restyle plan is re-applied after insert.closeHeader');
      const repair = await w('batch', { keepGoing: false, commands: restyleCommands(plan) });
      if (repair.isError) throw new Error(`batch repair: ${repair.text}`);

      const after = await w('inspect_document');
      evidence.styledAfter = (after.data?.blocks ?? [])
        .filter((b: DocBlock) => String(b.style ?? '').startsWith('Heading'))
        .map((b: DocBlock) => `${b.style}:"${b.text}"`);
      if (evidence.styledAfter.length !== plan.length) {
        throw new Error(`restyle kept ${evidence.styledAfter.length}/${plan.length} heading styles`);
      }

      // Provenance fields appended to the dedicated provenance paragraph.
      quirks.push('select.collapse collapses to the selection start; caret.end is needed to append the fields at the end of the provenance line');
      const select = await wcmd('select.text', { text: DOC.provenanceLine, occurrence: 1 });
      if (select.isError) throw new Error(`select.text provenance: ${select.text}`);
      const end = await wcmd('caret.end');
      if (end.isError) throw new Error(`caret.end: ${end.text}`);
      const fields: [string, string, string][] = [
        [' run=', 'DOCPROPERTY RunId', RUN_ID],
        [' model=', 'DOCPROPERTY ModelId', MODEL_ID],
      ];
      for (const [separator, instr, result] of fields) {
        const sep = await w('type_text', { text: separator, paragraphs: false });
        if (sep.isError) throw new Error(`type_text separator: ${sep.text}`);
        const field = await wcmd('insert.field', { instr, result });
        if (field.isError) throw new Error(`insert.field ${instr}: ${field.text}`);
      }
      const dot = await w('type_text', { text: '.', paragraphs: false });
      if (dot.isError) throw new Error(`type_text dot: ${dot.text}`);

      const inspectedAfter = await w('inspect_document');
      const provenanceBlock = (inspectedAfter.data?.blocks ?? [])
        .find((b: DocBlock) => String(b.text ?? '').startsWith(DOC.provenanceLine));
      evidence.provenanceBlock = String(provenanceBlock?.text ?? '');
      if (!evidence.provenanceBlock.startsWith(DOC.provenanceLine)) {
        throw new Error('provenance fields landed outside the provenance paragraph');
      }

      const props = await wcmd('file.properties', {
        title: DOC.title,
        author: DOC.author,
        keywords: keywordsFor(RUN_ID, MODEL_ID, sourceSha256),
      });
      if (props.isError) throw new Error(`file.properties: ${props.text}`);
      quirks.push('file.properties has no custom-property field, so source_sha256 rides in keywords and is read back from docProps/core.xml');

      const tmpDocx = join(CORRECTED, `tmp-${spec.base}-${pass}.docx`);
      const saved = await w('save_document', { path: tmpDocx });
      if (saved.isError) throw new Error(`save_document: ${saved.text}`);
      renameSync(tmpDocx, correctedPath);
      entry.stages.restyle = 'ok';

      const preview = await w('render_page', { page: 1, scale: 1.5 });
      savePng(preview, join(OUT, REL.correctedPreview(spec.base)));
    } catch (error) {
      entry.stages.restyle = 'failed';
      entry.errors.push(`restyle:${msg(error)}`);
    }
    if (entry.stages.restyle !== 'ok') {
      entries.push(entry);
      continue;
    }
    restyled = true;

    // ── stage 2: DOCX -> intermediate PDF ───────────────────────────────────
    try {
      const tmpPdf = join(PDF, `tmp-${spec.base}-${pass}.pdf`);
      const exported = await wcmd('file.exportPdf', { path: tmpPdf });
      if (exported.isError) throw new Error(String(exported.text));
      renameSync(tmpPdf, pdfPath);
      entry.stages.export = 'ok';
    } catch (error) {
      entry.stages.export = 'failed';
      entry.errors.push(`export:${msg(error)}`);
      entries.push(entry);
      continue;
    }

    // ── stage 3: provenance + stamp + signature ─────────────────────────────
    try {
      const provenance = provenanceFor(RUN_ID, MODEL_ID, spec.base, sourceSha256, new Date().toISOString());
      const jsonPath = join(OUT, REL.provenanceJson(spec.base));
      const pngPath = join(OUT, REL.provenancePng(spec.base));
      writeFileSync(jsonPath, `${JSON.stringify(provenance, null, 2)}\n`);
      await renderProvenancePng(provenance, pngPath);

      const openedPdf = await p('doc_open', { path: pdfPath });
      const doc = openedPdf.data?.doc ?? openedPdf.data?.id;
      if (!doc) throw new Error(`doc_open: ${String(openedPdf.text).slice(0, 120)}`);

      for (const [key, value] of [
        ['Title', DOC.title],
        ['Author', DOC.author],
        ['Subject', DOC.subject],
        ['Keywords', keywordsFor(RUN_ID, MODEL_ID, sourceSha256)],
      ] as const) {
        const info = await p('doc_set_info', { doc, key, value });
        if (info.isError) throw new Error(`doc_set_info ${key}: ${info.text}`);
      }

      const stamp = await p('stamp_custom', {
        doc, page: 1, path: pngPath, at: [480, 90], name: 'Provenance', author: DOC.author,
      });
      if (stamp.isError) throw new Error(`stamp_custom: ${stamp.text}`);
      quirks.push('stamp_custom scales a stamp to at most 200 pt and centres it on `at`; the card sits at [480, 90] to stay inside the page');

      const p12 = join(OUT, P12_REL);
      const tmpSigned = join(SIGNED, `tmp-${spec.base}-${pass}.pdf`);
      const signed = await p('sign_document', {
        doc,
        id: p12,
        password: P12_PASSWORD,
        out: tmpSigned,
        certify: 'no_changes',
        reason: 'Generator-lineage manifest',
        location: 'pipeline-host',
      });
      if (signed.isError) throw new Error(`sign_document: ${signed.text}`);
      renameSync(tmpSigned, signedPath);

      await p('doc_close', { doc }).catch(() => undefined);

      // Verify the published artefact, not the in-memory intermediate.
      const reopened = await p('doc_open', { path: signedPath });
      const signedDoc = reopened.data?.doc ?? reopened.data?.id;
      if (!signedDoc) throw new Error(`doc_open signed: ${String(reopened.text).slice(0, 120)}`);

      const signatures = await p('sign_list', { doc: signedDoc });
      evidence.signatureCount = Number(signatures.data?.count ?? 0);
      evidence.signatureAlgorithm = String(signatures.data?.signatures?.[0]?.algorithm ?? '');
      if (evidence.signatureCount < 1) throw new Error('sign_list found no signature');
      if (signatures.data?.all_valid === false) {
        quirks.push('sign_list.all_valid is false for a just-signed file: sign_id_create produced a self-signed ID');
      }

      const info = await p('doc_info', { doc: signedDoc });
      evidence.pdfTitle = String(info.data?.title ?? '');
      evidence.pdfKeywords = String(info.data?.keywords ?? '');
      evidence.stamp = (info.data?.annotations ?? [])
        .some((a: any) => a.type === 'Stamp' && a.contents === 'Provenance');

      const extracted = await p('text_extract', { doc: signedDoc, pages: [1] });
      evidence.pdfText = String(extracted.data?.pages?.[0]?.text ?? '');

      const rendered = await p('render_preview', { max_side: 1000 });
      savePng(rendered, join(OUT, REL.signedPreview(spec.base)));

      await p('doc_close', { doc: signedDoc }).catch(() => undefined);
      entry.stages.sign = 'ok';
    } catch (error) {
      entry.stages.sign = 'failed';
      entry.errors.push(`sign:${msg(error)}`);
    }
    entries.push(entry);
  }

  const manifest: Manifest = {
    run_id: RUN_ID,
    model_id: MODEL_ID,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    files: entries,
  };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(MANIFEST, text);
  writeFileSync(join(OUT, `manifest-pass${pass}.json`), text);

  return {
    manifest,
    good: entries.find((e) => e.input === REL.input('doc-alpha'))!,
    broken: entries.find((e) => e.input === REL.input('doc-broken'))!,
    restyled,
  };
};

// ── run ─────────────────────────────────────────────────────────────────────
try {
  // fixtures + signing identity (identity is environment state, not a stage)
  await generateInput();
  check('fixture input/doc-alpha.docx generated', exists(join(INPUT, 'doc-alpha.docx')), `${bytesOf(join(INPUT, 'doc-alpha.docx'))} bytes`);
  writeBrokenInput();
  check('fixture input/doc-broken.docx written', exists(join(INPUT, 'doc-broken.docx')), `${bytesOf(join(INPUT, 'doc-broken.docx'))} bytes`);

  const p12 = join(OUT, P12_REL);
  const identity = await p('sign_id_create', {
    path: p12, password: P12_PASSWORD, name: P12_IDENTITY.name, key: 'rsa2048',
    organization: P12_IDENTITY.organization, country: P12_IDENTITY.country, years: P12_IDENTITY.years,
  });
  check('signing identity created', !identity.isError && exists(p12), `${bytesOf(p12)} bytes`);

  const pass1 = await runPass(1);
  check('pass 1 ran the pipeline', pass1.restyled, 'restyle/export/sign executed');

  // ── pass 1: manifest ───────────────────────────────────────────────────────
  equal('pass 1: one row per input', pass1.manifest.files.length, INPUTS.length);
  equal('pass 1: good restyle ok', pass1.good.stages.restyle, 'ok');
  equal('pass 1: good export ok', pass1.good.stages.export, 'ok');
  equal('pass 1: good sign ok', pass1.good.stages.sign, 'ok');
  equal('pass 1: good row has no errors', pass1.good.errors.length, 0);
  equal('pass 1: broken restyle failed', pass1.broken.stages.restyle, 'failed');
  equal('pass 1: broken export skipped', pass1.broken.stages.export, 'skipped');
  equal('pass 1: broken sign skipped', pass1.broken.stages.sign, 'skipped');
  check('pass 1: broken row explains the failure', /zip|EOCD|package/i.test(pass1.broken.errors[0] ?? ''), pass1.broken.errors[0] ?? '');
  check('pass 1: broken row does not abort the batch', pass1.good.stages.sign === 'ok' && pass1.manifest.files.length === 2);

  // ── pass 1: DOCX master ────────────────────────────────────────────────────
  const correctedPath = join(OUT, REL.corrected('doc-alpha'));
  const bodyXml = readXmlSafe(correctedPath, 'word/document.xml');
  const headerXml = readXmlSafe(correctedPath, 'word/header1.xml');
  const coreXml = readXmlSafe(correctedPath, 'docProps/core.xml');

  check('master: corrected DOCX exists', exists(correctedPath), `${bytesOf(correctedPath)} bytes`);
  equal('master: input bytes unchanged', sha256File(join(INPUT, 'doc-alpha.docx')), pass1.good.source_sha256);
  equal('master: classifier found 4 headings', evidence.plan.length, 4);
  check('master: heading styles are named', evidence.plan.every((s) => s.style.startsWith('Heading ')));
  const bodyStyles = [...bodyXml.matchAll(/<w:pStyle w:val="([^"]+)"/g)].map((m) => m[1]);
  equal('master: body carries 1x Heading1 + 3x Heading2', bodyStyles.join(','), 'Heading1,Heading2,Heading2,Heading2');
  check('master: header banner is present', headerXml.includes('CONFIDENTIAL'), DOC.banner);
  check('master: banner uses a named style', headerXml.includes('<w:pStyle w:val="Classification"/>'));
  check('master: provenance fields appended after the line', evidence.provenanceBlock.startsWith(DOC.provenanceLine), evidence.provenanceBlock.slice(0, 90));
  check('master: run id field visible', evidence.provenanceBlock.includes(RUN_ID));
  check('master: model id field visible', evidence.provenanceBlock.includes(MODEL_ID));
  check('master: field codes are live fields', bodyXml.includes('DOCPROPERTY RunId') && bodyXml.includes('DOCPROPERTY ModelId'));
  check('master: keywords carry the source digest', coreXml.includes(`source_sha256=${pass1.good.source_sha256}`));
  check('master: title property written', coreXml.includes(`<dc:title>${DOC.title}</dc:title>`));
  check('master: corrected preview rendered', exists(join(OUT, REL.correctedPreview('doc-alpha'))));

  // ── pass 1: PDF artefacts ──────────────────────────────────────────────────
  const pdfPath = join(OUT, REL.pdf('doc-alpha'));
  const signedPath = join(OUT, REL.signed('doc-alpha'));
  check('pdf: intermediate export exists', exists(pdfPath), `${bytesOf(pdfPath)} bytes`);
  check('pdf: signed artefact exists', exists(signedPath), `${bytesOf(signedPath)} bytes`);
  check('pdf: at least one signature', evidence.signatureCount >= 1, `${evidence.signatureCount} signature(s)`);
  check('pdf: signature is RSA/SHA-256', /RSA/i.test(evidence.signatureAlgorithm) && /SHA-256/i.test(evidence.signatureAlgorithm), evidence.signatureAlgorithm);
  equal('pdf: title survives signing', evidence.pdfTitle, DOC.title);
  check('pdf: keywords survive signing', evidence.pdfKeywords.includes(`source_sha256=${pass1.good.source_sha256}`));
  check('pdf: banner visible in extracted text', evidence.pdfText.includes('CONFIDENTIAL'));
  check('pdf: body text visible in extracted text', ['Specification', 'Deployment', 'validation'].every((word) => evidence.pdfText.includes(word)));
  check('pdf: provenance stamp annotation present', evidence.stamp);
  if (!evidence.pdfText.includes('Quarterly')) {
    quirks.push("text_extract maps the 'r' glyph to U+FFFC, so the title extracts as \"Qua[FFFC]te[FFFC]ly\"");
  }
  check('pdf: signed preview rendered', exists(join(OUT, REL.signedPreview('doc-alpha'))));

  // ── pass 1: provenance sidecar ─────────────────────────────────────────────
  const provPath = join(OUT, REL.provenanceJson('doc-alpha'));
  const pngPath = join(OUT, REL.provenancePng('doc-alpha'));
  const provenance = JSON.parse(readFileSync(provPath, 'utf8')) as Provenance;
  equal('provenance: schema', provenance.schema, 'lineage/provenance/v1');
  equal('provenance: run id', provenance.run_id, RUN_ID);
  equal('provenance: model id', provenance.model_id, MODEL_ID);
  equal('provenance: source digest', provenance.source_sha256, pass1.good.source_sha256);
  equal('provenance: signed path', provenance.signed, REL.signed('doc-alpha'));
  check('provenance: PNG card exists', exists(pngPath) && pngMagic(pngPath), `${bytesOf(pngPath)} bytes`);

  // ── pass 2: idempotency ────────────────────────────────────────────────────
  const bytesBefore = {
    corrected: sha256File(correctedPath),
    signed: sha256File(signedPath),
    provenance: sha256File(provPath),
  };
  const pass2 = await runPass(2);
  check('pass 2: skipped the file', !pass2.restyled);
  equal('pass 2: good restyle skipped', pass2.good.stages.restyle, 'skipped');
  equal('pass 2: good export skipped', pass2.good.stages.export, 'skipped');
  equal('pass 2: good sign skipped', pass2.good.stages.sign, 'skipped');
  equal('pass 2: good row has no errors', pass2.good.errors.length, 0);
  equal('pass 2: broken still fails alone', pass2.broken.stages.restyle, 'failed');
  equal('pass 2: one row per input', pass2.manifest.files.length, INPUTS.length);
  equal('pass 2: corrected master unchanged', sha256File(correctedPath), bytesBefore.corrected);
  equal('pass 2: signed PDF unchanged', sha256File(signedPath), bytesBefore.signed);
  equal('pass 2: provenance card unchanged', sha256File(provPath), bytesBefore.provenance);
  equal('pass 2: input still unchanged', sha256File(join(INPUT, 'doc-alpha.docx')), pass1.good.source_sha256);
  check('pass 2: manifest.json is the skipped run', JSON.parse(readFileSync(MANIFEST, 'utf8')).files[0].stages.sign === 'skipped');

  // ── no partial writes ──────────────────────────────────────────────────────
  const leftovers = [CORRECTED, PDF, SIGNED]
    .flatMap((dir) => readdirSync(dir))
    .filter((name) => name.startsWith('tmp-'));
  equal('no temporary files left behind', leftovers.length, 0);

  writeFileSync(join(OUT, 'run-log.json'), JSON.stringify({
    run_id: RUN_ID,
    model_id: MODEL_ID,
    checks,
    failures,
    quirks: [...new Set(quirks)],
    passes: [
      { pass: 1, files: pass1.manifest.files, evidence },
      { pass: 2, files: pass2.manifest.files },
    ],
  }, null, 2));

  say('');
  say(`${checks} checks, ${failures.length} failing; ${new Set(quirks).size} engine quirk(s); artefacts in ${OUT}`);
  writeFileSync(join(OUT, 'run_ex5.log'), `${transcript.join('\n')}\n`);
  if (failures.length > 0) process.exitCode = 1;
} catch (error) {
  say(`FAIL harness crashed: ${error instanceof Error ? error.stack : String(error)}`);
  writeFileSync(join(OUT, 'run_ex5.log'), `${transcript.join('\n')}\n`);
  process.exitCode = 1;
} finally {
  await wc.close();
  await pc.close();
}
