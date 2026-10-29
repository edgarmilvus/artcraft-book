# 6. Advanced Application Implementation

A production worker that a SaaS web tier invokes to turn structured JSON job
payloads into layered, clipping-mask-conditioned, OkLCh-graded PSD brand
assets. It speaks to `photocraft-cli mcp` exclusively through the official
meta-tools (`doc_new`, `command_run`, `command_batch`, `doc_inspect`,
`doc_render_preview`, `doc_save`).

## What it does

The worker receives a manifest that specifies canvas size, palette, headline
type and OkLCh tone stops. It creates a 16-bit RGB document, paints a backdrop
and a card, builds a frame matte from an inset selection, adds a vignette,
a chroma trim and a Lab curves layer, places the headline, then renames,
clips and re-blends the stack in two `command_batch` calls.

Layer ids come straight off each creation reply (`createTrackedLayer`), so the
orchestrator never re-reads the tree to find out what it just made. The final
`doc_save` writes the layered PSD, the preview PNG is written from the
in-memory `doc_render_preview` bytes, and the report carries every layer id
plus the engine's save warnings.

## The listings

| file | what it is |
| --- | --- |
| `01_psd-brand-forge.ts` | the complete worker: manifest validation, bridge client, orchestration, vision QA, JSON-lines CLI |
| `src/psd-brand-forge.ts` | symlink to the same file, so `run_forge.ts` can import it |
| `package.json` | npm scripts (`forge`) and dependencies |
| `tsconfig.json` | TypeScript config with `strict: true` |

## Run it

```bash
cd chapter6/advanced_application_implementation/example/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_forge.ts
```

The harness runs the worker against a real engine child, then asserts on the
layer tree it produced:

```
19/19 checks passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/run_forge.log` | the harness log, nineteen checks |

The harness writes into a `mkdtemp` directory and removes it on exit, so no
PSD is left in the repository. It does produce a layered `8BPS` file (eight
layers, four of them clipped) and a 1024-pixel PNG preview; call
`runBrandForgeJob()` with your own client roots to keep both.

## Notes

- `photocraft-cli` must be on `PATH` (via `tools/craft-cli/bin`).
- There is no `wait` flag on the save: `doc_save` takes only `path`, and the
  extension chooses the writer. `runCommand` defaults `wait: true` and the
  orchestrator never overrides it, so every creation call is synchronous.
- The manifest is Zod-validated before a child process exists.
- Vision QA returns `null` when `OPENAI_API_KEY` is unset; that is a supported
  outcome, not a failure.
- The curves layer is built with `lightness`, which puts it in Lab space. Note
  that the space flag is not written to the PSD: reopening the saved file
  reports `space: "Rgb"` with the same anchors in `per_channel[0]`.
