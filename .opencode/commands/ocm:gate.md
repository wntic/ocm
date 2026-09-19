---
description: Run every gate and report the real output — no verdict on design
agent: verifier
subtask: true
---

Run the gate and report what it printed.

Start from this snapshot but do not trust it — re-run each command yourself:

!`./scripts/with-timeout.sh 480 ./scripts/check.sh 2>&1 | tail -40`

Changed files:

!`git status --short && echo "--- stat ---" && git diff --stat`

Report in your standard shape. If `$ARGUMENTS` names a brief, also confirm
every numbered item in its Tests list has a test that genuinely asserts it —
by reading the test, not its name.
