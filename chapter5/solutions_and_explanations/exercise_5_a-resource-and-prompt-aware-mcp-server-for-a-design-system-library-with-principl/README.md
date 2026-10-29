# 5. Exercise 5: A Resource-and-Prompt-Aware MCP Server for a Design-System Library with Principle-of-Least-Privilege Access — solution

The worked answer to Exercise 5: the capability design for one design-system
MCP server shared by three agents. The deliverable is the scope table, the
handler contract and the anti-enumeration policy, not a running transport.
The harness turns that design into inspectable matrices and a policy file.

## What it does

Each session gets a `ScopeDocument`: an opaque token, permitted resource URI
prefixes, permitted templates, a tool list, a prompt list and separate read
and write roots. All three agents share `/work/design-system` for reads and
each gets its own `/work/scratch/<agent>` for writes.

The handler contract has seven members: `listResources`,
`listResourceTemplates`, `readResource`, `listTools`, `callTool`, `listPrompts`
and `getPrompt`. The design fixes a check order for each. Resources are parsed,
permission-checked, resolved under the read root, re-checked after symlink
resolution, then read or derived. `designsystem://tokens/contrast-pairs` is
computed, so its body is marked `_source: "derived@wcag21"`; static reads are
marked `_source: "static"`.

The anti-enumeration rule is the spine: an ungranted tool, prompt or resource
returns the same generic `-32601` as one that does not exist. `listTools`,
`listResources` and `listPrompts` are filtered server-side, so an unauthorized
capability is invisible rather than merely uncallable. Layout is the only agent
that can enumerate `designsystem://templates/{templateName}`; copywriting and
color get `{ templates: [] }`, which looks identical to a server with no
templates.

## The listings

| file | what it is |
| --- | --- |
| `05_a-resource-and-prompt-aware-mcp-server-for-a-design-system-library-with-principle-of-least-privilege-access.ts` | the types, handler contract, behavior spec, `ErrorCodes` and `SCOPES` |
| `run_ex5.ts` | the acceptance harness — thirteen design checks plus the exported matrices |

## Run it

```bash
cd chapter5/solutions_and_explanations/exercise_5_a-resource-and-prompt-aware-mcp-server-for-a-design-system-library-with-principl/files
npx tsx run_ex5.ts
```

```
capability table

PASS three agents share one read root and never share a write root
PASS copywriting sees one tool, no prompts, no templates
PASS layout is the only agent that can enumerate templates
PASS resource prefixes do not overlap between agents
PASS the color agent sees the composite contrast resource
PASS prompt grants match the three-agent table
PASS every granted tool is a design-system tool, never a raw engine id
PASS scopes carry a placeholder token, never key material
PASS error codes are distinct and negative
PASS the anti-enumeration codes are the ones the spec reserves
PASS the visibility matrix shows the shared read root without leaking grants
PASS handler policy keeps not-allowed indistinguishable from not-found
PASS capability matrix and access artefacts were written

13/13 checks passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/scopes.json` | the three `ScopeDocument` values with placeholder tokens |
| `output/capability-matrix.json` | per-agent roots, resources, templates, tools, prompts and counts |
| `output/visibility.json` | which agents can see each known resource, tool and prompt |
| `output/access-matrix.csv` | the same grants in a one-row-per-agent review table |
| `output/handler-policy.json` | check order per handler, anti-enumeration rule, composite resource and error codes |
| `output/report.json` | all thirteen results and the per-agent summary |
| `output/run_ex5.log` | the harness log — thirteen checks and their tally |

No engine is driven. The visible artifacts are the security design itself:
the matrices make it possible to audit that copywriting cannot enumerate
layout's templates, that color alone can see the derived contrast pairs, and
that every write root is private.

## Notes

- **No engine and no MCP transport.** The solution is a TypeScript
  specification; the harness imports the table and asserts over it.
- The tokens in `SCOPES` are the literal string `<opaque>` on purpose — the
  file must never carry key material, which one check enforces.
- `ErrorCodes` fixes the six codes the server may return: `-32601`, `-32602`,
  `-32010`, `-32011`, `-32012` and `-32013`.
- Node.js 22.5+ and `npx tsx`.
