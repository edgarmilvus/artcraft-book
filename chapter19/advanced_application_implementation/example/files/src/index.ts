// src/index.ts
import { readFile } from "node:fs/promises";
import { StudioGovernor } from "./governor.js";
import { verifyAudit } from "./audit/logger.js";

/**
 * A twenty-line `.env` reader.
 *
 * The studio's policy is sealed in a vault and the passphrase lives in the
 * environment; a local developer keeps that passphrase in a `.env` file next
 * to the checkout. The format is the conventional one — `KEY=value`, `#`
 * comments, optional `export` prefix — and nothing more is supported on
 * purpose: a richer parser is a dependency, and a dependency in a
 * *governance* entry point is a supply-chain surface.
 */
async function loadDotEnv(path = ".env"): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return; // No .env is a perfectly ordinary deployment.
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const withoutExport = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length)
      : trimmed;
    const eq = withoutExport.indexOf("=");
    if (eq < 1) continue;
    const key = withoutExport.slice(0, eq).trim();
    const value = withoutExport.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key.length > 0 && process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * `studio-governor sync` — compile all adapters from the policy.
 * `studio-governor verify` — re-verify the audit chain.
 * `studio-governor run <agentId> <pipeline>` — run a governed pipeline.
 */
async function main(argv: string[]): Promise<void> {
  await loadDotEnv();
  const [cmd, ...rest] = argv;
  const policyPath = process.env.STUDIO_POLICY ?? ".storytold/studio.policy.json";
  const passphrase = process.env.STUDIO_VAULT_KEY;
  if (!passphrase) throw new Error("STUDIO_VAULT_KEY is not set");

  switch (cmd) {
    case "sync": {
      const gov = await StudioGovernor.load({ policyPath, passphrase });
      const reports = await gov.sync();
      let drifted = 0;
      for (const [agent, list] of Object.entries(reports)) {
        for (const r of list) {
          if (r.changed) { drifted++; console.log(`[sync] ${agent} ${r.reason} → ${r.path}`); }
        }
      }
      console.log(`[sync] ${drifted} file(s) changed`);
      // A non-zero exit is the governance gate: a drifted config must not
      // be allowed to reach a developer's editor.
      process.exit(drifted === 0 ? 0 : 1);
    }
    case "verify": {
      const raw = JSON.parse(await readFile(policyPath, "utf8"));
      const n = await verifyAudit(raw.audit?.path ?? ".storytold/audit.jsonl");
      console.log(`[verify] audit chain intact: ${n} entries`);
      return;
    }
    case "run": {
      const [agentId] = rest;
      if (!agentId) throw new Error("usage: studio-governor run <agentId>");
      const gov = await StudioGovernor.load({ policyPath, passphrase });
      const s = await gov.session(agentId);
      // In real deployments this dispatches to a named pipeline; here we
      // just probe the surface to confirm the connection is healthy.
      await s.craft("photocraft").call("command_list", {});
      await s.close();
      console.log(`[run] agent ${agentId} connected and probed`);
      return;
    }
    default:
      console.error("usage: studio-governor <sync|verify|run> [args]");
      process.exit(2);
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error("[studio-governor] fatal:", err);
  process.exit(1);
});
