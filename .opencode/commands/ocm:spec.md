---
description: Implement one spec end to end — tests, code, gate, review
agent: ocm-lead
---

Implement spec `$ARGUMENTS` end to end.

Repository state:

!`./scripts/with-timeout.sh 30 ./node_modules/.bin/tsc --noEmit 2>&1 | tail -3 || true; echo "--- specs ---"; ls docs/specs/*.md | xargs -n1 basename | tr '\n' ' '; echo; echo "--- tests ---"; ls test/*.mjs 2>/dev/null | xargs -n1 basename | tr '\n' ' ' || echo "(none)"; echo; echo "--- git ---"; git status --short`

Read `docs/specs/$ARGUMENTS-*.md` in full, then run your loop: test-author,
implementer, evaluator, repeating implementer on a FAIL up to three times.

Stop and ask if the spec's preconditions are not met, or if any subagent
reports a contradiction.
