# 6. Exercise 4: Batch Layer-Contract Audit Across a Legacy PSD Archive -- solution

The worked answer to Exercise 4: a read-only, parallel auditor that opens every
PSD in an archive, canonicalizes its layer tree, compares it with a baseline and
writes a CI-friendly `pass` / `warn` / `fail` report.

## What it does

`treeHash` hashes identity and order: name, kind, visibility, opacity, fill,
blend mode, clip state, and every sibling position. Layer ids and engine
counters are excluded because they differ between builds. Order is included
because clipping is positional — a layer that moves one slot down clips to a
different base.

`inspectTree` adds the reasons behind a verdict without touching the hash. A
rasterized `Type::` layer, a clipped top-level layer or a missing `Background`
group is a hard failure; an orphan clip or a tree that merely differs from the
baseline is a warning.

A pool of `photocraft-cli mcp` children does the work, because one stdio server
serializes document state. Each worker opens, inspects and closes one document
before taking the next, so memory stays flat across a large archive. The report
is sorted by file path, and every entry carries its 64-hex tree hash, layer
count and deepest nesting depth.

The archive is read-only. The harness also calls `assertReadOnlyRefusal` to
prove that a `doc_save` aimed at the read root is rejected by the sandbox.

## The listings

| file | what it is |
| --- | --- |
| `04_batch-layer-contract-audit-across-a-legacy-psd-archive.ts` | canonical hashing, heuristics, verdict logic, worker pool and sandbox check |
| `run_ex4.ts` | the acceptance harness — builds the archive, audits it twice and checks every verdict |
| `package.json` | manifest — `npm run harness` runs the acceptance harness |
| `tsconfig.json` | the strict TypeScript configuration |

`src/audit-archive.ts` is a symlink to the worked file so the harness imports it
as the book's listing does.

## Run it

```bash
cd chapter6/solutions_and_explanations/exercise_4_batch-layer-contract-audit-across-a-legacy-psd-archive/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex4.ts
```

```
PASS the audit found all five files
PASS the report is sorted by path
PASS the identical copy passes
PASS the rename is a warn, not a fail
PASS the flat document fails on the missing group
PASS the top-level clip fails
PASS the corrupt file fails as unreadable
PASS every entry carries a 64-hex tree hash
PASS the same tree hashes to the same value
PASS the layer counts describe real trees
PASS the report repeats the baseline hash
PASS two passes agree bit for bit
PASS a write into the read root is refused

13/13 checks passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/baseline/aw26-hoodie-charcoal/banner.psd` | the pristine contract-shaped baseline |
| `output/baseline/aw26-hoodie-charcoal/inspect.json` | the baseline tree as the engine reports it |
| `output/archive/a-good.psd` | an identical copy — `pass` |
| `output/archive/b-renamed.psd` | one renamed layer — `warn` |
| `output/archive/c-flat.psd` | a flat document with no `Background` group — `fail` |
| `output/archive/d-topclip.psd` | a clipped layer at the top level — `fail` |
| `output/archive/e-broken.psd` | a file that is not a PSD — `fail` as unreadable |
| `output/audit/report.json` | the first audit, with baseline hash and all five entries |
| `output/audit-second/report.json` | a second, independent pass used for the determinism check |
| `output/report.json` | checks, verdict counts, archive sizes and SHA-256 hashes |
| `output/run_ex4.log` | the harness log — thirteen checks and their tally |

The run ends with one `pass`, one `warn` and three `fail` entries. Both audit
reports contain the same tree hashes and verdicts, which is the determinism
claim in concrete form.

## Notes

- **`photocraft-cli` must be on `PATH`.** The harness builds its fixtures with
  the engine, then the auditor spawns a pool of MCP workers.
- **The archive is never written.** `doc_open` and `doc_inspect` only read;
  `doc_close` releases the document. The one attempted write into the read root
  is expected to fail.
- The audit directory is the write root, so the report has somewhere legitimate
  to land even though the archive does not.
- Node.js 22.5+ and `npx tsx`.
