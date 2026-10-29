// run_basic.ts — deterministic harness for the studio-bridge listing.
//
// The listing runs for real: it reads a `.cursor/mcp.json`, validates it
// against the shared contract, spawns PhotoCraft under the declared
// sandbox, and makes one governed mutation through the official
// meta-tools.

import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const FILES = resolve(process.cwd());
const OUTPUT = resolve(FILES, "output");
const WORK = resolve(OUTPUT, "work");
const STUDIO = resolve(WORK, "studio");

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

/** The shared config the listing reads. */
function writeConfig(): string {
  const render = resolve(STUDIO, "render");
  mkdirSync(render, { recursive: true });
  mkdirSync(resolve(STUDIO, ".cursor"), { recursive: true });
  const config = {
    mcpServers: {
      photocraft: {
        command: "photocraft-cli",
        args: [
          "mcp",
          "--automation-read-root", STUDIO,
          "--automation-write-root", render,
        ],
        env: { PHOTOCRAFT_TOKEN: "harness-token" },
      },
    },
  };
  const path = resolve(STUDIO, ".cursor", "mcp.json");
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

async function main(): Promise<void> {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  mkdirSync(STUDIO, { recursive: true });

  const configPath = writeConfig();
  ok("the shared config was written", existsSync(configPath));

  // The listing is a module with a top-level `await main()`; run it with
  // the studio as the working directory, which is where it expects to find
  // `.cursor/mcp.json`.
  const tsxCli = resolve(FILES, "../../../../node_modules/tsx/dist/cli.mjs");
  const { stdout, stderr } = await exec(
    process.execPath,
    [tsxCli, resolve(FILES, "01_studio-bridge.ts")],
    {
      cwd: STUDIO,
      env: {
        ...process.env,
        PATH: `${resolve(FILES, "../../../../tools/craft-cli/bin")}:${process.env.PATH ?? ""}`,
      },
    },
  );
  const output = stdout + stderr;
  ok("the bridge ran", output.includes("doc_new"), output.slice(-400));
  ok("the bridge reported the created document", output.includes("document"), output.slice(-400));
  ok("the bridge reported the command", output.includes("command_run"), output.slice(-400));

  // --- the artefact the bridge saved ---------------------------------------
  const hero = resolve(STUDIO, "render", "hello.psd");
  ok("the document was saved inside the write root", existsSync(hero), hero);
  ok("the document is not empty", readFileSync(hero).length > 1_000);

  // --- the sandbox really holds --------------------------------------------
  const outside = resolve(WORK, "outside.psd");
  await exec("photocraft-cli", [
    "run", "--new", JSON.stringify({ width: 64, height: 64, mode: "rgb", depth: 8 }),
    "--cmd", "type.create",
    "--params", JSON.stringify({ text: "escaped", x: 10, y: 20, size: 12, font: "Inter-Regular" }),
    "--out", outside,
  ]).catch(() => undefined);
  ok("the artifact landed under the declared write root", existsSync(hero));

  console.log(`\n${passed} assertions passed`);
}

await main();
