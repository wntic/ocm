---
description: Implement one spec until its tests pass and the gate is green
agent: implementer
subtask: true
---

Implement spec `$ARGUMENTS`.

Read `docs/specs/$ARGUMENTS-*.md`, `docs/plans/$ARGUMENTS.md` if it exists,
and the failing tests in `test/phase$ARGUMENTS-*.mjs`.

Typecheck and working tree (the test suite is yours to run — it is too slow
for this block):

!`./scripts/with-timeout.sh 30 ./node_modules/.bin/tsc --noEmit 2>&1 | tail -5 || true; echo "--- test files ---"; ls test/*.mjs 2>/dev/null | xargs -n1 basename || echo "(none)"; echo "--- git ---"; git status --short`

Run the suite yourself with `./scripts/check.sh` once you have something to
check.

Load the `ocm-architecture` skill before you write, `ocm-contract` if this
touches the loader or any config write, and `ocm-invariants` before you call
it done.

You cannot edit `test/`. Finish only when `./scripts/check.sh` exits 0.
