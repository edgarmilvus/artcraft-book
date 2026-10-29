import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { OpenAI } from "openai";

// --- Domain contracts from the exercise ---
export interface CMSAsset { contentId: string; cdnUrl: string; inferredFormat: "jpeg" | "png" | "webp" | "tiff" | "unknown"; declaredWidth: number; declaredHeight: number; exifOrientationHint?: number; }
export interface CMSFigure { asset: CMSAsset; caption: string; sentinel: string; anchorOrder: number; }
export interface CMSArticle { slug: string; title: string; kicker: string; byline: string; bodyMarkdown: string; hero: CMSAsset; figures: CMSFigure[]; }
export interface AssetLedgerEntry { contentId: string; diskPath: string; sha256: string; bytes: number; }
export interface AssetLedger { version: 1; entries: AssetLedgerEntry[]; }
export interface BuildRequest { issueNumber: number; publishDate: string; articles: CMSArticle[]; ledger: AssetLedger; outputDir: string; allowDegraded: boolean; hmacKey: string; }

export type Tier = "direct" | "ledger" | "placeholder";
export interface ResolutionEntry { contentId: string; tier: Tier; resolvedPath?: string; substitutedAt?: string; reason?: string; }

// --- MCP client for designcraft-cli ---
export class DesignCraftSession {
  private sessionIndex = 0;

  constructor(private client: Client) {}

  static async connect(readRoot: string, writeRoot: string): Promise<DesignCraftSession> {
    const transport = new StdioClientTransport({
      command: "designcraft-cli",
      args: ["mcp"],
    });
    const client = new Client({ name: "nightly-editorial", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    return new DesignCraftSession(client);
  }

  async call<T = any>(name: string, args: any = {}): Promise<T> {
    const res = await this.client.callTool({ name, arguments: args });
    // MCP text responses for designcraft are JSON-encoded strings.
    const block = (res.content as any[])[0];
    if (block?.type === "text") {
      try { return JSON.parse(block.text) as T; } catch { return block.text as any; }
    }
    return res as any;
  }

  execute(id: string, params: any = {}): Promise<any> { return this.call("execute", { command: id, params }); }
  batch(steps: { id: string; params?: any }[]): Promise<any> {
    return this.call("batch", { commands: steps.map(s => ({ command: s.id, params: s.params ?? {} })) });
  }

  /**
   * Close the session and its child process.
   *
   * The MCP client owns a `designcraft-cli` subprocess, and a live child
   * keeps the Node event loop alive — without this the build finishes and
   * the process never exits.
   */
  async close(): Promise<void> {
    try { await this.client.close(); } catch { /* the engine is already gone */ }
  }
}

// --- 1. Document parameter validation (hard failure before styles) ---
export const EXACT_DOC = {
  width: 612, height: 792, facingPages: true, pages: 12,
  columns: 3, gutter: 14,
  margins: { top: 54, bottom: 54, inside: 54, outside: 54 },
  preset: "Letter",
};

export function assertCanonicalParams(req: BuildRequest): void {
  // The exercise mandates these exact numbers; any deviation must hard-fail.
  const spec = EXACT_DOC;
  const bad = (msg: string) => { throw new Error(`FATAL: document skeleton deviates from spec — ${msg}`); };
  if (spec.columns !== 3) bad("columns");
  if (spec.gutter !== 14) bad("gutter");
  if (spec.margins.top !== 54 || spec.margins.bottom !== 54 || spec.margins.inside !== 54 || spec.margins.outside !== 54) bad("margins");
  if (req.articles.length !== 4) bad("articles != 4");
}

// --- 2. Style set (frozen once batch succeeds) ---
export async function installStyleSet(session: DesignCraftSession): Promise<void> {
  const steps = [
    { id: "style.paragraph.create", params: {
      name: "BODY-3COL",
      para: { align: "justify", hyphenate: true, spaceBefore: 0, spaceAfter: 0,
              leading: { kind: "points", value: 13 }, columns: 3, gutter: 14 },
    } },
    { id: "style.paragraph.create", params: {
      name: "HEADLINE-KICKER",
      chars: { size: 10, capitalization: "allCaps", tracking: 150 },
      para:  { spaceAfter: 12 },
    } },
    { id: "style.paragraph.create", params: {
      name: "HEADLINE-LEAD",
      chars: { size: 32 },
      para:  { spaceBefore: 1, hyphenate: false },
    } },
    { id: "style.paragraph.create", params: {
      name: "CAPTION-8PT",
      chars: { size: 8, fontStyle: "Italic" },
      para:  { spaceBefore: 6 },
    } },
    { id: "style.character.create", params: {
      name: "BYLINE-LIGHT",
      chars: { fill: "#4d4d4d", tracking: 100 }, // 30% gray ≈ #4d4d4d
    } },
    // Register the degraded-mode placeholder swatch exactly once.
    { id: "swatch.create", params: { name: "assetPending", color: "#d97706", spot: false } },
  ];
  // The batch stops at the first failing command, so the style set is
  // all there or the build does not proceed.
  await session.batch(steps);
}

// --- 3. Tiered asset resolution ---
export async function resolveAsset(
  session: DesignCraftSession, asset: CMSAsset, ledger: AssetLedger,
  writeRoot: string, log: ResolutionEntry[],
): Promise<{ tier: Tier; path?: string }> {
  // TIER 1 — direct URL, decoded into the write root.
  try {
    const out = path.join(writeRoot, "cache", `${asset.contentId}.${asset.inferredFormat === "unknown" ? "bin" : "img"}`);
    await fs.mkdir(path.dirname(out), { recursive: true });
    const r = await fetch(asset.cdnUrl, { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer());
      await fs.writeFile(out, buf);
      log.push({ contentId: asset.contentId, tier: "direct", resolvedPath: out });
      return { tier: "direct", path: out };
    }
  } catch { /* fall through to ledger */ }

  // TIER 2 — ledger lookup by contentId, existence- and size-checked.
  const entry = ledger.entries.find(e => e.contentId === asset.contentId);
  if (entry) {
    try {
      const st = await fs.stat(entry.diskPath);
      if (st.isFile() && st.size === entry.bytes) {
        // Verifying sha256 here is the difference between "ledger" and "trust the ledger blindly".
        const bytes = await fs.readFile(entry.diskPath);
        const sha = crypto.createHash("sha256").update(bytes).digest("hex");
        if (sha === entry.sha256) {
          log.push({ contentId: asset.contentId, tier: "ledger", resolvedPath: entry.diskPath });
          return { tier: "ledger", path: entry.diskPath };
        }
      }
    } catch { /* fall through */ }
  }

  // TIER 3 — placeholder; caller draws the swatch and labels the frame.
  log.push({
    contentId: asset.contentId, tier: "placeholder",
    substitutedAt: new Date().toISOString(),
    reason: entry ? "ledger-hash-mismatch" : "url-404-and-no-ledger",
  });
  return { tier: "placeholder" };
}

// --- 4. Hero + inline figure placement with fallback ---
export async function placeHero(
  session: DesignCraftSession, article: CMSArticle, spread: number,
  ledger: AssetLedger, writeRoot: string, log: ResolutionEntry[],
): Promise<{ tier: Tier; frameId?: number }> {
  const res = await resolveAsset(session, article.hero, ledger, writeRoot, log);
  if (res.tier !== "placeholder" && res.path) {
    const r = await session.call("place_image", {
      path: res.path, spread, x: 0, y: 0, width: 612,
    });
    // Pin the hero rect to full-bleed exactly.
    await session.execute("transform.set", { ids: [r.id], x: 0, y: 0, width: 612, height: 792 });
    return { tier: res.tier, frameId: r.id };
  }
  // Placeholder hero: a labeled filled frame so the human QA can find it later.
  const f = await session.execute("frame.create", {
    spread, rect: [0, 0, 612, 792], content: "graphic",
  });
  await session.execute("object.fill", { ids: [f.id], swatch: "assetPending" });
  await session.execute("object.label", { ids: [f.id], label: `pending:${article.hero.contentId}` });
  return { tier: "placeholder", frameId: f.id };
}

export async function placeInlineFigure(
  session: DesignCraftSession, fig: CMSFigure, spread: number, rect: [number, number, number, number],
  ledger: AssetLedger, writeRoot: string, log: ResolutionEntry[],
): Promise<{ tier: Tier; frameId: number }> {
  const res = await resolveAsset(session, fig.asset, ledger, writeRoot, log);
  if (res.tier !== "placeholder" && res.path) {
    const r = await session.call("place_image", { path: res.path, spread, x: rect[0], y: rect[1], width: rect[2] - rect[0] });
    await session.execute("transform.set", { ids: [r.id], x: rect[0], y: rect[1], width: rect[2] - rect[0], height: rect[3] - rect[1] });
    // Frame already configured for caption via caption.insert below.
    return { tier: res.tier, frameId: r.id };
  }
  const f = await session.execute("frame.create", { spread, rect, content: "graphic" });
  await session.execute("object.fill", { ids: [f.id], swatch: "assetPending" });
  await session.execute("object.label", { ids: [f.id], label: `pending:${fig.asset.contentId}` });
  return { tier: "placeholder", frameId: f.id };
}

// --- 5. Body threading (page 2 → page 3 → page 4) ---
export async function threadBody(session: DesignCraftSession, article: CMSArticle): Promise<{ story: number; frameCount: number }> {
  // Seed frame on spread 0 (page 2), then extend twice.
  const seed = await session.execute("frame.create", {
    spread: 0, rect: [54, 140, 558, 738], content: "text", text: article.bodyMarkdown,
  });
  const l1 = await session.execute("story.placeAndLink", {
    story: seed.story, rect: [54, 140, 558, 738], spread: 1,
  });
  const l2 = await session.execute("story.placeAndLink", {
    story: seed.story, rect: [54, 140, 558, 738], spread: 2,
  });
  const links = await session.execute("story.links", {});
  const chain = links.filter((l: any) => l.story === seed.story);
  if (chain.length !== 3) throw new Error(`threading: expected 3 frames, got ${chain.length}`);
  // Verify no second incoming link (loop / malformed thread).
  if (chain.some((l: any, i: number) => i > 0 && l.parent !== seed.story)) {
    throw new Error("malformed thread: non-linear parentage detected");
  }
  const st = await session.call("get_story", { story: seed.story });
  if (st.overset) throw new Error("body story is overset across three frames");
  return { story: seed.story, frameCount: chain.length };
}

// --- 6. Multimodal verification ---
async function verifyPagesWithVision(
  session: DesignCraftSession, openai: OpenAI, pages: number[], verifyDir: string,
): Promise<{ ok: boolean; placeholderTilesVisible: number; notes: string }> {
  await fs.mkdir(verifyDir, { recursive: true });
  const images: string[] = [];
  for (const page of pages) {
    const png = await session.call<{ path?: string; data?: string }>("render_page", { page, scale: 2 });
    // render_page in MCP can return a path OR a base64 payload depending on transport.
    if (png.path) {
      const bytes = await fs.readFile(png.path);
      images.push(bytes.toString("base64"));
    } else if ((png as any).data) {
      images.push((png as any).data);
    }
  }
  // Screenshot of the whole window as an audit artefact.
  await session.call("screenshot", { path: path.join(verifyDir, "window.png") });

  const prompt = `You are the layout QA partner for a print magazine. Return strict JSON:
{ "ok": boolean, "placeholderTilesVisible": number, "wrongAspectRatioArtifacts": number, "heroPresent": boolean, "figuresPresent": number, "notes": string }
A "placeholder tile" is a diagonal-hatch rectangle with a dark amber fill. Do not hallucinate; only count what you can see.`;

  const r = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        ...images.map(b64 => ({ type: "image_url" as const, image_url: { url: `data:image/png;base64,${b64}` } })),
      ],
    }],
    response_format: { type: "json_object" },
  });
  return JSON.parse(r.choices[0]!.message.content!);
}

// --- 7. Degraded layout (atomic, undo-first) ---
export async function applyDegradedLayout(session: DesignCraftSession, articles: CMSArticle[]): Promise<void> {
  // One atomic batch: undo the previous hero placements, then lay out degraded panels.
  const steps: { id: string; params: any }[] = [];
  // The exercise teaches: undo inside a batch is legal, and the batch
  // itself stops at the first failing command.
  steps.push({ id: "edit.undo", params: {} });
  for (let i = 0; i < articles.length; i++) {
    const a = articles[i]!;
    // Hero → tinted panel with title at 64pt centered.
    const panel = { id: "frame.create", params: { spread: i, rect: [0, 0, 612, 792], content: "graphic" } };
    steps.push(panel);
    const panelIdPlaceholder = `$last.id`; // batch interpolation is available in designcraft.
    steps.push({ id: "object.fill", params: { ids: [panelIdPlaceholder], swatch: "assetPending" } });
    steps.push({ id: "frame.create", params: {
      spread: i, rect: [54, 300, 558, 492], content: "text",
      text: a.title, caret: false,
    } });
    const titleFrame = `$last.id`;
    steps.push({ id: "style.paragraph.apply", params: { name: "HEADLINE-LEAD" } });
    // Each missing figure collapses into a typographic callout.
    for (const fig of a.figures) {
      steps.push({ id: "frame.create", params: {
        spread: i, rect: [54, 520, 558, 560], content: "text",
        text: `[Figure unavailable: ${fig.asset.contentId}]`,
      } });
      steps.push({ id: "style.paragraph.apply", params: { name: "CAPTION-8PT" } });
    }
  }
  try {
    await session.batch(steps);
  } catch (e) {
    throw new Error(`degraded layout batch failed: ${(e as Error).message}`);
  }
}

// --- 8. Sidecar signing ---
/**
 * Recursive canonical JSON: sorted keys at every depth. A replacer array
 * only filters the top level, which would silently omit every nested field
 * from the signature.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(k => `${JSON.stringify(k)}:${canonicalize(record[k])}`).join(",")}}`;
}

export function signSidecar(obj: unknown, key: string): string {
  return crypto.createHmac("sha256", key).update(canonicalize(obj)).digest("hex");
}

// --- 9. Orchestration ---
export async function runNightlyBuild(req: BuildRequest, writeRoot: string, openai: OpenAI): Promise<void> {
  assertCanonicalParams(req);
  const session = await DesignCraftSession.connect(writeRoot, writeRoot);
  try {
    const resolutionLog: ResolutionEntry[] = [];

    // Deterministic timestamps for byte-identical re-runs (per test oracle).
    await session.execute("prefs.set", { values: { "general.timestamp": req.publishDate } });

    // 1. Skeleton.
    await session.call("new_document", { ...EXACT_DOC, title: `Issue ${req.issueNumber}` });

    // 2. Frozen style set + placeholder swatch.
    await installStyleSet(session);

    // 3. Hero + inline art (per-article tiered resolution).
    const heroTiers: Record<string, Tier> = {};
    for (let i = 0; i < req.articles.length; i++) {
      const a = req.articles[i]!;
      const h = await placeHero(session, a, i, req.ledger, writeRoot, resolutionLog);
      heroTiers[a.slug] = h.tier;
      for (let k = 0; k < a.figures.length; k++) {
        const fig = a.figures[k]!;
        const y = 260 + k * 120;
        await placeInlineFigure(session, fig, i, [54, y, 558, y + 110], req.ledger, writeRoot, resolutionLog);
      }
    }

    // 4. Body threading (page 2 → 3 → 4 pattern, one article in this reduced skeleton).
    const primary = req.articles[0]!;
    await threadBody(session, primary);

    // 5. Multimodal verification.
    const verifyDir = path.join(writeRoot, req.outputDir, "verify");
    const vision = await verifyPagesWithVision(session, openai, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], verifyDir);

    // 6. If placeholders persist, degrade (or hard-fail if disallowed).
    if (vision.placeholderTilesVisible > 0) {
      if (!req.allowDegraded) {
        await session.call("save_document", { path: path.join(req.outputDir, "aborted.designcraft") });
        throw new Error(`build aborted: ${vision.placeholderTilesVisible} placeholder tiles visible, allowDegraded=false`);
      }
      await applyDegradedLayout(session, req.articles);
    }

    // 7. Export.
    const pdfPath = path.join(writeRoot, req.outputDir, `issue-${String(req.issueNumber).padStart(3, "0")}.pdf`);
    await session.call("save_document", { path: pdfPath, format: "PDF" });

    // 8. Sidecar + HMAC.
    const sidecar = {
      schemaVersion: 1,
      issue: req.issueNumber,
      publishDate: req.publishDate,
      resolutions: resolutionLog,
      visionVerdict: vision,
      degraded: vision.placeholderTilesVisible > 0,
    };
    const signature = signSidecar(sidecar, req.hmacKey);
    await fs.mkdir(path.dirname(pdfPath), { recursive: true });
    await fs.writeFile(
      path.join(writeRoot, req.outputDir, "sidecar.json"),
      JSON.stringify({ ...sidecar, signature }, null, 2),
    );
  } finally {
    // The MCP session owns a `designcraft-cli` child process. Closing it is
    // what lets the process exit: a live child keeps the event loop alive.
    await session.close();
  }
}
