// run_ex4.ts — acceptance harness for Chapter 3, Exercise 4.
//
// Compiles the strict service, boots the real worker pool, and drives the HTTP
// contract: readiness, classification, Prometheus counters, fatal input,
// the bounded queue (429 + Retry-After), SIGTERM, the negative type test and
// the distroless container shape.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const OUT = resolve(HERE, "..", "output");
const TSC = resolve(REPO, "node_modules/.bin/tsc");
const DOCKERFILE = join(HERE, "06_dockerfile.Dockerfile");
const MODEL = join(HERE, "02_json.json");

const checks: string[] = [];
const failures: string[] = [];
const quirks: string[] = [];
const lines: string[] = [];
const say = (line = ""): void => { lines.push(line); console.log(line); };
const check = (label: string, ok: boolean, detail = ""): void => {
  checks.push(label);
  if (!ok) failures.push(label);
  say(`${ok ? " ok " : "FAIL"} ${label.padEnd(62)}${detail}`);
};
const equal = (label: string, actual: unknown, expected: unknown): void =>
  check(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

// ── PNG fixtures ─────────────────────────────────────────────────────────────
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b: Uint8Array): number => {
  let c = 0xffffffff;
  for (const x of b) c = (TABLE[(c ^ x) & 0xff] as number) ^ (c >>> 8);
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
function writePng(path: string, width: number, height: number, rgb: readonly [number, number, number]): void {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 3;
      raw[i] = rgb[0]; raw[i + 1] = rgb[1]; raw[i + 2] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array()),
  ]));
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
const request = (port: number, method: string, path: string, body?: Buffer, contentType?: string): Promise<Reply> =>
  new Promise((resolveReply, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers: {
      ...(contentType === undefined ? {} : { "content-type": contentType }),
      ...(body === undefined ? {} : { "content-length": String(body.length) }),
    } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolveReply({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(body);
  });

const freePort = (): Promise<number> => new Promise((resolvePort, reject) => {
  const s = createNetServer();
  s.listen(0, "127.0.0.1", () => {
    const address = s.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    s.close(() => resolvePort(port));
  });
  s.on("error", reject);
});

const waitReady = async (port: number, deadline = 15_000): Promise<Reply | null> => {
  const start = Date.now();
  while (Date.now() - start < deadline) {
    try {
      const r = await request(port, "GET", "/readyz");
      if (r.status === 200) return r;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};

type Server = { proc: ChildProcess; port: number; logPath: string; output: () => string };
const startServer = async (label: string, env: Record<string, string>): Promise<Server> => {
  const port = await freePort();
  const logPath = join(OUT, `${label}.log`);
  const proc = spawn(process.execPath, ["dist/server.js"], {
    cwd: HERE, env: { ...process.env, MODEL_PATH: MODEL, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  proc.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
  proc.stderr?.on("data", (d: Buffer) => { output += d.toString(); });
  return { proc, port, logPath, output: () => output };
};
const stop = async (server: Server, signal: NodeJS.Signals = "SIGTERM"): Promise<number | null> => {
  if (server.proc.exitCode !== null) return server.proc.exitCode;
  server.proc.kill(signal);
  const code = await new Promise<number | null>((resolveExit) => {
    const timer = setTimeout(() => { server.proc.kill("SIGKILL"); resolveExit(-1); }, 12_000);
    server.proc.once("exit", (c) => { clearTimeout(timer); resolveExit(c); });
  });
  writeFileSync(server.logPath, server.output(), "utf8");
  return code;
};

const metricsValue = (body: string, key: string): number => {
  const match = new RegExp(`^${key} (.+)$`, "m").exec(body);
  return match === null ? NaN : Number(match[1]);
};

try {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(MODEL, JSON.stringify({ name: "palette-shim", version: "fixture" }, null, 2) + "\n");
  const red = join(OUT, "red.png");
  const green = join(OUT, "green.png");
  const blue = join(OUT, "blue.png");
  const dark = join(OUT, "dark.png");
  const gray = join(OUT, "gray.png");
  writePng(red, 224, 224, [240, 10, 10]);
  writePng(green, 224, 224, [10, 240, 10]);
  writePng(blue, 224, 224, [60, 60, 255]);
  writePng(dark, 224, 224, [8, 8, 8]);
  writePng(gray, 224, 224, [128, 128, 128]);

  say("── compile ────────────────────────────────────────────────────────────");
  const compile = spawnSync(TSC, ["-p", "tsconfig.json"], { cwd: HERE, encoding: "utf8", timeout: 120_000 });
  equal("strict build succeeds", compile.status, 0);
  check("build emits server.js", existsSync(join(HERE, "dist", "server.js")));
  check("build emits no source maps in the image contract",
    !existsSync(join(HERE, "dist", "server.js.map")) || /find dist -name '\*\.map' -delete/.test(readFileSync(DOCKERFILE, "utf8")));

  const negative = join(HERE, "negative-brand.ts");
  writeFileSync(negative, [
    'import type { Confidence } from "./types.js";',
    "// A plain number must NOT satisfy the brand.",
    "const leaked: Confidence = 0.5;",
    "void leaked;",
    "",
  ].join("\n"));
  const negativeBuild = spawnSync(TSC, [
    "--noEmit", "--strict", "--exactOptionalPropertyTypes", "--noUncheckedIndexedAccess",
    "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext",
    "--types", "node", "negative-brand.ts", "types.ts",
  ], { cwd: HERE, encoding: "utf8", timeout: 120_000 });
  check("a raw number cannot satisfy Confidence", negativeBuild.status !== 0,
    (negativeBuild.stdout + negativeBuild.stderr).split("\n")[0] ?? "");
  check("the brand error names assignability",
    /not assignable|Confidence/.test(negativeBuild.stdout + negativeBuild.stderr));
  rmSync(negative, { force: true });

  say("");
  say("── warm server: readiness, classification, metrics ─────────────────────");
  const warm = await startServer("warm", { WORKER_POOL_SIZE: "2", MAX_QUEUE_DEPTH: "8", WARM_START: "true" });
  const ready = await waitReady(warm.port);
  check("server becomes ready", ready !== null, ready === null ? "no /readyz 200" : `${ready.body}`);
  const readyBody = ready === null ? {} : JSON.parse(ready.body);
  equal("ready payload status", readyBody.status, "ready");
  check("ready reports a model load", Number(readyBody.modelLoadMs) >= 0, String(readyBody.modelLoadMs));
  check("ready reports boot time", Number(readyBody.bootMs) >= 0, String(readyBody.bootMs));

  const classify = async (file: string, type = "image/png") => {
    const reply = await request(warm.port, "POST", "/classify", readFileSync(file), type);
    return { ...reply, json: reply.status === 200 ? JSON.parse(reply.body) : undefined };
  };
  const redReply = await classify(red);
  equal("red image classifies", redReply.status, 200);
  equal("red is apparel", redReply.json?.category, "apparel");
  check("red palette is red", Array.isArray(redReply.json?.dominantPalette) &&
    Math.abs(redReply.json.dominantPalette[0] - 240) < 8, JSON.stringify(redReply.json?.dominantPalette));
  check("confidence is a unit number", redReply.json?.confidence >= 0 && redReply.json.confidence <= 1,
    String(redReply.json?.confidence));
  equal("green image classifies", (await classify(green)).json?.category, "home");
  equal("blue image classifies", (await classify(blue)).json?.category, "electronics");
  equal("dark image classifies", (await classify(dark)).json?.category, "unknown");
  equal("gray image classifies", (await classify(gray)).json?.category, "home");

  const noType = await request(warm.port, "POST", "/classify", readFileSync(red), "text/plain");
  equal("wrong content type is 415", noType.status, 415);
  const badPng = await request(warm.port, "POST", "/classify", Buffer.from("not a png"), "image/png");
  equal("bad PNG is a 500", badPng.status, 500);
  check("bad PNG reports the decoder error", /PNG|signature/.test(badPng.body), badPng.body.slice(0, 120));
  const jpeg = await request(warm.port, "POST", "/classify",
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 0)]), "image/jpeg");
  equal("JPEG shim refusal is a 500", jpeg.status, 500);
  check("JPEG refusal explains the shim", /JPEG/.test(jpeg.body), jpeg.body.slice(0, 120));
  equal("unknown route is 404", (await request(warm.port, "GET", "/nope")).status, 404);

  const metrics = await request(warm.port, "GET", "/metrics");
  equal("metrics endpoint is 200", metrics.status, 200);
  check("metrics are Prometheus text", /text\/plain/.test(String(metrics.headers["content-type"])));
  equal("warm start is counted", metricsValue(metrics.body, "warmStartHits"), 1);
  equal("no cold start on the warm pod", metricsValue(metrics.body, "coldStartCount"), 0);
  check("metrics expose model load time", Number.isFinite(metricsValue(metrics.body, "modelLoadMs")));
  check("metrics expose p50/p99 latency",
    Number.isFinite(metricsValue(metrics.body, "inferenceLatencyP50Ms")) &&
    Number.isFinite(metricsValue(metrics.body, "inferenceLatencyP99Ms")));
  check("p99 is at least p50",
    metricsValue(metrics.body, "inferenceLatencyP99Ms") >= metricsValue(metrics.body, "inferenceLatencyP50Ms"));
  equal("SIGTERM exits zero", await stop(warm), 0);

  say("");
  say("── bounded queue: MAX_QUEUE_DEPTH=0 → 429 + Retry-After ───────────────");
  const narrow = await startServer("narrow", { WORKER_POOL_SIZE: "1", MAX_QUEUE_DEPTH: "0", WARM_START: "true" });
  check("narrow server becomes ready", await waitReady(narrow.port) !== null);
  const big = join(OUT, "big.png");
  writePng(big, 2400, 2400, [120, 80, 200]);
  const burst = await Promise.all(Array.from({ length: 6 }, () =>
    request(narrow.port, "POST", "/classify", readFileSync(big), "image/png")));
  const rejected = burst.filter((r) => r.status === 429);
  check("a full queue returns 429", rejected.length > 0, `${rejected.length}/${burst.length}`);
  check("429 carries Retry-After: 1", rejected.every((r) => String(r.headers["retry-after"]) === "1"));
  check("429 body names the queue", rejected.every((r) => /queue full/.test(r.body)));
  check("some requests still succeed", burst.some((r) => r.status === 200), `${burst.filter((r) => r.status === 200).length}`);
  equal("narrow server stops", await stop(narrow), 0);

  say("");
  say("── cold start counter ──────────────────────────────────────────────────");
  const cold = await startServer("cold", { WORKER_POOL_SIZE: "1", MAX_QUEUE_DEPTH: "4", WARM_START: "false" });
  check("cold server becomes ready", await waitReady(cold.port) !== null);
  const coldMetrics = await request(cold.port, "GET", "/metrics");
  equal("cold start is counted", metricsValue(coldMetrics.body, "coldStartCount"), 1);
  equal("warm counter stays zero", metricsValue(coldMetrics.body, "warmStartHits"), 0);
  await request(cold.port, "POST", "/classify", readFileSync(red), "image/png");
  equal("cold server stops", await stop(cold), 0);

  say("");
  say("── container + type contracts ──────────────────────────────────────────");
  const docker = readFileSync(DOCKERFILE, "utf8");
  equal("Dockerfile has three stages", (docker.match(/^FROM /gm) ?? []).length, 3);
  check("final stage is distroless Node 22", /FROM\s+gcr\.io\/distroless\/nodejs22-debian12/.test(docker));
  const finalStage = docker.slice(docker.lastIndexOf("\nFROM ") + 1);
  const finalCopies = finalStage.match(/^COPY /gm) ?? [];
  check("final stage has at most three COPYs", finalCopies.length <= 3, String(finalCopies.length));
  check("final stage copies only runtime content", !/^\s*COPY\s+.*(src|test|spec)/m.test(finalStage));
  check("final stage runs as non-root 1000", /^USER 1000:1000$/m.test(finalStage));
  check("final stage ships the model", /COPY models\/brand-classifier-v4\.onnx/.test(finalStage));
  check("build strips source maps", /find dist -name '\*\.map' -delete/.test(docker));
  check("server resolves worker next to its module", /path\.dirname\(fileURLToPath\(import\.meta\.url\)\)/.test(readFileSync(join(HERE, "server.ts"), "utf8")));
  const sources = ["types.ts", "model.ts", "worker.ts", "server.ts"].map((f) => readFileSync(join(HERE, f), "utf8")).join("\n");
  check("no `any` escapes the source", !/[:<]\s*any\b|\bas\s+any\b/.test(sources));
  check("Confidence has a private brand", /__brand/.test(sources) && /as Confidence/.test(sources));
  quirks.push("the inference shim decodes PNG only; the HTTP contract still accepts image/jpeg and refuses it at the decoder");

  const log = { checks: checks.length, failures, quirks, warmPort: warm.port };
  writeFileSync(join(OUT, "run-log.json"), JSON.stringify(log, null, 2) + "\n");
  say("");
  say(`${checks.length} checks, ${failures.length} failing; artefacts in ${OUT}`);
} catch (error) {
  say(`FAIL harness crashed: ${error instanceof Error ? error.stack : String(error)}`);
  writeFileSync(join(OUT, "run-log.json"), JSON.stringify({ checks: checks.length, failures, crash: String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  writeFileSync(join(OUT, "run_ex4.log"), lines.join("\n") + "\n");
}
if (failures.length > 0) process.exitCode = 1;
