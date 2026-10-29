// run_forge.ts — the deterministic harness for the Autonomous Creative Studio.
//
// The harness runs the whole studio for real: it spawns the ArtCraft
// engines, lets the agents produce the campaign, and then checks the
// artefacts, the journal, the budget and the audit that came out. Nothing
// is mocked except the two language models, which are injected as
// deterministic stand-ins — the studio never calls a model directly, so the
// harness supplies one.
//
// It also exercises the human-in-the-loop bridge. The control channel
// belongs to the desktop application, and the CLI cannot open it, so the
// harness hosts a stub server and points the Python bridge at it.

import { execFile } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { CraftClient, CraftPathError, CRAFT_DIALECTS } from "./03_craft-client.js";
import { BriefSchema, type Brief, type CopyModel, type VisionModel } from "./04_types.js";
import { StudioOrchestrator } from "./12_orchestrator.js";

const execFileAsync = promisify(execFile);

const FILES = resolve(process.cwd());
const OUTPUT = resolve(FILES, "output");
const WORK = resolve(OUTPUT, "work");
const CAMPAIGN_ID = "6f1a1f2c-9b4d-4f0e-9a2b-2c9b0d5e7a11";
const BRIDGE = resolve(FILES, "14_live_bridge.py");
const CONTROL_TOKEN = "harness-control-token";

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

interface Size {
  width: number;
  height: number;
}

/** Read a PNG's pixel size out of its IHDR chunk. */
function pngSize(path: string): Size | null {
  const buffer = readFileSync(path);
  if (buffer.length < 24) return null;
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function isPdf(path: string): boolean {
  return readFileSync(path).subarray(0, 4).toString("latin1") === "%PDF";
}

/**
 * The raster of a PNG: its header and its compressed pixels, without the
 * ancillary chunks. VectorCraft stamps a "Creation Time" text chunk into
 * every PNG it exports, so two runs of the same campaign produce files
 * that differ in their metadata and agree, byte for byte, in their
 * pixels. Determinism has to be asserted on the raster.
 */
function pngRaster(path: string): Buffer {
  const data = readFileSync(path);
  const parts: Buffer[] = [];
  let offset = 8;
  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.subarray(offset + 4, offset + 8).toString("latin1");
    if (type === "IHDR" || type === "IDAT") {
      parts.push(data.subarray(offset, offset + 12 + length));
    }
    offset += 12 + length;
  }
  return Buffer.concat(parts);
}

// ── the injected models ─────────────────────────────────────────────────────

/** A deterministic stand-in for a copy model. */
const copyModel: CopyModel = async (brief: Brief) => ({
  headline: `${brief.product.name}: ${brief.product.tagline}`,
  subhead: `Designed for ${brief.audience}.`,
  bullets: brief.product.keyBenefits.map((benefit) => benefit.trim()),
  cta: "Shop now",
});

/**
 * A deterministic stand-in for a vision model. It asks for one levels
 * correction and then accepts the image, so the auditor's correction
 * branch and its accepting branch are both exercised. Each studio run
 * gets its own instance, so the two runs of the harness are comparable.
 */
function createVisionModel(): VisionModel {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === 1) {
      return {
        status: "fix",
        fix: "levels",
        gamma: 1.15,
        reason: "The shadows are clipped.",
      };
    }
    return { status: "ok", reason: "The tones are balanced." };
  };
}

// ── the stub control channel ────────────────────────────────────────────────

interface StubChannel {
  readonly port: number;
  readonly frames: Array<{ method: string; id: unknown }>;
  close(): Promise<void>;
}

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * A stub of the desktop control channel: an authenticated, loopback-only
 * JSON-lines server. The real counterpart is `photocraft --control <port>`,
 * which lives in the desktop application and needs a window, so it cannot
 * run in a headless harness.
 */
async function startStubChannel(token: string): Promise<StubChannel> {
  const frames: Array<{ method: string; id: unknown }> = [];
  const server: Server = createServer((socket: Socket) => {
    let authenticated = false;
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line.length === 0) continue;
        const frame = JSON.parse(line) as {
          id?: unknown;
          method?: string;
          params?: { token?: string; path?: string };
        };
        frames.push({ method: String(frame.method), id: frame.id });

        if (!authenticated) {
          if (frame.method !== "auth" || frame.params?.token !== token) {
            socket.write(
              `${JSON.stringify({
                id: frame.id ?? null,
                ok: false,
                error: "authentication required",
              })}\n`,
            );
            socket.end();
            return;
          }
          authenticated = true;
          socket.write(
            `${JSON.stringify({
              id: frame.id ?? null,
              ok: true,
              result: { authenticated: true },
            })}\n`,
          );
          continue;
        }

        if (frame.method === "engine.execute") {
          socket.write(
            `${JSON.stringify({
              id: frame.id ?? null,
              ok: true,
              result: {
                document: 0,
                width: 1080,
                height: 1080,
                layers: ["Background", "Type"],
              },
            })}\n`,
          );
          continue;
        }

        if (frame.method === "ui.screenshot") {
          const path = frame.params?.path ?? "approval-snapshot.png";
          writeFileSync(path, PNG_1PX);
          socket.write(
            `${JSON.stringify({ id: frame.id ?? null, ok: true, result: { path } })}\n`,
          );
          continue;
        }

        socket.write(
          `${JSON.stringify({
            id: frame.id ?? null,
            ok: false,
            error: `unknown method \`${String(frame.method)}\``,
          })}\n`,
        );
      }
    });
  });

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    frames,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
      }),
  };
}

// ── the run ─────────────────────────────────────────────────────────────────

const BRIEF = BriefSchema.parse({
  campaignId: CAMPAIGN_ID,
  product: {
    name: "Lumen Desk Lamp",
    tagline: "Light that follows the sun",
    priceUsd: 129,
    keyBenefits: [
      "Warm dimmable LED",
      "Twelve-hour battery",
      "Ships in a day",
    ],
    palette: {
      primary: "#0f172a",
      accent: "#f97316",
      neutral: "#f8fafc",
    },
  },
  audience: "designers who work late",
  tone: "premium",
  channels: [
    "instagram-post",
    "email-hero",
    "web-banner",
    "tiktok-reel",
    "print-flyer",
    "pdf-onepager",
  ],
});

async function runStudio(campaignRoot: string) {
  const orchestrator = new StudioOrchestrator({
    brief: BRIEF,
    campaignRoot,
    copyModel,
    visionModel: createVisionModel(),
    budget: { maxCommands: 2_500, maxSeconds: 900, maxModelTokens: 120_000 },
    requestTimeoutMs: 180_000,
  });
  return orchestrator.run();
}

async function main(): Promise<void> {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });

  // ── the studio runs for real ───────────────────────────────────────────
  const result = await runStudio(WORK);
  const workDir = result.workDir;

  ok("the campaign workspace exists", existsSync(workDir), workDir);
  ok("the hero PNG was written", existsSync(result.visuals.heroPngPath));
  ok("the CTA badge was written", existsSync(result.visuals.ctaBadgePngPath));
  ok("the feed PNG was written", existsSync(result.visuals.feedPngPath));
  ok("the banner PNG was written", existsSync(result.visuals.bannerPngPath));
  ok("the badge's editable document was written", existsSync(result.visuals.badgeVectorcraftPath));
  ok("the copy document was written", existsSync(result.copy.docxPath));

  // The copy document is read back through WordCraft itself, so the
  // assertion is about the document that shipped, not about the draft
  // the model returned.
  const wordClient = new CraftClient({
    dialect: "wordcraft",
    readRoot: workDir,
    writeRoot: workDir,
  });
  try {
    await wordClient.connect();
    await wordClient.call("open_document", { path: result.copy.docxPath });
    const read = (await wordClient.call<{ text: string }>("get_text", {})).text;
    ok("the copy document holds the headline", read.includes(result.copy.headline), read);
    ok("the copy document holds the subhead", read.includes(result.copy.subhead));
    for (const bullet of result.copy.bullets) {
      ok(`the copy document holds the bullet: ${bullet}`, read.includes(bullet));
    }
  } finally {
    await wordClient.close();
  }

  const heroSize = pngSize(result.visuals.heroPngPath);
  ok("the hero is 1080x1080", heroSize?.width === 1080 && heroSize?.height === 1080, JSON.stringify(heroSize));

  const badgeSize = pngSize(result.visuals.ctaBadgePngPath);
  ok("the badge is 640x160", badgeSize?.width === 640 && badgeSize?.height === 160, JSON.stringify(badgeSize));

  const feedSize = pngSize(result.visuals.feedPngPath);
  ok("the feed image is 1080x1080", feedSize?.width === 1080 && feedSize?.height === 1080, JSON.stringify(feedSize));

  const bannerSize = pngSize(result.visuals.bannerPngPath);
  ok("the banner is 1920x1080", bannerSize?.width === 1920 && bannerSize?.height === 1080, JSON.stringify(bannerSize));

  // ── the publisher's deliverables ───────────────────────────────────────
  ok("the flyer has two pages", result.published.flyerPngPaths.length === 2);
  for (const page of result.published.flyerPngPaths) {
    ok(`the flyer page exists: ${page.slice(page.lastIndexOf("/") + 1)}`, existsSync(page));
  }
  ok("the editable flyer was written", existsSync(result.published.flyerDesigncraftPath));
  ok("the print PDF is a PDF", isPdf(result.published.flyerPdfPath));
  ok("the tracking PDF is a PDF", isPdf(result.published.trackingPdfPath));
  ok("the campaign bundle is a PDF", isPdf(result.published.bundlePdfPath));
  ok("the bundle is larger than the tracking page",
    statSync(result.published.bundlePdfPath).size >
      statSync(result.published.trackingPdfPath).size,
  );
  const flyerPageSize = pngSize(result.published.flyerPngPaths[0] ?? "");
  ok(
    "the flyer page is an A4 page at 144 dpi",
    flyerPageSize?.width === 1191 && flyerPageSize?.height === 1684,
    JSON.stringify(flyerPageSize),
  );

  // The bundle is opened again through PdfCraft, so the assertion is
  // about the PDF that shipped.
  const pdfClient = new CraftClient({
    dialect: "pdfcraft",
    readRoot: workDir,
    writeRoot: workDir,
  });
  try {
    await pdfClient.connect();
    const opened = await pdfClient.call<{ doc: number }>("doc_open", {
      path: result.published.bundlePdfPath,
    });
    const info = await pdfClient.call<{ document: { pages: number } }>("doc_info", {
      doc: opened.doc,
    });
    equal("the bundle holds the flyer pages and the tracking page", info.document.pages, 3);
  } finally {
    await pdfClient.close();
  }

  // ── the motion plane ───────────────────────────────────────────────────
  ok("the reel was rendered", result.motion !== null);
  const frames = result.motion?.frames ?? 0;
  equal("the reel is five seconds at 24 fps", frames, 120);
  const firstFrame = join(result.motion?.framesDir ?? "", "frame-0000.png");
  const lastFrame = join(result.motion?.framesDir ?? "", "frame-0119.png");
  ok("the first frame was written", existsSync(firstFrame));
  ok("the last frame was written", existsSync(lastFrame));
  const frameSize = pngSize(firstFrame);
  ok("the frames are 1080x1080", frameSize?.width === 1080 && frameSize?.height === 1080, JSON.stringify(frameSize));

  // ── the journal ────────────────────────────────────────────────────────
  ok("the journal was flushed", existsSync(result.statePath));
  const journal = JSON.parse(readFileSync(result.statePath, "utf8")) as {
    auditLog: Array<{ agent: string; message: string }>;
    assets: Array<{ id: string; channel: string; path: string; bytes: number; dimensions: unknown }>;
    copy: { headline: string } | null;
    hero: { path: string } | null;
    commandsSpent: number;
  };
  const agents = journal.auditLog.map((entry) => entry.agent);
  for (const agent of ["orchestrator", "copywriter", "visual", "vision", "motion", "publisher"]) {
    ok(`the journal records the ${agent}`, agents.includes(agent), agents.join(","));
  }
  ok("the journal carries the copy block", journal.copy?.headline === BRIEF.product.name + ": " + BRIEF.product.tagline);
  ok("the journal carries the hero", journal.hero !== null);
  ok(
    "every artefact lives inside the campaign workspace",
    journal.assets.every((asset) => asset.path.startsWith(workDir)),
  );
  ok("every artefact has bytes", journal.assets.every((asset) => asset.bytes > 0));
  ok(
    "the PNG artefacts carry their pixel size",
    journal.assets
      .filter((asset) => asset.path.endsWith(".png"))
      .every((asset) => asset.dimensions !== null),
  );
  equal(
    "the artefact identifiers are deterministic",
    journal.assets.map((asset) => asset.id).join(","),
    "email-hero-01,instagram-post-01,web-banner-01,print-flyer-01,pdf-onepager-01,pdf-onepager-02",
  );

  // ── the budget ─────────────────────────────────────────────────────────
  ok("the budget spent commands", result.budget.commands > 0, String(result.budget.commands));
  ok("the budget spent model tokens", result.budget.tokens > 0, String(result.budget.tokens));
  ok("the budget stayed inside its command cap", result.budget.commands <= 2_500);
  ok("the budget stayed inside its token cap", result.budget.tokens <= 120_000);
  ok("the budget stayed inside its wall-clock cap", result.budget.seconds <= 900);
  equal(
    "the journal accounted for every command the budget spent",
    journal.commandsSpent,
    result.budget.commands,
  );

  // ── the audit ──────────────────────────────────────────────────────────
  ok("the audit passed", result.verdict.passed);
  ok("the audit asked for a correction", result.verdict.corrections.length === 1);
  equal("the correction was a levels adjustment", result.verdict.corrections[0]?.kind, "levels");
  equal("the correction used the model's gamma", result.verdict.corrections[0]?.gamma, 1.15);
  ok(
    "the audited artefact carries the verdict",
    journal.assets.some(
      (asset) => asset.channel === "instagram-post" && asset.path === result.visuals.feedPngPath,
    ),
  );

  // ── the client: one binary, one surface ────────────────────────────────
  equal("PhotoCraft's sandbox is the engine's", CRAFT_DIALECTS.photocraft.sandbox, "automation-roots");
  equal("VectorCraft's sandbox is the engine's", CRAFT_DIALECTS.vectorcraft.sandbox, "automation-roots");
  equal("PdfCraft's sandbox is a single root", CRAFT_DIALECTS.pdfcraft.sandbox, "single-root");
  equal("DesignCraft has no sandbox of its own", CRAFT_DIALECTS.designcraft.sandbox, "client-confined");
  equal("EffectCraft has no sandbox of its own", CRAFT_DIALECTS.effectcraft.sandbox, "client-confined");
  equal("WordCraft has no sandbox of its own", CRAFT_DIALECTS.wordcraft.sandbox, "client-confined");

  const photoClient = new CraftClient({
    dialect: "photocraft",
    readRoot: workDir,
    writeRoot: workDir,
  });
  const vectorClient = new CraftClient({
    dialect: "vectorcraft",
    readRoot: workDir,
    writeRoot: workDir,
  });
  try {
    await photoClient.connect();
    await vectorClient.connect();

    const photoTools = await photoClient.listTools();
    const vectorTools = await vectorClient.listTools();
    ok("PhotoCraft exposes a doc_new meta-tool", photoTools.includes("doc_new"));
    ok("PhotoCraft runs commands with command_run", photoTools.includes("command_run"));
    ok("VectorCraft has no doc_new meta-tool", !vectorTools.includes("doc_new"));
    ok("VectorCraft runs commands with command_run", vectorTools.includes("command_run"));
    ok("VectorCraft exports through document.export", vectorTools.includes("export"));

    const photoRegistry = (await photoClient.listCommands("type.create")) as unknown[];
    ok("PhotoCraft's registry holds type.create", Array.isArray(photoRegistry) && photoRegistry.length > 0);
    const vectorRegistry = (await vectorClient.listCommands("text.create")) as unknown[];
    ok("VectorCraft's registry holds text.create", Array.isArray(vectorRegistry) && vectorRegistry.length > 0);

    let refused = false;
    try {
      photoClient.writePath("/etc/passwd");
    } catch (error) {
      refused = error instanceof CraftPathError;
    }
    ok("the client refuses a path outside the campaign", refused);
  } finally {
    await Promise.allSettled([photoClient.close(), vectorClient.close()]);
  }

  // ── the human-in-the-loop bridge ───────────────────────────────────────
  const stub = await startStubChannel(CONTROL_TOKEN);
  const snapshot = join(workDir, "approval-snapshot.png");
  try {
    const { stdout } = await execFileAsync("python3", [BRIDGE], {
      env: {
        ...process.env,
        PHOTOCRAFT_TOKEN: CONTROL_TOKEN,
        CONTROL_PORT: String(stub.port),
        APPROVAL_SNAPSHOT: snapshot,
      },
    });
    const state = JSON.parse(stdout) as { width: number; height: number };
    equal("the bridge read the session state", state.width, 1080);
    ok("the bridge wrote the approval snapshot", existsSync(snapshot));
    equal("the auth frame came first", stub.frames[0]?.method, "auth");
    ok("the bridge then ran a command", stub.frames.some((frame) => frame.method === "engine.execute"));
    ok("the bridge then took a screenshot", stub.frames.some((frame) => frame.method === "ui.screenshot"));

    // The same bridge must refuse a channel it cannot authenticate on.
    let exitCode = 0;
    try {
      await execFileAsync("python3", [BRIDGE], {
        env: {
          ...process.env,
          PHOTOCRAFT_TOKEN: "the-wrong-token",
          CONTROL_PORT: String(stub.port),
          APPROVAL_SNAPSHOT: snapshot,
        },
      });
    } catch (error) {
      const failure = error as { code?: number };
      exitCode = failure.code ?? 1;
    }
    ok("the bridge refuses a wrong token", exitCode !== 0, String(exitCode));
  } finally {
    await stub.close();
  }

  // ── determinism ────────────────────────────────────────────────────────
  const secondRoot = resolve(WORK, "replay");
  mkdirSync(secondRoot, { recursive: true });
  const replay = await runStudio(secondRoot);
  const sameRaster = (a: string, b: string): boolean =>
    pngRaster(a).equals(pngRaster(b));
  ok(
    "a replay renders an identical hero",
    sameRaster(result.visuals.heroPngPath, replay.visuals.heroPngPath),
  );
  ok(
    "a replay renders an identical badge",
    sameRaster(result.visuals.ctaBadgePngPath, replay.visuals.ctaBadgePngPath),
  );
  ok(
    "a replay renders an identical feed image",
    sameRaster(result.visuals.feedPngPath, replay.visuals.feedPngPath),
  );
  ok(
    "a replay renders an identical banner",
    sameRaster(result.visuals.bannerPngPath, replay.visuals.bannerPngPath),
  );
  ok(
    "a replay renders identical frames",
    sameRaster(firstFrame, join(replay.motion?.framesDir ?? "", "frame-0000.png")),
  );
  equal(
    "a replay spends the same number of commands",
    replay.budget.commands,
    result.budget.commands,
  );
  equal(
    "a replay produces the same artefact identifiers",
    replay.state.assets.map((asset) => asset.id).join(","),
    result.state.assets.map((asset) => asset.id).join(","),
  );

  console.log(`\n${passed} assertions passed`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
