---
description: Show which specs are planned, tested, implemented, and what to run next
---

Repository state:

!`echo "=== specs ==="; ls docs/specs/*.md | xargs -n1 basename; echo; echo "=== plans ==="; ls docs/plans/*.md 2>/dev/null | xargs -n1 basename || echo "(none)"; echo; echo "=== tests ==="; ls test/*.mjs 2>/dev/null | xargs -n1 basename || echo "(none)"; echo; echo "=== gate ==="; ./scripts/with-timeout.sh 30 ./node_modules/.bin/tsc --noEmit 2>&1 | tail -5 || true; echo; echo "=== git ==="; git status --short; git log --oneline -5`

Report, in a short table: for each spec, whether it has a plan, a test file,
and a passing test file. Then name the single next command to run, using the
implementation order in `docs/specs/README.md`.

The cycle for a spec is: `/ocm:plan NN` → `/ocm:tests NN` → `/ocm:implement NN` →
`/ocm:check NN` → `/ocm:review NN`.

Do not change any files.
