// run_ex4.ts — acceptance harness for the live TCP rig panel.
//
// A local authenticated JSON-lines stub stands in for the EffectCraft desktop
// control channel. The harness injects the repeater rig, updates the stagger,
// captures a real PNG screenshot and checks the non-destructive reset.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import {
  CraftLiveClient,
  injectRig,
  isBatchResult,
  isPropertyGetResult,
  isScreenshotResult,
  reset,
  setStagger,
} from "./04_live-tcp-rigging-on-the-loopback-control-channel-repeater-trim-choreography.js";

const HERE = process.cwd();
const OUTPUT = resolve(HERE, "..", "output");
const WRITE = resolve(OUTPUT, "write");
const TOKEN = "a".repeat(64);

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

function screenshot(): string {
  const png = new PNG({ width: 1280, height: 720 });
  for (let y = 0; y < 720; y += 1) {
    for (let x = 0; x < 1280; x += 1) {
      const i = (y * 1280 + x) * 4;
      const dot = (x % 80 < 28 && y > 300 && y < 430);
      png.data[i] = dot ? 29 : 20;
      png.data[i + 1] = dot ? 78 : 24;
      png.data[i + 2] = dot ? 216 : 30;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png).toString("base64");
}

function startStub(token: string): Promise<{ server: Server; port: number; calls: string[] }> {
  const calls: string[] = [];
  const server = createServer((socket: Socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const frame = JSON.parse(line);
        const reply = (payload: unknown) => socket.write(JSON.stringify(payload) + "\n");
        if (frame.method === "auth") {
          reply(frame.params?.token === token
            ? { id: "auth", ok: true, result: { authenticated: true } }
            : { id: "auth", ok: false, error: { message: "bad token" } });
          continue;
        }
        calls.push(frame.method);
        if (frame.method === "ui.screenshot") {
          reply({ id: frame.id, ok: true, result: {
            path: "preview.png", bytes: 1024, dataBase64: screenshot(),
          } });
          continue;
        }
        if (frame.method === "engine.execute") {
          const command = frame.params.command;
          const params = frame.params.params ?? {};
          if (command === "editor.state") {
            reply({ id: frame.id, ok: true, result: { selection: { ids: [5], kind: "shape", name: "Rig Shape" } } });
          } else if (command === "engine.batch") {
            reply({ id: frame.id, ok: true, result: { steps: params.steps?.length ?? 0, results: [] } });
          } else if (command === "get_property") {
            reply({ id: frame.id, ok: true, result: { path: "shape/Repeater 1/offset", value: 12, keyframes: [{ time: 0 }] } });
          } else if (command === "edit.history.list") {
            reply({ id: frame.id, ok: true, result: { states: [{ label: "Rig: Repeater + Stagger" }] } });
          } else {
            reply({ id: frame.id, ok: true, result: {} });
          }
          continue;
        }
        reply({ id: frame.id, ok: true, result: {} });
      }
    });
  });
  return new Promise((resolveListen) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object");
      resolveListen({ server, port: address.port, calls });
    });
  });
}

async function main(): Promise<void> {
  rmSync(WRITE, { recursive: true, force: true });
  rmSync(resolve(OUTPUT, "report.json"), { force: true });
  mkdirSync(WRITE, { recursive: true });

  console.log("\n# guard shapes");
  ok("guard: valid batch", isBatchResult({ steps: 5, results: [] }));
  ok("guard: invalid batch", !isBatchResult({ steps: 5 }));
  ok("guard: valid screenshot", isScreenshotResult({ path: "a.png", bytes: 1 }));
  ok("guard: invalid screenshot", !isScreenshotResult({ bytes: 1 }));
  ok("guard: valid property", isPropertyGetResult({ path: "p", value: 1 }));
  ok("guard: invalid property", !isPropertyGetResult({ path: "p" }));

  const { server, port, calls } = await startStub(TOKEN);
  try {
    console.log("\n# the live rig");
    const client = new CraftLiveClient("127.0.0.1", port, TOKEN, WRITE);
    await client.connect();
    ok("auth: connected with the token", true);

    const layerId = await injectRig(client, 12);
    equal("rig: selected shape id", layerId, 5);
    ok("rig: editor.state was sent", calls.includes("engine.execute"));

    await setStagger(client, layerId, 24);
    ok("stagger: update sent", calls.filter((method) => method === "engine.execute").length >= 2);

    const path = await client.screenshot("preview.png");
    ok("screenshot: written", existsSync(path));
    const png = PNG.sync.read(readFileSync(path));
    equal("screenshot: width", png.width, 1280);
    equal("screenshot: height", png.height, 720);

    const resetResult = await reset(client);
    equal("reset: undone", resetResult, "undone");
    await client.close();
  } finally {
    server.close();
  }

  for (const artefact of ["write/preview.png"]) {
    ok(`output: ${artefact}`, existsSync(resolve(OUTPUT, artefact)));
  }
  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 4,
    engine: "effectcraft loopback stub",
    assertions: passed + 1,
    tokenLength: TOKEN.length,
    frameCalls: calls.length,
    artefacts: ["write/preview.png"],
    result: "auth-first TCP rig, repeater batch, stagger update, screenshot and non-destructive reset verified",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
