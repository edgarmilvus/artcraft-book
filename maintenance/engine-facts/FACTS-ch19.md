# Chapter 19 — the engines' real MCP surfaces

Verified against the binaries in `tools/craft-cli/bin` (photocraft 0.8.2,
vectorcraft 0.10.0, designcraft 0.4.0, lightcraft 0.5.0, pdfcraft 0.5.0,
wordcraft 0.3.0, gridcraft 0.10.0, deckcraft 0.9.0). Nothing here is
inferred from documentation.

## The three engines of this chapter do not share a vocabulary

This is the single most important fact for the chapter, and every listing
has to respect it.

| | PhotoCraft | VectorCraft | DesignCraft |
| --- | --- | --- | --- |
| run one command | `command_run { id, params }` | `command_run { id, params }` | `execute { command, params }` |
| run many | `command_batch { steps }` | `command_batch { steps }` | `batch { commands }` |
| discover | `command_list { filter }` | `command_list { filter }` | `list_commands { filter, enabledOnly }` |
| new document | `doc_new { … }` | *(none — `file.new` is a command)* | `new_document { … }` |
| open / save | `doc_open` / `doc_save` | `open_file` / `save_file` | `open_document` / `save_document` |
| inspect | `doc_inspect { index? }` | `doc_inspect` | `inspect_document` |
| render | `doc_render_preview` | `render_preview` | `render_page { page, path, scale }` |
| place an image | `doc_place` | `insert_picture` | `place_image { frame, path }` |
| screenshot | `ui_screenshot { max_side }` | `ui_screenshot` | `screenshot` |

PhotoCraft's `command_run` takes **`id`** and `params`; DesignCraft's
`execute` takes **`command`** and `params`. VectorCraft has no `doc_new`
meta-tool at all — a document is created by running the `file.new`
*command*.

## The sandbox flags

`--automation-read-root` and `--automation-write-root` are accepted by
**PhotoCraft, FilmCraft, VectorCraft and DeckCraft**. They are *rejected*
by WordCraft, PdfCraft and GridCraft, whose `mcp` sub-command takes no
directory flag at all:

```
$ gridcraft-cli mcp --automation-read-root /tmp
gridcraft-cli: unknown option --automation-read-root
```

So a policy that projects the same roots into every client must know which
engines take the flags — a fact the chapter's adapters encode per craft.

## DesignCraft

- 444 commands. `links.list`, `links.relink`, `links.relinkFolder`,
  `links.update`, `font.list`, `font.replace`, `find.objects`,
  `find.find`, `story.get`, `story.setDirection`, `layout.pages.insert`,
  `swatch.create`, `swatch.addToSwatches`, `object.fill`,
  `select.firstAbove` and `page.transitions` all exist.
- **There is no `comment.*` command.** The comment commands are
  `note.new`, `note.edit`, `note.list`, `note.delete`, `note.convertToText`.
- `render_page`'s `page` is **0-based**, and its `scale` is "pixels per
  point (default 1 = 72 ppi)".
- `list_commands` takes `filter` and **`enabledOnly`** (camelCase), not
  `enabled_only`.
- `batch` takes `{ commands: [{ command, params }] }` — and the result
  interpolation works:

  ```
  batch → { completed: 2, results: [ { id: 8, story: 9 }, null ] }
  ```

  A later step may write `{"story": "$0.story"}` and the engine resolves it
  against the *first* step's result. A step that returns no such key fails
  with "`$0.story`: no `story` in {"id":10}" — which is the interpolation
  working, not the interpolation missing.

## VectorCraft

- 743 commands. The text command is **`text.create { x, y, text, size?,
  font?, color? }`**, not `type.create` (that is PhotoCraft's).
- `shape.rectangle { x, y, width, height, radius? }`,
  `paint.setFill { color }`, `file.new { width?, height?, … }` and
  `document.export { path?, format?, … }` all exist.
- The export formats are `svg | svgz | pdf | png | jpg | webp | gif | png8
  | txt | dxf | eps | emf | wmf | tiff | bmp | tga | psd | vectorcraft |
  template`.

## PhotoCraft

- 892 commands. `type.create { x, y, text, font?, size?, color?, … }`,
  `layer.newAdjustmentLayer.curves`, `layer.newAdjustmentLayer.levels`,
  `filter.blur.gaussianBlur { radius }` all exist.
- `doc_new` takes `width`, `height`, `mode` (`rgb|gray|cmyk|lab`), `depth`
  (`8|16|32`) and `background`; it answers `{ document: 0 }`.
- `doc_save` takes `path` and `format` — the format is an **extension**
  (`pcraft, psd, png, jpg, tif, webp, exr`), lower-case.
- `ui_screenshot` takes `max_side` (maximum 2048) and answers with an
  **image** content block.

## LightCraft

- 283 commands. The vocabulary is `album.*`, `albums.*`, `app.*`,
  `beforeAfter.*`, `catalog.*`, `crop.*`, `curve.*`, `denoise.*`,
  `develop.*`, `edit.*`, `export.*`, `faces.*`, `filter.*`, `folder.*`,
  `geometry.*`, `history.*`, `journal.*`, `keyword.*`, `label.*`,
  `library.*`, `mask.*`, `merge.*`, `metadata.*`, `photo.*`,
  `pointColor.*`, `preset.*`, `presets.*`, `profile.*`, `profiles.*`,
  `redeye.*`, `segment.*`, `spot.*`, `stack.*`, `version.*`.
- The development commands are `develop.set { control?, value?, values?,
  ids? }`, `develop.adjust`, `develop.get`, `develop.curve`,
  `develop.controls`, `develop.matchExposure` and `develop.reset`.
- **The slider names are control ids, not command ids.** `develop.controls`
  reports them: `light.exposure` (−5..5, two decimals), `light.contrast`,
  `light.highlights`, `light.shadows`, `light.whites` and `light.blacks`
  (−100..100), `wb.temp` (2000–50000 K) and `wb.tint` (±150) — *not*
  `color.temperature` and `color.tint` — `color.vibrance`,
  `color.saturation`, and `mixer.<band>.hue` / `mixer.<band>.sat` /
  `mixer.<band>.lum`.
- `develop.adjust` and `develop.controls` act on the **active** photo: it
  has to be selected first with `library.select`.
- The keyword writer is `photo.setMeta { ids, addKeywords }`; there is no
  `metadata.set`, and `photo.inspect` reads the keywords back at
  `meta.keywords`.
- `render_photo { id?, path?, size?, format? }` has no `quality` argument —
  the byte budget goes through the `export` tool (`quality`, `limitKb`).
- `lightcraft-cli --control PORT` answers "unknown subcommand": the CLI
  cannot open the TCP control channel, so stdio is the only automation
  surface.
- `command_list` takes `{ filter, enabled_only }` — **snake_case**, unlike
  DesignCraft's `enabledOnly`.

## PdfCraft

- 183 commands *and* about 150 meta-tools. The distinction matters:
  `redact.mark`, `redact.apply`, `redact.clear`, `redact.sanitize`,
  `redact.search`, `file.open`, `file.save` and `doc.compare` are in the
  **command registry**; `pdfa_convert`, `pdfa_verify`, `accessibility_check`,
  `accessibility_report`, `sign_list`, `doc_info`, `doc_hidden_info` and
  `text_extract` are **tools**.
- **A registry entry is not the same as a reachable command.** The
  redaction commands have no headless tool — `command_list` reports
  `tool: null` for them — so `command_run { id: "redact.mark" }` fails
  with `command "redact.mark" has no headless tool; see command_list`.
  The meta-tools `redact_mark`, `redact_apply` and `redact_clear` are the
  only way to reach them.
- The real command ids for the conformance and accessibility passes are
  `standards.pdfa` and `a11y.report`; `sign.validate` and `export.docx`
  are the other two the chapter leans on. `file.export` does not exist.
- The `enabled` flag in `command_list` mirrors the *desktop app's*
  contextual state — only 32 of the 183 commands are ever enabled, and
  `redact.mark` is always false — so "assert that it is enabled" is not a
  headless gate.
- `redact_mark { find }` and `text_find { query }` are **literal**
  searches, not regular expressions.
- PdfCraft's `mcp` takes `--root DIR`, not the automation flags, and it
  *silently ignores unknown options* — so without `--root` it has no path
  confinement at all. The refusal is
  `<path> is outside the allowed directory <root>`.
- `redact_mark` *fails* when a pattern matches nothing ("nothing matched,
  so nothing was marked"), and it answers `{ marked, marks_pending,
  pages_marked }`; `redact_apply` answers `{ applied }`.
- `sign_list` answers `{ all_valid, count, signatures[] }`, and a signature
  carries `status` (`valid|unknown|invalid`), `modification`
  (`none|allowed|disallowed`), `revision` and a `certificate` descriptor
  (subject, issuer, serial, SHA-256 fingerprint, validity window).

## GridCraft

- 341 commands and 21 meta-tools; `execute_command { command, params }`,
  `list_commands { search }`, `inspect_workbook`, `new_workbook`,
  `open_workbook`, `save_workbook`, `write_range`, `set_cell`,
  `get_cell`, `read_range`, `format_range`, `evaluate_formula`.
- No batch tool, no `.grid` container, and no directory flag.

## DeckCraft

- 321 commands and 25 meta-tools; `run_command { command, params }`,
  `batch { commands, keepGoing }`, `list_commands { filter }`,
  `new_presentation`, `open_presentation`, `save_presentation`, `export`,
  `inspect_document`, `inspect_slide`, `render_slide`, `add_slide`,
  `add_text_box`, `set_text`, `insert_table`, `insert_chart`.
