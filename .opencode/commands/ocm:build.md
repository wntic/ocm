---
description: Implement one brief end to end — decompose, then tests, code and verification per subtask
agent: lead
---

Implement the brief at `$ARGUMENTS` end to end.

`$ARGUMENTS` is a path to a brief. A bare number is shorthand for
`docs/specs/<NN>-*.md` while the specs still exist.

Repository state:

!`./scripts/with-timeout.sh 30 ./node_modules/.bin/tsc --noEmit 2>&1 | tail -3 || true; echo "--- tests ---"; ls test/*.mjs 2>/dev/null | xargs -n1 basename | tr '\n' ' ' || echo "(none)"; echo; echo "--- git ---"; git status --short`

Read the brief in full, then run your loop: decompose into subtasks, dispatch
`subtask` for each in order, and finish with the integration gate.

Stop and ask if the brief's preconditions are not met, if a subtask fails
twice, or if any subagent reports a contradiction.
