// run_governor.ts — deterministic harness for the Nimbus governance stack.
//
// The harness builds a real policy, seals a real vault, compiles the three
// client configurations, opens a governed MCP session against PhotoCraft, and
// proves that the policy engine refuses what the policy refuses — and that
// the audit chain records every decision.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { StudioGovernor } from "./src/governor.js";
import { sealVault } from "./src/policy/vault.js";
import { verifyAudit } from "./src/audit/logger.js";
import type { StudioPolicy } from "./src/policy/schema.js";

const FILES = resolve(process.cwd());
const OUTPUT = resolve(FILES, "output");
const WORK = resolve(OUTPUT, "work");

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

const PASSPHRASE = "harness-studio-passphrase";
const STUDIO_ROOT = resolve(WORK, "studio");

async function main(): Promise<void> {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  mkdirSync(resolve(STUDIO_ROOT, "project"), { recursive: true });
  mkdirSync(resolve(STUDIO_ROOT, "render"), { recursive: true });

  const vault = sealVault({ PHOTOCRAFT_TOKEN: "harness-token" }, PASSPHRASE);

  const policy: StudioPolicy = {
    version: "1.0",
    workspace: STUDIO_ROOT,
    crafts: [
      {
        id: "photocraft",
        binary: "photocraft-cli",
        args: [],
        roots: { read: [resolve(STUDIO_ROOT, "project")], write: [resolve(STUDIO_ROOT, "render")] },
        allow: ["type.create", "layer.newAdjustmentLayer", "filter.blur", "doc_new", "doc_save", "ui_screenshot"],
        deny: ["file.runScript"],
        desktopControl: true,
        secretEnv: ["PHOTOCRAFT_TOKEN"],
        sandboxFlags: true,
      },
      {
        id: "vectorcraft",
        binary: "vectorcraft-cli",
        args: [],
        roots: { read: [resolve(STUDIO_ROOT, "project")], write: [resolve(STUDIO_ROOT, "render")] },
        allow: ["file.new", "shape.", "paint.", "text.create", "document.export"],
        deny: [],
        desktopControl: false,
        secretEnv: [],
        sandboxFlags: true,
      },
      {
        // DesignCraft rejects --automation-read-root outright: its boundary
        // is the working directory the server is spawned in.
        id: "designcraft",
        binary: "designcraft-cli",
        args: [],
        roots: { read: [resolve(STUDIO_ROOT, "project")], write: [resolve(STUDIO_ROOT, "render")] },
        allow: ["file.new", "file.save", "frame.create", "type.char"],
        deny: [],
        desktopControl: false,
        secretEnv: [],
        sandboxFlags: false,
      },
    ],
    roles: [
      {
        name: "producer",
        allow: ["type.create", "layer.newAdjustmentLayer", "filter.blur", "doc_new", "doc_save", "ui_screenshot", "file.new", "shape.", "paint.", "text.create", "document.export", "file.new", "file.save", "frame.create", "type.char"],
        deny: ["file.runScript"],
        mayExport: true,
        mayDriveDesktop: true,
        requiresHumanInTheLoop: false,
      },
      {
        name: "viewer",
        allow: ["doc_new", "doc_inspect"],
        deny: ["*"],
        mayExport: false,
        mayDriveDesktop: false,
        requiresHumanInTheLoop: true,
      },
    ],
    agents: [
      {
        id: "claude-code:brand-producer",
        shell: "claude-code",
        role: "producer",
        crafts: ["photocraft", "vectorcraft", "designcraft"],
        overrides: {},
        visibleSecrets: [],
      },
      {
        id: "cursor:lead-designer",
        shell: "cursor",
        role: "producer",
        crafts: ["photocraft"],
        overrides: {},
        visibleSecrets: ["PHOTOCRAFT_TOKEN"],
      },
      {
        id: "opencode:asset-pipeline",
        shell: "opencode",
        role: "viewer",
        crafts: ["photocraft"],
        overrides: {},
        visibleSecrets: [],
      },
    ],
    audit: { path: resolve(STUDIO_ROOT, "audit", "audit.jsonl"), chained: true, bundle: true },
    secrets: vault,
  };

  const policyPath = resolve(STUDIO_ROOT, "studio.policy.json");
  mkdirSync(resolve(STUDIO_ROOT), { recursive: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(policyPath, JSON.stringify(policy, null, 2));

  const gov = await StudioGovernor.load({ policyPath, passphrase: PASSPHRASE });

  // --- the three projections ------------------------------------------------
  const reports = await gov.sync();
  equal("three agents were compiled", Object.keys(reports).length, 3);

  const cursorMcp = resolve(STUDIO_ROOT, ".cursor", "mcp.json");
  const cursorRule = resolve(STUDIO_ROOT, ".cursor", "rules", "studio.mdc");
  const claudeMcp = resolve(STUDIO_ROOT, ".mcp.json");
  const claudeSettings = resolve(STUDIO_ROOT, ".claude", "settings.json");
  const openCode = resolve(STUDIO_ROOT, "opencode.json");

  for (const path of [cursorMcp, cursorRule, claudeMcp, claudeSettings, openCode]) {
    ok(`the projection exists: ${path.slice(STUDIO_ROOT.length + 1)}`, existsSync(path), path);
  }

  // --- the Cursor projection ------------------------------------------------
  const cursor = JSON.parse(readFileSync(cursorMcp, "utf8"));
  ok("the Cursor config has servers", Object.keys(cursor.mcpServers).length === 1);
  const cursorServer = cursor.mcpServers["storytold-photocraft"];
  equal("the Cursor server is the binary", cursorServer.command, "photocraft-cli");
  ok(
    "the Cursor server carries the sandbox roots",
    cursorServer.args.includes("--automation-read-root"),
    JSON.stringify(cursorServer.args),
  );
  ok(
    "the Cursor config carries no secret",
    !readFileSync(cursorMcp, "utf8").includes("harness-token"),
  );

  // --- the idempotence of the projection ------------------------------------
  const second = await gov.sync();
  const changed = Object.values(second).flat().filter((r) => r.changed).length;
  equal("a second sync changes nothing", changed, 0);

  // --- a governed session ---------------------------------------------------
  const session = await gov.session("claude-code:brand-producer");
  try {
    const photo = session.craft("photocraft");
    const created = await photo.call("doc_new", {
      width: 400, height: 200, mode: "rgb", depth: 8, background: "#101014",
    });
    ok("the governed call reached the engine", created !== undefined);

    // --- the policy refuses what the policy refuses ----------------------
    let refused = false;
    try {
      await photo.call("command_run", {
        id: "file.runScript",
        params: { path: "/tmp/evil.js" },
      });
    } catch (err) {
      refused = String(err).includes("policy");
      ok("the refusal names the policy", refused, String(err));
    }
    ok("the denied command was refused", refused);
  } finally {
    await session.close();
  }

  // --- the audit chain ------------------------------------------------------
  const auditPath = policy.audit.path;
  ok("the audit log was written", existsSync(auditPath));
  const entries = await verifyAudit(auditPath);
  ok("the audit chain verifies", entries >= 2, `${entries} entries`);

  const lines = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  ok("the denial is in the audit log", lines.some((e) => e.status === "denied"),
    JSON.stringify(lines.map((e) => e.status)));
  ok("the audit entries carry the agent", lines.every((e) => typeof e.agent === "string"));
  ok("the audit entries are chained",
    lines.slice(1).every((e, i) => e.prev === lines[i]!.hash));

  // --- the vault ------------------------------------------------------------
  ok("the policy carries no plaintext secret",
    !readFileSync(policyPath, "utf8").includes("harness-token"));

  console.log(`\n${passed} assertions passed`);
}

await main();
