# 19. Advanced Application Implementation

Three agents — Cursor, Claude Code, OpenCode — against eight engines, and one
policy that decides what each of them may run. The governor is the single
source of truth: a validated policy, a sealed vault, a policy engine, an
append-only audit chain, an MCP client factory, and three adapters that
*compile* each client's configuration from the policy instead of letting a
human maintain five files in five formats.

## What it does

```
policy/mcp.fleet.json  ──▶  StudioPolicy.parse        one schema for crafts, roles, agents, audit
sealVault(secrets)     ──▶  policy.secrets            AES-256-GCM, scrypt-derived key; no plaintext
StudioGovernor.load()  ──▶  engine · audit · factory  never returns a half-initialised governor
sync()                 ──▶  cursor · claude · opencode projections, with a DriftReport per file
session(agentId)       ──▶  CraftSession per craft    every call screened by the engine, then audited
```

Each adapter writes the file its shell actually reads: `.cursor/mcp.json` plus
`.cursor/rules/studio.mdc`, `.mcp.json` plus `.claude/settings.json`, and
`opencode.json`. `sync()` is **idempotent** — a second call reports zero
changed files, which is what makes the projection safe to run from a pre-commit
hook or a control plane.

The policy engine is a prefix matcher: `shape.` allows `shape.rectangle` and
`shape.ellipse`, `"*"` allows everything, and deny wins. Roles are compiled per
agent, and a craft's `sandboxFlags` says whether the engine even accepts
`--automation-read-root` / `--automation-write-root` — PhotoCraft and
VectorCraft do, DesignCraft does not, so its boundary is the working directory
the server is spawned in. A refused command throws with the policy in the
message and lands in the audit log as `denied`.

The audit log is a hash chain: each entry carries the digest of the previous
one, so `verifyAudit()` can tell a truncated or edited file from a complete one.

## The listings

| file | what it is |
| --- | --- |
| `src/governor.ts` | `StudioGovernor` — `load()`, `sync()`, `session()`, `close()` |
| `src/index.ts` | the CLI: `sync`, `verify`, `run <agentId> <pipeline>`, plus a twenty-line `.env` reader |
| `src/policy/schema.ts` | the Zod schema: `CraftBinding`, role, agent, audit and vault |
| `src/policy/vault.ts` | `sealVault` / `openVault` — AES-256-GCM with an scrypt key |
| `src/policy/engine.ts` | `PolicyEngine` — the prefix matcher and the per-agent decision |
| `src/audit/logger.ts` | the chained JSONL logger, `canonicalize()` and `verifyAudit()` |
| `src/mcp/factory.ts` | `McpClientFactory` — one governed `CraftSession` per craft, every call screened |
| `src/adapters/cursor.ts` · `claude-code.ts` · `opencode.ts` | the three projections and their `DriftReport` |
| `src/pipelines/brand-hero.ts` | the worked pipeline: PhotoCraft hero, VectorCraft lockup, DesignCraft spread — three dialects, one policy |
| `policy/mcp.fleet.json` · `mcp.fleet.lock.json` · `effectcraft.binding.json` | the fleet policy, its lockfile, and a single-craft binding |

## Run it

```bash
cd chapter19/advanced_application_implementation/example/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_forge.ts
```

The harness seals a vault, writes a three-craft policy, loads the governor,
compiles the three projections, syncs twice, opens a governed session against
PhotoCraft, tries one denied command, and verifies the audit chain.

```
PASS three agents were compiled
PASS the Cursor server carries the sandbox roots
PASS the Cursor config carries no secret
PASS a second sync changes nothing
PASS the governed call reached the engine
PASS the refusal names the policy
PASS the audit chain verifies
PASS the audit entries are chained

20 assertions passed
```

## What it produces

Everything lands under `files/output/work/studio/`:

| artifact | what it is |
| --- | --- |
| `.cursor/mcp.json` | the Cursor projection — servers, sandbox roots, no secrets |
| `.cursor/rules/studio.mdc` · `.mcp.json` · `.claude/settings.json` · `opencode.json` | the other four projections |
| `audit/audit.jsonl` | the chained audit log: allowed and denied calls, each with its `prev` hash |
| `studio.policy.json` | the policy the harness wrote, with the sealed vault inside it |

## Notes

- **`photocraft-cli` must be on `PATH`** for the governed call. The projection
  step needs no engine at all.
- **No plaintext secret anywhere.** `sealVault` takes the passphrase (the
  harness uses a fixed one); the policy file carries ciphertext only, and the
  adapters never write the token into a client config.
- **Idempotence is an assertion, not a hope.** The second `sync()` is compared
  file by file, and the run fails if any projection changed.
- **DesignCraft is the exception that proves the schema.** It rejects the
  automation-root flags, which is why `sandboxFlags` is a policy field rather
  than a global assumption.
- Type-check it with `npm run check`.
