# 1. Exercise 4: Command Registry Topology Mapping for MCP-Aware Agents -- solution

The worked solution for Exercise 4: a read-only mapper that connects to
DesignCraft's MCP server, snapshots the 444-command registry twice, and turns
the disabled commands into six precondition buckets with an escape command for
each.

## What it does

`MCPServer` speaks line-delimited JSON-RPC 2.0 to `designcraft-cli mcp`. The
mapper calls `list_commands` twice:

- `enabledOnly: true` returns the 269 commands that can run right now;
- no flag returns all 444, including the 175 with a `disabled_reason`.

Each command is classified by the first matching pattern in a precedence-ordered
list: `NEEDS_TEXT_CARET`, `NEEDS_FRAME_OR_STORY`, `NEEDS_SELECTION`,
`NEEDS_DOCUMENT`, then the catch-all `NEEDS_STATE`; commands with no reason and
`enabled: true` are `ALWAYS_ENABLED`.

For every disabled bucket the mapper resolves an escape command from the
*enabled* set. Exact ids come first (`edit.selectAll`, `frame.create`,
`file.new`, `library.open`); only if none is enabled does it fall back to a
prefix family, and then the shortest match wins. That distinction matters:
`select.` also matches navigation commands that do not leave the disabled
state.

It also builds a top-ten domain histogram and, for each domain, ranks three
central commands by escape affinity plus how many sibling ids share their
prefix. The report is emitted inline on stdout because the DesignCraft MCP
server has no arbitrary-file write primitive; the harness persists it.

The mapper only calls `list_commands`. It never calls `execute`, `batch`,
`new_document` or `open_document`, so it is safe against a live session.

## The listings

| file | what it is |
| --- | --- |
| `04_command-registry-topology-mapping-for-mcp-aware-agents.py` | the MCP client, the bucket classifier, the escape resolver and the report |
| `run_ex4.py` | acceptance harness: runs the mapper, then recomputes every bucket and domain from a second live session |

## Run it

```bash
cd chapter2/solutions_and_explanations/exercise_4_command-registry-topology-mapping-for-mcp-aware-agents/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
../../../../.venv/bin/python run_ex4.py
```

The `PATH` export puts the `*-cli` binaries in front of any system install;
the repository venv is the interpreter the harness is tested with.

The harness runs the mapper, persists the inline JSON, and then opens a second
DesignCraft MCP session to verify the report against the live registry. It
exits non-zero on a failed check.

## What it produces

| artifact | what it is |
| --- | --- |
| `output/registry_topology.json` | the persisted report: snapshots, six buckets, escapes, domains, notes |
| `output/mapper.log` | the mapper's stdout and stderr |
| `output/run_ex4.log` | every acceptance check |
| `output/run-log.json` | check count, failures and the bucket summary |

## What the harness asserts

- the mapper exits cleanly and prints one JSON document;
- the two snapshots are 269 enabled and 444 total, and the enabled count is a
  subset of the total;
- there are exactly six buckets in precedence order; their counts partition
  all 444 commands and `ALWAYS_ENABLED` equals the enabled snapshot;
- every disabled bucket has a non-empty example and reason sample, and every
  escape is a command that is enabled in the live registry;
- the top-ten domain histogram is descending, has unique prefixes, and its
  central command lists match the live ranking;
- the mapper resolves the same bucket counts, examples, reasons and escapes
  when the harness recomputes them from a second session;
- `command_list` is not aliased: DesignCraft answers `unknown tool` with
  `isError: true`, which is the naming divergence the report documents;
- the persisted report round-trips without losing the bucket list.

## Notes

- DesignCraft calls its registry tool `list_commands`; the sibling suites use
  `command_list`. The mapper does not paper over the difference.
- The MCP client raises on a JSON-RPC error but a tool refusal arrives as a
  normal result with `isError: true` and an explanatory text block.
- The report's domain table is a top-ten view, not a partition: it accounts
  for 225 of 444 commands, and the harness checks that budget rather than
  expecting a sum to the registry size.
- The mapper is safe to run beside a live session because it never mutates
  the document model.
