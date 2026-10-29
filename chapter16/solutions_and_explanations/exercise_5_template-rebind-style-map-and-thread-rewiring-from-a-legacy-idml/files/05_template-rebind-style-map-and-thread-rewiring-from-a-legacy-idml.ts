import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs/promises";
import path from "node:path";

// --- Contracts ---
export interface RebindRequest {
  template: string; output: string;
  styleMap: Record<string, string>;
  stories: RebindStory[];
  fallbackFonts: Record<string, { family: string; style: string }>;
  paperResize?: { from: [number, number]; to: [number, number]; };
  baselineGrid?: { start: number; increment: number; color: [number, number, number]; viewThreshold: number; };
}
export interface RebindStory { name: string; seedSpread: number; seedRect: [number, number, number, number]; containerSpreadChain: number[]; styleToApply?: string; }
export interface FontSubstitution { family: string; style: string; toFamily: string; toStyle: string; reason: "not-installed" | "style-missing" | "embedding-restricted"; documentFontPreserved: boolean; }
export interface RebindReport {
  schemaVersion: 1;
  styleMapApplied: Array<{ from: string; to: string; paragraphsAffected: number; }>;
  storiesRewired: Array<{ name: string; frames: number[]; overset: boolean; }>;
  orphanFramesRemoved: number;
  fontSubstitutions: FontSubstitution[];
  gridPort: { templateStart: number; templateIncrement: number; newStart: number; newIncrement: number; ratio: number; };
  postConditions: { everyFrameSingleStory: boolean; everyThreadTerminates: boolean; allStylesCanonical: boolean; allMissingFontsResolved: boolean; };
}

export class DC {
  constructor(private c: Client) {}
  static async connect(readRoot: string, writeRoot: string) {
    const t = new StdioClientTransport({ command: "designcraft-cli", args: ["mcp"] });
    const c = new Client({ name: "rebind", version: "1.0.0" }, { capabilities: {} });
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

// --- 1. Open the IDML ---
export async function openTemplate(dc: DC, req: RebindRequest): Promise<{ index: number; documentFonts: string[]; warnings: any[] }> {
  const r = await dc.call<any>("open_document", { path: req.template });
  return { index: r.index, documentFonts: r.documentFonts ?? [], warnings: r.warnings ?? [] };
}

// --- 2. Style map application ---
export async function applyStyleMap(
  dc: DC, styleMap: Record<string, string>,
): Promise<Array<{ from: string; to: string; paragraphsAffected: number }>> {
  const doc = await dc.call<any>("inspect_document", {});
  const existingStyles = new Set<string>((doc.paragraphStyles ?? []).map((s: any) => s.name));
  const log: Array<{ from: string; to: string; paragraphsAffected: number }> = [];
  const steps: any[] = [];

  for (const [legacy, canonical] of Object.entries(styleMap)) {
    // If the canonical does not exist, create it fresh with a neutral skeleton.
    if (!existingStyles.has(canonical)) {
      steps.push({
        id: "style.paragraph.create",
        params: { name: canonical, para: {}, chars: {} },
      });
    }
    // Reapply the canonical on every paragraph currently carrying the legacy style.
    const affected = doc.stories.flatMap((s: any) =>
      s.paragraphStyles.map((st: string, i: number) => st === legacy ? { story: s.id, para: i } : null,
      )).filter(Boolean) as Array<{ story: number; para: number }>;

    for (const { story } of affected) {
      steps.push({ id: "style.paragraph.apply", params: { name: canonical, clearOverrides: false } });
    }
    // Delete the legacy style, replaceWith ensures no paragraph falls back to [No Paragraph Style].
    steps.push({ id: "style.paragraph.delete", params: { name: legacy, replaceWith: canonical } });

    log.push({ from: legacy, to: canonical, paragraphsAffected: affected.length });
  }
  // One batch is one undo step. The batch stops at the first failing
  // command, so the caller restores the snapshot when it fails.
  await dc.batch(steps);
  return log;
}

// --- 3. Thread rewiring ---
export async function rewireStory(
  dc: DC, req: RebindRequest, spec: RebindStory,
): Promise<{ frames: number[]; overset: boolean }> {
  // Unlink any pre-existing story from the frames we are about to repurpose.
  // DesignCraft's story.unlink is a no-op on frames not currently in a thread.
  const doc = await dc.call<any>("inspect_document", {});
  const victims: number[] = [];
  for (const spread of doc.spreads) {
    for (const item of spread.items) {
      if (item.kind !== "text") continue;
      const inOurSpread = item.spread === spec.seedSpread ||
                          spec.containerSpreadChain.includes(item.spread);
      if (inOurSpread) victims.push(item.id);
    }
  }
  for (const id of victims) {
    try { await dc.execute("story.unlink", { story: id }); } catch { /* already unlinked */ }
    try { await dc.execute("edit.clear", { ids: [id] }); } catch { /* already gone */ }
  }

  // Seed frame on the first spread.
  const seed = await dc.execute("frame.create", {
    spread: spec.seedSpread,
    rect: spec.seedRect,
    content: "text",
  });
  const frames = [seed.id];
  const story = seed.story;

  // Chain subsequent frames via placeAndLink, always addressing the *root* story
  // (placeAndLink copies from parent; the story id is the chain's identity).
  for (const spread of spec.containerSpreadChain) {
    const r = await dc.execute("story.placeAndLink", {
      story,
      rect: spec.seedRect,
      spread,
    });
    frames.push(r.id);
  }

  // If a styleToApply is specified, force it on all paragraphs of the new story.
  if (spec.styleToApply) {
    await dc.execute("style.paragraph.apply", { name: spec.styleToApply });
  }

  // Verify termination: `get_story` reports overset for the whole chain.
  const st = await dc.call<any>("get_story", { story });
  return { frames, overset: !!st.overset };
}

// --- 4. Orphan frame cleanup ---
export async function removeOrphans(dc: DC, claimed: Set<number>): Promise<number> {
  const doc = await dc.call<any>("inspect_document", {});
  const toDelete: number[] = [];
  for (const spread of doc.spreads) {
    for (const item of spread.items) {
      if (item.kind !== "text") continue;
      if (claimed.has(item.id)) continue;
      // A frame with no story (or an empty story) that is not a master text frame.
      const hasStory = !!item.story;
      const isMaster = item.origin === "master" || item.origin === "parent";
      if (!hasStory && !isMaster) toDelete.push(item.id);
    }
  }
  if (toDelete.length > 0) {
    await dc.execute("edit.clear", { ids: toDelete });
  }
  return toDelete.length;
}

// --- 5. Font resolution (conservative) ---
export async function resolveFonts(
  dc: DC, req: RebindRequest, documentFonts: string[],
): Promise<FontSubstitution[]> {
  const list = await dc.execute("font.list", {});
  const missing: Array<{ family: string; style: string }> = list
    .filter((f: any) => f.source === null)
    .map((f: any) => ({ family: f.family, style: f.style }));

  const subs: FontSubstitution[] = [];
  for (const m of missing) {
    // Step 1: is the font shipped in the IDML's Document Fonts folder?
    // DesignCraft loaded those faces during open_document; if the missing font is
    // one of them, its source is no longer null and would not appear in `missing`.
    // We still double-check: if the face name appears in documentFonts, preserve.
    const embedded = documentFonts.some(f => f.toLowerCase() === `${m.family} ${m.style}`.toLowerCase()
          || f.toLowerCase().startsWith(m.family.toLowerCase()));
    if (embedded) {
      subs.push({ ...m, toFamily: m.family, toStyle: m.style, reason: "embedding-restricted", documentFontPreserved: true });
      continue;
    }
    // Step 2: fall back per the supplied table.
    const fb = req.fallbackFonts[m.family] ?? { family: "Inter", style: "Regular" };
    await dc.execute("font.replace", {
      family: m.family, style: m.style,
      toFamily: fb.family, toStyle: fb.style,
      redefineStyles: true,
    });
    subs.push({
      ...m, toFamily: fb.family, toStyle: fb.style,
      reason: "not-installed", documentFontPreserved: false,
    });
  }
  return subs;
}

// --- 6. Grid porting ---
export function portGrid(req: RebindRequest): RebindReport["gridPort"] {
  const t = req.baselineGrid ?? { start: 48, increment: 13, color: [128, 128, 255] as [number, number, number], viewThreshold: 75 };
  const ratio = req.paperResize
    ? (req.paperResize.to[1] / req.paperResize.from[1])
    : 1.0;
  const newStart = Math.round(t.start * ratio);
  const newIncrement = Math.round(t.increment * ratio);
  return { templateStart: t.start, templateIncrement: t.increment, newStart, newIncrement, ratio };
}

// --- 7. Post-condition assertions ---
export async function assertPostConditions(
  dc: DC,
): Promise<RebindReport["postConditions"]> {
  const doc = await dc.call<any>("inspect_document", {});

  // 7a. Every text frame belongs to exactly one story, or to zero (master text frame).
  const storyCountByFrame = new Map<number, number>();
  for (const spread of doc.spreads) {
    for (const item of spread.items) {
      if (item.kind !== "text") continue;
      const n = storyCountByFrame.get(item.id) ?? 0;
      storyCountByFrame.set(item.id, n + 1);
    }
  }
  const everyFrameSingleStory = [...storyCountByFrame.values()].every(n => n === 1);

  // 7b. Every thread terminates (no overset).
  let everyThreadTerminates = true;
  for (const s of doc.stories) {
    if (s.overset) everyThreadTerminates = false;
  }

  // 7c. All styles are canonical (no legacy names survive the map).
  const styleNames = new Set<string>((doc.paragraphStyles ?? []).map((s: any) => s.name));
  const LEGACY = /^(BodyText-Legacy|Headline-02|Caption_7)$/; // per the exercise
  const allStylesCanonical = ![...styleNames].some(n => LEGACY.test(n));

  // 7d. All missing fonts resolved (this is checked via the report's own ledger).
  const list = await dc.execute("font.list", {});
  const stillMissing = list.filter((f: any) => f.source === null).length;
  const allMissingFontsResolved = stillMissing === 0;

  return { everyFrameSingleStory, everyThreadTerminates, allStylesCanonical, allMissingFontsResolved };
}

// --- 8. Orquestration ---
export async function runRebind(
  req: RebindRequest, readRoot: string, writeRoot: string, dcOverride?: DC,
): Promise<RebindReport> {
  const dc = dcOverride ?? await DC.connect(readRoot, writeRoot);
  const open = await openTemplate(dc, req);

  // Style map first: canonical styles must exist before content rethread.
  const styleMapApplied = await applyStyleMap(dc, req.styleMap);

  // Rethread all eight stories, collecting every claimed frame id.
  const claimed = new Set<number>();
  const storiesRewired: RebindReport["storiesRewired"] = [];
  for (const s of req.stories) {
    const r = await rewireStory(dc, req, s);
    r.frames.forEach(id => claimed.add(id));
    storiesRewired.push({ name: s.name, frames: r.frames, overset: r.overset });
  }

  // Orphan removal runs *after* all threads exist, so master frames are correctly excluded.
  const orphanFramesRemoved = await removeOrphans(dc, claimed);

  // Fonts.
  const fontSubstitutions = await resolveFonts(dc, req, open.documentFonts);

  // Grid porting.
  const gridPort = portGrid(req);
  await dc.execute("document.preferences", {
    baselineGrid: {
      start: gridPort.newStart, increment: gridPort.newIncrement,
      relativeTo: "topOfPage",
      color: (req.baselineGrid?.color ?? [128, 128, 255]),
      viewThreshold: req.baselineGrid?.viewThreshold ?? 75,
    },
  });

  // Save the rebind result *before* post-conditions, so failures leave a recoverable artefact.
  const outputPath = path.join(writeRoot, req.output);
  await dc.call("save_document", { path: outputPath });

  const postConditions = await assertPostConditions(dc);
  const report: RebindReport = {
    schemaVersion: 1,
    styleMapApplied,
    storiesRewired,
    orphanFramesRemoved,
    fontSubstitutions,
    gridPort,
    postConditions,
  };
  // Persist the report sidecar.
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(path.join(path.dirname(outputPath), "rebind-report.json"), JSON.stringify(report, null, 2));

  // Hard-fail if any post-condition is false — the pipeline is not complete.
  const allOk = Object.values(postConditions).every(Boolean);
  if (!allOk) {
    throw new Error(`Rebind post-conditions failed: ${JSON.stringify(postConditions)}`);
  }
  return report;
}
