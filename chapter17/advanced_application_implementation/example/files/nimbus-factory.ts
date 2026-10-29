/* ============================================================================
 * NimbusContracts — Headless Office Pipeline
 * ----------------------------------------------------------------------------
 * nimbus-factory.ts — the composition root.
 * ========================================================================== */

import { mkdir } from "node:fs/promises";

import { OfficeMcpBridge } from "./office-bridge.js";
import { DocumentPipeline, type PipelineAuditEvent } from "./nimbus-pipeline.js";

/* ----------------------------------------------------------------------------
 * 7. COMPOSITION ROOT
 * ----------------------------------------------------------------------------
 * A minimal, framework-agnostic factory. The surrounding SaaS process calls
 * `createNimbusPipeline()` once at boot, then reuses the returned pipeline.
 * Killing the pipeline tears down both MCP subprocesses.
 * -------------------------------------------------------------------------- */

export interface NimbusPipelineHandle {
  pipeline: DocumentPipeline;
  bridge: OfficeMcpBridge;
  shutdown: () => Promise<void>;
}

export async function createNimbusPipeline(opts: {
  wordcraftBinary: string;
  pdfcraftBinary: string;
  readRoot: string;
  writeRoot: string;
  templateRoot: string;
  outputRoot: string;
  signingIdPath: string;
  signingIdPassword: string;
  emitAudit: (event: PipelineAuditEvent) => Promise<void>;
}): Promise<NimbusPipelineHandle> {
  await mkdir(opts.outputRoot, { recursive: true });

  const bridge = new OfficeMcpBridge({
    wordcraftBinary: opts.wordcraftBinary,
    pdfcraftBinary: opts.pdfcraftBinary,
    readRoot: opts.readRoot,
    writeRoot: opts.writeRoot,
    callTimeoutMs: 180_000,
  });
  await bridge.connect();

  const pipeline = new DocumentPipeline({
    bridge,
    templateRoot: opts.templateRoot,
    outputRoot: opts.outputRoot,
    signingIdPath: opts.signingIdPath,
    signingIdPassword: opts.signingIdPassword,
    emitAudit: opts.emitAudit,
  });

  return {
    pipeline,
    bridge,
    shutdown: () => bridge.close(),
  };
}
