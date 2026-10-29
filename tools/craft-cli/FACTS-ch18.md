# GridCraft and DeckCraft — the verified API surface

Everything below was checked against the real binaries (`gridcraft-cli`
0.10.0, `deckcraft-cli` 0.9.0) with the MCP stdio transport. Nothing here
is inferred from documentation.

## The transports

```bash
gridcraft-cli mcp [--connect PORT] [--in FILE | --sample NAME]
deckcraft-cli mcp [--connect PORT] [--sample]
                [--automation-read-root DIR] [--automation-write-root DIR]
```

- **GridCraft takes no directory flag at all.** `--automation-read-root` is
  an *error* ("unknown option"), not a no-op. Its boundary is the working
  directory it is given (`cwd` on the transport), and it does not police the
  result — an absolute path is written wherever it points.
- **DeckCraft does take `--automation-read-root` / `--automation-write-root`**
  and enforces them ("files confined: read root …, write root …").

## GridCraft's MCP tools

`execute_command`, `list_commands`, `inspect_workbook`, `read_range`,
`write_range`, `set_cell`, `get_cell`, `evaluate_formula`, `select`,
`format_range`, `insert_chart`, `create_table`, `sort_range`, `filter`,
`open_workbook`, `save_workbook`, `new_workbook`, `undo`, `redo`,
`screenshot`, `list_functions`.

### The tools that matter

| tool | arguments | answers |
| --- | --- | --- |
| `new_workbook` | `{ sample?: "budget"\|"sales"\|"grades" }` | `{ index, title }` — a fresh workbook has one sheet, `Sheet1` |
| `execute_command` | `{ command, params }` | the command's own payload |
| `list_commands` | `{ search? }` | `[{ id, label, menu, params, shortcut, enabled }]` — 341 commands |
| `inspect_workbook` | `{}` | `{ title, path, dirty, calcMode, activeSheet, activeCell, sheets[], names[], undo[], redo[] }` |
| `read_range` | `{ range, sheet?, formulas?, formatted? }` | `{ range, sheet, values[][] }` |
| `write_range` | `{ range, values[][] }` | `{ cells }` — a string starting with `=` is a formula |
| `set_cell` | `{ cell, input }` | `{ cell, value }` — `input` is text, a number or `=formula` |
| `get_cell` | `{ cell }` | the whole cell record: `value`, `formula`, `input`, `style`, … |
| `evaluate_formula` | `{ formula, cell? }` | the evaluated value |
| `format_range` | `{ range, numberFormat?, bold?, fontSize?, fillColor?, … }` | `{ applied, range }` |
| `save_workbook` | `{ path }` | `{ bytes, path }` |
| `open_workbook` | `{ path }` | the workbook's payload |

`inspect_workbook` has **no** `styles` key, **no** `revision` key and **no**
`namedRanges` key — the names are in `names`, and the revision has to be
computed by the caller (the SHA-256 of the saved bytes is the honest
answer).

### The commands that matter

| command | parameters | notes |
| --- | --- | --- |
| `cell.set` | `{ cell?, input, sheet? }` | the only way to write a cell |
| `cell.get` | `{ cell?, sheet? }` | the full cell record |
| `range.setValues` | `{ range?, values }` | the command behind `write_range` |
| `home.insertSheet` | `{ name?, before? }` | `{ index, name }` |
| `sheet.rename` | `{ sheet?, name }` | `sheet` is the *name* or the index |
| `sheet.activate` | `{ sheet? }` | the trace commands work on the active sheet |
| `sheet.read` | `{ range?, sheet?, formulas?, formatted? }` | the values of a range |
| `formulas.defineName` | `{ name, refersTo?, scope?, comment?, oldName?, oldScope? }` | `refersTo` is `"=Sheet!$B$2"` |
| `formulas.nameManager` | `{}` | `[{ name, refersTo, scope, value, comment }]` |
| `formulas.calculateNow` | `{}` | force a recalc |
| `formulas.errorChecking` | `{}` | `{ circular: ["Sheet!C2"], errors: [{ cell, error, formula, sheet }] }` |
| `formulas.tracePrecedents` | `{ cell? }` | `[{ range, sheet }]` — the cell must be on the **active** sheet |
| `formulas.traceDependents` | `{ cell? }` | `[{ cell, sheet }]` |
| `file.save` | `{ path? }` | **xlsx by default**; `.csv`, `.tsv`, `.json`, `.html` by extension |
| `file.exportCsv` | `{ path, sheet? }` | `{ bytes, path }` |
| `file.open` | `{ path }` | |
| `data.fromTextCsv` | `{ path \| text, delimiter?, sheet? }` | imports into a **new** sheet as a table |

### The facts that will bite you

- **There is no `.gridcraft` container.** `file.save` accepts `.xlsx`,
  `.csv`, `.tsv`, `.json` and `.html`; anything else is refused with
  "unknown file format".
- **There is no batch tool.** Every write is its own round trip, and the
  writes are *not* atomic. Build in a scratch workbook and publish it with
  one rename if you need all-or-nothing semantics.
- **A circular reference evaluates to `#CIRC!`** and the cell reads back as
  `{"error": "#CIRC!"}`. `formulas.errorChecking` names the cells in the
  cycle.
- **A named range may contain dots but not hyphens.** `"FX.EUR.USD"` is
  accepted; `"Helios-US.Amount.Rev_Net"` answers "The name that you
  entered is not valid." Sanitize the entity key.
- **The trace commands work on the active sheet.** `formulas.tracePrecedents
  { cell: "Revenue!B2" }` is refused with "… names a sheet other than the
  one this command works on" unless `Revenue` is active. Activate the sheet
  first and address the cell without a qualifier.
- **`cell.set` takes one cell.** A sheet's cells are written one call at a
  time, or in one `write_range` with a row of values.
- **The MCP reply carries the payload in the first `text` content block**
  and does *not* populate `structuredContent`. A failing tool answers with
  `isError: true` and a plain sentence — check the flag before the parse.

## DeckCraft's MCP tools

`list_commands`, `run_command`, `batch`, `new_presentation`,
`open_presentation`, `save_presentation`, `export`, `inspect_document`,
`inspect_slide`, `render_slide`, `add_slide`, `go_to_slide`, `add_shape`,
`add_text_box`, `set_text`, `insert_picture`, `insert_table`,
`insert_chart`, `select`, `pointer`, `select_tool`, `key`, `type_text`,
`screenshot`, `call_app`.

| tool | arguments | answers |
| --- | --- | --- |
| `new_presentation` | `{ theme?, blank? }` | the presentation's payload |
| `run_command` | `{ command, params }` | the command's own payload |
| `batch` | `{ commands: [{ command, params }], keepGoing? }` | the steps' payloads — a **real** batch |
| `list_commands` | `{ filter? }` | 321 commands |
| `add_slide` | `{ layout?, title?, body? }` | `{ index, … }` |
| `add_text_box` | `{ x, y, w, h, text, size?, color?, align? }` | the shape |
| `set_text` | `{ id, text }` | the shape |
| `insert_table` | `{ x, y, w, h, rows, cols, data[][] }` | the table |
| `insert_chart` | `{ x, y, w, h, type?, title?, categories[], series[] }` | the chart |
| `export` | `{ path, format?, all?, slide?, dpi?, … }` | `{ path, bytes }` |
| `save_presentation` | `{ path? }` | `{ path, bytes }` |
| `inspect_document` | `{}` | the presentation's tree |
| `render_slide` | `{ slide?, scale? }` | an **image** content block |

### The facts that will bite you

- **`render_slide` answers with an image content block**, not a text one.
  A client that reads the first `text` block sees an empty string.
- **DeckCraft has a real `batch`**, with `keepGoing` (default false). It
  stops at the first failure.
- **The export formats are `png`, `jpeg`, `pptx`, `deckcraft`, `outline`,
  `pdf` and `gif`.**
- **There is no `slide.fromGridCraft` command.** A deck is bound by
  reading the audited numbers out of the workbook and writing them into the
  deck's shapes.
