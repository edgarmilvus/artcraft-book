# Why this fixture allows a one-character text tolerance

`wordcraft-note` is the only fixture in the suite that opts into a non-zero
`tolerance.textDamerauLevenshtein` (1). It exists to prove the tolerance path
works end to end: the harness copies it, edits one character of the golden
text, and requires the run to pass; a two-character edit still fails.

The reason a single character is not a regression here is that this fixture
asserts WordCraft's block and style canonicalization, not precise typesetting.
A one-character difference in a note cannot change a style chain, a page
count or a render, and the render tolerance is still 0 — the visual contract
stays exact. Every other fixture is compared at 0/0.

If you tighten this fixture, change the plan and regenerate the golden in the
same commit so the review sees both halves.
