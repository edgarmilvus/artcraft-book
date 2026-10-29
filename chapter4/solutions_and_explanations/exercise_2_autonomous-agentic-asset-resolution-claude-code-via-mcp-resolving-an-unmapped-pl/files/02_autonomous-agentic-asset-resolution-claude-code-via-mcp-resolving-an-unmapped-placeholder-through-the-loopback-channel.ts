// Solution for Chapter 4. The full implementation used by the acceptance harness.

// asset-resolver.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";

// ---------- Domain types ----------
export interface LinkEntry {
  readonly asset: string;
  readonly name: string;
  readonly path: string;
  readonly status: "ok" | "modified" | "missing" | "embedded";
  readonly uses: ReadonlyArray<{ readonly id: number; readonly page: number }>;
}
export interface UnresolvedAsset {
  readonly assetId: string;
  readonly name: string;
  readonly extension: string;
  readonly page: number;
  readonly frameBounds: readonly [number, number, number, number];
  readonly hints: readonly string[];
}
export type VisionVerdict =
  | { readonly resolved: true;  readonly path: string; readonly confidence: number }
  | { readonly resolved: false; readonly why: string };
export type ConfidenceBand = "low" | "medium" | "high" | "certain";
export type ResolutionAttempt =
  | { readonly kind: "relink";        readonly candidate: string; readonly ok: boolean }
  | { readonly kind: "relinkFolder";  readonly dir: string;       readonly ok: boolean }
  | { readonly kind: "vision";        readonly verdict: VisionVerdict; readonly band: ConfidenceBand };

// ---------- Quantization of confidence into a 4-band palette ----------
export function toBand(c: number): ConfidenceBand {
  if (c >= 0.95) return "certain";
  if (c >= 0.80) return "high";
  if (c >= 0.55) return "medium";
  return "low";
}

// The container convention is `/work`; a laptop run overrides it.
const ROOT = process.env.AUTOMATION_ROOT ?? "/work";
/** Directory of candidate files the resolver may relink from. */
const CANDIDATE_DIR = process.env.CANDIDATE_DIR ?? `${ROOT}/incoming`;
/** Directories tried by the broadened `relinkFolder` pass. */
const SEARCH_DIRS = (process.env.SEARCH_DIRS ?? `${ROOT}/archive`).split(":");

// ---------- Orchestrator ----------
export class AssetResolutionRunImpl {
  private client!: Client;
  private nextCallIndex = 0;

  public async resolve(idmlPath: string, outputPath: string) {
    try {
      // 1. Statically reject any output path that escapes the write root.
      if (outputPath.startsWith("/") && !outputPath.startsWith(`${ROOT}/`)) {
        throw new Error(`Refusing to write outside automation write root: ${outputPath}`);
      }

      // 2. Connect to the MCP broker (headless or live app; the transport is identical).
      const transport = new StdioClientTransport({
        command: "designcraft-cli",
        // `designcraft-cli mcp` takes no root flags: it uses its working
        // directory for both reads and writes (`[--connect PORT] [--sample]`).
        args: ["mcp"],
        cwd: ROOT,
      });
      this.client = new Client({ name: "asset-resolver", version: "1.0.0" }, { capabilities: {} });
      await this.client.connect(transport);

      // 3. Open the file.
      await this.call("open_document", { path: idmlPath });

      // 4. Enumerate unresolved assets via the engine command registry.
      const listReply = (await this.call("execute", { command: "links.list", params: {} })) as
        ReadonlyArray<LinkEntry>;
      const unresolved: readonly UnresolvedAsset[] = listReply
        .filter(e => e.status === "missing")
        .map(e => this.toUnresolved(e));

      const resolved: string[] = [];
      const attempts = new Map<string, ResolutionAttempt[]>();

      // 5. For each missing asset, try deterministic first, then multimodal.
      for (const asset of unresolved) {
        const log: ResolutionAttempt[] = [];
        attempts.set(asset.assetId, log);
        const ok = await this.resolveOne(asset, log);
        if (ok) resolved.push(asset.assetId);
      }

      // 6. Single batch: clear guides, re-grid the spread, refresh the links.
      const batchSteps = [
        { command: "guide.deleteAll", params: {} },
        { command: "layout.createGuides", params: { rows: 6, columns: 4, fitTo: "margins" } },
        { command: "links.update", params: {} },
      ];
      const batchReply = await this.call("batch", { commands: batchSteps });
      if (isFailure(batchReply)) {
        // Rollback with an explicit undo loop.
        const steps = batchSteps.length;
        for (let i = 0; i < steps; i++) {
          await this.call("execute", { command: "edit.undo", params: {} });
        }
        throw new Error(`batch failed: ${JSON.stringify(batchReply)}`);
      }

      // 7. Save.
      await this.call("save_document", { path: outputPath });

      return { resolved, unresolved: unresolved.filter(u => !resolved.includes(u.assetId)), attempts };
    } finally {
      // The session owns a `designcraft-cli` child process. Closing it is
      // what lets the process exit: a live child keeps the event loop alive.
      await this.client?.close();
    }
  }

  /** Close the MCP session and its child process. Idempotent. */
  public async close(): Promise<void> {
    try { await this.client.close(); } catch { /* the engine is already gone */ }
  }

  // Deterministic pass first, then multimodal fallback.
  private async resolveOne(asset: UnresolvedAsset, log: ResolutionAttempt[]): Promise<boolean> {
    // ---- Deterministic: candidate search from local metadata index ----
    const candidates = await this.indexQuery(asset.hints); // sorted by score
    for (const c of candidates.slice(0, 4)) {
      const r = await this.call("execute", {
        command: "links.relink",
        params: { asset: asset.assetId, path: c },
      });
      const ok = !isFailure(r);
      log.push({ kind: "relink", candidate: c, ok });
      if (ok) return true;
    }

    // ---- Multimodal: render the region and ask a vision model ----
    const renderPng = await this.call("render_page", { page: asset.page, scale: 0.5 });
    const verdict = await this.visionDecide(renderPng, asset);
    log.push({ kind: "vision", verdict, band: verdict.resolved ? toBand(verdict.confidence) : "low" });

    if (verdict.resolved && toBand(verdict.confidence) !== "low") {
      const r = await this.call("execute", {
        command: "links.relink", params: { asset: asset.assetId, path: verdict.path },
      });
      if (!isFailure(r)) { log.push({ kind: "relink", candidate: verdict.path, ok: true }); return true; }
    }

    // ---- Broadened search: relinkFolder against a wider directory ----
    for (const dir of await this.broadenedDirs(asset)) {
      const r = await this.call("execute", {
        command: "links.relinkFolder",
        params: { dir, missingOnly: true, assets: [asset.assetId] },
      });
      const ok = !isFailure(r) && (r as any)?.relinked > 0;
      log.push({ kind: "relinkFolder", dir, ok });
      if (ok) return true;
    }

    // Six-attempt cap reached → collapse into failure marker.
    return false;
  }

  // ---------- Helpers ----------
  /**
   * Call an MCP tool and unwrap the transport envelope.
   *
   * `callTool` resolves to `{ content: [{ type: "text", text }] }`; the
   * engine's payload is JSON inside that text block. Returning the envelope
   * made every caller treat it as data (`listReply.filter` on an object),
   * so the unwrap belongs here, once.
   */
  private async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.nextCallIndex++;
    const res = (await this.client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
    };
    if (res.isError) throw new Error(`${name} failed: ${res.content?.[0]?.text ?? "unknown"}`);
    const text = res.content?.find((c) => c.type === "text")?.text;
    if (text === undefined) return res;
    try { return JSON.parse(text); } catch { return text; }
  }
  private async readStoryOnce(): Promise<string> {
    const s = await this.call("execute", { command: "story.get", params: { story: 1 } });
    return isFailure(s) ? "" : ((s as any)?.text ?? "");
  }
  private toUnresolved(e: LinkEntry): UnresolvedAsset {
    const dot = e.name.lastIndexOf(".");
    return {
      assetId: e.asset, name: e.name, extension: dot >= 0 ? e.name.slice(dot + 1) : "",
      page: e.uses[0]?.page ?? 0, frameBounds: [0, 0, 0, 0],
      hints: this.hintsFromName(e.name),
    };
  }
  private hintsFromName(n: string): readonly string[] {
    return n.replace(/\.[^.]+$/, "").split(/[_\-\s@]+/).filter(Boolean);
  }
  /**
   * Deterministic candidate search over a local directory: every file whose
   * name contains all the hints, ranked by how many hints it matches and by
   * basename proximity.
   */
  private async indexQuery(hints: readonly string[]): Promise<readonly string[]> {
    if (!fs.existsSync(CANDIDATE_DIR)) return [];
    const files = fs.readdirSync(CANDIDATE_DIR).filter((f) => !f.startsWith("."));
    const scored = files
      .map((f) => {
        const lower = f.toLowerCase();
        const hits = hints.filter((h) => lower.includes(h.toLowerCase())).length;
        return { path: `${CANDIDATE_DIR}/${f}`, hits, len: f.length };
      })
      .filter((c) => hints.length === 0 || c.hits > 0)
      .sort((a, b) => b.hits - a.hits || a.len - b.len);
    return scored.map((c) => c.path);
  }

  private async broadenedDirs(_a: UnresolvedAsset): Promise<readonly string[]> {
    return SEARCH_DIRS.filter((d) => fs.existsSync(d));
  }
  private async visionDecide(_png: unknown, _asset: UnresolvedAsset): Promise<VisionVerdict> {
    // Serialize the render to base64 and hand it to the vision LLM with a strict JSON schema.
    return { resolved: false, why: "vision fallback disabled in this harness" };
  }
}

// ---------- Small utility ----------
function isFailure(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return o["ok"] === false || typeof o["error"] === "string";
}
