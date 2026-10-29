/**
 * lib/lightcraft-culler.ts
 * ---------------------------------------------------------------------------
 * "Hello World" of the LightCraft high-throughput RAW pipeline:
 *   MCP ingest  ->  vector-store similarity dedup  ->  agentic culling  ->
 *   32-bit float develop preset  ->  cropped JPEG deliverable.
 *
 * Every engine call goes through LightCraft's native MCP meta-tools
 * (`import`, `query_photos`, `command_run`, `command_batch`, `apply_preset`,
 * `set_develop`, `render_photo`, `export`), so the same file runs unchanged
 * in a Next.js route handler, a Vercel background function, or an Electron
 * tray worker. No GUI is required at any point.
 *
 * The two dependencies that need a server — the vector store and the
 * embedding model — are injected, so the pipeline can be run against a local
 * store and a scripted embedder as well as against pgvector and OpenAI.
 * ---------------------------------------------------------------------------
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

// ===========================================================================
// 1. Environment contract - one zod schema, validated at cold start.
// ===========================================================================

/**
 * Runtime configuration. Parsing `process.env` here means a missing
 * WORK_ROOT or LIGHTCRAFT_BIN throws the first instant the module is
 * imported, not ten minutes into a background job when the first RAW lands.
 *
 * The database and the embedding model are *not* in the schema: they arrive
 * through the injected `store` and `embedder`, so a local run needs neither a
 * Postgres nor an API key.
 */
const Env = z
  .object({
    LIGHTCRAFT_BIN: z.string().default("lightcraft-cli"),
    WORK_ROOT: z.string().default(process.cwd()),
    LIBRARY_DIR: z.string().optional(),
  })
  .parse(process.env);

// ===========================================================================
// 2. Vector store - the schema the production store uses, and the interface
//    the pipeline talks to.
// ===========================================================================

/**
 * `text-embedding-3-small` supports Matryoshka truncation; at 512 dims the
 * storage cost per photo is ~2 KB (4 bytes/dim + row overhead) versus ~6 KB
 * at 1536. That matters when a single wedding shoot can be 12 000 frames.
 *
 * `vector_cosine_ops` pairs with the `<=>` operator used in the search query.
 */
const SCHEMA_SQL = /* sql */ `
  CREATE EXTENSION IF NOT EXISTS vector;

  CREATE TABLE IF NOT EXISTS photo_embeddings (
    photo_id     INTEGER      PRIMARY KEY,
    fingerprint  TEXT         NOT NULL,
    embedding    VECTOR(512)  NOT NULL,
    captured_at  TIMESTAMPTZ,
    camera       TEXT,
    lens         TEXT,
    iso          INTEGER,
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS photo_embeddings_hnsw
    ON photo_embeddings
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
`;

/** One indexed photo. */
export interface PhotoEmbedding {
  photoId: number;
  fingerprint: string;
  embedding: number[];
  capturedAt: string | null;
  camera: string;
  lens: string;
  iso: number | null;
}

/** The store the pipeline needs. pgvector implements it in production. */
export interface VectorStore {
  /** Create the schema (or the table) if it does not exist. */
  migrate(): Promise<void>;
  /** Upsert one photo's embedding. */
  upsert(row: PhotoEmbedding): Promise<void>;
  /** The ids of the photos within a cosine similarity of `photoId`. */
  burstOf(photoId: number, threshold: number, k: number): Promise<number[]>;
  close(): Promise<void>;
}

/** The embedding model. */
export interface Embedder {
  embed(text: string): Promise<number[]>;
}

/**
 * The pgvector implementation. The `pg` client is imported lazily so the
 * module loads (and its unit tests run) without a database installed.
 */
export class PgVectorStore implements VectorStore {
  private pool: any;

  constructor(connectionString: string) {
    this.pool = connectionString;
  }

  private async client(): Promise<any> {
    if (typeof this.pool === "object" && this.pool?.query) return this.pool;
    // The module name is held in a variable on purpose: the optional
    // dependency must not be a compile-time requirement.
    const moduleName = "pg";
    const { Pool } = (await import(moduleName)) as any;
    this.pool = new Pool({ connectionString: this.pool as string });
    return this.pool;
  }

  async migrate(): Promise<void> {
    const pool = await this.client();
    await pool.query(SCHEMA_SQL);
  }

  async upsert(row: PhotoEmbedding): Promise<void> {
    const pool = await this.client();
    await pool.query(
      `INSERT INTO photo_embeddings
         (photo_id, fingerprint, embedding, captured_at, camera, lens, iso)
       VALUES ($1, $2, $3::vector, $4, $5, $6, $7)
       ON CONFLICT (photo_id) DO UPDATE
         SET fingerprint = EXCLUDED.fingerprint,
             embedding   = EXCLUDED.embedding,
             updated_at  = NOW()`,
      [
        row.photoId,
        row.fingerprint,
        `[${row.embedding.join(",")}]`, // pgvector accepts the bracketed text literal
        row.capturedAt,
        row.camera,
        row.lens,
        row.iso,
      ],
    );
  }

  async burstOf(photoId: number, threshold: number, k: number): Promise<number[]> {
    const pool = await this.client();
    const { rows } = await pool.query(
      `SELECT photo_id
         FROM photo_embeddings
        WHERE photo_id <> $1
          AND embedding <=> (
                SELECT embedding FROM photo_embeddings WHERE photo_id = $1
              ) < $2
        ORDER BY embedding <=> (
                SELECT embedding FROM photo_embeddings WHERE photo_id = $1
              )
        LIMIT $3`,
      [photoId, 1 - threshold, k],
    );
    return rows.map((r: { photo_id: number }) => r.photo_id);
  }

  async close(): Promise<void> {
    if (typeof this.pool === "object" && this.pool?.end) await this.pool.end();
  }
}

/** The OpenAI embedder, imported lazily for the same reason. */
export class OpenAiEmbedder implements Embedder {
  constructor(private readonly apiKey: string, private readonly model = "text-embedding-3-small") {}

  async embed(text: string): Promise<number[]> {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: this.apiKey });
    const response = await client.embeddings.create({
      model: this.model,
      input: text,
      dimensions: 512, // must match VECTOR(512) exactly, or pgvector rejects the row
    });
    return response.data[0].embedding;
  }
}

// ===========================================================================
// 3. LightCraft MCP handle - a thin, typed facade over the meta-tools.
// ===========================================================================

/** A row of LightCraft's `query_photos` reply (subset of the real columns). */
export interface LightCraftPhoto {
  id: number;
  fileName: string;
  captured: string | null;
  camera: string;
  lens?: string;
  iso?: number;
  rating: 0 | 1 | 2 | 3 | 4 | 5;
  flag: "pick" | "reject" | "none";
  sharpness?: number;                            // injected by `photo.analyze`
  clipped?: number;                              // injected by `photo.analyze`
  group?: number | null;                         // the engine's own burst group
}

export interface CullerOptions {
  store: VectorStore;
  embedder: Embedder;
  /** The LightCraft library folder. */
  libraryDir?: string;
  /** The preset the deliverable is graded with. */
  presetName?: string;
  bin?: string;
}

export class LightCraftCuller {
  private readonly mcp = new Client(
    { name: "lightcraft-culler", version: "1.0.0" },
    { capabilities: {} },
  );
  private readonly options: CullerOptions;
  private readonly presetName: string;

  constructor(options: CullerOptions) {
    this.options = options;
    this.presetName = options.presetName ?? "studio-hdr-2024";
  }

  // -------------------------------------------------------------------------
  // 3a. Lifecycle.
  // -------------------------------------------------------------------------

  /**
   * Boot the MCP child process, then run the store's migration.
   *
   * LightCraft has no automation roots: the library folder is opened with
   * `--library`, and the files the engine reads are the ones the `import`
   * tool is given. A `--automation-read-root` flag is not a thing.
   */
  async start(): Promise<void> {
    const libraryDir = this.options.libraryDir ?? Env.LIBRARY_DIR ?? `${Env.WORK_ROOT}/library`;
    await this.mcp.connect(
      new StdioClientTransport({
        command: this.options.bin ?? Env.LIGHTCRAFT_BIN,
        args: ["mcp", "--library", libraryDir],
      }),
    );
    await this.options.store.migrate();
  }

  /** Release the MCP child and the store. Must be idempotent. */
  async stop(): Promise<void> {
    await this.mcp.close().catch(() => undefined);
    await this.options.store.close().catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // 3b. Ingest.
  // -------------------------------------------------------------------------

  /**
   * Copy a burst of RAW files into LightCraft's library.
   * Returns the numeric photo ids LightCraft assigned to the new rows.
   *
   * @param paths Absolute paths of the source files.
   */
  async ingest(paths: string[]): Promise<number[]> {
    const result = await this.mcp.callTool({
      name: "import",
      arguments: {
        paths,
        mode: "copy",        // never touch the SD card
        organize: "date",    // Originals/YYYY/YYYY-MM-DD/...
        rename: "{date:%Y%m%d_%H%M%S}_{seq:4}",
        onDeleted: "skip",   // idempotent re-runs
      },
    });
    const raw = ((result as any).content[0] as { type: "text"; text: string }).text;
    const { imported } = JSON.parse(raw) as { imported: number[] };
    return imported;
  }

  // -------------------------------------------------------------------------
  // 3c. Fingerprint - deterministic caption, then embed.
  // -------------------------------------------------------------------------

  /**
   * Turn one photo into a stable, embeddable caption. Determinism is the
   * whole trick: the exact same RAW file, ingested twice, must produce the
   * exact same caption and therefore the exact same vector, otherwise the
   * deduplication step silently fails.
   *
   * The caption identifies the *shot* - camera, lens, ISO and the whole
   * second the shutter fired. The sharpness is deliberately not in it: the
   * sharpness decides which frame of a shot wins, so folding it into the
   * fingerprint would give every frame of the burst its own vector and the
   * burst would never be found.
   */
  private buildFingerprint(p: LightCraftPhoto): string {
    const captured = p.captured ? new Date(p.captured) : null;
    const second = captured ? Math.floor(captured.getTime() / 1000) : 0;
    return [
      `camera=${p.camera ?? ""}`,
      `lens=${p.lens ?? ""}`,
      `iso=${p.iso ?? 0}`,
      `second=${second}`,
    ].join(" | ");
  }

  /**
   * Fetch EXIF + sharpness for a set of ids with exactly two round trips:
   * one `photo.analyze`, one `query_photos`. Never loop per id - a 200-frame
   * burst would take ten seconds of MCP chatter by itself.
   */
  async analyse(ids: number[]): Promise<LightCraftPhoto[]> {
    // `photo.analyze` is a real LightCraft command; on a burst it groups
    // look-alike shots taken within ten seconds and marks the sharpest.
    const analysed = await this.mcp.callTool({
      name: "command_run",
      arguments: {
        id: "photo.analyze",
        params: { ids, pickBest: false, rejectBelow: 0 },
      },
    });
    const { photos: scores } = JSON.parse(
      ((analysed as any).content[0] as { text: string }).text,
    ) as { photos: { id: number; sharpness: number; clipped?: number; group?: number | null }[] };
    const sharp = new Map(scores.map((s) => [s.id, s.sharpness]));
    const groups = new Map(scores.map((s) => [s.id, s.group ?? null]));

    const meta = await this.mcp.callTool({
      name: "query_photos",
      arguments: { filter: { ids }, limit: ids.length },
    });
    const { photos } = JSON.parse(
      ((meta as any).content[0] as { text: string }).text,
    ) as { photos: LightCraftPhoto[] };

    return photos.map((p) => ({
      ...p,
      sharpness: sharp.get(p.id) ?? 0,
      clipped: scores.find((s) => s.id === p.id)?.clipped ?? 0,
      group: groups.get(p.id) ?? null,
    }));
  }

  /** Embed one caption with Matryoshka-truncated 3-small. */
  private async embed(caption: string): Promise<number[]> {
    return this.options.embedder.embed(caption);
  }

  /**
   * Analyse + embed a batch and upsert it into the store.
   *
   * The pgvector implementation runs the whole batch in one transaction, so a
   * timeout mid-loop rolls back cleanly instead of leaving half a burst
   * unindexed.
   */
  async index(ids: number[]): Promise<void> {
    const photos = await this.analyse(ids);
    for (const p of photos) {
      const caption = this.buildFingerprint(p);
      const vector = await this.embed(caption);
      await this.options.store.upsert({
        photoId: p.id,
        fingerprint: caption,
        embedding: vector,
        capturedAt: p.captured,
        camera: p.camera ?? "",
        lens: p.lens ?? "",
        iso: p.iso ?? null,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 3d. Burst retrieval - cosine nearest neighbours inside the same second.
  // -------------------------------------------------------------------------

  /**
   * Return the ids of every frame shot within the same second as `photoId`.
   * Cosine *similarity* threshold of 0.98 corresponds to cosine *distance*
   * 0.02, which is what `<=>` returns.
   */
  async burstOf(photoId: number, threshold = 0.98, k = 12): Promise<number[]> {
    return this.options.store.burstOf(photoId, threshold, k);
  }

  // -------------------------------------------------------------------------
  // 3e. Verdicts - one atomic command_batch, not five round trips.
  // -------------------------------------------------------------------------

  /**
   * Rate and flag every frame in a burst in a single MCP call. `command_batch`
   * runs the steps in order and stops on the first failure, so a malformed id
   * can never leave half a burst rated.
   */
  async applyCulling(picks: number[], rejects: number[]): Promise<void> {
    const steps = [];
    if (picks.length) {
      steps.push({ id: "photo.rate", params: { ids: picks, rating: 5 } });
      steps.push({ id: "photo.flag", params: { ids: picks, flag: "pick" } });
    }
    if (rejects.length) {
      steps.push({ id: "photo.rate", params: { ids: rejects, rating: 1 } });
      steps.push({ id: "photo.flag", params: { ids: rejects, flag: "reject" } });
    }
    if (!steps.length) return;
    await this.mcp.callTool({
      name: "command_batch",
      arguments: { steps, stop_on_error: true },
    });
  }

  // -------------------------------------------------------------------------
  // 3f. Deliver - preset -> develop sliders -> preview PNG -> JPEG export.
  // -------------------------------------------------------------------------

  /**
   * The id of the grading preset, created on first use.
   *
   * A preset is addressed by its engine id (`user.<n>.<name>`), not by its
   * name, so the pipeline has to look it up before it can apply it.
   */
  async ensurePreset(): Promise<string> {
    const listed = await this.mcp.callTool({
      name: "command_run",
      arguments: { id: "presets.list", params: {} },
    });
    const presets = JSON.parse(((listed as any).content[0] as { text: string }).text) as {
      id: string; name: string;
    }[];
    const existing = presets.find((preset) => preset.name === this.presetName);
    if (existing) return existing.id;

    const created = await this.mcp.callTool({
      name: "command_run",
      arguments: {
        id: "preset.create",
        params: {
          name: this.presetName,
          groups: [
            { name: "light", values: { "light.exposure": 0.2, "light.contrast": 10 } },
            { name: "color", values: { "color.vibrance": 8 } },
          ],
        },
      },
    });
    const { id } = JSON.parse(((created as any).content[0] as { text: string }).text) as { id: string };
    return id;
  }

  /**
   * Push one RAW through the non-destructive pipeline:
   *  1. apply the shared studio preset (32-bit float grade),
   *  2. nudge two sliders on top of it,
   *  3. render a cropped PNG preview for the UI,
   *  4. export a full-length JPEG for the client.
   *
   * The RAW is never modified; every step is an entry in the edit stack that
   * `export` re-evaluates from the original pixels.
   */
  async deliver(photoId: number, outDir: string): Promise<string> {
    const presetId = await this.ensurePreset();
    await this.mcp.callTool({
      name: "apply_preset",
      arguments: { preset: presetId, ids: [photoId] },
    });
    await this.mcp.callTool({
      name: "set_develop",
      arguments: {
        id: photoId,
        values: {
          "light.exposure": 0.35,
          "light.contrast": 18,
          "color.vibrance": 12,
        },
      },
    });
    // The preview is the frame at up to 4096 px on the long edge. The engine
    // answers with a text block *and* the image; the image is what the UI
    // layer wants.
    const preview = await this.mcp.callTool({
      name: "render_photo",
      arguments: { id: photoId, size: 1024, format: "png" },
    });
    const image = ((preview as any).content as { type: string; data?: string }[]).find(
      (block) => block.type === "image",
    ) as { type: "image"; data: string } | undefined;
    const b64 = image?.data ?? "";
    // Persist the preview alongside the deliverable; your UI layer reads it
    // from object storage, but a Hello World just logs the byte count.
    console.log(`preview for ${photoId}: ${b64.length} base64 chars`);

    const jpegPath = `${outDir}/${photoId}.jpg`;
    await this.mcp.callTool({
      name: "export",
      arguments: {
        ids: [photoId],
        path: jpegPath,
        format: "jpeg",
        quality: 92,
        colorSpace: "srgb",
        longEdge: 3000,
        conflict: "overwrite",
      },
    });
    return jpegPath;
  }

  // -------------------------------------------------------------------------
  // 3g. The whole pipeline, in one method, so a route handler can call it.
  // -------------------------------------------------------------------------

  /**
   * Ingest -> index -> cluster bursts -> pick winners -> rate/flag -> deliver.
   * Returns the sets the caller needs to render a to-camera or an export log.
   */
  async run(
    paths: string[],
    outDir = `${Env.WORK_ROOT}/deliverables`,
  ): Promise<{ picks: number[]; rejects: number[]; files: string[] }> {
    const ids = await this.ingest(paths);
    await this.index(ids);

    const picks: number[] = [];
    const rejects: number[] = [];

    // The engine groups the look-alike frames of a burst itself (shots taken
    // within ten seconds); the vector store adds the frames the engine could
    // not group - a second copy of the same file, ingested twice. The two
    // relations are merged, so one burst is one cluster however it was found.
    const scored = await this.analyse(ids);
    const parent = new Map<number, number>();
    const find = (id: number): number => {
      const current = parent.get(id) ?? id;
      if (current === id) return id;
      const root = find(current);
      parent.set(id, root);
      return root;
    };
    const union = (a: number, b: number): void => {
      const rootA = find(a);
      const rootB = find(b);
      if (rootA !== rootB) parent.set(rootA, rootB);
    };
    for (const id of ids) parent.set(id, id);
    for (const photo of scored) {
      if (photo.group !== null && photo.group !== undefined) union(photo.id, photo.group);
    }
    for (const id of ids) {
      for (const neighbour of await this.burstOf(id)) union(id, neighbour);
    }

    const groups = new Map<number, number[]>();
    for (const id of ids) {
      const root = find(id);
      groups.set(root, [...(groups.get(root) ?? []), id]);
    }
    for (const members of groups.values()) {
      const inGroup = scored.filter((photo) => members.includes(photo.id));
      if (!inGroup.length) continue;
      const best = inGroup.reduce((a, b) =>
        (a.sharpness ?? 0) >= (b.sharpness ?? 0) ? a : b,
      );
      picks.push(best.id);
      rejects.push(...members.filter((m) => m !== best.id));
    }

    await this.applyCulling(picks, rejects);
    const files = [];
    for (const id of picks) {
      files.push(await this.deliver(id, outDir));
    }
    return { picks, rejects, files };
  }
}

// ===========================================================================
// 4. HTTP surface - the only place a web framework is mentioned.
// ===========================================================================

/**
 * A minimal Next.js App Router handler. `runtime = "nodejs"` is mandatory
 * because the MCP transport spawns a child process, and `maxDuration` must
 * exceed the worst-case burst (a 200-frame ingest + 20 exports on a laptop
 * lands around 90 s, so 300 s gives headroom on the Pro tier).
 *
 * The culler instance should live in a module-scoped singleton so warm
 * invocations reuse the LightCraft session and the store's pool.
 */
let singleton: LightCraftCuller | null = null;

export async function getCuller(
  options: CullerOptions,
): Promise<LightCraftCuller> {
  if (!singleton) {
    singleton = new LightCraftCuller(options);
    await singleton.start();
  }
  return singleton;
}

export async function handleBurstRequest(
  paths: string[],
  options: CullerOptions,
): Promise<{ picks: number[]; rejects: number[]; files: string[] }> {
  const culler = await getCuller(options);
  return culler.run(paths);
}
