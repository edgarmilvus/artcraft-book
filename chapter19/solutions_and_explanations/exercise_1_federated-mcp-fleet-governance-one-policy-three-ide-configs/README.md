# 19. Solutions and Explanations

The worked solution to Exercise 1. One master file states what the studio wants;
the generator resolves it into a signed lockfile and a *station* per role — three
client configurations each, every one of them pointed at a policy shim rather
than at an engine. It is the same problem as the chapter's governor, one scale
up: constraint in, resolution out, and a compliance bot able to verify a running
workstation without touching the vault.

## What it does

```
mcp.fleet.json      the constraint: roles, engines, capabilities, roots, vault pointers
      │
      ├─ resolveFleet / resolveRole       one concrete server set per role
      ├─ roleCapabilitiesSha256           the capability digest a shim refuses to run without
      ├─ mcp.fleet.lock.json              the resolution, HMAC-signed, one entry per role×server
      ├─ mcp.fleet.manifest.sha256        a digest per file the run wrote
      └─ stations/<role>/                 .cursor/mcp.json · .mcp.json · opencode.json
```

The engine registry is a table, and the table is the whole point: PhotoCraft
runs a command through `command_run { id }`, DesignCraft through
`execute { command }`, EffectCraft through `execute_command { command }`;
discovery is `command_list { filter }` or `list_commands { filter }`, and the
"enabled only" switch is `enabled_only` in LightCraft and `enabledOnly` in
DesignCraft. A generator that hard-codes one spelling audits nothing.

The second table is the sandbox. `--automation-read-root` and
`--automation-write-root` are honored by PhotoCraft, FilmCraft, VectorCraft and
DeckCraft; the others refuse them or ignore them silently. So every resolved
server records `enforcement: "engine" | "worker"`, and the shim invocation only
carries the flags the engine will accept.

Each station's config names the shim, `mcp-shim`, with `--role`, `--read-root`,
`--write-root`, `--cap-hash`, `--fleet-lock` and `--vault-key-ref`, and the real
binary after `--real-binary`. The shim is what refuses a denied command (exit
40), an approval-gated one with no token (41), a path outside the roots (42), a
lock that does not describe the role (43) and a capability hash that does not
match (44). The environment carries vault pointers only; the plaintext never
reaches a config file.

The generator also refuses to produce anything from a policy that is
incoherent: an unknown role, a literal secret in the environment, a role whose
roots widen past its server's, a command that is both allowed and denied — each
is a policy error with a name, not a crash.

## The listings

| file | what it is |
| --- | --- |
| `01_generator.ts` | the generator: the engine-registry table, the fleet schema, resolution, the HMAC envelope, the three derivations, and `assertRegistrySubset` |
| `run_ex1.ts` | the harness — a fixed clock, a fixed secret, four roles, and the drift and refusal passes |

## Run it

```bash
cd chapter19/solutions_and_explanations/exercise_1_federated-mcp-fleet-governance-one-policy-three-ide-configs/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex1.ts
```

The harness writes the master policy and its five variants, generates the fleet,
regenerates it later and drifted, and then feeds it four incoherent policies.

```
PASS the envelope signature verifies
PASS a tampered envelope fails verification
PASS DesignCraft runs a command through `execute { command }`
PASS the worker never hands a rejecting engine a sandbox flag
PASS a second run is byte-identical
PASS a later run changes only the timestamp and the signatures
PASS the generator refuses a literal secret in the environment

75 assertions passed
```

## What it produces

Everything lands under `output/work/`; the headline files are also copied to
`output/`:

| artifact | what it is |
| --- | --- |
| `output/mcp.fleet.lock.json` | the signed resolution (also under `work/build/`) |
| `output/mcp.fleet.manifest.sha256` | the per-file digests |
| `output/mcp.fleet.json` | the master policy |
| `output/motion-senior.cursor.mcp.json`, `.claude.mcp.json`, `.opencode.json` | the three client projections for one role |
| `build/mcp.fleet.lock.json` | the signed resolution: one entry per role and server, with roots, dialect and enforcement |
| `build/mcp.fleet.manifest.sha256` | one digest per file the run wrote |
| `work/build/stations/<role>/.cursor/mcp.json` | the Cursor projection for that role |
| `work/build/stations/<role>/.mcp.json` | the Claude Code projection (project scope) |
| `work/build/stations/<role>/opencode.json` | the OpenCode projection, with per-server `enabled` flags |
| `build-later/` · `build-drifted/` | the same, for the later run and the drifted policy |
| `policy/mcp.fleet.json` · `edited` · `literal` · `overlap` · `widened` | the master policy and the four policies the generator must refuse |

The four roles are `junior-editor`, `motion-senior`, `colorist-senior` and
`compliance-auditor`.

## Notes

- **No engine is spawned.** The generator is a compiler; it needs no binary on
  `PATH`, which is why it runs on CI.
- **The clock and the secret are injected.** `generateFleet` takes `now` and
  `secret`, so the byte-identity assertion is meaningful: two runs at the same
  instant with the same secret produce the same bytes.
- **`shimPath` defaults to `<outDir>/bin/mcp-shim`.** The shim is the operator's
  binary; this project compiles the configuration that points at it.
- **Drift is a feature.** Editing an allow-list changes the capability digest
  and the envelope signature, and a lock drifted from its master still verifies
  against its own master but no longer against the original.
- Type-check it with `npm run check`.
