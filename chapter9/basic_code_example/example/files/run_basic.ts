// run_basic.ts — deterministic harness for the LightCraft culler.
//
// The pipeline is driven against the real headless LightCraft: a burst of
// generated photos is imported, scored by `photo.analyze`, clustered by a
// local vector store, culled, and delivered as JPEGs. The store and the
// embedder are the local implementations, so no database and no API key are
// needed.

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import {
  LightCraftCuller,
  type Embedder,
  type LightCraftPhoto,
  type PhotoEmbedding,
  type VectorStore,
} from "./01_lightcraft-culler.js";

const OUTPUT = resolve(process.cwd(), "output");
const INPUT = resolve(OUTPUT, "input");
const DELIVER = resolve(OUTPUT, "deliverables");

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

function near(label: string, actual: number, expected: number, eps: number): void {
  ok(label, Math.abs(actual - expected) <= eps, `expected ${expected} ± ${eps}, got ${actual}`);
}

/**
 * A deterministic embedder: the same caption always gives the same vector,
 * and two captions that share their tokens stay close - which is what the
 * burst search needs.
 */
class LocalEmbedder implements Embedder {
  async embed(text: string): Promise<number[]> {
    const vector = new Array(512).fill(0);
    for (const token of text.split(/[|\s]+/).filter(Boolean)) {
      const digest = createHash("sha256").update(token).digest();
      for (let i = 0; i < 4; i += 1) {
        vector[digest.readUInt16BE(i * 2) % 512] += 1;
      }
    }
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vector.map((v) => v / norm);
  }
}

/** The vector store, in memory, with the same cosine query the SQL uses. */
class LocalStore implements VectorStore {
  readonly rows: PhotoEmbedding[] = [];
  migrated = false;

  async migrate(): Promise<void> {
    this.migrated = true;
  }

  async upsert(row: PhotoEmbedding): Promise<void> {
    const existing = this.rows.findIndex((r) => r.photoId === row.photoId);
    if (existing >= 0) this.rows[existing] = row;
    else this.rows.push(row);
  }

  async burstOf(photoId: number, threshold: number, k: number): Promise<number[]> {
    const query = this.rows.find((r) => r.photoId === photoId);
    if (!query) return [];
    const neighbours = this.rows
      .filter((r) => r.photoId !== photoId)
      .map((r) => {
        const similarity =
          r.embedding.reduce((sum, v, i) => sum + v * query.embedding[i], 0);
        return { id: r.photoId, similarity };
      })
      .filter((n) => n.similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k);
    return neighbours.map((n) => n.id);
  }

  async close(): Promise<void> {}
}

/** A photo with a measurable amount of detail, so the sharpness differs. */
function makePhoto(seed: number, blur: boolean): Buffer {
  const size = 640;
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const wave = Math.sin((x + seed * 13) / (blur ? 24 : 3)) * Math.cos((y - seed * 7) / (blur ? 24 : 3));
      const value = 128 + wave * (blur ? 12 : 90);
      png.data[i] = Math.max(0, Math.min(255, Math.round(value)));
      png.data[i + 1] = Math.max(0, Math.min(255, Math.round(value * 0.8)));
      png.data[i + 2] = Math.max(0, Math.min(255, Math.round(value * 0.6)));
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

async function main(): Promise<void> {
  rmSync(OUTPUT, { recursive: true, force: true });
  mkdirSync(INPUT, { recursive: true });
  mkdirSync(DELIVER, { recursive: true });
  mkdirSync(resolve(OUTPUT, "library"), { recursive: true });

  // A burst of six frames: three sharp, three soft.
  const paths: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const file = resolve(INPUT, `burst-${i}.png`);
    writeFileSync(file, makePhoto(i, i % 2 === 1));
    paths.push(file);
  }

  const store = new LocalStore();
  const culler = new LightCraftCuller({
    store,
    embedder: new LocalEmbedder(),
    libraryDir: resolve(OUTPUT, "library"),
    presetName: "studio-hdr-2024",
  });

  console.log("\n# the pipeline");
  await culler.start();
  try {
    ok("engine: the store was migrated", store.migrated);
    const result = await culler.run(paths, DELIVER);

    console.log("\n# the ingest");
    ok("ingest: the six frames were imported", result.picks.length + result.rejects.length === 6,
      `${result.picks.length} + ${result.rejects.length}`);
    ok("ingest: the store holds every frame", store.rows.length === 6, `${store.rows.length}`);
    ok("ingest: every row has a fingerprint", store.rows.every((row) => row.fingerprint.includes("camera=")));
    ok("ingest: every row has a 512-d vector", store.rows.every((row) => row.embedding.length === 512));

    console.log("\n# the culling");
    ok("culling: one winner", result.picks.length === 1, JSON.stringify(result.picks));
    ok("culling: the rest are rejected", result.rejects.length === 5);
    ok("culling: the winner is not rejected", !result.rejects.includes(result.picks[0]));

    console.log("\n# the deliverable");
    equal("deliver: one file per winner", result.files.length, 1);
    ok("deliver: the file exists", existsSync(result.files[0]));
    const bytes = readFileSync(result.files[0]);
    ok("deliver: it is a JPEG", bytes[0] === 0xff && bytes[1] === 0xd8, `${bytes.length} bytes`);
    ok("deliver: it is not empty", bytes.length > 1000, `${bytes.length} bytes`);

    console.log("\n# the engine state");
    const session = new (await import("./01_lightcraft-culler.js")).LightCraftCuller({
      store: new LocalStore(),
      embedder: new LocalEmbedder(),
    });
    await session.stop();
    ok("engine: the session tears down cleanly", true);
  } finally {
    await culler.stop();
  }

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
