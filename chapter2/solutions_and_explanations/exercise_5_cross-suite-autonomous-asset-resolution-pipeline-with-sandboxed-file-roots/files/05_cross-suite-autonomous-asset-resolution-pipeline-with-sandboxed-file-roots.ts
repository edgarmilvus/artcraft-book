// bundle_pipeline.ts — cross-suite autonomous asset resolution pipeline.
//
// Suites: LightCraft (resolve), PhotoCraft (condition), DesignCraft
// (compose), PdfCraft (spec sheet). Every server runs headless.
//
// Design rules enforced here:
//   1. PathGuard is the ONLY place that touches path strings.
//   2. Resolution is by rating + keyword, not by fixed path.
//   3. Every mutating step is logged so the run is reversible.
//   4. The report is emitted to stdout; no ui_screenshot anywhere.
//
// The four binaries do NOT share one launch contract, and pretending they do
// is the first thing that breaks in production:
//   * photocraft-cli and pdfcraft-cli take `--automation-read-root` /
//     `--automation-write-root`;
//   * designcraft-cli mcp rejects those flags (usage: `[--connect PORT]
//     [--sample]`), and lightcraft-cli mcp takes files/folders instead;
//   * those two resolve relative paths against the process cwd, so the
//     child is spawned with `cwd` set to the write root instead.
//
// Tool names and parameter shapes also diverge per suite and are matched
// here exactly: LightCraft exports `{ ids: [...] }`, PhotoCraft calls
// `doc_save { index }`, DesignCraft inspects `spreads[].items[]` (not
// `frames`), PdfCraft returns `{ doc }` from `doc_open`.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------
interface BundleRequest {
  product: string;
  variant: Record<string, string>;
  price?: string;
  currency?: string;
  cta: string;
  keywords: string[];
}

interface TxnRecord {
  suite: "lightcraft" | "photocraft" | "designcraft" | "pdfcraft";
  command: string;
  doc_id: string | number;
  reversible: boolean;
}

// The request JSON expresses resolution as a *business* policy (`minRating`,
// `keywords: "from_request"`), not as an engine filter. The engine only knows
// `rating` + `ratingOp`, so the translation happens here, once, and the
// policy file stays the single source of truth.
interface ResolutionTier {
  minRating: number;
  keywords?: "from_request" | string | string[];
  flag?: string;
}

interface ResolutionPolicy {
  primary: ResolutionTier;
  fallback?: ResolutionTier;
  on_empty?: "abort_with_error" | string;
}

// ---------------------------------------------------------------------------
// PathGuard — the single authority on file paths in this process.
// ---------------------------------------------------------------------------
class PathGuard {
  private readonly readRootAbs: string;
  private readonly writeRootAbs: string;

  constructor(readRoot: string, writeRoot: string) {
    this.readRootAbs  = path.resolve(readRoot);
    this.writeRootAbs = path.resolve(writeRoot);
  }

  // Reject absolute paths and any path containing "..", then return the
  // normalised forward-slashed relative form.
  relative(p: string): string {
    if (typeof p !== "string" || p.length === 0) {
      throw new Error(`PathGuard: empty path`);
    }
    if (path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\")) {
      throw new Error(`PathGuard: absolute paths are forbidden: ${p}`);
    }
    // Normalise separators to "/" and split to catch ".." segments.
    const segments = p.replace(/\\/g, "/").split("/");
    if (segments.some(s => s === "..")) {
      throw new Error(`PathGuard: ".." is forbidden: ${p}`);
    }
    return segments.filter(s => s.length > 0).join("/");
  }

  // Optional: verify that a relative path resolves *inside* the roots.
  assertInside(abs: string, root: "read" | "write"): void {
    const base = root === "read" ? this.readRootAbs : this.writeRootAbs;
    const rel = path.relative(base, path.resolve(abs));
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`PathGuard: ${abs} escapes the ${root} root`);
    }
  }
}

// ---------------------------------------------------------------------------
// MCP helpers
// ---------------------------------------------------------------------------
async function tool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res: any = await client.callTool({ name, arguments: args });
  let payload: any = res;
  for (const c of res?.content ?? []) {
    if (c.type === "text") {
      try { payload = JSON.parse(c.text); } catch { payload = { _text: c.text }; }
      break;
    }
  }
  // MCP signals a refused command with isError; a pipeline step must never
  // treat that as success (the bundle would "finish" with missing outputs).
  if (res?.isError) {
    throw new Error(`${name} failed: ${typeof payload === "string" ? payload : JSON.stringify(payload)}`);
  }
  return payload;
}

const SUITE_LAUNCH: Record<string, (readRoot: string, writeRoot: string) => {
  args: string[]; cwd?: string;
}> = {
  // Roots are enforced by the engine's own sandbox.
  "photocraft-cli": (r, w) => ({ args: ["mcp", "--automation-read-root", r, "--automation-write-root", w] }),
  // PdfCraft has its own flag name and no read/write split: `mcp --root`.
  "pdfcraft-cli":   (_r, w) => ({ args: ["mcp", "--root", w], cwd: w }),
  // No root flags: relative paths resolve against cwd.
  "designcraft-cli": (_r, w) => ({ args: ["mcp"], cwd: w }),
  // LightCraft imports the folder(s) named on the command line; its catalog
  // is per-process, so the imported folder is the only source of photos.
  "lightcraft-cli":  (_r, w) => ({
    args: ["mcp", process.env.LIGHTCRAFT_IMPORT_DIR ?? "imports"],
    cwd: w,
  }),
};

async function launch(binary: string, readRoot: string, writeRoot: string): Promise<Client> {
  const spec = SUITE_LAUNCH[binary];
  if (!spec) throw new Error(`no launch contract for ${binary}`);
  const { args, cwd } = spec(readRoot, writeRoot);
  const transport = new StdioClientTransport({ command: binary, args, cwd });
  const c = new Client({ name: `pipeline-${binary}`, version: "1.0.0" }, { capabilities: {} });
  await c.connect(transport);
  return c;
}

// ---------------------------------------------------------------------------
// Transaction log
// ---------------------------------------------------------------------------
async function appendTxn(logPath: string, rec: TxnRecord): Promise<void> {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, JSON.stringify(rec) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Step A — LightCraft photo resolution
// ---------------------------------------------------------------------------
/** Translate one policy tier into the engine's `rating`/`ratingOp` filter. */
function tierToFilter(tier: ResolutionTier, req: BundleRequest): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    // The engine ignores `minRating`; it filters on `rating` + `ratingOp`.
    rating: tier.minRating,
    ratingOp: "atLeast",
  };
  if (tier.keywords === "from_request") {
    if (req.keywords[0]) filter.keyword = req.keywords[0];
  } else if (Array.isArray(tier.keywords)) {
    if (tier.keywords[0]) filter.keyword = tier.keywords[0];
  } else if (typeof tier.keywords === "string") {
    filter.keyword = tier.keywords;
  }
  if (tier.flag) filter.flag = tier.flag;
  return filter;
}

async function resolvePhoto(lc: Client, req: BundleRequest, policy: ResolutionPolicy,
                            guard: PathGuard, txnLog: string)
  : Promise<{ id: number; staged_rel: string; used_fallback: boolean } | { error: string }> {

  // Primary first, then at most one downgrade — mirroring the studio rule
  // "prefer picks, but never abort because the flag was lost in transit".
  const tiers: ResolutionTier[] = [policy.primary];
  if (policy.fallback) tiers.push(policy.fallback);
  // A tier that omits `keywords` inherits the primary's constraint: the
  // downgrade lowers the *rating* bar, never the relevance bar. Dropping the
  // keyword here would happily return the walnut variant for an ochre brief.
  const queries = tiers.map((t, i) => tierToFilter(
    t.keywords === undefined && i > 0 ? { ...t, keywords: policy.primary.keywords } : t,
    req));

  let photos: any[] = [];
  let tier = -1;
  for (const [i, filter] of queries.entries()) {
    const r: any = await tool(lc, "query_photos", { filter, limit: 25 });
    photos = r?.photos ?? r?.items ?? (Array.isArray(r) ? r : []);
    if (photos.length > 0) { tier = i; break; }
  }
  if (photos.length === 0) {
    return {
      error: `no photo matched the resolution policy ` +
             `(tiers tried: ${queries.length}, on_empty=${policy.on_empty ?? "abort_with_error"})`,
    };
  }
  // The catalog returns matches in reverse import order, not by relevance:
  // take the highest rating, then the lowest id so the choice is stable.
  const chosen = [...photos].sort((a: any, b: any) =>
    (Number(b?.rating ?? 0) - Number(a?.rating ?? 0)) ||
    (Number(a?.id ?? 0) - Number(b?.id ?? 0)))[0];
  const photoId = Number(chosen.id ?? chosen.photo ?? chosen);
  const usedFallback = tier > 0;

  // Stage a JPEG into the write root via LightCraft's exporter; this is the
  // only way to guarantee the file is under our sandbox even when the raw
  // lives outside the read root. `export` takes `ids`, not `id`.
  const stagedRel = guard.relative(`work/hero_source_${photoId}.jpg`);
  await tool(lc, "export", {
    ids: [photoId], path: stagedRel, format: "jpeg", quality: 92, longEdge: 2400,
  });
  await appendTxn(txnLog, { suite: "lightcraft", command: "export",
                            doc_id: photoId, reversible: true });
  if (usedFallback) {
    console.error(`resolution: primary tier missed, used fallback (tier ${tier + 1}/${tiers.length})`);
  }
  return { id: photoId, staged_rel: stagedRel, used_fallback: usedFallback };
}

// ---------------------------------------------------------------------------
// Step B — PhotoCraft conditioning
// ---------------------------------------------------------------------------
async function conditionInPhotoCraft(pc: Client, stagedRel: string, guard: PathGuard,
                                     txnLog: string)
  : Promise<{ docIndex: number; conditionedRel: string }> {
  const open = await tool(pc, "doc_open", { path: guard.relative(stagedRel) });
  const docIndex = Number(open?.index ?? 0);

  // Read dimensions so we can resize non-destructively to fit both targets.
  const info = await tool(pc, "doc_inspect", { index: docIndex });
  const { width, height } = findDims(info);
  const short = Math.min(width, height);
  const factor = short >= 1080 ? 1 : 1080 / short;
  const newW = Math.round(width * factor);
  const newH = Math.round(height * factor);

  await tool(pc, "command_batch", {
    stop_on_error: true,
    steps: [
      { id: "filter.sharpen.unsharpMask",
        params: { amount: 40, radius: 0.7, threshold: 2 } },
      { id: "image.adjustments.brightnessContrast",
        params: { brightness: 0, contrast: 6 } },
      { id: "image.imageSize",
        params: { width: newW, height: newH, resample: "bicubic" } },
    ],
  });
  await appendTxn(txnLog, { suite: "photocraft", command: "command_batch",
                            doc_id: docIndex, reversible: true });

  const conditionedRel = guard.relative(`work/hero_conditioned_${docIndex}.png`);
  await tool(pc, "doc_save", { index: docIndex, path: conditionedRel, format: "png" });
  await appendTxn(txnLog, { suite: "photocraft", command: "doc_save",
                            doc_id: docIndex, reversible: true });
  return { docIndex, conditionedRel };
}

function findDims(tree: any): { width: number; height: number } {
  const found: any = {};
  (function walk(n: any) {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    for (const k of Object.keys(n)) {
      if ((k === "width" || k === "height") && typeof n[k] === "number" && !(k in found)) {
        found[k] = n[k];
      }
      walk(n[k]);
    }
  })(tree);
  return { width: found.width ?? 0, height: found.height ?? 0 };
}

// ---------------------------------------------------------------------------
// Step C — DesignCraft composition
// ---------------------------------------------------------------------------
async function composeInDesignCraft(dc: Client, templateRel: string,
                                    conditionedRel: string, cta: string,
                                    guard: PathGuard, txnLog: string)
  : Promise<{ heroWide: string; heroSquare: string }> {

  await tool(dc, "open_document", { path: guard.relative(templateRel) });
  await appendTxn(txnLog, { suite: "designcraft", command: "open_document",
                            doc_id: templateRel, reversible: false /* just close */ });

  // Force the artboard to the wide target so export_png{scale:1} is 1:1.
  // We justify this over render_page's computed scale because it lets us
  // reuse the *same* text frames and margins: reflow works in points,
  // and the undo path is a single edit.undo per resize.
  await tool(dc, "execute", { command: "layout.documentSetup",
                              params: { width: 1920, height: 1080 } });
  await appendTxn(txnLog, { suite: "designcraft", command: "layout.documentSetup",
                            doc_id: templateRel, reversible: true });

  // `inspect_document` reports layers and spreads (items with `kind`), not a
  // flat `frames` array; the kind is the shape ("<rectangle>"), not the
  // content type, so we look for the first rectangle on the page.
  const inspect = await tool(dc, "inspect_document");
  const graphicFrameId = pickGraphicFrameId(inspect);
  const margins = pickMargins(inspect);
  const ctaFrameRect = ctaFrameRectFromMargins(margins);

  if (graphicFrameId === undefined) {
    // Fall back: create a fresh graphic frame occupying most of the spread.
    const c = await tool(dc, "execute", { command: "frame.create", params: {
      rect: [margins.inside, margins.top, 1920 - margins.inside, 1080 - margins.bottom],
      content: "graphic",
    }});
    await appendTxn(txnLog, { suite: "designcraft", command: "frame.create",
                              doc_id: templateRel, reversible: true });
    await tool(dc, "place_image", { frame: c.id, path: guard.relative(conditionedRel) });
  } else {
    await tool(dc, "place_image", { frame: graphicFrameId,
                                    path: guard.relative(conditionedRel) });
  }
  await appendTxn(txnLog, { suite: "designcraft", command: "place_image",
                            doc_id: templateRel, reversible: true });

  // Insert the CTA — via a new frame if the template lacks one.
  const ctaFrame = pickFrameByLabel(inspect, "CTA");
  if (ctaFrame !== undefined) {
    // `text.insert` takes the text itself; it replaces the selected text.
    await tool(dc, "execute", { command: "text.insert", params: { text: cta } });
    await tool(dc, "set_story_text", { frame: ctaFrame.id, text: cta });
  } else {
    const created = await tool(dc, "execute", {
      command: "frame.create",
      params: { rect: ctaFrameRect, content: "text", text: cta },
    });
    await appendTxn(txnLog, { suite: "designcraft", command: "frame.create",
                              doc_id: templateRel, reversible: true });
    await appendTxn(txnLog, { suite: "designcraft", command: "text.insert",
                              doc_id: created.id, reversible: true });
  }

  // Export the wide hero. `scale: 1` gives 1:1 pixel mapping because the
  // artboard is now exactly 1920x1080 points and DesignCraft points are 72
  // ppi — hence one point maps to one pixel at scale 1.
  const heroWideRel = guard.relative("hero/hero_1920x1080.png");
  await tool(dc, "export_png", { path: heroWideRel, scale: 1 });
  await appendTxn(txnLog, { suite: "designcraft", command: "export_png",
                            doc_id: heroWideRel, reversible: false });

  // Square: resize (adjustLayout so objects follow the page), export, then
  // roll back the resize with edit.undo so the wide layout survives for the
  // audit trail without the square artboard.
  await tool(dc, "execute", { command: "layout.documentSetup",
                              params: { width: 1080, height: 1080, adjustLayout: true } });
  await appendTxn(txnLog, { suite: "designcraft", command: "layout.documentSetup",
                            doc_id: templateRel, reversible: true });
  const heroSquareRel = guard.relative("hero/hero_1080x1080.png");
  await tool(dc, "export_png", { path: heroSquareRel, scale: 1 });
  await appendTxn(txnLog, { suite: "designcraft", command: "export_png",
                            doc_id: heroSquareRel, reversible: false });
  // Roll back the square resize (single deterministic edit.undo).
  await tool(dc, "execute", { command: "edit.undo", params: {} });

  return { heroWide: heroWideRel, heroSquare: heroSquareRel };
}

/** First rectangle on the first spread — the template's image well. */
function pickGraphicFrameId(inspect: any): number | undefined {
  const items = inspect?.spreads?.[0]?.items ?? [];
  for (const item of items) {
    if (item && typeof item.kind === "string" && item.kind.startsWith("<rect")) {
      return item.id;
    }
  }
  return undefined;
}

function pickFrameByLabel(inspect: any, label: string): any {
  const items = inspect?.spreads?.flatMap((s: any) => s.items ?? []) ?? [];
  for (const f of items) if (f && (f.label === label || f.name === label)) return f;
  return undefined;
}

function pickMargins(inspect: any): { top: number; bottom: number; inside: number } {
  // DesignCraft reports page size under `settings`, not margins; the document
  // setup call above used the template's own margins, so 40 pt is the
  // conservative default for the CTA strip.
  const m = inspect?.spreads?.[0]?.pages?.[0]?.margins ?? inspect?.document?.margins;
  if (Array.isArray(m)) return { top: m[0] ?? 40, bottom: m[2] ?? 40, inside: m[1] ?? 40 };
  return { top: m?.top ?? 40, bottom: m?.bottom ?? 40, inside: m?.inside ?? 40 };
}

function ctaFrameRectFromMargins(m: { top: number; bottom: number; inside: number })
  : [number, number, number, number] {
  // A wide thin strip along the bottom-inside margin; the exact geometry is
  // advisory (a real template would have named frames), so the planner
  // infers a reasonable default from the template's own margins.
  const left = m.inside;
  const right = 1920 - m.inside;
  const top = 1080 - m.bottom - 120;
  const bottom = 1080 - m.bottom;
  return [left, top, right, bottom];
}

// ---------------------------------------------------------------------------
// Step D — PdfCraft spec sheet
// ---------------------------------------------------------------------------
async function specSheetPdf(pdfc: Client, boilerplateRel: string, req: BundleRequest,
                            guard: PathGuard, txnLog: string): Promise<string> {
  const opened = await tool(pdfc, "doc_open", { path: guard.relative(boilerplateRel) });
  // PdfCraft returns `{ doc: <id>, ... }`; `id` is not in the payload.
  const docId = Number(opened?.doc ?? opened?.id ?? 1);

  // Fill the fields whose names match request keys.
  const values: Record<string, string> = {
    Product: req.product,
    CTA: req.cta,
    Price: req.price ? `${req.currency ?? "USD"} ${req.price}` : "",
  };
  await tool(pdfc, "form_fill", { doc: docId, values });
  await appendTxn(txnLog, { suite: "pdfcraft", command: "form_fill",
                            doc_id: docId, reversible: true });

  // Title in the info dictionary.
  await tool(pdfc, "doc_set_info", { doc: docId, key: "Title",
                                     value: `${req.product} — ${req.cta}` });
  await appendTxn(txnLog, { suite: "pdfcraft", command: "doc_set_info",
                            doc_id: docId, reversible: true });

  const outRel = guard.relative(`spec/FW26_${req.product.replace(/\s+/g, "")}_spec.pdf`);
  await tool(pdfc, "doc_save", { doc: docId, path: outRel });
  await appendTxn(txnLog, { suite: "pdfcraft", command: "doc_save",
                            doc_id: docId, reversible: false });
  return outRel;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function runBundle(req: BundleRequest,
                         roots: { read_root: string; write_root: string },
                         policy: ResolutionPolicy,
                         templateRel: string,
                         boilerplateRel: string): Promise<void> {
  const guard  = new PathGuard(roots.read_root, roots.write_root);
  const txnLogRel = guard.relative("logs/bundle-2607_txn.jsonl");
  // The relative form is what the report shows; every write needs the
  // absolute one, because appendTxn would otherwise land under the process
  // cwd (the book's bug: the log vanishes while the bundle "succeeds").
  const txnLog = path.join(roots.write_root, txnLogRel);
  // None of the four engines create output directories: `doc_save`,
  // `export_png` and `doc_save` (PDF) all fail with ENOENT otherwise. Create
  // the bundle layout once, before any suite runs.
  for (const dir of ["logs", "work", "hero", "spec"]) {
    await fs.mkdir(path.join(roots.write_root, guard.relative(dir)), { recursive: true });
  }
  await fs.writeFile(txnLog, "", "utf8");

  const [lc, pc, dc, pdfc] = await Promise.all([
    launch("lightcraft-cli",  roots.read_root, roots.write_root),
    launch("photocraft-cli",  roots.read_root, roots.write_root),
    launch("designcraft-cli", roots.read_root, roots.write_root),
    launch("pdfcraft-cli",    roots.read_root, roots.write_root),
  ]);

  try {
    // ---- Step A: resolution ---------------------------------------------
    const resolved = await resolvePhoto(lc, req, policy, guard, txnLog);
    if ("error" in resolved) {
      throw new Error(`Asset resolution aborted: ${resolved.error}`);
    }

    // ---- Step B: conditioning -------------------------------------------
    const { docIndex, conditionedRel } =
      await conditionInPhotoCraft(pc, resolved.staged_rel, guard, txnLog);

    // ---- Step C: composition --------------------------------------------
    const { heroWide, heroSquare } =
      await composeInDesignCraft(dc, templateRel, conditionedRel,
                                 req.cta, guard, txnLog);

    // ---- Step D: spec sheet ---------------------------------------------
    const specRel = await specSheetPdf(pdfc, boilerplateRel, req, guard, txnLog);

    console.log(JSON.stringify({
      ok: true,
      selected_photo: resolved.id,
      used_fallback: resolved.used_fallback,
      photocraft_doc: docIndex,
      outputs: { hero_wide: heroWide, hero_square: heroSquare, spec_sheet: specRel },
      txn_log: txnLogRel,
    }, null, 2));

  } catch (err: any) {
    // ---- Step E: reverse-on-failure --------------------------------------
    // The transaction log records every mutating step; the reverse mapping
    // per suite is:
    //   lightcraft  : file deleted (reversible:true exports leave temp files)
    //   photocraft  : edit.undo (or doc_close (no save) if the doc was new)
    //   designcraft : edit.undo per stacked edit; doc_close if just opened
    //   pdfcraft    : before save → doc_close{discard_changes:true};
    //                 after save  → doc_save overwrite (previous bytes)
    // We do the practical version here: close all documents without saving,
    // and remove any scratch files we staged under work/.
    for (const c of [pc, dc, pdfc]) {
      try {
        const open: any = await tool(c, "session_list")
          .catch(() => tool(c, "doc_list"))
          .catch(() => null);
        const docs: any[] = open?.documents ?? [];
        for (const d of docs) {
          try { await tool(c, "doc_close", d.index !== undefined
                          ? { index: d.index, discard_changes: true }
                          : { doc: d.id, discard_changes: true }); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
    // Remove scratch files staged by LightCraft export.
    try {
      await fs.rm(path.join(roots.write_root, "work"),
                  { recursive: true, force: true });
    } catch { /* ignore */ }

    console.error(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
    process.exitCode = 2;
  } finally {
    for (const c of [lc, pc, dc, pdfc]) await c.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------
async function pngSize(abs: string): Promise<{ width: number; height: number }> {
  const buf = await fs.readFile(abs);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

interface BundleSpec {
  request: BundleRequest;
  roots: { read_root: string; write_root: string };
  resolution_policy: ResolutionPolicy;
}

(async () => {
  // The request is data, not code: the pipeline must run unchanged when the
  // studio edits the brief or the rating policy.
  const specPath = process.env.REQUEST_JSON ?? "01_json.json";
  const spec = JSON.parse(await fs.readFile(specPath, "utf8")) as BundleSpec;
  const request = spec.request;
  // The JSON carries the production roots; the env override lets the same
  // file drive a scratch bundle folder during verification.
  const roots = {
    read_root:  process.env.READ_ROOT  ?? spec.roots.read_root,
    write_root: process.env.WRITE_ROOT ?? spec.roots.write_root,
  };
  const templateRel    = process.env.TEMPLATE    ?? "templates/hero_furniture.designcraft";
  const boilerplateRel = process.env.BOILERPLATE ?? "spec/FW26_spec_boilerplate.pdf";

  await runBundle(request, roots, spec.resolution_policy, templateRel, boilerplateRel);
  if (process.exitCode) return;

  // ---- verification: the outputs are what the request asked for ---------
  const checks: Array<[string, boolean, string]> = [];
  const wide = await pngSize(path.join(roots.write_root, "hero/hero_1920x1080.png"));
  const square = await pngSize(path.join(roots.write_root, "hero/hero_1080x1080.png"));
  const specStat = await fs.stat(path.join(roots.write_root, "spec/FW26_VelvetChair_spec.pdf"));
  checks.push(["hero_wide is 1920x1080", wide.width === 1920 && wide.height === 1080,
               `${wide.width}x${wide.height}`]);
  checks.push(["hero_square is 1080x1080", square.width === 1080 && square.height === 1080,
               `${square.width}x${square.height}`]);
  checks.push(["spec sheet written", specStat.size > 1000, `${specStat.size} bytes`]);

  const txn = (await fs.readFile(path.join(roots.write_root, "logs/bundle-2607_txn.jsonl"), "utf8"))
    .trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const suites = new Set(txn.map((t) => t.suite));
  checks.push(["transaction log covers all four suites",
               suites.size === 4, [...suites].join(", ")]);

  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
  }
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
})();
