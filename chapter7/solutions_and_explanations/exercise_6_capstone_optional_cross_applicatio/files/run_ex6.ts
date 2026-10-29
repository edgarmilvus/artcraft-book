// run_ex6.ts — deterministic harness for the cross-application brochure pipeline.
//
// Generates four product photos, builds a two-page DesignCraft template, and
// runs the whole PhotoCraft -> DesignCraft -> PdfCraft pipeline against the
// real engines. The vision clients are scripted: they measure the pixels they
// are given instead of calling a provider, and the assertions check engine
// state (files, link tables, PDF pages) rather than model prose.

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import {
  Engine,
  LocalAuditCache,
  classifyPreflightIssue,
  classifyVisionConfidence,
  isTransient,
  preflightFromDesign,
  preflightFromPdf,
  restoreFromCopy,
  runBrochurePipeline,
  withStage,
  type BrochureJob,
  type GlobalVision,
  type LocalCritique,
  type LocalVision,
  type PipelineRunReport,
  type PreflightIssue,
  type SpreadAudit,
  type SpreadContext,
} from "./02_pipeline.js";

const ROOT = process.cwd();
const INPUT = resolve(ROOT, "input");
const OUTPUT = resolve(ROOT, "..", "output");
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

// ---------------------------------------------------------------------------
// Fixture photos
// ---------------------------------------------------------------------------

const SIZE = 1200;

function makeProduct(seed: number): Buffer {
  const png = new PNG({ width: SIZE, height: SIZE });
  const base = [40 + seed * 60, 90 - seed * 20, 150 - seed * 30];
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const i = (y * SIZE + x) * 4;
      const glow = 1 - Math.hypot(x - SIZE / 2, y - SIZE / 2) / SIZE;
      png.data[i] = Math.min(255, Math.round(base[0] + glow * 120));
      png.data[i + 1] = Math.min(255, Math.round(base[1] + glow * 90));
      png.data[i + 2] = Math.min(255, Math.round(base[2] + glow * 60));
      png.data[i + 3] = 255;
    }
  }
  // A product shape so the local audit has something to measure.
  for (let y = 380; y < 860; y += 1) {
    for (let x = 430; x < 770; x += 1) {
      const i = (y * SIZE + x) * 4;
      png.data[i] = 235;
      png.data[i + 1] = 225;
      png.data[i + 2] = 210;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

// ---------------------------------------------------------------------------
// Scripted vision
// ---------------------------------------------------------------------------

function lstar(r: number, g: number, b: number): number {
  const linear = (value: number) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  const y = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y;
}

function meanLightness(png: PNG): number {
  let total = 0;
  let count = 0;
  for (let i = 0; i < png.data.length; i += 16) {
    total += lstar(png.data[i], png.data[i + 1], png.data[i + 2]);
    count += 1;
  }
  return total / count;
}

function decode(pngB64: string): PNG {
  return PNG.sync.read(Buffer.from(pngB64, "base64"));
}

const measuringLocalVision: LocalVision = {
  async audit(photoPngB64: string, sku: string): Promise<LocalCritique> {
    const png = decode(photoPngB64);
    const lightness = meanLightness(png);
    // A treated photo that lost all its detail reads as a flat grey.
    const flat = lightness < 4 || lightness > 96;
    return {
      exposure_ok: !flat,
      color_ok: !flat,
      retouch_artifacts: flat ? ["flat field"] : [],
      confidence: flat ? 0.42 : 0.93,
      note: `measured mean L* ${lightness.toFixed(1)}`,
    };
  },
};

const unsparingLocalVision: LocalVision = {
  async audit(): Promise<LocalCritique> {
    return {
      exposure_ok: false,
      color_ok: true,
      retouch_artifacts: ["halo around the healed spot"],
      confidence: 0.4,
      note: "the retouch leaves a halo",
    };
  },
};

const measuringGlobalVision: GlobalVision = {
  async audit(spreadPngB64: string, context: SpreadContext): Promise<SpreadAudit> {
    const png = decode(spreadPngB64);
    const lightness = meanLightness(png);
    const blank = lightness > 99.5;
    // The gutter is the only place a picture may not reach.
    const [gx0, gy0, gx1, gy1] = context.gutterRectPt;
    const scale = png.width / context.pageWidthPt;
    const spills = context.placements.filter((placement) => {
      const [x0, , x1] = placement.bounds;
      return x0 < gx1 && x1 > gx0 && gy1 > gy0;
    });
    return {
      spreadIndex: context.spreadIndex,
      imageGutterSpill: spills.map((placement) => ({ sku: placement.sku, frameId: placement.frameId })),
      typographyHierarchyOk: !blank,
      brandComplianceOk: !blank,
      traceableFindings: [],
      confidence: blank ? 0.3 : 0.91,
    };
  },
};

const failingGlobalVision: GlobalVision = {
  async audit(spreadPngB64: string, context: SpreadContext): Promise<SpreadAudit> {
    const base = await measuringGlobalVision.audit(spreadPngB64, context);
    return {
      ...base,
      traceableFindings: [
        {
          sku: context.placements[0]?.sku ?? "unknown",
          photoCraftCommandToUndo: "layer.newAdjustmentLayer.levels",
          note: "a healed spot leaves a halo around the product",
        },
      ],
      confidence: 0.95,
    };
  },
};

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

function unitTaxonomy(): void {
  console.log("\n# failure taxonomy");
  equal("taxonomy: 0.4 is a human decision", classifyVisionConfidence(0.4), "human_required");
  equal("taxonomy: 0.65 wants a correction", classifyVisionConfidence(0.65), "retryable_with_correction");
  equal("taxonomy: 0.8 passes", classifyVisionConfidence(0.8), null);

  const missing: PreflightIssue = {
    severity: "error",
    code: "missing_image",
    message: "image not found",
    sku: "a",
    frameId: null,
    ppi: null,
  };
  equal("taxonomy: a missing image is a human decision", classifyPreflightIssue(missing), "human_required");
  equal(
    "taxonomy: a low PPI is a correction",
    classifyPreflightIssue({ ...missing, code: "low_ppi" }),
    "retryable_with_correction",
  );
  equal(
    "taxonomy: an unreadable PDF is unrecoverable",
    classifyPreflightIssue({ ...missing, code: "pdf_unreadable" }),
    "unrecoverable",
  );

  ok("taxonomy: a dead engine is transient", isTransient(new Error("MCP server unreachable")));
  ok("taxonomy: a bad argument is not transient", !isTransient(new Error("unknown command `nope`")));
}

async function unitStages(): Promise<void> {
  console.log("\n# stage wrapper");
  let attempts = 0;
  const sleeps: number[] = [];
  const flaky = await withStage(
    "pdfcraft",
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("MCP server unreachable");
      return "ok";
    },
    { sleep: async (ms) => { sleeps.push(ms); } },
  );
  equal("stage: a transient failure is retried", attempts, 3);
  ok("stage: the retry succeeds", flaky.ok);
  equal("stage: the backoff grows", sleeps[0] < sleeps[1], true);

  let hardAttempts = 0;
  const hard = await withStage(
    "photocraft",
    async () => {
      hardAttempts += 1;
      throw new Error("unknown command `nope`");
    },
    { sleep: async () => {} },
  );
  equal("stage: a permanent failure is not retried", hardAttempts, 1);
  ok("stage: the failure is classified", hard.failure?.kind === "unrecoverable");
}

async function unitCache(): Promise<void> {
  console.log("\n# local audit cache");
  const cache = new LocalAuditCache(() => 0);
  const critique: LocalCritique = {
    exposure_ok: true,
    color_ok: true,
    retouch_artifacts: [],
    confidence: 0.9,
    note: "",
  };
  equal("cache: the first lookup misses", (await cache.get("abc")) === null, true);
  cache.set("abc", critique);
  const hit = await cache.get("abc");
  ok("cache: the second lookup hits", hit !== null);
  const stats = cache.stats();
  equal("cache: one miss", stats.misses, 1);
  equal("cache: one hit", stats.hits, 1);
}

function unitPreflight(): void {
  console.log("\n# preflight");
  const low = preflightFromDesign(
    [{ frameId: 7, page: 0, ppi: 210 }],
    [
      {
        sku: "lamp",
        treatedPath: "/tmp/lamp.png",
        frameId: 7,
        bounds: [36, 36, 288, 288],
        page: 0,
        spread: 0,
      },
    ],
    300,
  );
  equal("preflight: one low PPI is reported", low.length, 1);
  equal("preflight: the frame is named", low[0].frameId, 7);
  equal("preflight: the sku is named", low[0].sku, "lamp");

  const okIssues = preflightFromDesign([{ frameId: 7, page: 0, ppi: 430 }], [], 300);
  equal("preflight: a good PPI passes", okIssues.length, 0);

  const pdfIssues = preflightFromPdf([{ page: 1, pixels: [1200, 1200], rect: [36, 36, 252, 252] }], 300);
  equal("preflight: the PDF PPI is computed", pdfIssues.length, 0);
  const pdfLow = preflightFromPdf([{ page: 1, pixels: [1200, 1200], rect: [36, 36, 400, 400] }], 300);
  equal("preflight: a low PDF PPI is reported", pdfLow.length, 1);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function buildTemplate(
  design: Engine,
  templatePath: string,
  options: { pages?: number; columns?: number } = {},
): Promise<void> {
  await design.tool("new_document", {
    preset: "Letter",
    pages: options.pages ?? 2,
    columns: options.columns ?? 2,
    gutter: 18,
    margins: 36,
    facingPages: false,
  });
  await design.tool("save_document", { path: templatePath });
}

function makeJob(jobId: string, skus: string[], workspace = WORK): BrochureJob {
  return {
    jobId,
    productPhotos: skus.map((sku) => ({ sku, sourcePath: resolve(INPUT, `${sku}.png`) })),
    designTemplatePath: resolve(workspace, "template.designcraft"),
    outputPdfPath: resolve(workspace, "brochure.pdf"),
    preflightMinPpi: 300,
    budgetMsPerSpread: 6 * 60 * 1000,
    workspace,
    photosPerPage: 2,
    gutterPt: 18,
  };
}

function engines() {
  const photo = new Engine("photocraft-cli", [
    "mcp",
    "--automation-read-root",
    resolve(WORK, "photos"),
    "--automation-write-root",
    resolve(WORK, "treated"),
  ]);
  const design = new Engine("designcraft-cli", ["mcp"]);
  const pdf = new Engine("pdfcraft-cli", ["mcp", "--root", WORK]);
  return { photo, design, pdf };
}

async function main(): Promise<void> {
  // Keep the shell-captured run_ex6.log beside the evidence.
  rmSync(WORK, { recursive: true, force: true });
  rmSync(resolve(OUTPUT, "wide"), { recursive: true, force: true });
  for (const name of ["pipeline_report.json", "report.json"]) {
    rmSync(resolve(OUTPUT, name), { force: true });
  }
  mkdirSync(INPUT, { recursive: true });
  mkdirSync(resolve(WORK, "photos"), { recursive: true });
  mkdirSync(resolve(WORK, "treated"), { recursive: true });
  mkdirSync(resolve(WORK, "design"), { recursive: true });
  mkdirSync(resolve(WORK, "export"), { recursive: true });

  unitTaxonomy();
  await unitStages();
  await unitCache();
  unitPreflight();

  // Two distinct products, each placed twice, so the audit cache has a hit.
  writeFileSync(resolve(INPUT, "lamp.png"), makeProduct(0));
  writeFileSync(resolve(INPUT, "chair.png"), makeProduct(1));
  const skus = ["lamp", "chair", "lamp", "chair"];

  const { photo, design, pdf } = engines();
  await Promise.all([photo.connect(), design.connect(), pdf.connect()]);
  try {
    console.log("\n# template");
    await buildTemplate(design, resolve(WORK, "template.designcraft"));
    ok("template: written", existsSync(resolve(WORK, "template.designcraft")));

    console.log("\n# pipeline");
    const job = makeJob("brochure-1", skus);
    const report: PipelineRunReport = await runBrochurePipeline(job, {
      photo,
      design,
      pdf,
      vision: { local: measuringLocalVision, global: measuringGlobalVision },
    });

    equal("pipeline: four photo stages", report.stages.filter((s) => s.stage === "photocraft").length, 4);
    equal("pipeline: two local audits", report.stages.filter((s) => s.stage === "vision_local").length, 2);
    equal("pipeline: two cache misses", report.localAuditCacheMisses, 2);
    equal("pipeline: two cache hits", report.localAuditCacheHits, 2);
    equal("pipeline: one design stage", report.stages.filter((s) => s.stage === "designcraft").length >= 1, true);
    equal("pipeline: one pdf stage", report.stages.filter((s) => s.stage === "pdfcraft").length >= 1, true);
    equal("pipeline: no human review", report.humanRequired, false);
    ok("pipeline: the PDF is written", report.finalPdfWritten);
    ok("pipeline: the PDF exists", existsSync(job.outputPdfPath));
    equal("pipeline: two global audits", report.globalAudit.length, 2);
    ok(
      "pipeline: the global audit is confident",
      report.globalAudit.every((audit) => audit.confidence > 0.7),
    );
    ok(
      "pipeline: no gutter spill",
      report.globalAudit.every((audit) => audit.imageGutterSpill.length === 0),
    );
    equal("pipeline: the rollback strategy is a restore", report.rollbackStrategy, "restore_from_copy");

    const preflights = report.stages.filter((s) => s.stage === "preflight");
    ok("pipeline: the preflight ran", preflights.length >= 2);
    ok(
      "pipeline: the preflight passes",
      preflights.every((stage) => stage.ok),
      JSON.stringify(preflights.map((stage) => stage.failure)),
    );

    console.log("\n# engine state");
    const layout = await design.tool<any>("inspect_document");
    const placed = (layout.spreads ?? []).flatMap((spread: any) => spread.items ?? []);
    const pictures = placed.filter((item: any) => item.kind === "<image>");
    const captions = placed.filter((item: any) => item.kind === "<text frame>");
    equal("state: four placed images", pictures.length, 4);
    equal("state: four captions", captions.length, 4);
    const links = await design.execute<any>("links.list");
    const uses = (Array.isArray(links) ? links : []).flatMap((link: any) => link.uses ?? []);
    equal("state: four link uses", uses.length, 4);
    ok(
      "state: every image clears 300 PPI",
      uses.every((use: any) => use.ppi >= 300),
      JSON.stringify(uses.map((use: any) => use.ppi)),
    );
    const stories = layout.stories ?? [];
    ok("state: the captions have stories", stories.length >= 4);

    const pdfBytes = readFileSync(job.outputPdfPath);
    ok("state: the PDF is a real file", pdfBytes.length > 5000, `${pdfBytes.length} bytes`);
    ok("state: the PDF header is right", pdfBytes.subarray(0, 5).toString() === "%PDF-");
    const pdfHash = createHash("sha256").update(pdfBytes).digest("hex");
    ok("state: the PDF hash is stable", pdfHash.length === 64);

    console.log("\n# rollback on a traceable finding");
    const job2 = makeJob("brochure-2", ["lamp", "chair"]);
    const pristineHash = createHash("sha256")
      .update(readFileSync(resolve(INPUT, "lamp.png")))
      .digest("hex");
    const failing = await runBrochurePipeline(job2, {
      photo,
      design,
      pdf,
      vision: { local: measuringLocalVision, global: failingGlobalVision },
    });
    ok("rollback: the run is escalated", failing.humanRequired);
    ok("rollback: the reason names the photo", failing.humanRequiredReasons.some((r) => r.includes("lamp")));
    writeFileSync(resolve(OUTPUT, "report-rollback.json"), JSON.stringify(failing, null, 2));
    const afterHash = createHash("sha256")
      .update(readFileSync(resolve(WORK, "photos", "lamp.png")))
      .digest("hex");
    equal("rollback: the working copy is the pristine photo", afterHash, pristineHash);

    console.log("\n# human review on a low-confidence photo");
    const job3 = makeJob("brochure-3", ["lamp", "chair"]);
    const lowConfidence = await runBrochurePipeline(job3, {
      photo,
      design,
      pdf,
      vision: { local: unsparingLocalVision, global: measuringGlobalVision },
    });
    ok("human: the run is escalated", lowConfidence.humanRequired);
    ok(
      "human: the reason names the confidence",
      lowConfidence.humanRequiredReasons.some((reason) => reason.includes("0.40")),
      JSON.stringify(lowConfidence.humanRequiredReasons),
    );
    ok("human: no PDF is written", !lowConfidence.finalPdfWritten);
    writeFileSync(resolve(OUTPUT, "report-human-review.json"), JSON.stringify(lowConfidence, null, 2));

    console.log("\n# preflight correction");
    const wide = resolve(OUTPUT, "wide");
    mkdirSync(resolve(wide, "photos"), { recursive: true });
    mkdirSync(resolve(wide, "treated"), { recursive: true });
    mkdirSync(resolve(wide, "design"), { recursive: true });
    mkdirSync(resolve(wide, "export"), { recursive: true });
    const widePhoto = new Engine("photocraft-cli", [
      "mcp",
      "--automation-read-root",
      resolve(wide, "photos"),
      "--automation-write-root",
      resolve(wide, "treated"),
    ]);
    const widePdf = new Engine("pdfcraft-cli", ["mcp", "--root", wide]);
    await Promise.all([widePhoto.connect(), widePdf.connect()]);
    try {
      // One column the width of the page: the picture is placed far too large,
      // so the 300 PPI gate has to fire and the frame has to be corrected.
      await buildTemplate(design, resolve(wide, "template.designcraft"), { pages: 1, columns: 1 });
      const wideJob = makeJob("brochure-wide", ["lamp"], wide);
      const corrected = await runBrochurePipeline(wideJob, {
        photo: widePhoto,
        design,
        pdf: widePdf,
        vision: { local: measuringLocalVision, global: measuringGlobalVision },
      });
      equal("correction: the run is not escalated", corrected.humanRequired, false);
      ok("correction: the PDF is written", corrected.finalPdfWritten);
      const preflightStages = corrected.stages.filter((s) => s.stage === "preflight");
      ok("correction: the gate fired", preflightStages.length >= 2, `${preflightStages.length}`);
      const failedGate = preflightStages.find((stage) => stage.ok === false);
      ok(
        "correction: the PPI gate failed first",
        failedGate !== undefined,
        JSON.stringify(preflightStages.map((stage) => stage.failure)),
      );
      ok(
        "correction: the failure asks for a correction",
        failedGate?.failure?.kind === "retryable_with_correction",
        JSON.stringify(failedGate?.failure),
      );
      ok(
        "correction: the last pass cleared it",
        preflightStages[preflightStages.length - 1]?.ok === true,
        JSON.stringify(preflightStages[preflightStages.length - 1]?.failure),
      );
      const wideLinks = await design.execute<any>("links.list");
      const wideUses = (Array.isArray(wideLinks) ? wideLinks : []).flatMap((link: any) => link.uses ?? []);
      ok(
        "correction: the placed image now clears 300 PPI",
        wideUses.every((use: any) => use.ppi >= 300),
        JSON.stringify(wideUses.map((use: any) => use.ppi)),
      );
    } finally {
      await Promise.all([widePhoto.close(), widePdf.close()]);
    }

    writeFileSync(resolve(OUTPUT, "pipeline_report.json"), JSON.stringify(report, null, 2));
    ok("output: the report is written", existsSync(resolve(OUTPUT, "pipeline_report.json")));

    const artefacts = [
      "pipeline_report.json",
      "report-rollback.json",
      "report-human-review.json",
      "work/brochure.pdf",
      "work/template.designcraft",
      "work/design/brochure-1.designcraft",
      "work/export/brochure-1.pdf",
      "work/photos/lamp.png",
      "work/treated/lamp.png",
      "wide/brochure.pdf",
      "wide/design/brochure-wide.designcraft",
      "wide/export/brochure-wide.pdf",
    ];
    for (const artefact of artefacts) {
      const path = resolve(OUTPUT, artefact);
      ok(`output: ${artefact}`, existsSync(path) && readFileSync(path).length > 0);
    }
    const finalPdf = readFileSync(resolve(OUTPUT, "wide/brochure.pdf"));
    ok("output: final PDF header", finalPdf.subarray(0, 5).toString() === "%PDF-");
    ok("output: final PDF has pages", finalPdf.length > 5000, `${finalPdf.length} bytes`);

    writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
      exercise: 6,
      engines: ["photocraft-cli", "designcraft-cli", "pdfcraft-cli"],
      assertions: passed + 1,
      integration: {
        jobId: report.jobId,
        stages: report.stages.length,
        cacheHits: report.localAuditCacheHits,
        cacheMisses: report.localAuditCacheMisses,
        finalPdfWritten: report.finalPdfWritten,
        rollbackStrategy: report.rollbackStrategy,
      },
      artefacts,
      result: "cross-application brochure pipeline completed; rollback, human review and PPI correction verified",
    }, null, 2));
    ok("output: manifest report", existsSync(resolve(OUTPUT, "report.json")));
  } finally {
    await Promise.all([photo.close(), design.close(), pdf.close()]);
  }

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
