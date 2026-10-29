# 14. Exercise 4: Live TCP Rigging — solution

The worked live rig panel. It authenticates first on the loopback socket,
injects a repeater + trim rig as one batch, updates the stagger in place, and
captures a Program-monitor screenshot.

## What it does

1. `CraftLiveClient` sends the `auth` frame before any other frame and rejects
   a non-64-hex token.
2. `editor.state` must report exactly one selected shape layer.
3. `injectRig()` posts one atomic `engine.batch` that adds a repeater, a trim,
   initial `copies`/`offset` keys and a `rig.stagger.v1` comment.
4. `setStagger()` discovers the existing offset key and updates it instead of
   appending a duplicate.
5. `screenshot()` refuses absolute or `..` paths and writes the base64 image
   under the configured write root.
6. `reset()` only undoes a state whose top history label is the rig's own; it
   reports `skipped` for a timeline it does not own.

## Run it

```bash
cd chapter14/solutions_and_explanations/exercise_4_live-tcp-rigging-on-the-loopback-control-channel-repeater-trim-choreography/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex4.ts
```

```
16 assertions passed
```

A local authenticated JSON-lines stub stands in for the desktop control
channel; the client code and all frame shapes are the real ones.

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/write/preview.png` | a 1280×720 Program-monitor screenshot |
| `output/report.json` | assertion count, frame-call count and artifact list |
| `output/run_ex4.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/04_live-tcp-rigging-on-the-loopback-control-channel-repeater-trim-choreography.ts` | TCP client, auth/framer, rig batch, stagger setter, screenshot and reset |
| `files/run_ex4.ts` | the acceptance harness: stub server, auth, batch, screenshot and undo |
| `files/01_typescript.ts` | the live-client and frame contract |

## Notes

- The auth frame is mandatory and first; there is no unauthenticated mode.
- Screenshots are sandboxed relative to the write root.
- The reset is non-destructive and state-owned.
- Type-check it with `npm run check`.
