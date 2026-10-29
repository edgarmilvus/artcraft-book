# Chapter 19 — Full-Stack Studio Governance - Integrating Cursor (.cursor/mcp.json), Claude Code, and OpenCode

The chapter turns a hand-maintained pile of per-IDE MCP configuration files
into a single governed policy: one source of truth, mechanically projected
into Cursor's `.cursor/mcp.json`, Claude Code's `.mcp.json` and OpenCode's
`opencode.json`, with every command checked against the policy and every
decision written to a hash-chained audit log.

## The projects

Each project has its own README with the command to run it and the
artifacts it writes.

| project | what it is |
| --- | --- |
| [Advanced Application Implementation](advanced_application_implementation/example/) | Three agents — Cursor, Claude Code, OpenCode — against eight engines, and one policy that decides what each of them may run. |
| [Basic Code Example](basic_code_example/example/) | The "hello world" of studio governance: one TypeScript module that reads the same .cursor/mcp.json that Cursor, Claude Code and OpenCode read,… |
| [Solution — Exercise 1](solutions_and_explanations/exercise_1_federated-mcp-fleet-governance-one-policy-three-ide-configs/) | The worked fleet generator: one policy, signed lockfile and three client projections per role. |
| [Solution — Exercise 2](solutions_and_explanations/exercise_2_autonomous-asset-remediation-in-designcraft-with-claude-code-and-command-batch/) | The worked DesignCraft remediation: relink, font, reflow, swatch and certificate. |
| [Solution — Exercise 3](solutions_and_explanations/exercise_3_multimodal-colour-grading-loop-with-lightcraft-tcp-auth-and-a-vision-llm/) | The worked color loop: TCP auth, catalog, bounded nudges and restart. |
| [Solution — Exercise 4](solutions_and_explanations/exercise_4_supervisor-worker-delegation-for-filmcraft-timeline-assembly/) | The worked supervisor: least-loaded assignment, policy refusal and HMAC journal. |
| [Solution — Exercise 5](solutions_and_explanations/exercise_5_policy-enforced-batch-redaction-and-archive-with-pdfcraft-headless-opencode-and-/) | The worked redaction pipeline: policy, signed-input queue and signed manifests. |
| [Solution — Exercise 6 (Stretch)](solutions_and_explanations/exercise_6_cross-suite-asset-provenance-ledger/) | The worked provenance ledger: HMAC chain, SQLite audit, reconciliation and tamper evidence. |

## What you need

Node.js 22.5+, Python 3.10+ and the engine binaries — or just Docker. The
root README sets out both paths and the one-time setup:
[what you need](../README.md#what-you-need) and
[install](../README.md#install).

## Run everything

```bash
./chapter19/run_all.sh
```

The script runs every harness in the chapter, prints one line per
harness, and exits non-zero if any of them fails. Each harness leaves
its log in the `output/` directory of the project it exercises.

To run a single project, open its README: it gives the exact command
and the environment that command needs.

## Notes on the engines

The details that will bite you first:

- **The engines do not share a meta-tool vocabulary** — PhotoCraft runs
  `command_run { id, params }`, DesignCraft runs `execute { command,
  params }`, EffectCraft runs `execute_command`, DeckCraft runs
  `run_command`.
- **Only four engines accept the sandbox flags** — PhotoCraft, FilmCraft,
  VectorCraft and DeckCraft. The rest reject them and are bounded by their
  working directory instead.
- **VectorCraft has no `doc_new`** — a document is created by running the
  `file.new` command, and its text command is `text.create`.
- **DesignCraft has no `comment.*` command** — the comment commands are
  `note.new`, `note.edit` and `note.list`.
- **LightCraft's vocabulary is not `light.*`** — it is `develop.*`,
  `photo.*`, `curve.*`, `filter.*` and so on.
- **PdfCraft's commands and its tools are different things** —
  `redact.mark` is a command; `pdfa_verify` and `sign_list` are tools.
