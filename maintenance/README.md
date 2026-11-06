# maintenance/ — what authoring the book needs

Nothing here is required to run a listing. A reader who cloned the repository
to run the examples never opens this directory; the toolchain it needs lives in
`tools/`.

| path | what it is |
| --- | --- |
| `check.sh` | the five checks CI runs (linked tree, types, master server, project READMEs), on this machine |
| `check_project_readmes.py` | walks every project README and reports a file, artefact or `cd` line that no longer matches the tree |
| `engine-facts/FACTS-ch18.md` | GridCraft and DeckCraft surfaces, written by running the binaries |
| `engine-facts/FACTS-ch19.md` | PhotoCraft, VectorCraft, DesignCraft, LightCraft, PdfCraft |
| `engine-facts/FACTS-ch20.md` | the capstone engines, FilmCraft, the control channel |

```bash
maintenance/check.sh          # the whole check
maintenance/check.sh --fast   # skip the install step
python3 maintenance/check_project_readmes.py 17 18
```

Both scripts resolve the repository root from their own location, so they work
from anywhere.

The fact sheets are the reference the chapters were written against: they record
**what each engine actually answers**, not what its documentation claims. The
single most important line is that the ten binaries do not share a dialect —
PhotoCraft, VectorCraft, FilmCraft, LightCraft and PdfCraft run
`command_run { id, params }`; DesignCraft and WordCraft run
`execute { command, params }`; EffectCraft and GridCraft run
`execute_command { command, params }`; DeckCraft runs
`run_command { command, params }`.

These files stay in the repository so a future edition can re-check an engine
without rediscovering it.
