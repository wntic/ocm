---
description: Review the current diff against the spec it claims to implement
agent: spec-reviewer
subtask: true
---

Review the working-tree changes against spec `$ARGUMENTS`.

The diff:

!`git diff --stat && echo "=== full diff ===" && git diff`

Untracked files:

!`git status --short | grep '^??' || echo "(none)"`

Read `docs/specs/$ARGUMENTS-*.md` in full, then walk it section by section
against the diff. Report findings in the priority order from your
instructions, each citing both the code and the spec line.
