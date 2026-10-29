# 19. Basic Code Example

The "hello world" of studio governance: one TypeScript module that reads the
same `.cursor/mcp.json` that Cursor, Claude Code and OpenCode read, validates it,
spawns the PhotoCraft engine under the roots the config declares, and makes one
governed mutation — `doc_new`, one `command_run`, `doc_save`.

## What it does

The module is thirty lines of behavior and three hundred lines of explanation,
and the explanation is the point: it demonstrates the three runtime pillars the
chapter names.

1. **ESM.** Every dependency is a static `import`; there is no `require()` and
   no dynamic loading, so the TypeScript server in an editor, a model reading
   the source, and the bundler all see the same graph. `import.meta.url`
   replaces `__dirname`, because a bundle loaded from elsewhere still has to
   know where it came from.
2. **The event loop.** `readFile`, `connect` and `callTool` all suspend their
   frame and return control to the loop, so one process can host many studios.
3. **WASM parity.** The bridge never touches WASM, but it depends on it: the
   command id it sends — `type.create` — is the same string whether the engine
   runs in a browser, a CI runner or the desktop app.

The flow is: read `.cursor/mcp.json` from the working directory, `StudioConfig.parse`
it (a Zod failure throws before any subprocess is spawned), look up the
`photocraft` entry by name, spawn `photocraft-cli mcp` with the entry's `args`
and merged `env`, then `doc_new { width: 1920, height: 1080, mode: "rgb" }`,
`command_run { id: "type.create", params: { text, font, size, color, x, y } }`,
and `doc_save { path: "hello.psd" }`.

The engine enforces the roots: `--automation-read-root` is the studio and
`--automation-write-root` is `render/`, so the save lands inside the write root
no matter what path was asked for.

## The listings

| file | what it is |
| --- | --- |
| `01_studio-bridge.ts` | the bridge — the shared config schema, `loadStudioConfig`, `openGovernedSession`, `main`, and a top-level `await main()` with an explicit rejection handler |

## Run it

```bash
cd chapter19/basic_code_example/example/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_basic.ts
```

The harness writes the studio's `.cursor/mcp.json`, runs the module with the
studio as its working directory, then checks the artifact and makes one escape
attempt of its own.

```
PASS the shared config was written
PASS the bridge ran
PASS the document was saved inside the write root
PASS the document is not empty
PASS the artifact landed under the declared write root

7 assertions passed
```

## What it produces

Everything lands under `output/work/`:

| artifact | what it is |
| --- | --- |
| `work/studio/.cursor/mcp.json` | the shared config the bridge reads: the `photocraft` entry, its `mcp` args, the two roots, the token in `env` |
| `work/studio/render/hello.psd` | the document, saved inside the declared write root (in the `outputs-v1` release bundle, not committed) |
| `work/outside.psd` | the output of the harness's escape attempt through `photocraft-cli run`, the one-shot sub-command that is *not* behind the MCP roots |

## Notes

- **`photocraft-cli` on `PATH`.** The bridge itself never hard-codes it — the
  command comes from the config entry, which is the whole governance claim.
- **The config is the contract.** `.cursor/mcp.json`, Claude Code's settings and
  OpenCode's `mcp.json` all feed the same Zod schema; a hand-edited extra field
  makes the bridge refuse to start.
- **`npx tsx`, not `node`.** The harness runs the module through `tsx` so the
  `.js` specifiers resolve.
- Type-check it with `npm run check`.
