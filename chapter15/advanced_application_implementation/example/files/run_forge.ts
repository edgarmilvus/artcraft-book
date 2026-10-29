// run_forge.ts — deterministic harness for the Lottie → VP9 worker.
//
// The whole worker runs against the real engines: an EffectCraft project is
// built and saved, the worker exports it as Lottie, rasterises the frames in
// headless Chromium and encodes them as VP9 — through the same store
// abstraction a deployment would use.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LottieVP9Pipeline } from "./01_lottie-vp9-pipeline.js";

const OUTPUT = resolve(process.cwd(), "output");
const ROOT = resolve(OUTPUT, "workspace");
const PROJECT_ROOT = resolve(ROOT, "projects");
const WORK_DIR = resolve(ROOT, "work");
const STORE_ROOT = resolve(ROOT, "store");

let passed = 0;
function ok(label: string, condition: boolean, detail = ""): void {
  if (!condition) {
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    process.exit(1);
  }
  passed += 1;
  console.log(`PASS ${label}`);
}

/** A store that keeps every artefact on disk. */
class DiskStore {
  constructor(
    private readonly root: string,
    private readonly publicBase: string,
  ) {}

  async put(key: string, body: Buffer): Promise<{ url: string }> {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname, join } = await import("node:path");
    const abs = join(this.root, key);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, body);
    return { url: `${this.publicBase.replace(/\/$/, "")}/${key}` };
  }
}

/** Build the source project the worker renders. */
async function buildProject(projectPath: string): Promise<void> {
  const transport = new StdioClientTransport({ command: "effectcraft-cli", args: ["mcp"] });
  const client = new Client({ name: "cap15-harness", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    const run = async (command: string, params: Record<string, unknown> = {}) => {
      const res = await client.callTool({
        name: "execute_command",
        arguments: { command, params },
      });
      const block = (res.content as Array<{ type: string; text?: string }>).find(
        (b) => b.type === "text",
      );
      if (!block?.text) return undefined;
      try {
        return JSON.parse(block.text);
      } catch {
        // A rejected command answers with a plain-text diagnostic.
        throw new Error(`EffectCraft rejected ${command}: ${block.text}`);
      }
    };
    // `file.newProject` starts a fresh project and takes no parameters.
    await run("file.newProject");
    await run("comp.new", { name: "Hero", width: 640, height: 360, frameRate: 30, duration: 1 });
    const script = `
      var c = app.project.items.addComp("Hero", 640, 360, 1, 1, 30);
      var bg = c.layers.addSolid([0.043, 0.070, 0.125], "BG", 640, 360, 1);
      var title = c.layers.addText("Lottie");
      var tp = title.property("ADBE Text Properties").property("ADBE Text Document");
      var doc = tp.value;
      doc.fontSize = 72;
      doc.fillColor = [1.0, 0.82, 0.4];
      tp.setValue(doc);
      title.property("ADBE Transform Group").property("ADBE Position").setValue([320, 180]);
      c.numLayers;
    `;
    await client.callTool({ name: "run_script", arguments: { name: "build", code: script } });
    await run("file.save", { path: projectPath });
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  rmSync(OUTPUT, { recursive: true, force: true });
  for (const dir of [PROJECT_ROOT, WORK_DIR, STORE_ROOT]) mkdirSync(dir, { recursive: true });

  console.log("\n# the source project");
  const projectPath = resolve(PROJECT_ROOT, "hero.ecproj");
  await buildProject(projectPath);
  ok("project: it was built and saved", existsSync(projectPath));
  ok("project: it is not empty", statSync(projectPath).size > 1000, `${statSync(projectPath).size} bytes`);

  console.log("\n# the worker");
  const require = createRequire(import.meta.url);
  // The renderer loads `lottie.min.js` from this directory with a
  // `file://` URL, so it is the folder the bundle actually lives in.
  const lottieWebDir = dirname(require.resolve("lottie-web/build/player/lottie.min.js"));
  const pipeline = new LottieVP9Pipeline({
    projectRoot: PROJECT_ROOT,
    workDir: WORK_DIR,
    lottieWebDir,
    store: new DiskStore(STORE_ROOT, "https://cdn.acme.io/animations"),
  });

  const result = await pipeline.run({
    projectId: "hero",
    width: 640,
    height: 360,
    fps: 30,
    durationSec: 1,
    alpha: false,
    crf: 30,
    targets: ["lottie", "webm"],
    assetBaseUrl: "https://cdn.acme.io/animations",
  });

  console.log("\n# the result");
  equal("result: it rendered 30 frames", result.frames, 30);
  ok("result: it encoded something", result.encodedBytes > 1000, `${result.encodedBytes}`);
  ok("result: it took some time", result.elapsedMs > 0, `${result.elapsedMs}`);
  equal("result: it has a content hash", result.hash.length, 16);
  ok("result: the lottie was published", typeof result.lottieUrl === "string", result.lottieUrl);
  ok("result: the webm was published", typeof result.webmUrl === "string", result.webmUrl);

  console.log("\n# the artefacts");
  const lottie = JSON.parse(
    readFileSync(resolve(WORK_DIR, "hero.lottie.json"), "utf8"),
  ) as { fr: number; ip: number; op: number; w: number; h: number };
  ok("lottie: it was published", existsSync(resolve(STORE_ROOT, `hero/${result.hash}.json`)));
  equal("lottie: it runs at 30 fps", lottie.fr, 30);
  equal("lottie: it starts at frame 0", lottie.ip, 0);
  equal("lottie: it ends at frame 30", lottie.op, 30);
  equal("lottie: it is 640 wide", lottie.w, 640);

  const webm = resolve(STORE_ROOT, `hero/${result.hash}.webm`);
  ok("webm: it was published", existsSync(webm), webm);
  ok("webm: it is not empty", statSync(webm).size > 1000, `${statSync(webm).size} bytes`);

  assert.ok(existsSync(webm));
  console.log(`\n${passed} assertions passed`);
}

function equal<T>(label: string, actual: T, expected: T): void {
  ok(label, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
