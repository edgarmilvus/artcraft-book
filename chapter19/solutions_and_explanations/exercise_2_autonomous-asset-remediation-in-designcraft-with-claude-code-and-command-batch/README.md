# 19. Exercise 2: Autonomous Asset Remediation — solution

The worked DesignCraft repair. A legacy magazine document that has crossed three
storage mounts is relinked, re-fonted, reflowed and certified by an agent using
`command_batch`.

## What it does

1. Discovers the DesignCraft command surface, then opens the document.
2. Relinks every asset it can find under the current mounts, and embeds a
   labelled placeholder for the four files that are genuinely gone.
3. Replaces the missing font from the alias table; when the alias table is
   incomplete it halts instead of guessing.
4. Reflows every overset story without deleting text: promotes the story to a
   primary text frame, sets the direction and inserts pages, repeating until
   the story fits.
5. Restores the `Northwind Teal (legacy)` swatch to the Swatches panel.
6. Lays a remediation certificate into the document (with a note when the run
   is partial), exports it, hashes it and writes an audit trail of every call.
7. Two safety scenarios: a document outside the workspace is refused, and an
   incomplete font table halts with a certificate but no false success.

## Run it

```bash
cd chapter19/solutions_and_explanations/exercise_2_autonomous-asset-remediation-in-designcraft-with-claude-code-and-command-batch/files
PY=$("../../../../tools/pick_python.sh")
"$PY" run_ex2.py
```

```
64 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/cert-q3-catalog.pdf` | the remediation certificate PDF |
| `output/cert-q3-catalog.audit.json` | every command, result, flag and the `$N.path` interpolation |
| `output/q3-catalog.remediated.designcraft` | the repaired document |
| `output/remediation-manifest.json` | relinked/placeholdered counts, font and swatch work |
| `output/work/scenarios/halt/` | the incomplete-font halt proof |
| `output/work/scenarios/sandbox/` | the workspace-refusal proof |
| `output/run_ex2.log` | shell-captured harness log |

## The listings

| file | what it is |
| --- | --- |
| `files/02_autonomous-asset-remediation-in-designcraft-with-claude-code-and-command-batch.py` | discovery, relink, font, reflow, swatch, certificate and audit |
| `files/run_ex2.py` | the real-engine acceptance harness |
| `files/01_jsonc.jsonc`, `files/02_jsonc.jsonc` | font and swatch alias contracts |

## Notes

- Reflow does not assume one page is enough: the certificate embeds the
  document path, whose length depends on the checkout location, so the agent
  inserts pages until the story reports no overset.
- The certificate is reflowed **before** it is exported, so its page count and
  the document's page count agree.
- A missing font is a halt, not a substitution, when the alias table has no
  entry.
- Type-check equivalent: `python3 -m py_compile` on the module and harness.
