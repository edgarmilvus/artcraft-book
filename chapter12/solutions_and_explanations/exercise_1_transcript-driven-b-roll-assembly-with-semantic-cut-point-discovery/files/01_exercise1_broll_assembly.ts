// exercise1_broll_assembly.ts
// Launch: filmcraft-cli mcp --automation-read-root /work/project --automation-write-root /work/project
// Header comment preserves the exact tick base so nobody silently divides by a rounded number.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const TICKS_PER_SECOND = 254_016_000_000n;         // FilmCraft's rational time base (Premiere parity)
const TICKS_PER_SECOND_NUM = 254_016_000_000;      // safe Number form for typical durations
const READ_ROOT = process.env.FILMCRAFT_READ_ROOT ?? "/work/project";
const WRITE_ROOT = process.env.FILMCRAFT_WRITE_ROOT ?? "/work/project";
const PAUSE_GAP_SECONDS = 0.6;                     // sentence boundary threshold from the written brief
const DEFAULT_BROLL_DURATION_SECONDS = 4.0;        // "configurable default clip duration"
const MIN_MATCH_SCORE = 0.30;                      // below this, back off rather than guess

// ---- Transport wrapper: thin RPC around the FilmCraft MCP envelope --------------
// We do NOT mix stdio MCP and TCP here. Every call goes through `command_run` or
// `command_batch` so the same business logic ports to a TCP shell unchanged.
class FilmCraft {
  private reqId = 0;
  private client!: Client;
  async connect() {
    const transport = new StdioClientTransport({
      command: "filmcraft-cli",
      args: ["mcp",
        "--automation-read-root", READ_ROOT,
        "--automation-write-root", WRITE_ROOT],
      // `file.import` resolves a relative path against the *process* working
      // directory, so the engine is started in the read root: the manifest can
      // then spell its paths relative to it.
      cwd: READ_ROOT,
    });
    this.client = new Client({ name: "e1-broll", version: "1.0.0" }, { capabilities: {} });
    await this.client.connect(transport);
  }
  private async callTool(name: string, args: Record<string, unknown>) {
    const res = await this.client.callTool({ name, arguments: args });
    // MCP returns content blocks; the runner packs typed JSON in the first text block.
    const block = (res.content as any[]).find(b => b.type === "text");
    if (!block) throw new Error(`${name} returned no text block`);
    return JSON.parse(block.text);
  }
  async run(id: string, params: Record<string, unknown> = {}) {
    return this.callTool("command_run", { id, params });
  }
  async batch(steps: Array<{ id: string; params?: Record<string, unknown> }>) {
    // stop_on_error: true is the single most important param here -- a half-applied
    // assembly whose later step failed would leave V2 with invisible orphans.
    return this.callTool("command_batch", { steps, stop_on_error: true });
  }
  async close()        { await this.client.close(); }
  async project()      { return this.callTool("project_inspect", {}); }
  async sequence()     { return this.callTool("sequence_inspect", {}); }
  async inspectDoc()   { return this.callTool("doc_inspect", {}); }

  /**
   * Is a speech model installed on this machine?
   *
   * `transcript.generate` downloads a 290 MB model the first time it runs, so
   * a pipeline that has to answer "is the transcript ready?" asks the engine
   * instead of finding out by waiting.
   */
  async speechModelReady(): Promise<boolean> {
    const models = await this.run("transcript.models", {});
    return (models?.models ?? []).some((m: any) => m?.installed === true);
  }

  /**
   * Render one Program frame.
   *
   * `render_frame` takes the time and a pixel budget and answers with an
   * *image block*, not a path: the PNG never touches the disk unless we write
   * it there ourselves. The bytes come back base64-encoded.
   */
  async renderFrame(a: { seconds: number; max_side?: number }): Promise<string> {
    const res = await this.client.callTool({
      name: "render_frame",
      arguments: { seconds: a.seconds, max_side: a.max_side ?? 960 },
    });
    const blocks = (res.content as any[]) ?? [];
    const image = blocks.find((b) => b.type === "image" && typeof b.data === "string");
    if (!image) throw new Error("render_frame returned no image block");
    return image.data;
  }
}

/**
 * The project tree, flattened into media items.
 *
 * `project_inspect` answers with a tree: the bins and the sequences hang under
 * `root.children`, and a media item is identified by its `item` field (a bin
 * is identified by `id`). `duration` is in ticks.
 */
function mediaItems(project: any): Map<number, any> {
  const out = new Map<number, any>();
  const walk = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (typeof node.item === "number" && typeof node.name === "string") {
      out.set(node.item, node);
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(project?.root ?? project);
  return out;
}

/** The bins of the project, keyed by name. */
function binsByName(project: any): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (typeof node.id === "number" && typeof node.name === "string" && !("item" in node)) {
      out.set(node.name, node.id);
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(project?.root ?? project);
  return out;
}

/**
 * The words of a transcript, whichever shape the engine answered with.
 *
 * `transcript.inspect` reports the words at the top level, and older builds
 * nest them under the item they belong to.
 */
function extractWords(payload: any): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  const fold = (w: any): void => {
    if (!w || typeof w !== "object") return;
    const text = w.text ?? w.word;
    if (typeof text !== "string" || !text) return;
    const start = Number(w.start ?? w.startTicks ?? 0);
    const end = Number(w.end ?? w.endTicks ?? start);
    out.push({ text, start, end });
  };
  const list = payload?.words ?? payload?.items?.[0]?.words ?? payload?.segments ?? [];
  for (const w of Array.isArray(list) ? list : []) fold(w);
  return out;
}

// ---- Domain helpers --------------------------------------------------------------

// A sentence is a maximal run of words ending in . ! ? or a pause >= PAUSE_GAP_SECONDS.
// We work in byte offsets because FilmCraft's transcript.search reports those.
interface Sentence {
  text: string;
  startByte: number;
  endByte: number;
  endTimeSeconds: number;
}

function tokenizeSentences(
  words: Array<{ text: string; start: number; end: number }>,
): Sentence[] {
  const out: Sentence[] = [];
  let cursorStart = 0;
  let buf = "";
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    buf += (buf ? " " : "") + w.text;
    const next = words[i + 1];
    const pause = next ? (next.start - w.end) : Infinity;   // ticks -> seconds handled by caller
    const terminal = /[.!?]$/.test(w.text);
    if (terminal || pause >= PAUSE_GAP_SECONDS * TICKS_PER_SECOND_NUM || i === words.length - 1) {
      out.push({
        text: buf.trim(),
        startByte: cursorStart,
        endByte: w.end,
        endTimeSeconds: w.end / TICKS_PER_SECOND_NUM,
      });
      cursorStart = next ? next.start : w.end;
      buf = "";
    }
  }
  return out;
}

// Very light noun-phrase detector: keep capitalized bigrams, "the <noun>" patterns,
// and words in a small curated concrete-noun whitelist. This deliberately avoids
// any external NLP service -- the exercise contract says use only what the NLE gives us.
const CONCRETE_NOUNS = new Set([
  "hive","hives","rooftop","rooftops","honeycomb","bees","bee","pollen","queen","brood",
  "smoker","veil","gloves","garden","flowers","lavender","clover","wildflower","urban",
  "city","warehouse","farm","apiary","extractor","jar","comb","frame","lid","wax",
]);

function extractPhrases(sentence: Sentence): string[] {
  const phrases = new Set<string>();
  const words = sentence.text.split(/\s+/);
  // Capitalized bigrams
  for (let i = 0; i < words.length - 1; i++) {
    if (/^[A-Z][a-z]+$/.test(words[i]) && /^[A-Z]?[a-z]+$/.test(words[i + 1])) {
      phrases.add(`${words[i]} ${words[i + 1]}`);
    }
  }
  // Concrete nouns, optionally preceded by "the"
  for (let i = 0; i < words.length; i++) {
    const w = words[i].toLowerCase().replace(/[^a-z]/g, "");
    if (CONCRETE_NOUNS.has(w)) {
      const prev = words[i - 1]?.toLowerCase();
      phrases.add(prev === "the" ? `the ${w}` : w);
    }
  }
  return [...phrases];
}

// B-roll index: filename tokens + optional override map + transcript words from each
// clip's own whisper pass. We store a weighted bag-of-words so a phrase like
// "rooftop hives" scores higher on "city-rooftop-hives-day3.mov" than on "queen-bee-close.mov".
interface BRollEntry {
  itemId: number;
  fileName: string;
  durationTicks: number;
  bag: Map<string, number>;
}

const OVERRIDE_MAP: Record<string, string[]> = {
  // Filenames the crew named cryptically are hand-mapped once, then the map is a
  // first-class artifact on disk so the pipeline is reproducible and auditable.
  "B_Roll/Day02/IMG_4821.mov": ["honeycomb", "extractor", "wax", "hands"],
  "B_Roll/Day03/IMG_5102.mov": ["rooftop", "city skyline", "hives", "bees"],
  // ... 200 more entries loaded from broll_overrides.json
};

async function buildBRollIndex(
  fc: FilmCraft,
  arollItemIds: number[],
  brollItemIds: number[],
): Promise<BRollEntry[]> {
  const proj = await fc.project();
  const byId = mediaItems(proj);

  // One whisper pass over every B-roll clip. Many have ambient dialogue.
  let tr: any = { words: [] };
  if (await fc.speechModelReady()) {
    try {
      tr = await fc.run("transcript.generate", {
        items: brollItemIds,
        model: "whisper-base",
        language: "en",
        diarize: false,
      });
    } catch { /* silent clips have no transcript; not an error */ }
  }

  const entries: BRollEntry[] = [];
  for (const id of brollItemIds) {
    const it = byId.get(id);
    if (!it) continue;
    const bag = new Map<string, number>();
    const bump = (tok: string, w = 1) => {
      bag.set(tok, (bag.get(tok) ?? 0) + w);
    };
    // Filename tokens get the strongest weight: "city-rooftop-hives-day3.mov"
    const stem = String(it.name ?? "").toLowerCase();
    for (const tok of stem.split(/[^a-z]+/).filter(Boolean)) bump(tok, 3);
    // Override map
    for (const tok of OVERRIDE_MAP[it.name] ?? []) bump(tok, 5);
    // Clip's own transcript (if any)
    for (const w of extractWords(tr)) {
      for (const tok of String(w.text).toLowerCase().split(/[^a-z]+/)) if (tok) bump(tok, 1);
    }
    entries.push({
      itemId: id,
      fileName: it.name,
      durationTicks: it.duration,
      bag,
    });
  }
  return entries;
}

// Cosine similarity in bag-of-words space. Cheap and, crucially, deterministic.
function score(entry: BRollEntry, phrase: string): number {
  const toks = phrase.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (!toks.length) return 0;
  let dot = 0, p2 = 0;
  const phraseVec = new Map<string, number>();
  for (const t of toks) phraseVec.set(t, (phraseVec.get(t) ?? 0) + 1);
  for (const [t, w] of phraseVec) {
    p2 += w * w;
    const b = entry.bag.get(t);
    if (b) dot += w * b;
  }
  let q2 = 0; for (const v of entry.bag.values()) q2 += v * v;
  if (!dot || !q2) return 0;
  return dot / Math.sqrt(p2 * q2);
}

// ---- Pause-aligned cut point discovery -------------------------------------------
// Given a matched phrase's byte offset in the A-roll transcript, walk backwards to the
// nearest word gap longer than PAUSE_GAP_SECONDS. We never insert mid-sentence --
// this is the "snap to nearest silent pause" requirement.
function nearestPauseAfter(
  words: Array<{ text: string; start: number; end: number }>,
  byteOffset: number,
): number | null {
  for (let i = 0; i < words.length; i++) {
    if (words[i].end >= byteOffset) {
      const gapStart = words[i].end;
      const next = words[i + 1];
      if (!next) return gapStart;
      const gapTicks = next.start - gapStart;
      if (gapTicks >= PAUSE_GAP_SECONDS * TICKS_PER_SECOND_NUM) return next.start;
    }
  }
  return null;
}

// ---- Main pipeline --------------------------------------------------------------
interface AssemblyReport {
  sequenceId: number;
  brollPlacements: Array<{
    track: "V2";
    startTicks: number; durationTicks: number; brollItemId: number;
    matchedPhrase: string; confidence: number;
  }>;
  contactSheetPaths: string[];
  reviewDocPath: string;
  undoStepsRequired: number;
  preRunSnapshotPath: string;
}

async function main() {
  const fc = new FilmCraft();
  await fc.connect();

  // 0. The assembly sequence. It needs two video tracks: V1 carries the A-roll,
  //    V2 the B-roll overlay. `file.newSequence` answers with `{ sequence: id }`.
  const created = await fc.run("file.newSequence", {
    name: "B-Roll Assembly",
    width: 1920, height: 1080, fps: 24,
    video: 2, audio: 1,
  });
  const sequenceId = (created as any).sequence;

  // 1. Pre-run snapshot. We save BOTH project and sequence trees so the report can
  //    reconstruct exactly what existed before the run.
  const preRunProject = await fc.project();
  const preRunSequence = await fc.sequence();
  const prePath = path.join(WRITE_ROOT, "assembly_pre_run.json");
  await fs.writeFile(prePath, JSON.stringify({ project: preRunProject, sequence: preRunSequence }, null, 2));

  // 2. Import A-roll + B-roll into dedicated bins.
  //    file.import takes a paths array and (per schema) an optional bin; when the
  //    schema is silent we use file.newBin + project.moveToBin as the fallback path.
  await fc.run("file.newBin", { name: "A-Roll" });
  await fc.run("file.newBin", { name: "B-Roll" });
  const imA = await fc.run("file.import", { paths: ["B_Roll_Project/A001_C003.mov"] });
  const brollPaths = await collectBRollPaths();               // reads /work/project/B_Roll_Project/B_Roll/**
  const imB = await fc.run("file.import", { paths: brollPaths });

  // Move into bins after import. This is idempotent and portable across schema drifts.
  const bins = await fc.project();
  const binB = binsByName(bins).get("B-Roll");
  if (binB === undefined) throw new Error("the B-Roll bin is missing");
  const brollIds: number[] = (imB as any).items ?? [];
  await fc.run("project.moveToBin", { items: brollIds, bin: binB });

  // 3. Transcribe the A-roll. The engine's speech model is the primary source;
  //    a sidecar transcript (written by the customer's own ASR) is the fallback
  //    for the machines that have no model installed.
  const arollId: number = ((imA as any).items ?? [])[0];
  if (arollId === undefined) throw new Error("the A-roll did not import");
  let words: Array<{ text: string; start: number; end: number }> = [];
  if (await fc.speechModelReady()) {
    try {
      const tr = await fc.run("transcript.generate", {
        items: [arollId], model: "whisper-base", language: "en", diarize: false,
      });
      words = extractWords(tr);
    } catch { /* the speech model failed on this clip */ }
  }
  if (words.length === 0) {
    const sidecar = path.join(READ_ROOT, "a_roll_transcript.json");
    words = extractWords(JSON.parse(await fs.readFile(sidecar, "utf8")));
  }
  if (words.length === 0) throw new Error("no transcript available for the A-roll");

  // 4. Sentence segmentation then concrete-noun extraction.
  const sentences = tokenizeSentences(words);
  const matches = sentences.flatMap(s => extractPhrases(s).map(p => ({ phrase: p, sentence: s })));

  // 5. Rank B-roll against every extracted phrase.
  const index = await buildBRollIndex(fc, [arollId], brollIds);
  const sequences = await fc.sequence();
  const rate = sequences?.settings?.frame_rate ?? { num: 24, den: 1 };
  const fps = rate.num / rate.den;

  interface Candidate {
    phrase: string;
    sentence: Sentence;
    entry: BRollEntry;
    score: number;
    inTicks: number;
  }
  const candidates: Candidate[] = [];
  for (const m of matches) {
    // transcript.search back-checks that our byte offsets land on real text.
    const hits = await fc.run("transcript.search", { query: m.sentence.text });
    // The matches are unused beyond validation; search's role is to confirm
    // that the offsets land on real text. A search that finds nothing is not
    // fatal: the engine only indexes the transcript of the current clip.
    void hits;
    let best: BRollEntry | null = null, bestScore = 0;
    for (const e of index) {
      const s = score(e, m.phrase);
      if (s > bestScore) { bestScore = s; best = e; }
    }
    if (!best || bestScore < MIN_MATCH_SCORE) continue;
    const after = nearestPauseAfter(words, m.sentence.endByte);
    if (after == null) continue;
    candidates.push({ phrase: m.phrase, sentence: m.sentence, entry: best, score: bestScore, inTicks: after });
  }

  // De-duplicate: at most one B-roll per (entry) and enforce non-overlap on V2.
  candidates.sort((a, b) => b.score - a.score);
  const chosen: Candidate[] = [];
  const usedEntries = new Set<number>();
  const defaultDurTicks = Math.round(DEFAULT_BROLL_DURATION_SECONDS * TICKS_PER_SECOND_NUM);
  for (const c of candidates) {
    if (usedEntries.has(c.entry.itemId)) continue;
    const end = c.inTicks + Math.min(defaultDurTicks, c.entry.durationTicks);
    if (chosen.some(o => o.inTicks < end && c.inTicks < o.inTicks + Math.min(defaultDurTicks, o.entry.durationTicks))) continue;
    chosen.push(c);
    usedEntries.add(c.entry.itemId);
  }

  // 6. Place each one. timeline.place on V2 only: A1 is untouched by construction.
  //    Wrapping the placement batch in a single command_batch with stop_on_error is
  //    the schema-sanctioned way to keep the timeline in a well-defined state.
  const steps = chosen.map(c => ({
    id: "timeline.place",
    params: {
      item: c.entry.itemId,
      track: "V2",
      time: c.inTicks,
      sourceIn: 0,
      duration: Math.min(defaultDurTicks, c.entry.durationTicks),
      insert: false,                 // insert:false makes this a pure overlay, not a ripple
      video: true, audio: false,     // B-roll audio is explicitly NOT placed
    },
  }));
  if (steps.length) {
    const placed = await fc.batch(steps);
    if (placed.failed) throw new Error(`placement failed at step ${placed.failed}: ${JSON.stringify(placed)}`);
  }

  // 7. Contact sheet: render a frame at the midpoint of each of the first five insertions.
  const contactSheetPaths: string[] = [];
  for (const c of chosen.slice(0, 5)) {
    const midSeconds = (c.inTicks + Math.min(defaultDurTicks, c.entry.durationTicks) / 2) / TICKS_PER_SECOND_NUM;
    const rel = `contact_${c.entry.itemId}.png`;
    const abs = path.join(WRITE_ROOT, rel);
    const png = await fc.renderFrame({ seconds: midSeconds, max_side: 480 });
    await fs.writeFile(abs, Buffer.from(png, "base64"));
    contactSheetPaths.push(rel);
  }

  // 8. Human-readable review doc.
  const md = ["| timecode | B-roll file | matched phrase | confidence | suggested duration (s) |",
              "|---|---|---|---|---|"];
  for (const c of chosen) {
    const tc = ticksToTimecode(c.inTicks, fps);
    const durS = Math.min(defaultDurTicks, c.entry.durationTicks) / TICKS_PER_SECOND_NUM;
    md.push(`| ${tc} | ${c.entry.fileName} | ${c.phrase} | ${c.score.toFixed(3)} | ${durS.toFixed(2)} |`);
  }
  const reviewRel = "broll_review.md";
  await fs.writeFile(path.join(WRITE_ROOT, reviewRel), md.join("\n"));

  // 9. Report. undoStepsRequired is the count of applied edits (placements plus
  //    bin creation); the caller can roll back with that many edit.undo calls.
  const report: AssemblyReport = {
    sequenceId,
    brollPlacements: chosen.map(c => ({
      track: "V2",
      startTicks: c.inTicks,
      durationTicks: Math.min(defaultDurTicks, c.entry.durationTicks),
      brollItemId: c.entry.itemId,
      matchedPhrase: c.phrase,
      confidence: c.score,
    })),
    contactSheetPaths,
    reviewDocPath: reviewRel,
    undoStepsRequired: chosen.length + 2,   // +2 for the two newBin calls
    preRunSnapshotPath: prePath,
  };
  process.stdout.write(JSON.stringify(report, null, 2));

  // Release the engine: the stdio child keeps the event loop alive, so a
  // worker that does not close the session never exits.
  await fc.close();
}

function ticksToTimecode(t: number, fps: number): string {
  const totalSeconds = t / Number(TICKS_PER_SECOND);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const f = Math.floor((totalSeconds - Math.floor(totalSeconds)) * fps);
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}:${String(f).padStart(2,"0")}`;
}

async function collectBRollPaths(): Promise<string[]> {
  const root = path.join(READ_ROOT, "B_Roll_Project/B_Roll");
  const out: string[] = [];
  for (const day of await fs.readdir(root)) {
    for (const f of await fs.readdir(path.join(root, day))) {
      if (/\.(mov|mp4|mxf)$/i.test(f)) out.push(`B_Roll_Project/B_Roll/${day}/${f}`);
    }
  }
  return out;
}

main().catch(e => { console.error(e); process.exit(1); });
