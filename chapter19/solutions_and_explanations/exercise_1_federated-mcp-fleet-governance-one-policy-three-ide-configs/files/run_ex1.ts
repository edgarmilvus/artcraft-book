// run_ex1.ts — deterministic harness for the exercise 1 solution.
//
// The generator runs for real against the studio's master policy: it writes
// the signed lock file and the three per-role IDE configurations, and this
// harness then re-verifies the envelope, inspects the derived artefacts,
// proves that the resolution is deterministic and that editing a constraint
// changes it.
//
// Nothing here touches the network and nothing here needs an API key: the
// envelope is signed with a local HMAC secret.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ENGINE_SURFACES,
  FleetValidationError,
  assertRegistrySubset,
  canonical,
  generateFleet,
  parseJsonc,
  parseLock,
  roleCapabilitiesSha256,
  verifyLockAgainstFleet,
  verifyLockSignature,
  type LockEntry,
  type LockEnvelope,
} from "./01_generator.js";

const FILES = resolve(process.cwd());
const OUTPUT = resolve(FILES, "..", "output");
const WORK = resolve(OUTPUT, "work");
const POLICY = resolve(FILES, "../../../advanced_application_implementation/example/files/policy");
const STARTER = resolve(POLICY, "mcp.fleet.json");
const CONTRACT = resolve(POLICY, "mcp.fleet.lock.json");

const SECRET = Buffer.from("northwind-harness-hmac-key-v1", "utf8");
const CLOCK = (): string => "2026-01-15T09:00:00.000Z";

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

function throws(fn: () => unknown): string {
  try {
    fn();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function sameKeys(expected: Record<string, unknown>, actual: object): boolean {
  const a = Object.keys(expected).sort().join(",");
  const b = Object.keys(actual).sort().join(",");
  return a === b;
}

function isSorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! <= value);
}

function entry(lock: LockEnvelope, role: string, server: string): LockEntry {
  const found = lock.entries.find((e) => e.role === role && e.server === server);
  if (!found) throw new Error(`no lock entry for ${role}/${server}`);
  return found;
}

function argAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

interface MutableFleet {
  servers: { id: string; env: Record<string, string> }[];
  capabilities: Record<
    string,
    Record<string, { allow: string[]; deny: string[]; writeRoots?: string[] }>
  >;
}

async function main(): Promise<void> {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(resolve(WORK, "policy"), { recursive: true });

  // The master policy is the studio's file; the harness works on a copy so
  // the drift checks never touch the original.
  const fleetPath = resolve(WORK, "policy", "mcp.fleet.json");
  writeFileSync(fleetPath, readFileSync(STARTER, "utf8"));

  const outDir = resolve(WORK, "build");
  const generated = generateFleet({ fleetPath, outDir, secret: SECRET, now: CLOCK });
  const lock = generated.lock;
  const lockPath = resolve(outDir, "mcp.fleet.lock.json");

  /* ── the master policy ─────────────────────────────────────────────────── */
  equal("the master policy declares the studio's four roles", generated.fleet.roles.length, 4);
  equal("the master policy declares five engines", generated.fleet.servers.length, 5);
  ok(
    "the master policy keeps every environment value a vault pointer",
    generated.fleet.servers.every((s) =>
      Object.values(s.env).every((value) => /^\{\{vault:[A-Za-z0-9_./-]+\}\}$/.test(value)),
    ),
  );

  /* ── the envelope ──────────────────────────────────────────────────────── */
  ok("the lock file is written", existsSync(lockPath));
  const onDisk = parseLock(readFileSync(lockPath, "utf8"));
  ok(
    "the lock file on disk is the lock the generator returned",
    canonical(onDisk) === canonical(lock),
  );
  equal("the envelope version is 1", lock.envelopeVersion, "1");
  equal("the envelope names the studio", lock.studio, "Northwind Motion");
  ok(
    "the envelope is stamped with an ISO-8601 instant",
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(lock.generatedAt),
    lock.generatedAt,
  );
  equal(
    "the envelope covers every role and server pair",
    lock.entries.length,
    10,
  );
  equal(
    "the junior editor reaches two engines",
    lock.entries.filter((e) => e.role === "junior-editor").length,
    2,
  );
  equal(
    "the compliance auditor reaches all five engines",
    lock.entries.filter((e) => e.role === "compliance-auditor").length,
    5,
  );
  ok("the envelope lists the roles in a stable order", isSorted(lock.roles));

  /* ── the published contract ────────────────────────────────────────────── */
  const contract = parseJsonc(readFileSync(CONTRACT, "utf8")) as Record<string, unknown>;
  ok("the envelope matches the published contract", sameKeys(contract, lock));
  const contractEntries = contract["entries"];
  ok("the published contract carries entries", Array.isArray(contractEntries));
  const contractEntry = (contractEntries as Record<string, unknown>[])[0] ?? {};
  ok(
    "every entry matches the published contract",
    lock.entries.every((e) => sameKeys(contractEntry, e)),
  );

  /* ── the signature ─────────────────────────────────────────────────────── */
  equal("the envelope signature verifies", throws(() => verifyLockSignature(lock, SECRET)), "");
  ok(
    "every entry carries the envelope's own signature",
    lock.entries.every((e) => e.signature === lock.signature),
  );
  equal(
    "the lock verifies against the master policy",
    throws(() => verifyLockAgainstFleet(lock, generated.fleet, SECRET)),
    "",
  );
  equal(
    "a tampered envelope fails verification",
    throws(() => verifyLockSignature({ ...lock, studio: "Somebody Else" }, SECRET)),
    "envelope signature mismatch",
  );
  const tamperedEntry = { ...lock, entries: lock.entries.map((e, i) => (i === 0 ? { ...e, writeRoot: "/tmp" } : e)) };
  ok(
    "a tampered entry fails verification",
    throws(() => verifyLockSignature(tamperedEntry, SECRET)) !== "",
  );

  /* ── the engine dialects ───────────────────────────────────────────────── */
  const design = entry(lock, "junior-editor", "designcraft-prod");
  const light = entry(lock, "colorist-senior", "lightcraft-prod");
  const effect = entry(lock, "motion-senior", "effectcraft-prod");
  const film = entry(lock, "motion-senior", "filmcraft-prod");
  const pdf = entry(lock, "compliance-auditor", "pdfcraft-prod");

  ok(
    "DesignCraft runs a command through `execute { command }`",
    design.surface.runTool === "execute" && design.surface.runArg === "command",
    `${design.surface.runTool} { ${design.surface.runArg} }`,
  );
  ok(
    "DesignCraft's registry is `list_commands { filter, enabledOnly }`",
    design.surface.discoveryTool === "list_commands" &&
      design.surface.discoveryFilterArg === "filter" &&
      design.surface.discoveryEnabledArg === "enabledOnly",
  );
  ok(
    "DesignCraft's document lifecycle is `new_document` / `save_document`",
    design.surface.documentTools.new === "new_document" &&
      design.surface.documentTools.save === "save_document",
  );
  ok(
    "LightCraft runs a command through `command_run { id }`",
    light.surface.runTool === "command_run" && light.surface.runArg === "id",
  );
  ok(
    "LightCraft's registry is `command_list { filter, enabled_only }`",
    light.surface.discoveryTool === "command_list" &&
      light.surface.discoveryEnabledArg === "enabled_only",
  );
  ok(
    "LightCraft has no document-creation meta-tool",
    light.surface.documentTools.new === null,
  );
  ok(
    "EffectCraft runs a command through `execute_command { command }`",
    effect.surface.runTool === "execute_command" && effect.surface.runArg === "command",
  );
  ok(
    "EffectCraft batches through `batch { steps }`",
    effect.surface.batchTool === "batch" && effect.surface.batchArg === "steps",
  );
  ok(
    "PdfCraft's registry is `command_list`",
    pdf.surface.discoveryTool === "command_list",
  );
  ok(
    "VectorCraft has no document-creation meta-tool",
    ENGINE_SURFACES.vectorcraft.documentTools.new === null,
  );
  ok(
    "WordCraft's registry has no 'enabled only' switch",
    ENGINE_SURFACES.wordcraft.discoveryEnabledArg === null,
  );

  /* ── the sandbox ───────────────────────────────────────────────────────── */
  ok(
    "DesignCraft's roots are policed by the worker, not by the engine",
    design.sandbox.enforcedBy === "worker" && design.sandbox.engineFlags.length === 0,
  );
  ok(
    "FilmCraft's roots are policed by the engine",
    film.sandbox.enforcedBy === "engine" &&
      film.sandbox.engineFlags.join(" ") ===
        "--automation-read-root /work/projects --automation-write-root /work/projects/motion",
    film.sandbox.engineFlags.join(" "),
  );
  ok(
    "the worker polices the roots whatever the engine does",
    lock.entries.every((e) => e.sandbox.workerEnforced),
  );

  /* ── the capabilities ──────────────────────────────────────────────────── */
  ok(
    "the recorded role digest matches the master policy",
    design.sha256RoleCapabilities === roleCapabilitiesSha256(generated.fleet, "junior-editor"),
  );
  ok(
    "the allow-list and the deny-list never overlap",
    lock.entries.every((e) => e.capabilities.allow.every((id) => !e.capabilities.deny.includes(id))),
  );
  ok(
    "the resolved allow-list is sorted",
    lock.entries.every((e) => isSorted(e.capabilities.effectiveAllow)),
  );
  ok(
    "an approval-gated command is part of the effective allow-list",
    design.capabilities.effectiveAllow.includes("file.open") &&
      design.capabilities.effectiveAllow.includes("place.styles"),
  );
  ok(
    "a denied command is not part of the effective allow-list",
    design.capabilities.deny.every((id) => !design.capabilities.effectiveAllow.includes(id)),
  );

  /* ── the derived configurations ────────────────────────────────────────── */
  const station = generated.stations["junior-editor"];
  ok("the junior editor's station is provisioned", station !== undefined);
  const cursorServers = station!.cursor.mcpServers;
  equal("the cursor config exposes only the role's servers", Object.keys(cursorServers).length, 2);
  ok(
    "the cursor config runs the shim, not the engine",
    Object.values(cursorServers).every((c) => c.command.endsWith("mcp-shim")),
  );
  const designArgs = cursorServers["designcraft-prod"]!.args;
  ok(
    "the shim is pointed at the real engine binary",
    (argAfter(designArgs, "--real-binary") ?? "").endsWith("designcraft-cli"),
    argAfter(designArgs, "--real-binary") ?? "<missing>",
  );
  equal("the shim is told which role it serves", argAfter(designArgs, "--role"), "junior-editor");
  equal(
    "the shim carries the role's capability hash",
    argAfter(designArgs, "--cap-hash"),
    roleCapabilitiesSha256(generated.fleet, "junior-editor"),
  );
  equal(
    "the shim is told the write root",
    argAfter(designArgs, "--write-root"),
    "/work/projects/banners",
  );
  ok(
    "the worker never hands a rejecting engine a sandbox flag",
    !designArgs.includes("--automation-read-root") && !designArgs.includes("--automation-write-root"),
  );
  const motion = generated.stations["motion-senior"];
  ok("the motion senior's station is provisioned", motion !== undefined);
  const filmArgs = motion!.opencode.mcp["filmcraft-prod"]!.args;
  ok(
    "the worker hands an accepting engine its sandbox flags",
    filmArgs.includes("--automation-read-root") && filmArgs.includes("--automation-write-root"),
    filmArgs.join(" "),
  );
  ok(
    "the claude code config is the project scope",
    existsSync(resolve(outDir, "stations", "junior-editor", ".mcp.json")) &&
      Object.keys(station!.claude.mcpServers).length === Object.keys(cursorServers).length,
  );
  ok(
    "the opencode config gates every server of the fleet",
    Object.keys(station!.opencode.mcp).length === generated.fleet.servers.length &&
      Object.values(station!.opencode.mcp).every((s) => typeof s.enabled === "boolean"),
  );
  ok(
    "the opencode config switches off the servers the role cannot see",
    station!.opencode.mcp["effectcraft-prod"]!.enabled === false,
  );
  ok(
    "the opencode config switches on the servers the role can see",
    station!.opencode.mcp["designcraft-prod"]!.enabled === true,
  );
  ok(
    "the derived environment carries vault pointers only",
    Object.values(station!.opencode.mcp).every((s) =>
      Object.values(s.env).every((value) => /^\{\{vault:[A-Za-z0-9_./-]+\}\}$/.test(value)),
    ),
  );
  const manifest = readFileSync(resolve(outDir, "mcp.fleet.manifest.sha256"), "utf8");
  equal(
    "the manifest records a digest for every written file",
    manifest.trim().split("\n").length,
    Object.keys(generated.files).length,
  );

  /* ── the live registry assertion ───────────────────────────────────────── */
  const mcpReply = {
    content: [
      {
        type: "text",
        text: JSON.stringify({ commands: [{ id: "file.new" }, { id: "type.create" }] }),
      },
    ],
  };
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const caller = {
    callTool: async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      calls.push({ name, args });
      return mcpReply;
    },
  };
  const allowed = new Set(["file.new", "type.create"]);
  const subset = await assertRegistrySubset(caller, "designcraft", allowed);
  equal("the registry assertion reads the command ids", subset.count, 2);
  equal("the registry assertion names the discovery tool", subset.tool, "list_commands");
  ok(
    "DesignCraft's discovery call carries `enabledOnly`",
    calls[0]?.args["enabledOnly"] === true,
    JSON.stringify(calls[0]?.args ?? {}),
  );
  let leak = "";
  try {
    await assertRegistrySubset(caller, "designcraft", new Set(["file.new"]));
  } catch (error) {
    leak = error instanceof Error ? error.message : String(error);
  }
  ok("the registry assertion catches a leaked command id", leak.includes("leaked"), leak);

  await assertRegistrySubset(caller, "wordcraft", allowed, { filter: "layer" });
  ok(
    "WordCraft's discovery call uses `query` and no 'enabled only' switch",
    calls[2]?.args["query"] === "layer" && calls[2]?.args["enabled_only"] === undefined,
    JSON.stringify(calls[2]?.args ?? {}),
  );
  await assertRegistrySubset(caller, "photocraft", allowed);
  ok(
    "PhotoCraft's discovery call carries `enabled_only`",
    calls[3]?.args["enabled_only"] === true && calls[3]?.name === "command_list",
    JSON.stringify(calls[3]?.args ?? {}),
  );

  /* ── determinism ───────────────────────────────────────────────────────── */
  const first = readFileSync(lockPath, "utf8");
  generateFleet({ fleetPath, outDir, secret: SECRET, now: CLOCK });
  ok("a second run is byte-identical", first === readFileSync(lockPath, "utf8"));

  const later = generateFleet({
    fleetPath,
    outDir: resolve(WORK, "build-later"),
    secret: SECRET,
    now: () => "2026-02-01T12:00:00.000Z",
  });
  const strip = (e: LockEntry): Record<string, unknown> => {
    const { generatedAt: _at, signature: _sig, ...rest } = e;
    return rest;
  };
  equal(
    "a later run resolves to the same servers",
    later.lock.entries.map((e) => `${e.role}/${e.server}`).join(","),
    lock.entries.map((e) => `${e.role}/${e.server}`).join(","),
  );
  ok(
    "a later run changes only the timestamp and the signatures",
    canonical(later.lock.entries.map(strip)) === canonical(lock.entries.map(strip)),
  );

  /* ── drift ─────────────────────────────────────────────────────────────── */
  const editedPath = resolve(WORK, "policy", "edited.fleet.json");
  const edited = parseJsonc(readFileSync(fleetPath, "utf8")) as MutableFleet;
  edited.capabilities["junior-editor"]!["designcraft-prod"]!.allow.push("bookmark.add");
  edited.capabilities["junior-editor"]!["designcraft-prod"]!.writeRoots = [
    "/work/projects/banners/preview",
  ];
  writeFileSync(editedPath, JSON.stringify(edited, null, 2));

  const drifted = generateFleet({
    fleetPath: editedPath,
    outDir: resolve(WORK, "build-drifted"),
    secret: SECRET,
    now: CLOCK,
  });
  const driftedEntry = entry(drifted.lock, "junior-editor", "designcraft-prod");
  ok(
    "editing the allow-list changes the capability digest",
    driftedEntry.sha256ServerCapabilities !== design.sha256ServerCapabilities,
  );
  ok(
    "editing the allow-list changes the envelope signature",
    drifted.lock.signature !== lock.signature,
  );
  equal(
    "editing the write root changes the resolved root",
    driftedEntry.writeRoot,
    "/work/projects/banners/preview",
  );
  ok(
    "the drifted lock still verifies against its own master",
    throws(() => verifyLockAgainstFleet(drifted.lock, drifted.fleet, SECRET)) === "",
  );
  ok(
    "the drifted lock no longer verifies against the original master",
    throws(() => verifyLockAgainstFleet(drifted.lock, generated.fleet, SECRET)) !== "",
  );

  /* ── refusals ──────────────────────────────────────────────────────────── */
  equal(
    "the generator refuses an unknown role",
    throws(() =>
      generateFleet({
        fleetPath,
        outDir: resolve(WORK, "build-unknown-role"),
        secret: SECRET,
        now: CLOCK,
        roles: ["ghost-editor"],
      }),
    ),
    "unknown role: ghost-editor",
  );

  const literalPath = resolve(WORK, "policy", "literal.fleet.json");
  const literal = parseJsonc(readFileSync(fleetPath, "utf8")) as MutableFleet;
  literal.servers[0]!.env["NORTHWIND_DESIGN_TOKEN"] = "sk-live-0f9a2c";
  writeFileSync(literalPath, JSON.stringify(literal, null, 2));
  const literalMessage = throws(() =>
    generateFleet({
      fleetPath: literalPath,
      outDir: resolve(WORK, "build-literal"),
      secret: SECRET,
      now: CLOCK,
    }),
  );
  ok(
    "the generator refuses a literal secret in the environment",
    literalMessage.includes("vault pointers"),
    literalMessage,
  );
  ok(
    "the refusal is a policy error, not a crash",
    literalMessage !== "" && literalMessage.includes("invalid mcp.fleet.json"),
  );

  const widenedPath = resolve(WORK, "policy", "widened.fleet.json");
  const widened = parseJsonc(readFileSync(fleetPath, "utf8")) as MutableFleet;
  widened.capabilities["junior-editor"]!["designcraft-prod"]!.writeRoots = ["/work/elsewhere"];
  writeFileSync(widenedPath, JSON.stringify(widened, null, 2));
  const widenedMessage = throws(() =>
    generateFleet({
      fleetPath: widenedPath,
      outDir: resolve(WORK, "build-widened"),
      secret: SECRET,
      now: CLOCK,
    }),
  );
  ok(
    "the generator refuses a role that widens the sandbox past the server",
    widenedMessage.includes("outside the server's write roots"),
    widenedMessage,
  );

  const overlapPath = resolve(WORK, "policy", "overlap.fleet.json");
  const overlap = parseJsonc(readFileSync(fleetPath, "utf8")) as MutableFleet;
  overlap.capabilities["junior-editor"]!["designcraft-prod"]!.deny.push("type.create");
  writeFileSync(overlapPath, JSON.stringify(overlap, null, 2));
  const overlapMessage = throws(() =>
    generateFleet({
      fleetPath: overlapPath,
      outDir: resolve(WORK, "build-overlap"),
      secret: SECRET,
      now: CLOCK,
    }),
  );
  ok(
    "the generator refuses a command that is both allowed and denied",
    overlapMessage.includes("both allowed and denied"),
    overlapMessage,
  );
  ok(
    "the refusals are policy errors",
    widenedMessage.includes("invalid mcp.fleet.json") &&
      overlapMessage.includes("invalid mcp.fleet.json"),
  );

  const publish: Array<[string, string]> = [
    ["build/mcp.fleet.lock.json", "mcp.fleet.lock.json"],
    ["build/mcp.fleet.manifest.sha256", "mcp.fleet.manifest.sha256"],
    ["policy/mcp.fleet.json", "mcp.fleet.json"],
    ["build/stations/motion-senior/.cursor/mcp.json", "motion-senior.cursor.mcp.json"],
    ["build/stations/motion-senior/.mcp.json", "motion-senior.claude.mcp.json"],
    ["build/stations/motion-senior/opencode.json", "motion-senior.opencode.json"],
  ];
  for (const [from, to] of publish) copyFileSync(resolve(WORK, from), resolve(OUTPUT, to));

  console.log(`\n${passed} assertions passed`);
}

await main();
