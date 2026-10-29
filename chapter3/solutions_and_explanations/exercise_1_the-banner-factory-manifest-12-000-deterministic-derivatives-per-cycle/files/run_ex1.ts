// run_ex1.ts — acceptance harness for Chapter 3, Exercise 1.
//
// Builds a deterministic hero fixture, runs the banner-factory orchestrator
// against the real PhotoCraft engine, and verifies the PNG deck, the structured
// log, the failure sidecar, sharding and the container/CronJob contracts.
//
//   npx tsx run_ex1.ts
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const OUT = resolve(HERE, "..", "output");
const ASSETS = join(OUT, "assets");
const BANNERS = join(OUT, "output");
const CLIS = resolve(REPO, "tools/craft-cli/bin");
const TSX = resolve(REPO, "node_modules/.bin/tsx");
const SOLUTION = join(HERE, "01_orchestrator.ts");
const DOCKERFILE = join(HERE, "02_solutions_and_explanations.Dockerfile");
const CRONJOB = join(HERE, "03_cronjob.yaml");

const checks: string[] = [];
const failures: string[] = [];
const quirks: string[] = [];
const log: string[] = [];
const say = (line = ""): void => { log.push(line); console.log(line); };
const check = (label: string, ok: boolean, detail = ""): void => {
  checks.push(label);
  if (!ok) failures.push(label);
  say(`${ok ? " ok " : "FAIL"} ${label.padEnd(62)}${detail}`);
};
const equal = (label: string, actual: unknown, expected: unknown): void =>
  check(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

// ── deterministic PNG writer ─────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
const crc32 = (buf: Uint8Array): number => {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Uint8Array): Buffer => {
  const typed = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typed.copy(out, 4);
  out.writeUInt32BE(crc32(typed), 8 + data.length);
  return out;
};
function writeHero(path: string, width: number, height: number): void {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 4;
      const band = Math.floor(x / 48) % 6;
      const shade = Math.floor((y / height) * 90);
      raw[i] = 40 + band * 28;
      raw[i + 1] = 90 + band * 14 + shade;
      raw[i + 2] = 140 - band * 12;
      raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]));
}
const pngSize = (path: string): { width: number; height: number } => {
  const b = readFileSync(path);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
};
const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

// ── fixture manifest ─────────────────────────────────────────────────────────
const aspects = {
  square: { id: "square", w: 1080, h: 1080 },
  portrait: { id: "portrait", w: 1080, h: 1350 },
  wide: { id: "wide", w: 1200, h: 628 },
  story: { id: "story", w: 720, h: 1280 },
};
// One manifest row is one (SKU, palette, aspect) work item. The full deck is
// therefore three SKUs × four aspects, plus one row whose hero cannot decode.
const goodRows = [
  { sku: "chair-01", palette: "autumn", focalX: 0.5, focalY: 0.5 },
  { sku: "chair-02", palette: "spring", focalX: 0.4, focalY: 0.5 },
  { sku: "chair-03", palette: "spring", focalX: 0.6, focalY: 0.4 },
].flatMap((row) => Object.keys(aspects).map((aspect) => ({
  ...row, heroPath: "hero.png", aspect,
})));
const badRow = {
  sku: "chair-bad", heroPath: "missing-hero.png", palette: "autumn", aspect: "story", focalX: 0.5, focalY: 0.5,
};
const manifest = {
  campaignUuid: "FW26",
  rows: [...goodRows, badRow],
  aspects,
  palettes: {
    spring: { shadow: [[0, 0], [64, 40], [192, 215], [255, 255]] },
    autumn: { shadow: [[0, 0], [48, 72], [180, 196], [255, 255]] },
  },
};
const expectedNames = goodRows.map((row) => {
  const a = aspects[row.aspect as keyof typeof aspects];
  return `FW26_${row.sku}_${row.palette}_${a.id}_${a.w}x${a.h}.png`;
});

type Banner = {
  ts: string; campaignUuid: string; sku: string; palette: string; aspect: string;
  durationMs: number; bytesWritten: number; warmStartHit: boolean; jobId: number | null;
};

const reset = (): void => {
  for (const path of [ASSETS, BANNERS]) rmSync(path, { recursive: true, force: true });
  rmSync(join(OUT, "failures.jsonl"), { force: true });
  rmSync(join(OUT, "run-log.json"), { force: true });
  rmSync(join(OUT, "run_ex1.log"), { force: true });
  mkdirSync(ASSETS, { recursive: true });
  mkdirSync(BANNERS, { recursive: true });
  writeHero(join(ASSETS, "hero.png"), 1200, 900);
  writeFileSync(join(ASSETS, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
};
const run = (extraEnv: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync(TSX, [SOLUTION], {
    cwd: HERE,
    encoding: "utf8",
    timeout: 300_000,
    env: {
      ...process.env,
      PATH: `${CLIS}:${process.env.PATH ?? ""}`,
      ASSET_ROOT: ASSETS,
      OUT_ROOT: BANNERS,
      MANIFEST_PATH: join(ASSETS, "manifest.json"),
      FAILURES_PATH: join(OUT, "failures.jsonl"),
      AVAILABLE_WORKERS: "2",
      ...extraEnv,
    },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};
const parseBanners = (stdout: string): Banner[] => stdout.split("\n").filter((l) => l.trim().startsWith("{"))
  .map((line) => JSON.parse(line) as Banner);

// ── static contracts ─────────────────────────────────────────────────────────
const docker = existsSync(DOCKERFILE) ? readFileSync(DOCKERFILE, "utf8") : "";
const cron = existsSync(CRONJOB) ? readFileSync(CRONJOB, "utf8") : "";
const has = (text: string, re: RegExp): boolean => re.test(text);

try {
  reset();
  say("── run 1: full shard ──────────────────────────────────────────────────");
  const first = run();
  writeFileSync(join(OUT, "orchestrator.stdout.log"), first.stdout);
  writeFileSync(join(OUT, "orchestrator.stderr.log"), first.stderr);
  equal("orchestrator exits cleanly", first.status, 0);
  check("orchestrator prints no stack trace", !/^\s+at .+\(/m.test(first.stderr), first.stderr.slice(0, 160));

  const banners1 = parseBanners(first.stdout);
  equal("one JSON line per successful banner", banners1.length, goodRows.length);
  equal("success stream contains only banner records",
    banners1.every((b) => b.campaignUuid === "FW26" && typeof b.sku === "string"), true);
  equal("failure rows are quarantined", banners1.filter((b) => b.sku === "chair-bad").length, 0);

  const firstHashes = new Map<string, string>();
  for (const name of expectedNames) {
    const path = join(BANNERS, name);
    check(`banner exists: ${name}`, existsSync(path), existsSync(path) ? `${statSync(path).size} bytes` : "missing");
    if (!existsSync(path)) continue;
    firstHashes.set(name, sha256(path));
    const size = pngSize(path);
    const [, , , aspect] = name.replace(/\.png$/, "").split("_");
    const spec = aspect === "square" ? aspects.square : aspect === "portrait" ? aspects.portrait
      : aspect === "wide" ? aspects.wide : aspects.story;
    equal(`${name} dimensions`, `${size.width}x${size.height}`, `${spec.w}x${spec.h}`);
  }

  const failurePath = join(OUT, "failures.jsonl");
  check("failures.jsonl sidecar exists", existsSync(failurePath));
  const failureLines = existsSync(failurePath)
    ? readFileSync(failurePath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  equal("one failure record per bad row", failureLines.length, 1);
  check("failure records carry the contract fields",
    failureLines.every((f) => typeof f.sku === "string" && typeof f.reason === "string" && Number.isInteger(f.exitCode)),
    JSON.stringify(failureLines[0] ?? {}));
  equal("failure records name the bad SKU", [...new Set(failureLines.map((f) => f.sku))].join(","), "chair-bad");

  for (const banner of banners1) {
    check(`log fields: ${banner.sku}/${banner.aspect}`,
      typeof banner.ts === "string" && !Number.isNaN(Date.parse(banner.ts)) &&
      typeof banner.durationMs === "number" && banner.durationMs >= 0 &&
      typeof banner.bytesWritten === "number" &&
      typeof banner.warmStartHit === "boolean" &&
      (banner.jobId === null || Number.isInteger(banner.jobId)));
    const name = `FW26_${banner.sku}_${banner.palette}_${banner.aspect}_${aspects[banner.aspect as keyof typeof aspects].w}x${aspects[banner.aspect as keyof typeof aspects].h}.png`;
    if (existsSync(join(BANNERS, name))) {
      equal(`bytesWritten matches disk: ${name}`, banner.bytesWritten, statSync(join(BANNERS, name)).size);
    }
  }
  equal("every banner reports the warm session", banners1.every((b) => b.warmStartHit === true), true);

  say("");
  say("── run 2: determinism ─────────────────────────────────────────────────");
  rmSync(failurePath, { force: true });
  const second = run();
  equal("second run exits cleanly", second.status, 0);
  const banners2 = parseBanners(second.stdout);
  equal("second run produces the same count", banners2.length, banners1.length);
  let identical = 0;
  for (const name of expectedNames) {
    const path = join(BANNERS, name);
    if (!existsSync(path)) continue;
    if (firstHashes.get(name) === sha256(path)) identical += 1;
  }
  equal("every PNG is byte-identical across runs", identical, expectedNames.length);
  check("determinism is per (SKU, palette, aspect)",
    expectedNames.every((n) => /^FW26_[^_]+_(spring|autumn)_(square|portrait|wide|story)_\d+x\d+\.png$/.test(n)));

  say("");
  say("── sharding ───────────────────────────────────────────────────────────");
  const shardNames: string[][] = [];
  for (const index of ["0", "1"]) {
    const shardOut = join(OUT, `shard-${index}`);
    rmSync(shardOut, { recursive: true, force: true });
    mkdirSync(shardOut, { recursive: true });
    const shard = run({
      OUT_ROOT: shardOut,
      FAILURES_PATH: join(OUT, `failures-${index}.jsonl`),
      REPLICA_INDEX: index,
      REPLICA_COUNT: "2",
    });
    equal(`replica ${index} exits cleanly`, shard.status, 0);
    const names = parseBanners(shard.stdout).map((b) =>
      `FW26_${b.sku}_${b.palette}_${b.aspect}_${aspects[b.aspect as keyof typeof aspects].w}x${aspects[b.aspect as keyof typeof aspects].h}.png`);
    shardNames.push(names.sort());
    equal(`replica ${index} writes half the deck`, names.length, expectedNames.length / 2);
    check(`replica ${index} writes its PNGs`, names.every((n) => existsSync(join(shardOut, n))));
  }
  equal("the two shards are disjoint", shardNames[0].filter((n) => shardNames[1].includes(n)).length, 0);
  equal("the union covers the whole deck", new Set([...shardNames[0], ...shardNames[1]]).size, expectedNames.length);

  say("");
  say("── container + CronJob contract ───────────────────────────────────────");
  check("Dockerfile final stage is debian:bookworm-slim", has(docker, /FROM\s+debian:bookworm-slim\s+AS\s+runtime/i));
  check("Dockerfile creates craft with UID/GID 10001", has(docker, /groupadd\s+-g\s+10001/) && has(docker, /useradd\s+-u\s+10001/));
  check("Dockerfile installs the Inter/IBM Plex font folder", has(docker, /COPY\s+Fonts\//i) && has(docker, /fc-cache/i));
  check("Dockerfile declares the automation roots",
    /ASSET_ROOT=\/work\/assets/.test(docker) && /OUT_ROOT=\/work\/output/.test(docker));
  const orchestrator = readFileSync(SOLUTION, "utf8");
  check("orchestrator passes both automation roots to the engine",
    /--automation-read-root/.test(orchestrator) && /--automation-write-root/.test(orchestrator));
  check("orchestrator bakes an 8-px warm-up", /--warmup/.test(docker) && /doc_render_preview/.test(orchestrator) && /max_side["']?:\s*8/.test(orchestrator));
  check("Dockerfile warm-up uses the MCP client, not raw JSON-RPC", !/"jsonrpc"/.test(docker));
  check("Dockerfile runs as the non-root craft user", has(docker, /^USER craft$/m));
  check("Dockerfile documents the memory/cpu/read-only runtime contract", /--memory=2g/.test(docker) && /--cpus=2/.test(docker) && /--read-only/.test(docker) && /--tmpfs \/tmp:size=512m/.test(docker));
  check("CronJob runs four parallel completions", has(cron, /parallelism:\s*4/) && has(cron, /completions:\s*4/));
  check("CronJob requests 500m CPU and caps at 2 CPU / 2Gi", /cpu:\s*["']?500m/.test(cron) && /cpu:\s*["']?2["']?/.test(cron) && /memory:\s*["']?2Gi/.test(cron));
  check(
    "CronJob probes both jobs_list and session_list",
    /--probe/.test(cron)
      && /async function probe[\s\S]{0,500}jobs_list[\s\S]{0,500}session_list/.test(orchestrator),
  );
  check("CronJob mounts assets read-only", /name:\s*assets,[^}]*readOnly:\s*true/.test(cron));

  if (banners1.some((b) => b.jobId === null)) {
    quirks.push("doc_export returned no job handle; the export completed synchronously, which the drain gate accepts");
  }

  const summary = {
    checks: checks.length,
    failures,
    quirks,
    banners: banners1.length,
    failuresJsonl: failureLines.length,
    identicalPngs: identical,
    shards: shardNames.map((n) => n.length),
  };
  writeFileSync(join(OUT, "run-log.json"), JSON.stringify(summary, null, 2));
  say("");
  say(`${checks.length} checks, ${failures.length} failing; ${banners1.length} banners, ${failureLines.length} quarantined; artefacts in ${OUT}`);
} catch (error) {
  say(`FAIL harness crashed: ${error instanceof Error ? error.stack : String(error)}`);
  writeFileSync(join(OUT, "run-log.json"), JSON.stringify({ checks: checks.length, failures, crash: String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  writeFileSync(join(OUT, "run_ex1.log"), log.join("\n") + "\n");
}
if (failures.length > 0) process.exitCode = 1;
