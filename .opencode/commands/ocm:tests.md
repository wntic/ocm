---
description: Write the failing phase tests for one spec, before implementation
agent: test-author
subtask: true
---

Write the phase test file for spec `$ARGUMENTS`.

Read `docs/specs/$ARGUMENTS-*.md` — its Tests section is your checklist — and
`docs/plans/$ARGUMENTS.md` if it exists.

Existing tests:

!`ls test/ 2>/dev/null || echo "(none — you may need to create test/harness.mjs first; spec 00 defines it)"`

Implement the spec's numbered Tests list in order, one test per item, plus the
four invariants. Then run `bun test test/phase$ARGUMENTS-*.mjs` and confirm
every failure is "not implemented" rather than a fault in your own fixture.

Report the file written, the test names, and the failure output.
