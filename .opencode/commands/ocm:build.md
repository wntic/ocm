---
description: Implement one spec until its tests pass and the gate is green
agent: implementer
subtask: true
---

Implement spec `$ARGUMENTS`.

Read `docs/specs/$ARGUMENTS-*.md`, `docs/plans/$ARGUMENTS.md` if it exists,
and the failing tests in `test/phase$ARGUMENTS-*.mjs`.

Current gate status:

!`bunx tsc --noEmit 2>&1 | tail -5; echo "--- tests ---"; bun test 2>&1 | tail -15`

Load the `ocm-architecture` skill before you write, `ocm-contract` if this
touches the loader or any config write, and `ocm-invariants` before you call
it done.

You cannot edit `test/`. Finish only when `./scripts/check.sh` exits 0.
