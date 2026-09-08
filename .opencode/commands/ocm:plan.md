---
description: Break one spec into an ordered task list at docs/plans/NN.md
agent: spec-analyst
subtask: true
---

Plan the implementation of spec `$ARGUMENTS`.

Read `docs/specs/$ARGUMENTS-*.md` in full, along with `docs/specs/README.md`
for its place in the order and every spec it lists as a dependency.

Current state of the repository:

!`ls docs/specs/ && echo "--- plans ---" && ls docs/plans/ 2>/dev/null || echo "(no plans yet)" && echo "--- tests ---" && ls test/ 2>/dev/null || echo "(no tests yet)"`

Write `docs/plans/$ARGUMENTS.md` following the structure in your instructions.
Write nothing else.
