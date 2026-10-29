// Solution module for Chapter 1, Exercise 5:
// Lineage-first batch — WordCraft/PDFCraft DOCX -> signed PDF with a manifest.
//
// The harness (run_ex5.ts) owns the MCP sessions; this module owns the parts
// that must be identical across runs: the input document, the classifier that
// turns inspected paragraphs into named styles, the manifest schema, the
// lineage keywords and the provenance record.

import { createHash } from 'node:crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Run identity
// ─────────────────────────────────────────────────────────────────────────────
export const RUN_ID = `run-${new Date().toISOString().slice(0, 10)}`;
export const MODEL_ID = 'deepseek/deepseek-v4.1-flash';

export interface InputSpec {
  base: string;
  /** A corrupt DOCX used to prove per-file failure isolation. */
  broken?: boolean;
}

export const INPUTS: InputSpec[] = [
  { base: 'doc-alpha' },
  { base: 'doc-broken', broken: true },
];

export const BROKEN_BYTES = 'this file is not a DOCX package\n';

// ─────────────────────────────────────────────────────────────────────────────
// The generated document
// ─────────────────────────────────────────────────────────────────────────────
export const DOC = {
  title: 'Quarterly Product Specification',
  author: 'pipeline',
  subject: 'Product specification (signed)',
  banner: 'CONFIDENTIAL — INTERNAL DISTRIBUTION ONLY',
  provenanceLine:
    'Provenance lineage for auditors: generated source digest and run identifiers.',
  paragraphs: [
    { text: 'Quarterly Product Specification', role: 'title' },
    { text: 'Scope', role: 'heading' },
    {
      text: 'This document describes the interfaces and the acceptance criteria for the Q4 release, restricted to internal distribution.',
      role: 'body',
    },
    { text: 'Interfaces', role: 'heading' },
    {
      text: 'The ingestion service exposes a single synchronous endpoint and a batch endpoint backed by the same validation core.',
      role: 'body',
    },
    { text: 'Rollout', role: 'heading' },
    {
      text: 'Deployment proceeds in three waves with an automated rollback on error budget exhaustion.',
      role: 'body',
    },
    {
      text: 'Provenance lineage for auditors: generated source digest and run identifiers.',
      role: 'provenance',
    },
  ],
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Relative artefact paths (all under the harness's output directory)
// ─────────────────────────────────────────────────────────────────────────────
export const REL = {
  input: (base: string): string => `input/${base}.docx`,
  corrected: (base: string): string => `corrected/${base}.docx`,
  pdf: (base: string): string => `pdf/${base}.pdf`,
  signed: (base: string): string => `signed/${base}.pdf`,
  provenanceJson: (base: string): string => `provenance/${base}.json`,
  provenancePng: (base: string): string => `provenance/${base}.png`,
  correctedPreview: (base: string): string => `provenance/${base}-corrected-page1.png`,
  signedPreview: (base: string): string => `provenance/${base}-signed-page1.png`,
} as const;

export const P12_REL = 'certs/pipeline.p12';
export const P12_PASSWORD = 'pipeline-test';
export const P12_IDENTITY = {
  name: 'pipeline',
  organization: 'Lineage Pipeline',
  country: 'IT',
  years: 2,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Manifest schema
// ─────────────────────────────────────────────────────────────────────────────
export type StageResult = 'ok' | 'failed' | 'skipped';

export interface Stages {
  restyle: StageResult;
  export: StageResult;
  sign: StageResult;
}

export interface ManifestEntry {
  input: string;
  corrected: string;
  /** Published artefact: the signed PDF. */
  pdf: string;
  source_sha256: string;
  stages: Stages;
  errors: string[];
}

export interface Manifest {
  run_id: string;
  model_id: string;
  started_at: string;
  finished_at: string;
  files: ManifestEntry[];
}

export const skippedStages = (): Stages => ({
  restyle: 'skipped',
  export: 'skipped',
  sign: 'skipped',
});

export const manifestEntry = (base: string, sourceSha256: string): ManifestEntry => ({
  input: REL.input(base),
  corrected: REL.corrected(base),
  pdf: REL.signed(base),
  source_sha256: sourceSha256,
  stages: skippedStages(),
  errors: [],
});

// ─────────────────────────────────────────────────────────────────────────────
// Classifier: inspected paragraphs -> named paragraph styles
// ─────────────────────────────────────────────────────────────────────────────
export interface DocBlock {
  index: number;
  text?: string;
  style?: string;
  type?: string;
}

export interface RestyleStep {
  index: number;
  text: string;
  style: 'Heading 1' | 'Heading 2';
}

/**
 * First block is the title. Short isolated runs that do not end in a full stop
 * are section headings. Body prose and the explicit provenance line stay as
 * Normal, so the document never relies on direct character formatting.
 */
export function classify(blocks: DocBlock[]): RestyleStep[] {
  const paragraphs = blocks.filter((block) => (block.type ?? 'paragraph') === 'paragraph');
  const steps: RestyleStep[] = [];
  let titleSeen = false;

  for (const block of paragraphs) {
    const text = String(block.text ?? '').trim();
    if (!text) continue;
    if (!titleSeen) {
      titleSeen = true;
      steps.push({ index: block.index, text, style: 'Heading 1' });
      continue;
    }
    if (text === DOC.provenanceLine) continue;
    if (text.length <= 24 && !text.endsWith('.')) {
      steps.push({ index: block.index, text, style: 'Heading 2' });
    }
  }
  return steps;
}

export interface RegistryCommand {
  command: string;
  params: Record<string, unknown>;
}

export const restyleCommands = (steps: RestyleStep[]): RegistryCommand[] =>
  steps.flatMap(({ text, style }) => [
    { command: 'select.text', params: { text, occurrence: 1 } },
    { command: 'para.style', params: { style } },
  ]);

// ─────────────────────────────────────────────────────────────────────────────
// Lineage records
// ─────────────────────────────────────────────────────────────────────────────
export const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/**
 * WordCraft exposes title/subject/author/keywords/comments/category only; there
 * is no custom document property, so the digest rides in `keywords` and is
 * read back from docProps/core.xml for the idempotency check.
 */
export const keywordsFor = (runId: string, modelId: string, sourceSha256: string): string =>
  `model_id=${modelId};run_id=${runId};source_sha256=${sourceSha256}`;

export interface Provenance {
  schema: 'lineage/provenance/v1';
  run_id: string;
  model_id: string;
  base: string;
  input: string;
  corrected: string;
  pdf: string;
  signed: string;
  source_sha256: string;
  engines: {
    restyle_export: 'wordcraft';
    provenance_render: 'vectorcraft';
    stamp_sign: 'pdfcraft';
  };
  created_at: string;
}

export const provenanceFor = (
  runId: string,
  modelId: string,
  base: string,
  sourceSha256: string,
  createdAt: string,
): Provenance => ({
  schema: 'lineage/provenance/v1',
  run_id: runId,
  model_id: modelId,
  base,
  input: REL.input(base),
  corrected: REL.corrected(base),
  pdf: REL.pdf(base),
  signed: REL.signed(base),
  source_sha256: sourceSha256,
  engines: {
    restyle_export: 'wordcraft',
    provenance_render: 'vectorcraft',
    stamp_sign: 'pdfcraft',
  },
  created_at: createdAt,
});

/** Compact key/value lines rendered into the stamp PNG. */
export const provenanceLines = (provenance: Provenance): string[] => [
  'LINEAGE PROVENANCE',
  '',
  `run_id        ${provenance.run_id}`,
  `model_id      ${provenance.model_id}`,
  `input         ${provenance.input}`,
  `master        ${provenance.corrected}`,
  `signed        ${provenance.signed}`,
  `sha256        ${provenance.source_sha256}`,
  `engines       ${provenance.engines.restyle_export} / ${provenance.engines.provenance_render} / ${provenance.engines.stamp_sign}`,
  `created_at    ${provenance.created_at}`,
];

/**
 * A pass may skip a file only when the corrected master exists, its keywords
 * carry this exact source digest, and the signed PDF exists.
 */
export const canSkip = (correctedExists: boolean, signedExists: boolean, coreXml: string, sourceSha256: string): boolean =>
  correctedExists && signedExists && coreXml.includes(`source_sha256=${sourceSha256}`);
