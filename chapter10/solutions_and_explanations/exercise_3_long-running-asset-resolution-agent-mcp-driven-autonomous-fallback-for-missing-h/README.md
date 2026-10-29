# 10. Exercise 3: Long-Running Asset Resolution Agent — solution

The worked resolution cascade. It asks LightCraft for a suitable asset, falls
back to an authenticated PhotoCraft placeholder channel, and otherwise
defers — recording every call with a digest.

## What it does

1. `try_catalog()` queries LightCraft with a SKU filter, selects the most
   recent candidate that clears the minimum long edge, applies the brand
   preset and crops to the requested aspect.
2. If the catalog has no candidate, `try_placeholder()` opens the PhotoCraft
   loopback channel, authenticates with the 64-hex token, nudges the
   placeholder and captures a real PNG.
3. Budgets are sliced across the two strategies rather than spent on one
   slow lookup.
4. Every call is recorded through a local `call()` wrapper with method,
   params, elapsed time and a 16-hex result digest.
5. `degraded` means a real asset below the requested quality; `placeholder`
   means a generated stand-in; `deferred` means no file was produced.
6. The harness runs all three paths and writes the traces beside the outputs.

## Run it

```bash
cd chapter10/solutions_and_explanations/exercise_3_long-running-asset-resolution-agent-mcp-driven-autonomous-fallback-for-missing-h/files
PY=$("../../../../tools/pick_python.sh")
"$PY" run_ex3.py
```

LightCraft must be on `PATH`, and the repository virtual environment supplies
the Python dependencies:

```bash
export PATH="/path/to/repo/tools/craft-cli/bin:$PATH"
```

```
24 assertions passed
```

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/source/hero.png` | the staged asset imported into LightCraft |
| `output/library/` | the working LightCraft catalog |
| `output/resolved/SKU-100-resolved.jpg` | catalog-resolution artifact |
| `output/placeholder/SKU-200-placeholder.png` | generated loopback placeholder |
| `output/resolution-traces.json` | all three traces with call tables and digests |
| `output/report.json` | statuses, paths and artifact list |
| `output/run_ex3.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/03_long-running-asset-resolution-agent-mcp-driven-autonomous-fallback-for-missing-hero-images.py` | MCP client, catalog strategy, loopback client, placeholder strategy and resolver |
| `files/run_ex3.py` | the acceptance harness: catalog hit, placeholder and deferral |
| `files/stub_control_server.py` | authenticated loopback stand-in that writes a real PNG |

## Notes

- `LIGHTCRAFT_LIBRARY` selects the library the MCP client opens.
- The catalog query uses an explicit `filter` object; `library.filter`
  followed by an empty query does not clear the previous view in this
  engine build.
- Python 3.10 or newer, with `Pillow` from the repository environment.
