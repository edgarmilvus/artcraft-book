# 4. Exercise 2: Autonomous Agentic Asset Resolution — solution

The worked solution for Exercise 2. The resolver speaks MCP to the real
DesignCraft engine, repairs a broken placed-image link, and saves the repaired
document as a native `.designcraft` package that DesignCraft reopens.

## What it does

`AssetResolutionRunImpl.resolve(idmlPath, outputPath)`:

1. Rejects an absolute output path outside `AUTOMATION_ROOT` before opening a
   session or touching the filesystem.
2. Starts `designcraft-cli mcp` in `AUTOMATION_ROOT` and opens the IDML
   package.
3. Enumerates the link table and keeps the entries whose `status` is not
   `ok`. The solution never rewrites a healthy link.
4. Runs the deterministic passes first: the original folder, the candidate
   folder, then the broadened search roots from `SEARCH_DIRS`. The fixture's
   moved image is found under `incoming/` as `campaign-cover-v1.png`.
5. Relinks the found asset, refreshes the link metadata, and rolls back the
   in-memory change if a later step fails.
6. Saves the document with `save_document` inside the automation write root.
   DesignCraft writes its native `.designcraft` container, so the harness
   names the output `asset-resolved.designcraft` rather than pretending the
   bytes are an IDML package.
7. Returns the resolved ids, unresolved ids and per-asset attempts.

The batch itself is the exercise's four-step repair: delete the old guides,
create a 6×4 grid, update the link metadata, and save only after the batch
reports success. A failed batch is undone step by step before the error is
rethrown.

## Run it

```bash
export PATH="$PWD/tools/craft-cli/bin:$PATH"
cd chapter4/solutions_and_explanations/exercise_2_autonomous-agentic-asset-resolution-claude-code-via-mcp-resolving-an-unmapped-pl/files
npx tsx run_ex2.ts
```

The harness:

1. Builds a 1024×768 document with the real DesignCraft engine, places
   `assets/hero-flat-v3.png` (shipped with the project), and exports
   `in/asset.idml` with `embedImages: false`.
2. Reopens the package and confirms the placed link is `missing` after the
   working copy is moved to `holding/`.
3. Runs the resolver against `out/asset-resolved.designcraft`.
4. Reopens the saved package with DesignCraft and reads its link table back.
5. Checks that the write-root guard rejects `/tmp/asset-run-outside.idml` and
   that no such file is created.

### What the output means

The resolver reports `resolved: [8]` and an empty `unresolved` list. That id
is the link entry created by `file.place`; it is stable for the fixture, not
part of the public contract. The attempt log has one `relink` attempt and the
candidate ends in `campaign-cover-v1.png`.

The fixture IDML is 8567 bytes. The saved native package is 12970 bytes and
reopens with a link table of `["ok"]`; that reopened table is the acceptance
criterion, not the extension of the output file. The output is inside
`AUTOMATION_ROOT`, so it passes the same guard a production run uses.

## What it produces

| artifact | what it is |
| --- | --- |
| `output/asset-run/in/asset.idml` | the fixture exported by DesignCraft |
| `output/asset-run/incoming/campaign-cover-v1.png` | the surviving copy the resolver finds |
| `output/asset-run/archive/campaign-cover-v1.png` | a second search-root copy |
| `output/asset-run/holding/campaign-cover.png` | the moved-away working copy that breaks the link |
| `output/asset-run/out/asset-resolved.designcraft` | the repaired native document |
| `output/run-log.json` | check count, failures, resolved count, attempt count and byte sizes |
| `output/run_ex2.log` | harness log with all 11 assertions |

The run ends with `11/11 checks passed`.

## Notes

- **DesignCraft must be on `PATH`.** The harness sets `PATH` through
  `run_all.sh`; when running manually, include `tools/craft-cli/bin`.
- `AUTOMATION_ROOT` defaults to the solution's `output/asset-run`. The
  harness sets `CANDIDATE_DIR` and `SEARCH_DIRS` to the fixture folders.
- The image fixture is shared with Chapter 1, so the check proves a real PNG
  round-trip rather than a generated placeholder.
- `save_document` writes DesignCraft's native container. Naming that output
  `.idml` would be misleading and would fail `open_document` on the next run;
  the harness keeps the extension honest and verifies the reopened links.
- Node.js 22.5+ and `tsx` are required.
