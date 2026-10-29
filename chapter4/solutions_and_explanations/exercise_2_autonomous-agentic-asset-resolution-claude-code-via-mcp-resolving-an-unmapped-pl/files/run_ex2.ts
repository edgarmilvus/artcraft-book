/**
 * Acceptance harness for the chapter-4 exercise 2 reference resolver.
 *
 * The fixture is built with the real DesignCraft engine: a 1024x768 document
 * with one placed PNG is exported as an IDML package with an external link,
 * then the PNG is moved away. The resolver has to find the surviving copy
 * under `incoming/`, relink it, refresh the guides and save a new package.
 *
 * The output is reopened with DesignCraft so the harness verifies the saved
 * link table, not just the resolver's in-memory result.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AssetResolutionRunImpl } from "./02_autonomous-agentic-asset-resolution-claude-code-via-mcp-resolving-an-unmapped-placeholder-through-the-loopback-channel.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "..", "output");
const ROOT = process.env.AUTOMATION_ROOT ?? path.join(OUT, "asset-run");
const SOURCE_PNG = path.join(HERE, "assets", "hero-flat-v3.png");

const checks: { label: string; ok: boolean; detail: string }[] = [];
const ok = (label: string, cond: boolean, detail = ""): boolean => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label.padEnd(46)}${detail}`);
  checks.push({ label, ok: cond, detail });
  return cond;
};

function resetTree(): void {
  fs.rmSync(ROOT, { recursive: true, force: true });
  for (const d of ["working", "incoming", "archive", "in", "out", "holding"]) {
    fs.mkdirSync(path.join(ROOT, d), { recursive: true });
  }
  fs.copyFileSync(SOURCE_PNG, path.join(ROOT, "working", "campaign-cover.png"));
  fs.copyFileSync(SOURCE_PNG, path.join(ROOT, "incoming", "campaign-cover-v1.png"));
  fs.copyFileSync(SOURCE_PNG, path.join(ROOT, "archive", "campaign-cover-v1.png"));
}

async function withDesignCraft<T>(fn: (call: (name: string, args: Record<string, unknown>) => Promise<any>) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: "designcraft-cli",
    args: ["mcp"],
    cwd: ROOT,
    stderr: "ignore",
  });
  const client = new Client({ name: "ex2-fixture", version: "1.0.0" });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
    };
    const text = res.content?.find((c) => c.type === "text")?.text ?? "";
    if (res.isError) throw new Error(`${name}: ${text}`);
    try { return JSON.parse(text); } catch { return text; }
  };
  try { return await fn(call); } finally { await client.close(); }
}

async function buildFixture(idmlPath: string): Promise<void> {
  await withDesignCraft(async (call) => {
    await call("execute", { command: "file.new", params: { width: 1024, height: 768, dpi: 72 } });
    await call("execute", { command: "file.place", params: { path: path.join(ROOT, "working", "campaign-cover.png") } });
    await call("execute", {
      command: "file.exportIdml",
      params: { path: idmlPath, embedImages: false },
    });
  });
}

async function linksIn(idmlPath: string): Promise<any[]> {
  return withDesignCraft(async (call) => {
    await call("open_document", { path: idmlPath });
    const raw = await call("execute", { command: "links.list", params: {} });
    return Array.isArray(raw) ? raw : (raw?.links ?? []);
  });
}

async function main(): Promise<void> {
  process.env.AUTOMATION_ROOT = ROOT;
  process.env.CANDIDATE_DIR = path.join(ROOT, "incoming");
  process.env.SEARCH_DIRS = path.join(ROOT, "archive");
  fs.mkdirSync(OUT, { recursive: true });

  resetTree();
  const idmlPath = path.join(ROOT, "in", "asset.idml");
  const outPath = path.join(ROOT, "out", "asset-resolved.designcraft");

  console.log("phase A: building the fixture with DesignCraft");
  await buildFixture(idmlPath);
  const inputSize = fs.existsSync(idmlPath) ? fs.statSync(idmlPath).size : 0;
  ok("IDML package written", inputSize > 1000, `${inputSize} bytes`);

  fs.renameSync(
    path.join(ROOT, "working", "campaign-cover.png"),
    path.join(ROOT, "holding", "campaign-cover.png"),
  );
  const brokenLinks = await linksIn(idmlPath);
  ok("fixture link is broken", brokenLinks.some((l) => l.status === "missing"), JSON.stringify(brokenLinks.map((l) => l.status)));

  console.log("phase B: resolving the broken link");
  const { AssetResolutionRunImpl: Resolver } = await import(
    "./02_autonomous-agentic-asset-resolution-claude-code-via-mcp-resolving-an-unmapped-placeholder-through-the-loopback-channel.js"
  );
  const runner: AssetResolutionRunImpl = new Resolver();
  const result = await runner.resolve(idmlPath, outPath);
  console.log("  result:", JSON.stringify(result).slice(0, 220));

  ok("one asset relinked", result.resolved.length === 1, `resolved=${result.resolved.length}`);
  ok("no unresolved assets left", result.unresolved.length === 0, `left=${result.unresolved.length}`);

  const attempts = [...result.attempts.values()].flat();
  ok("deterministic relink attempted", attempts.some((a) => a.kind === "relink"), `${attempts.length} attempts`);
  ok("candidate found in incoming", attempts.some((a) => a.kind === "relink" && a.candidate.endsWith("campaign-cover-v1.png")));
  ok("resolved document saved", fs.existsSync(outPath), `${fs.existsSync(outPath) ? fs.statSync(outPath).size : 0} bytes`);
  ok("resolved native package is non-trivial", fs.existsSync(outPath) && fs.statSync(outPath).size > 1000);

  const repaired = await linksIn(outPath);
  ok("reopened link table has no missing entries", repaired.length > 0 && repaired.every((l) => l.status !== "missing"),
    JSON.stringify(repaired.map((l) => l.status)));

  const outside = "/tmp/asset-run-outside.idml";
  fs.rmSync(outside, { force: true });
  let guard = "";
  try {
    await new Resolver().resolve(idmlPath, outside);
  } catch (e) {
    guard = (e as Error).message;
  }
  ok("refuses an output outside the write root", guard.includes("outside automation write root"), guard);
  ok("outside file was not written", !fs.existsSync(outside));

  const failed = checks.filter((c) => !c.ok).length;
  fs.writeFileSync(path.join(OUT, "run-log.json"), JSON.stringify({
    checks: checks.length,
    failures: checks.filter((c) => !c.ok).map((c) => c.label),
    resolved: result.resolved.length,
    attempts: attempts.length,
    inputBytes: inputSize,
    outputBytes: fs.existsSync(outPath) ? fs.statSync(outPath).size : 0,
  }, null, 2) + "\n");
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
