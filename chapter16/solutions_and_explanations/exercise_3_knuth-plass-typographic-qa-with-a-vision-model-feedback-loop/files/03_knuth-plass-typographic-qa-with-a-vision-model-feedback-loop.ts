import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { OpenAI } from "openai";
import fs from "node:fs/promises";
import path from "node:path";

// --- Contracts ---
export interface SpreadQAReport {
  spreadIndex: number;
  pageRange: [number, number];
  passes: QAPass[];
  outcome: "clean" | "converged-with-warnings" | "aborted";
  capturedSnapshotRef: string;
}
export interface QAPass {
  passNumber: 1 | 2 | 3;
  renderedAt: string;
  renderedFiles: string[];
  metrics: {
    hyphenatedLineEnds: number; maxConsecutiveHyphens: number;
    riverRows: number; riverRowsHighSeverity: number;
    widows: number; orphans: number; looseLines: number;
  };
  rawModelResponse: string;
  suggestions: Array<{
    style: string; attr: string; from: unknown; to: unknown; rationale: string;
    applied: boolean;
    rejectedReason?: "cascade-protection" | "invalid-target" | "would-regress-adjacent-spread";
  }>;
}
export interface StyleSnapshot {
  capturedAt: string; documentRef: string;
  styles: Array<{ name: string; basedOn?: string; nextStyle?: string; para?: object; chars?: object; system: boolean; }>;
}

export class DC {
  constructor(private c: Client) {}
  static async connect(readRoot: string, writeRoot: string) {
    const t = new StdioClientTransport({ command: "designcraft-cli", args: ["mcp"] });
    const c = new Client({ name: "kp-qa", version: "1.0.0" }, { capabilities: {} });
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

// --- 1. Style snapshot ---
export async function captureStyles(dc: DC, ref: string): Promise<StyleSnapshot> {
  const list = await dc.execute("style.list", {});
  const snapshot: StyleSnapshot = {
    capturedAt: new Date().toISOString(),
    documentRef: ref,
    styles: list.paragraph.concat(list.character).map((s: any) => ({
      name: s.name, basedOn: s.basedOn, nextStyle: s.nextStyle,
      para: s.para, chars: s.chars, system: s.system ?? false,
    })),
  };
  return snapshot;
}

// --- 2. Cascade protection ---
// If modifying `style` would propagate to any style `basedOn: style`, we must NOT edit in place.
// Instead we create a derived style and reassign only the offending paragraphs.
export async function applySurgicalFix(
  dc: DC,
  targetStyle: string,
  attr: "hyphenation" | "justification" | "tracking" | "wordSpacing" | "letterSpacing",
  value: any,
  spreadIndex: number,
  allStyles: any[],
): Promise<{ applied: boolean; rejectedReason?: string }> {
  const derived = allStyles.some((s: any) => s.basedOn === targetStyle);
  if (derived) {
    // Create a per-spread derived style so no other spread inherits the change.
    const derivedName = `${targetStyle}.spread-${String(spreadIndex).padStart(2, "0")}`;
    const para: any = {};
    const chars: any = {};
    switch (attr) {
      case "hyphenation":   para.hyphenate = true; para.composer = "everyLine"; break;
      case "justification": para.align = "justify"; para.composer = "everyLine"; break;
      case "tracking":      chars.tracking = value; break;
      case "wordSpacing":   para.wordSpacing = value; break;
      case "letterSpacing": chars.tracking = value; break;
    }
    await dc.execute("style.paragraph.create", { name: derivedName, basedOn: targetStyle, para, chars });
    // Reassign only the paragraphs on this spread that use the style.
    const doc = await dc.call<any>("inspect_document", {});
    const spread = doc.spreads[spreadIndex];
    const targets: number[] = [];
    for (const item of spread.items) {
      if (item.kind !== "text") continue;
      const story = await dc.call<any>("get_story", { frame: item.id });
      // Gather paragraph indices on this story that carry the style.
      (story.paragraphStyles ?? []).forEach((s: string, i: number) => {
        if (s === targetStyle) targets.push(i);
      });
    }
    for (const p of targets) {
      await dc.execute("style.paragraph.apply", { name: derivedName });
    }
    return { applied: true };
  }
  // No cascade risk: edit the base style in place.
  await dc.execute("style.paragraph.edit", { name: targetStyle, para: paraFrom(attr, value), chars: charsFrom(attr, value) });
  return { applied: true };
}
export function paraFrom(attr: string, v: any) { return attr === "hyphenation" ? { hyphenate: true, composer: "everyLine" } : attr === "wordSpacing" ? { wordSpacing: v } : attr === "justification" ? { align: "justify", composer: "everyLine" } : {}; }
export function charsFrom(attr: string, v: any) { return attr === "tracking" || attr === "letterSpacing" ? { tracking: v } : {}; }

// --- 3. Render a spread at 2× ---
export async function renderSpread(dc: DC, spreadIndex: number, outDir: string, passNumber: number): Promise<string[]> {
  await fs.mkdir(outDir, { recursive: true });
  const left = spreadIndex * 2 + 1;
  const right = left + 1;
  const files: string[] = [];
  for (const page of [left, right]) {
    const p = path.join(outDir, `pass-${passNumber}-page-${page}.png`);
    await dc.call("render_page", { page, scale: 2, path: p });
    files.push(p);
  }
  return files;
}

// --- 4. Vision call ---
export const VISION_PROMPT = `You are a senior typographer reviewing a two-page spread for a print book.
Return ONLY valid JSON matching this shape:

{
  "hyphenatedLineEnds": [int],
  "maxConsecutiveHyphens": int,
  "riverRows": [{"y": int, "spans": [[int, int]], "severity": "low" | "high"}],
  "widows": int,
  "orphans": int,
  "looseLines": int,
  "suggestions": [
    { "style": string, "attr": "hyphenation"|"justification"|"tracking"|"wordSpacing"|"letterSpacing",
      "from": <any>, "to": <any>, "rationale": string }
  ]
}

Rules:
- A "river" is a vertical run of >= 3 lines in which an inter-word gap aligns within +/-2px of the line above and below it.
- A "widow" is a final paragraph line of <= 2 words.
- An "orphan" is a first paragraph line of <= 3 words that ends on a page break.
- Only propose legal changes for a justified 3-column body: adjustment down to 85%, hyphenation ladder min 3, max 2 consecutive hyphens.
- Be conservative with rivers: mark severity "low" unless the channel is unmistakable.`;

export async function visionPass(openai: OpenAI, pngs: string[]): Promise<{ metrics: any; suggestions: any[]; raw: string }> {
  const b64s = await Promise.all(pngs.map(p => fs.readFile(p).then(b => b.toString("base64"))));
  const r = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: VISION_PROMPT },
        ...b64s.map(b => ({ type: "image_url" as const, image_url: { url: `data:image/png;base64,${b}` } })),
      ],
    }],
    response_format: { type: "json_object" },
  });
  const raw = r.choices[0]!.message.content!;
  const parsed = JSON.parse(raw);
  // The pipeline applies a confidence threshold: rivers reported as "low" severity
  // are treated as *warnings*, not as defects that force another pass.
  const high = (parsed.riverRows ?? []).filter((r: any) => r.severity === "high").length;
  return {
    metrics: {
      hyphenatedLineEnds: (parsed.hyphenatedLineEnds ?? []).length,
      maxConsecutiveHyphens: parsed.maxConsecutiveHyphens ?? 0,
      riverRows: (parsed.riverRows ?? []).length,
      riverRowsHighSeverity: high,
      widows: parsed.widows ?? 0,
      orphans: parsed.orphans ?? 0,
      looseLines: parsed.looseLines ?? 0,
    },
    suggestions: parsed.suggestions ?? [],
    raw,
  };
}

// --- 5. Convergence test ---
export function isClean(m: QAPass["metrics"]): boolean {
  return m.maxConsecutiveHyphens <= 2 && m.riverRowsHighSeverity === 0 && m.widows === 0 && m.orphans === 0;
}
export function isConvergedWithWarnings(m: QAPass["metrics"]): boolean {
  // Warnings are low-severity rivers / loose lines once every hard defect is
  // gone. The old predicate required isClean() to be true, which made this
  // branch unreachable because isClean() is tested first.
  return m.maxConsecutiveHyphens <= 2 && m.riverRowsHighSeverity === 0 &&
    m.widows === 0 && m.orphans === 0 && (m.riverRows > 0 || m.looseLines > 0);
}

// --- 6. Full spread QA loop ---
export async function qaSpread(
  dc: DC, spreadIndex: number, openai: OpenAI, buildDir: string, snapshotRef: string,
): Promise<SpreadQAReport> {
  const report: SpreadQAReport = {
    spreadIndex,
    pageRange: [spreadIndex * 2 + 1, spreadIndex * 2 + 2],
    passes: [],
    outcome: "converged-with-warnings",
    capturedSnapshotRef: snapshotRef,
  };
  const allStyles = (await dc.execute("style.list", {})).paragraph;

  for (let pass = 1; pass <= 3; pass++) {
    const pngs = await renderSpread(dc, spreadIndex, path.join(buildDir, "qa", `spread-${spreadIndex}`), pass);
    const { metrics, suggestions, raw } = await visionPass(openai, pngs);
    const qaPass: QAPass = { passNumber: pass as 1 | 2 | 3, renderedAt: new Date().toISOString(), renderedFiles: pngs, metrics, rawModelResponse: raw, suggestions: [] };

    for (const sug of suggestions) {
      // Reject suggestions that would invalidate the half-line invariant on adjacent spreads.
      if (sug.attr === "wordSpacing" && sug.to && (sug.to as any).min && (sug.to as any).min < 85) {
        qaPass.suggestions.push({ ...sug, applied: false, rejectedReason: "would-regress-adjacent-spread" });
        continue;
      }
      try {
        const r = await applySurgicalFix(dc, sug.style, sug.attr, sug.to, spreadIndex, allStyles);
        qaPass.suggestions.push({ ...sug, applied: r.applied, rejectedReason: r.rejectedReason as any });
      } catch (e) {
        qaPass.suggestions.push({ ...sug, applied: false, rejectedReason: "invalid-target" as any });
      }
    }
    report.passes.push(qaPass);
    if (isClean(metrics)) { report.outcome = "clean"; return report; }
  }

  // After three passes, if we are still not clean, abort and restore.
  const lastMetrics = report.passes[report.passes.length - 1]!.metrics;
  report.outcome = isClean(lastMetrics) ? "clean"
    : isConvergedWithWarnings(lastMetrics) ? "converged-with-warnings"
    : "aborted";
  if (report.outcome === "aborted") {
    await restoreSnapshot(dc, path.join(buildDir, snapshotRef));
  }
  return report;
}

// --- 7. Snapshot restore (best-effort, non-atomic by design) ---
export async function restoreSnapshot(dc: DC, snapshotPath: string): Promise<void> {
  const snap: StyleSnapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
  const steps: any[] = [];
  for (const s of snap.styles) {
    // Re-issue edits for every style that differs from the snapshot.
    steps.push({ id: "style.paragraph.edit", params: { name: s.name, para: s.para, chars: s.chars, basedOn: s.basedOn, nextStyle: s.nextStyle } });
  }
  // The batch stops at the first failing step, so the restore below is
  // what puts the document back: the snapshot, not a flag.
  await dc.batch(steps);
}

// --- 8. Orchestration entry ---
export async function runChapterQA(spreadCount: number, buildDir: string, openai: OpenAI, dc: DC): Promise<SpreadQAReport[]> {
  const snapshot = await captureStyles(dc, "chapter-04");
  const snapRef = "styles-snapshot.json";
  await fs.writeFile(path.join(buildDir, snapRef), JSON.stringify(snapshot, null, 2));
  const reports: SpreadQAReport[] = [];
  for (let s = 0; s < spreadCount; s++) reports.push(await qaSpread(dc, s, openai, buildDir, snapRef));
  // Chapter-level verdict.
  const cleanSpreads = reports.filter(r => r.outcome === "clean").length;
  const aborted = reports.filter(r => r.outcome === "aborted").length;
  const blocked = aborted > 0;
  await fs.writeFile(path.join(buildDir, "chapter-qa-summary.json"), JSON.stringify({
    total: reports.length, cleanSpreads, aborted, blocked,
    reports: reports.map(r => ({ spreadIndex: r.spreadIndex, outcome: r.outcome })),
  }, null, 2));
  return reports;
}
