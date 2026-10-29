// run_basic.ts — the deterministic harness for the studio-hello listing.
//
// The listing is published as a set of files; this harness assembles
// them into the project the layout describes, type-checks that
// project, runs the pipeline for real against PhotoCraft, and checks
// every artefact the run claims to have produced: the banner, the
// brand store, the journal and the budget.
//
// It needs no API key, no network and no database server.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

// ---------------------------------------------------------------------------
// The harness's own bookkeeping.
// ---------------------------------------------------------------------------

const FILES = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(FILES, "output");
const WORK = join(OUTPUT, "work");
const PROJECT = join(WORK, "project");
const STUDIO = join(WORK, "studio");
const LOCK = join(OUTPUT, ".lock");

/** The clock every run is stamped with, so two runs are identical. */
const FIXED_NOW = "2026-01-01T00:00:00.000Z";

/** The brief the studio renders. */
const BRIEF = {
  product: "ArtCraft Suite",
  audience: "indie game studios",
  tone: "confident, technical",
  callToAction: "Start the free trial",
};

/**
 * The published listings and the module names the project layout gives
 * them. The harness assembles the project from these files, so the
 * listing in the book is the listing that runs.
 */
const LISTINGS: ReadonlyArray<readonly [string, string]> = [
  ["03_src_env_ts_the_environment_modul.ts", "src/env.ts"],
  ["04_src_dbclient_ts_the_local_store.ts", "src/dbClient.ts"],
  ["06_src_brandmemory_ts_the_vector_me.ts", "src/brandMemory.ts"],
  ["07_src_photocraftbridge_ts_the_mcp.ts", "src/photocraftBridge.ts"],
  ["08_src_pipeline_ts_the_orchestratio.ts", "src/pipeline.ts"],
  ["09_src_main_ts_the_entry_point.ts", "src/main.ts"],
  ["10_pipeline.test.ts", "test/pipeline.test.ts"],
];

/** The compiler settings the assembled project is checked with. */
const PROJECT_TSCONFIG = {
  compilerOptions: {
    target: "ES2023",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    lib: ["ES2023"],
    types: ["node"],
    strict: true,
    noImplicitAny: true,
    strictNullChecks: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    noImplicitOverride: true,
    noFallthroughCasesInSwitch: true,
    useUnknownInCatchVariables: true,
    verbatimModuleSyntax: true,
    isolatedModules: true,
    erasableSyntaxOnly: true,
    resolveJsonModule: true,
    noEmit: true,
    skipLibCheck: true,
  },
  include: ["src/**/*.ts", "test/**/*.ts"],
};

let passed = 0;

function ok(label: string, condition: boolean, detail = ""): void {
  if (!condition) {
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    process.exit(1);
  }
  passed += 1;
  console.log(`PASS ${label}`);
}

function equal(label: string, actual: unknown, expected: unknown): void {
  ok(
    label,
    Object.is(actual, expected),
    `expected ${String(expected)}, got ${String(actual)}`,
  );
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// The shapes the assembled modules answer with. They are declared here
// because the harness loads the modules at run time, from the tree it
// assembles.
// ---------------------------------------------------------------------------

interface BrandAssetMatch {
  readonly id: string;
  readonly headline: string;
  readonly cta: string;
  readonly palette: readonly string[];
  readonly similarity: number;
}

interface BrandStore {
  match(
    query: readonly number[],
    options: { threshold: number; count: number },
  ): BrandAssetMatch[];
  count(): number;
}

interface JournalEntry {
  readonly step: number;
  readonly name: string;
  readonly detail: string;
  readonly at: string;
}

interface StudioEnv {
  readonly photocraftBin: string;
  readonly workDir: string;
  readonly budgetUnits: number;
  readonly embeddingDim: number;
}

interface HeroRenderSpec {
  readonly width: number;
  readonly height: number;
  readonly headline: string;
  readonly subhead: string;
  readonly background: string;
  readonly accent: string;
  readonly outDir: string;
  readonly outFile: string;
}

interface StudioRunResult {
  readonly runId: string;
  readonly assetPath: string;
  readonly headline: string;
  readonly subhead: string;
  readonly exemplarId: string | null;
  readonly exemplarSimilarity: number | null;
  readonly warnings: readonly string[];
  readonly journal: readonly JournalEntry[];
  readonly budget: { limit: number; spent: number; remaining: number };
}

interface StudioDeps {
  readonly env: StudioEnv;
  readonly store: BrandStore;
  readonly embed: (text: string) => Promise<number[]>;
  readonly render: (spec: HeroRenderSpec) => Promise<unknown>;
  readonly now: () => string;
}

interface Modules {
  readonly openBrandStore: (options: {
    file: string;
    dim: number;
    now: () => string;
  }) => BrandStore;
  readonly createLocalEmbedder: (
    dim: number,
  ) => (text: string) => Promise<number[]>;
  readonly seedBrandMemory: (
    store: BrandStore,
    assets: unknown,
    model: unknown,
  ) => Promise<number>;
  readonly embedBrief: (
    text: string,
    model: unknown,
    dim: number,
  ) => Promise<number[]>;
  readonly findSimilarBrandAssets: (
    store: BrandStore,
    embedding: readonly number[],
    threshold: number,
    count: number,
  ) => Promise<BrandAssetMatch[]>;
  readonly briefToPrompt: (brief: unknown) => string;
  readonly renderHeroBanner: (
    binary: string,
    spec: HeroRenderSpec,
  ) => Promise<unknown>;
  readonly runStudioOnce: (
    brief: unknown,
    deps: StudioDeps,
  ) => Promise<StudioRunResult>;
  readonly HERO_RENDER_COST: number;
  readonly EXAMPLE_BRAND_ASSETS: unknown;
}

// ---------------------------------------------------------------------------
// The harness.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // The engines live beside the repository, not on the default path.
  const engines = resolve(FILES, "../../../../tools/craft-cli/bin");
  if (existsSync(engines)) {
    const current = process.env["PATH"] ?? "";
    if (!current.split(":").includes(engines)) {
      process.env["PATH"] = `${engines}:${current}`;
    }
  }

  // The harness owns the work tree, so two runs in the same directory
  // take turns rather than pull the tree from under each other.
  mkdirSync(OUTPUT, { recursive: true });
  await acquireLock();
  try {
    await run();
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
  }
}

/** Waits for the lock, or gives up after two minutes. */
async function acquireLock(): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      mkdirSync(LOCK);
      return;
    } catch (error: unknown) {
      const code = (error as { code?: string }).code;
      if (code !== "EEXIST") {
        throw error;
      }
      if (Date.now() > deadline) {
        throw new Error(`another harness is holding ${LOCK}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function run(): Promise<void> {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  assembleProject();

  ok(
    "the project tree was assembled",
    existsSync(join(PROJECT, "src", "pipeline.ts")),
  );
  ok(
    "the published test was assembled",
    existsSync(join(PROJECT, "test", "pipeline.test.ts")),
  );
  ok("the listing compiles under strict TypeScript", typeCheck());

  const modules = await loadModules();

  // --- the brand store ----------------------------------------------------
  const env: StudioEnv = {
    photocraftBin: "photocraft-cli",
    workDir: STUDIO,
    budgetUnits: 8,
    embeddingDim: 1536,
  };
  mkdirSync(STUDIO, { recursive: true });

  const storeFile = join(STUDIO, "brand-memory.sqlite");
  const store = modules.openBrandStore({
    file: storeFile,
    dim: env.embeddingDim,
    now: () => FIXED_NOW,
  });
  const embed = modules.createLocalEmbedder(env.embeddingDim);

  const seeded = await modules.seedBrandMemory(
    store,
    modules.EXAMPLE_BRAND_ASSETS,
    embed,
  );
  equal("the corpus was loaded into the store", seeded, 3);
  equal("the store holds three rows", store.count(), 3);
  ok("the brand store file exists", existsSync(storeFile));
  ok(
    "the brand store file is not empty",
    statSync(storeFile).size > 0,
    `${storeFile} is empty`,
  );

  // --- the retrieval ------------------------------------------------------
  const embedding = await modules.embedBrief(
    modules.briefToPrompt(BRIEF),
    embed,
    env.embeddingDim,
  );
  equal("the brief was embedded into 1536 dimensions", embedding.length, 1536);

  const grounded = await modules.findSimilarBrandAssets(
    store,
    embedding,
    0.72,
    3,
  );
  equal("the retrieval found the approved exemplar", grounded[0]?.id, "brand-001");
  ok(
    "the exemplar clears the similarity threshold",
    (grounded[0]?.similarity ?? 0) > 0.72,
    `similarity ${String(grounded[0]?.similarity)}`,
  );
  equal("the threshold excluded the other campaigns", grounded.length, 1);

  const every = await modules.findSimilarBrandAssets(store, embedding, 0, 3);
  equal("without a threshold every campaign comes back", every.length, 3);
  ok(
    "the campaigns come back best match first",
    (every[0]?.similarity ?? 0) >= (every[1]?.similarity ?? 0) &&
      (every[1]?.similarity ?? 0) >= (every[2]?.similarity ?? 0),
  );

  // --- the run ------------------------------------------------------------
  const deps: StudioDeps = {
    env,
    store,
    embed,
    render: (spec) => modules.renderHeroBanner(env.photocraftBin, spec),
    now: () => FIXED_NOW,
  };

  const first = await modules.runStudioOnce(BRIEF, deps);

  equal("the run grounded the copy in the exemplar", first.exemplarId, "brand-001");
  equal("the headline came from the exemplar", first.headline, "Ship faster");
  equal("the subhead came from the exemplar", first.subhead, "Try it now");
  equal(
    "the budget paid for the render",
    first.budget.spent,
    modules.HERO_RENDER_COST,
  );
  equal(
    "the budget stayed inside its limit",
    first.budget.remaining,
    8 - modules.HERO_RENDER_COST,
  );
  ok("the engine reported its warnings", first.warnings.length > 0);
  ok(
    "the engine reported the flattening of the layers",
    first.warnings.some((warning) => warning.includes("flattened")),
    first.warnings.join(" | "),
  );

  // --- the banner ---------------------------------------------------------
  ok("the banner was written", existsSync(first.assetPath));
  const banner = readFileSync(first.assetPath);
  ok(
    "the banner is a PNG file",
    banner.subarray(1, 4).toString("latin1") === "PNG",
  );
  const image = decodePng(banner);
  equal("the banner has the requested width", image.width, 1200);
  equal("the banner has the requested height", image.height, 628);
  equal("the banner carries the brand background", image.pixelAt(4, 4), "#ffffff");
  equal("the banner carries the brand accent", image.pixelAt(600, 250), "#f59e0b");
  ok("the banner is not a flat colour", image.distinctColours > 2);
  ok("the banner has type on it", image.darkPixels > 100);

  // --- the journal --------------------------------------------------------
  const journalPath = join(STUDIO, "runs", `${first.runId}.jsonl`);
  ok("the journal was written", existsSync(journalPath));
  const entries = readFileSync(journalPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as JournalEntry);
  equal("the journal has one line per step", entries.length, 5);
  ok(
    "the journal is in step order",
    entries.every((entry, index) => entry.step === index + 1),
  );
  equal(
    "the journal names the steps of the run",
    entries.map((entry) => entry.name).join(","),
    "embed,retrieve,compose,render,materialise",
  );
  ok(
    "the journal is stamped with the run clock",
    entries.every((entry) => entry.at === FIXED_NOW),
  );

  // --- replay -------------------------------------------------------------
  const second = await modules.runStudioOnce(BRIEF, deps);
  equal("the run id is addressed by the brief", second.runId, first.runId);
  equal("the replay wrote the same artefact", second.assetPath, first.assetPath);
  equal(
    "the replay wrote the same bytes",
    sha256(readFileSync(second.assetPath)),
    sha256(banner),
  );
  equal(
    "the replay wrote the same journal",
    sha256(readFileSync(join(STUDIO, "runs", `${second.runId}.jsonl`))),
    sha256(readFileSync(journalPath)),
  );

  // --- the guardrail ------------------------------------------------------
  await assert.rejects(
    modules.runStudioOnce(BRIEF, { ...deps, env: { ...env, budgetUnits: 1 } }),
    /budget exhausted/,
  );
  ok("the budget refuses a run it cannot pay for", true);

  // --- the published test -------------------------------------------------
  const testRun = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", join(PROJECT, "test", "pipeline.test.ts")],
    { cwd: FILES, encoding: "utf8" },
  );
  ok(
    "the published test passes",
    testRun.status === 0,
    `${testRun.stdout ?? ""}${testRun.stderr ?? ""}`.slice(-600),
  );
  ok(
    "the published test ran every case",
    /pass 5/.test(testRun.stdout ?? ""),
    (testRun.stdout ?? "").slice(-400),
  );

  console.log(`\n${passed} assertions passed`);
  console.log(
    "the published test on its own: npx tsx --test output/work/project/test/pipeline.test.ts",
  );
}

// ---------------------------------------------------------------------------
// The project assembly.
// ---------------------------------------------------------------------------

function assembleProject(): void {
  for (const [from, to] of LISTINGS) {
    const target = join(PROJECT, to);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(FILES, from), target);
  }
  writeFileSync(
    join(PROJECT, "tsconfig.json"),
    `${JSON.stringify(PROJECT_TSCONFIG, null, 2)}\n`,
    "utf8",
  );
}

/** Type-checks the assembled project with the project's own compiler. */
function typeCheck(): boolean {
  const compiler = join(FILES, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(compiler)) {
    console.error("FAIL the listing compiles under strict TypeScript — no compiler");
    process.exit(1);
  }
  const run = spawnSync(process.execPath, [compiler, "--noEmit", "-p", PROJECT], {
    cwd: FILES,
    encoding: "utf8",
  });
  if (run.status !== 0) {
    console.error(`${run.stdout ?? ""}${run.stderr ?? ""}`);
  }
  return run.status === 0;
}

// ---------------------------------------------------------------------------
// The assembled modules.
// ---------------------------------------------------------------------------

async function loadModules(): Promise<Modules> {
  const load = async (name: string): Promise<unknown> => {
    const url = pathToFileURL(join(PROJECT, "src", name)).href;
    return import(url);
  };
  const [dbClient, brandMemory, pipeline, photocraftBridge] = (await Promise.all([
    load("dbClient.ts"),
    load("brandMemory.ts"),
    load("pipeline.ts"),
    load("photocraftBridge.ts"),
  ])) as [
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>,
  ];

  return {
    openBrandStore: dbClient["openBrandStore"] as Modules["openBrandStore"],
    createLocalEmbedder:
      brandMemory["createLocalEmbedder"] as Modules["createLocalEmbedder"],
    seedBrandMemory:
      brandMemory["seedBrandMemory"] as Modules["seedBrandMemory"],
    embedBrief: brandMemory["embedBrief"] as Modules["embedBrief"],
    findSimilarBrandAssets:
      brandMemory["findSimilarBrandAssets"] as Modules["findSimilarBrandAssets"],
    briefToPrompt: pipeline["briefToPrompt"] as Modules["briefToPrompt"],
    renderHeroBanner:
      photocraftBridge["renderHeroBanner"] as Modules["renderHeroBanner"],
    runStudioOnce: pipeline["runStudioOnce"] as Modules["runStudioOnce"],
    HERO_RENDER_COST: photocraftBridge["HERO_RENDER_COST"] as number,
    EXAMPLE_BRAND_ASSETS: brandMemory["EXAMPLE_BRAND_ASSETS"],
  };
}

// ---------------------------------------------------------------------------
// A minimal PNG reader, so the harness checks pixels and not just bytes.
// ---------------------------------------------------------------------------

interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly pixelAt: (x: number, y: number) => string;
  readonly distinctColours: number;
  readonly darkPixels: number;
}

function decodePng(buffer: Buffer): DecodedPng {
  assert.deepEqual(
    [...buffer.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "not a PNG file",
  );

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8] ?? 0;
      colorType = body[9] ?? 0;
      interlace = body[12] ?? 0;
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  assert.equal(bitDepth, 8, "the banner is not 8 bits per channel");
  assert.ok(colorType === 2 || colorType === 6, "unexpected PNG colour type");
  assert.equal(interlace, 0, "the banner is interlaced");

  const channels = colorType === 2 ? 3 : 4;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(height * stride);

  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor] ?? 0;
    cursor += 1;
    const line = raw.subarray(cursor, cursor + stride);
    cursor += stride;
    const previous =
      y > 0
        ? pixels.subarray((y - 1) * stride, y * stride)
        : Buffer.alloc(stride);
    const current = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? (current[x - channels] ?? 0) : 0;
      const up = previous[x] ?? 0;
      const upLeft = x >= channels ? (previous[x - channels] ?? 0) : 0;
      current[x] = unfilter(filter, line[x] ?? 0, left, up, upLeft);
    }
  }

  const hex = (value: number): string => value.toString(16).padStart(2, "0");
  const colours = new Set<string>();
  let dark = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * stride + x * channels;
      const r = pixels[index] ?? 0;
      const g = pixels[index + 1] ?? 0;
      const b = pixels[index + 2] ?? 0;
      if (y % 2 === 0 && x % 2 === 0) {
        colours.add(`${hex(r)}${hex(g)}${hex(b)}`);
      }
      if (0.299 * r + 0.587 * g + 0.114 * b < 96) {
        dark += 1;
      }
    }
  }

  return {
    width,
    height,
    pixelAt: (x: number, y: number): string => {
      const index = y * stride + x * channels;
      return `#${hex(pixels[index] ?? 0)}${hex(pixels[index + 1] ?? 0)}${hex(pixels[index + 2] ?? 0)}`;
    },
    distinctColours: colours.size,
    darkPixels: dark,
  };
}

/** The five PNG scan-line filters, undone. */
function unfilter(
  filter: number,
  value: number,
  left: number,
  up: number,
  upLeft: number,
): number {
  switch (filter) {
    case 0:
      return value & 0xff;
    case 1:
      return (value + left) & 0xff;
    case 2:
      return (value + up) & 0xff;
    case 3:
      return (value + ((left + up) >> 1)) & 0xff;
    case 4: {
      const p = left + up - upLeft;
      const pa = Math.abs(p - left);
      const pb = Math.abs(p - up);
      const pc = Math.abs(p - upLeft);
      const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      return (value + predictor) & 0xff;
    }
    default:
      throw new Error(`unsupported PNG filter ${filter}`);
  }
}

await main();
