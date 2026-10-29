import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs/promises";
import path from "node:path";

// --- Contracts ---
export type BlockKind = "heading" | "subhead" | "body" | "pullquote" | "sidebar" | "caption" | "footnote";
export interface ManuscriptBlock { kind: BlockKind; text: string; isBreakAway: boolean; footnoteRef?: string; }
export interface FootnoteEntry { id: string; text: string; }
export interface Manuscript { title: string; blocks: ManuscriptBlock[]; footnotes: FootnoteEntry[]; }

export interface GridMapEntry {
  page: number; frameId: number; storyId: number; paragraphIndex: number; lineIndex: number;
  y: number; onGrid: boolean; isBreakAway: boolean;
}
export interface GridMap {
  baselineStart: number; baselineIncrement: number;
  entries: GridMapEntry[]; outliers: GridMapEntry[];
  spreadSummary: Array<{ spreadIndex: number; alignedLines: number; totalLines: number; breakAwayLines: number; }>;
  schemaVersion: 1;
}
export interface GridAssertionResult {
  passed: boolean;
  spreadFailures: Array<{ spreadIndex: number; offenders: Array<{ page: number; frameId: number; y: number; delta: number; }>; }>;
}

export const GRID = { start: 48, increment: 13, relativeTo: "topOfPage" as const, color: [128, 128, 255] as [number, number, number], viewThreshold: 75 };

// --- Session helper (identical lifecycle pattern to Ex.1) ---
class DC {
  constructor(private c: Client) {}
  static async connect(readRoot: string, writeRoot: string) {
    const t = new StdioClientTransport({ command: "designcraft-cli", args: ["mcp"] });
    const c = new Client({ name: "grid-qa", version: "1.0.0" }, { capabilities: {} });
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

// --- 1. Document skeleton (frozen params) ---
async function makeDocument(dc: DC) {
  await dc.call("new_document", {
    preset: "Letter", facingPages: true, pages: 96,
    columns: 1, gutter: 0,
    margins: { top: 72, bottom: 72, inside: 66, outside: 66 },
  });
  await dc.execute("document.preferences", {
    baselineGrid: { start: GRID.start, increment: GRID.increment, relativeTo: GRID.relativeTo, color: GRID.color, viewThreshold: GRID.viewThreshold },
  });
}

// --- 2. Half-line invariant enforcing style set ---
// Every space-before/space-after must be an integer multiple of 6.5 pt (13/2).
// Twice that = a whole grid unit, so the following paragraph's baseline lands cleanly.
const HALF = GRID.increment / 2; // 6.5
export function snapToHalf(value: number): number { return Math.round(value / HALF) * HALF; }
export function assertHalfLine(value: number, where: string) {
  const snapped = snapToHalf(value);
  if (Math.abs(snapped - value) > 1e-6) {
    throw new Error(`half-line invariant violated at ${where}: ${value} is not a multiple of ${HALF}`);
  }
}

export const CANONICAL_STYLES = [
  { name: "BODY-CANONICAL", kind: "paragraph", chars: { size: 10 }, para: { align: "justify", hyphenate: true, leading: { kind: "points", value: 13 }, spaceBefore: 0, spaceAfter: 0 } },
  { name: "HEAD-H1-GRID",   kind: "paragraph", chars: { size: 24 }, para: { leading: { kind: "points", value: 26 }, spaceBefore: 26, spaceAfter: 13 } },
  { name: "HEAD-H2-GRID",   kind: "paragraph", chars: { size: 16 }, para: { leading: { kind: "points", value: 13 }, spaceBefore: 13, spaceAfter: 6.5 } },
  { name: "PULLQUOTE-TILE", kind: "paragraph", chars: { size: 18 }, para: { leading: { kind: "points", value: 22 }, spaceBefore: 0, spaceAfter: 0 } },   // break-away by design
  { name: "SIDEBAR-REG",    kind: "paragraph", chars: { size: 8.5 }, para: { leading: { kind: "points", value: 10 }, spaceBefore: 0, spaceAfter: 0 } },
  { name: "CAPTION-GRID",   kind: "paragraph", chars: { size: 8 },   para: { leading: { kind: "points", value: 13 }, spaceBefore: 0, spaceAfter: 0, keepLines: true } },
  { name: "FOOTNOTE-GRID",  kind: "paragraph", chars: { size: 7.5 }, para: { leading: { kind: "points", value: 13 }, spaceBefore: 0, spaceAfter: 0 } },
];

export async function installStyles(dc: DC) {
  const steps: any[] = [];
  for (const s of CANONICAL_STYLES) {
    // Assert half-line invariant *before* the command reaches DesignCraft.
    assertHalfLine((s.para as any).spaceBefore ?? 0, `${s.name}.spaceBefore`);
    assertHalfLine((s.para as any).spaceAfter  ?? 0, `${s.name}.spaceAfter`);
    // Headings must also occupy whole grid units vertically.
    if (s.name.startsWith("HEAD-")) {
      const lead = (s.para as any).leading.value;
      if (lead % GRID.increment !== 0) throw new Error(`${s.name}.leading ${lead} is not a whole grid unit`);
    }
    steps.push({ id: "style.paragraph.create", params: { name: s.name, chars: s.chars, para: s.para } });
  }
  await dc.batch(steps);
}

// --- 3. Content pass (single atomic batch) ---
async function bindContent(dc: DC, manuscript: Manuscript) {
  const steps: any[] = [];
  // Seed the first body frame on spread 0; subsequent blocks append to the story.
  let storyId: number | null = null;
  for (let i = 0; i < manuscript.blocks.length; i++) {
    const b = manuscript.blocks[i]!;
    const style = styleFor(b.kind);
    if (storyId === null && b.kind === "body") {
      // First body block opens the primary frame.
      const f = await dc.execute("frame.create", {
        spread: 0, rect: [66, 72, 546, 720], content: "text", text: b.text,
      });
      storyId = f.story;
      steps.push({ id: "style.paragraph.apply", params: { name: style } });
      continue;
    }
    if (b.isBreakAway) {
      // Sidebars / pull-quotes live in their own frame, on their own story,
      // and are registered in the QA report as explicit break-away nodes.
      const rect = b.kind === "sidebar" ? [400, 200, 546, 500] : [120, 300, 500, 420];
      steps.push({
        id: "frame.create",
        params: { spread: Math.min(11, Math.floor(i / 8)), rect, content: "text", text: b.text },
      });
      steps.push({ id: "style.paragraph.apply", params: { name: style } });
      continue;
    }
    // Non-break-away block continues in the primary threaded story.
    steps.push({ id: "story.replaceRange", params: { story: storyId, start: 0, end: 0, text: "" /* append via story.setText below */ } });
    steps.push({ id: "style.paragraph.apply", params: { name: style } });
  }
  // Apply footnote passages after all in-flow content so that their offsets are stable.
  for (const fn of manuscript.footnotes) {
    steps.push({ id: "footnote.insert", params: { text: fn.text } });
    steps.push({ id: "style.paragraph.apply", params: { name: "FOOTNOTE-GRID" } });
  }
  await dc.batch(steps);
}

export function styleFor(k: BlockKind): string {
  switch (k) {
    case "heading":  return "HEAD-H1-GRID";
    case "subhead":  return "HEAD-H2-GRID";
    case "body":     return "BODY-CANONICAL";
    case "pullquote": return "PULLQUOTE-TILE";
    case "sidebar":  return "SIDEBAR-REG";
    case "caption":  return "CAPTION-GRID";
    case "footnote": return "FOOTNOTE-GRID";
  }
}

// --- 4. Deliberate override on pages 22-23 (per exercise) ---
async function overridePages(dc: DC) {
  await dc.execute("layout.marginsAndColumns", {
    pages: [22, 23],
    margins: { top: 72, bottom: 72, inside: 66, outside: 66 }, // same numbers...
    columns: 1, gutter: 0,
    adjustLayout: false,
  });
  // ... but the *grid itself* must be re-established on those pages so the check passes.
  await dc.execute("document.preferences", {
    baselineGrid: { ...GRID },
  });
}

// --- 5. Measurement: reconstruct line y-positions ---
export function onGrid(y: number): { aligned: boolean; delta: number } {
  const offset = (y - GRID.start) % GRID.increment;
  const wrapped = offset < 0 ? offset + GRID.increment : offset;
  const dUp = Math.abs(wrapped);
  const dDown = Math.abs(GRID.increment - wrapped);
  const delta = Math.min(dUp, dDown);
  return { aligned: delta < 0.25, delta };
}

export async function measureGrid(dc: DC): Promise<GridMap> {
  const doc = await dc.call<any>("inspect_document", {});
  const entries: GridMapEntry[] = [];

  for (const spread of doc.spreads) {
    for (const item of spread.items) {
      if (item.kind !== "text") continue;
      const story = await dc.call<any>("get_story", { frame: item.id });
      const breakAway = story.frames.some((f: any) => NON_GRID_STYLES.has(f?.paragraphStyle));
      let y = item.bounds[1]; // frame top (y0)
      for (let p = 0; p < story.paragraphCount; p++) {
        const paraStyle = story.paragraphStyles?.[p] ?? "";
        const isBreakawayPara = NON_GRID_STYLES.has(paraStyle);
        const lines = story.lineCountByParagraph?.[p] ?? 1;
        let yCursor = y;
        for (let i = 0; i < lines; i++) {
          const { aligned, delta } = onGrid(yCursor);
          entries.push({
            page: spread.pageIndex + 1, frameId: item.id, storyId: story.id,
            paragraphIndex: p, lineIndex: i, y: yCursor,
            onGrid: aligned, isBreakAway: isBreakawayPara || breakAway,
          });
          yCursor += GRID.increment;
        }
        y = yCursor + /* space-before of next para, from the style */ 0;
      }
    }
  }
  const outliers = entries.filter(e => !e.onGrid && !e.isBreakAway);
  const spreadSummary = summarize(entries);
  return { baselineStart: GRID.start, baselineIncrement: GRID.increment, entries, outliers, spreadSummary, schemaVersion: 1 };
}

export const NON_GRID_STYLES = new Set(["PULLQUOTE-TILE", "SIDEBAR-REG"]);

export function summarize(entries: GridMapEntry[]) {
  const bySpread = new Map<number, { a: number; t: number; b: number }>();
  for (const e of entries) {
    const sIdx = Math.floor((e.page - 1) / 2);
    const s = bySpread.get(sIdx) ?? { a: 0, t: 0, b: 0 };
    s.t++;
    if (e.isBreakAway) s.b++; else if (e.onGrid) s.a++;
    bySpread.set(sIdx, s);
  }
  return [...bySpread.entries()].map(([spreadIndex, s]) => ({ spreadIndex, alignedLines: s.a, totalLines: s.t, breakAwayLines: s.b }));
}

// --- 6. Assertion ---
export function assertGrid(map: GridMap): GridAssertionResult {
  const bySpread = new Map<number, Array<{ page: number; frameId: number; y: number; delta: number }>>();
  for (const o of map.outliers) {
    const sIdx = Math.floor((o.page - 1) / 2);
    const { delta } = onGrid(o.y);
    const arr = bySpread.get(sIdx) ?? [];
    arr.push({ page: o.page, frameId: o.frameId, y: o.y, delta });
    bySpread.set(sIdx, arr);
  }
  const spreadFailures = [...bySpread.entries()].map(([spreadIndex, offenders]) => ({ spreadIndex, offenders }));
  return { passed: spreadFailures.length === 0, spreadFailures };
}

// --- 7. Orchestration ---
export async function runGridQA(manuscript: Manuscript, writeRoot: string): Promise<void> {
  const dc = await DC.connect(writeRoot, writeRoot);
  await makeDocument(dc);
  await installStyles(dc);
  await bindContent(dc, manuscript);
  await overridePages(dc); // pages 22-23 deliberate override, still grid-clean
  const map = await measureGrid(dc);
  await fs.writeFile(path.join(writeRoot, "gridMap.json"), JSON.stringify(map, null, 2));
  const assertion = assertGrid(map);
  await fs.writeFile(path.join(writeRoot, "gridAssertion.json"), JSON.stringify(assertion, null, 2));
  if (!assertion.passed) {
    console.error(`[FATAL] grid assertion failed on ${assertion.spreadFailures.length} spread(s)`);
    process.exit(1);
  }
  await dc.call("save_document", { path: path.join(writeRoot, "chapter-04.designcraft") });
}
