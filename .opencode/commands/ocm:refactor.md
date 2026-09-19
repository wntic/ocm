---
description: Run a repository-machinery brief — tests, scripts, skills, docs — with the shipped code locked
agent: refactor
---

Execute the brief at `$ARGUMENTS`.

Repository state:

!`./scripts/with-timeout.sh 30 ./node_modules/.bin/tsc --noEmit 2>&1 | tail -3 || true; echo "--- tests ---"; ls test/*.test.mjs 2>/dev/null | xargs -n1 basename | tr '\n' ' ' || echo "(none)"; echo; echo "--- git ---"; git status --short && git branch --show-current`

Read it in full, confirm you can reach its acceptance criteria without
touching `src/`, `loader/` or `bin/`, then work through its tasks in order.

Stop and report if the brief requires a shipped-code change, or if an
acceptance criterion contradicts itself.
