---
description: Run every gate and return a PASS, FAIL or BLOCKED verdict
agent: evaluator
subtask: true
---

Return a verdict for spec `$ARGUMENTS`.

Run every gate in your procedure yourself and report the real output. Start
from this snapshot but do not trust it — re-run each command:

!`./scripts/with-timeout.sh 240 ./scripts/check.sh 2>&1 | tail -40`

Changed files:

!`git status --short && echo "--- stat ---" && git diff --stat`

Then read `docs/specs/$ARGUMENTS-*.md` and confirm every numbered item in its
Tests section has a test that genuinely asserts it.
