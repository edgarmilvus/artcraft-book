// gfx-factory/assets.ts
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Downloads and caches remote assets under a content-addressed
 * directory layout:
 *
 *   <cacheRoot>/ab/abcdef…-<basename>
 *
 * The two-character prefix shards the filesystem so directories
 * stay small even with millions of assets.
 */
export class AssetResolver {
  constructor(
    private readonly cacheRoot: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch
  ) {}

  /** Compute the on-disk path for a given asset URL without fetching. */
  private targetFor(url: string, digest: string): string {
    const { pathname } = new URL(url);
    const base = path.basename(pathname) || "asset.bin";
    const shard = digest.slice(0, 2);
    return path.join(this.cacheRoot, shard, `${digest}-${base}`);
  }

  /**
   * Fetch (or reuse) an asset. Returns the *relative* path under
   * the read-root so the caller can pass it straight to doc_place.
   */
  async resolve(url: string): Promise<{ relativePath: string; digest: string }> {
    const res = await this.fetchImpl(url);
    if (!res.ok) {
      throw new Error(`asset fetch ${res.status} ${res.statusText}: ${url}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const digest = crypto.createHash("sha256").update(buf).digest("hex");
    const abs = this.targetFor(url, digest);
    const rel = path.relative(this.cacheRoot, abs);

    try {
      await fs.access(abs);
      return { relativePath: rel, digest };
    } catch {
      /* not cached yet */
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    // Write atomically: a partially-written file must never be
    // visible to a concurrent worker that already saw `access()`.
    const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, abs);
    return { relativePath: rel, digest };
  }
}
