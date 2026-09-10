---
description: Verify the gate, then stage and commit with a proper message
---

Commit: $ARGUMENTS

Working tree:

!`git status --short; echo "--- stat ---"; git diff --stat; echo "--- staged ---"; git diff --staged --stat; echo "--- recent ---"; git log --oneline -5`

## 1. Verify before staging

Run `./scripts/check.sh`. **A red gate is a hard stop** — report the failure
and stage nothing. For a change touching only documentation or agent
configuration, `--no-probe` is enough; say which you ran.

## 2. Resolve what to commit

`$ARGUMENTS` may be:

- **File paths** — commit exactly those.
- **A description** ("the loader fix", "what you just did") — resolve against
  this conversation, then confirm against `git status`. If they disagree,
  trust git and say what you found.
- **Empty** — everything currently modified, if it is one logical change.

Name every path when staging. Never `git add -A`: it sweeps in files that were
not part of this work.

If the changes are not one logical change, propose the split instead of
committing a mixture.

## 3. Write the message

Read `git diff --staged` before writing a word. Match this repository's
existing style — `git log` is the reference.

**Subject**
- Imperative mood, so "This commit will ___" reads correctly
- Capitalised, no trailing period, ≤50 characters ideally, 72 at the outside
- Specific enough to understand without opening the diff
- A `scope: detail` form is fine when it earns its keep, as in
  `Rework spec workflow: ocm-lead loop, ocm:spec command`

Prefer a precise verb:

| Vague | Better |
|---|---|
| Update X | Refactor X, Simplify X, Tighten X |
| Fix X | Handle X, Prevent X, Resolve X |
| Change X | Replace X, Rename X, Move X |
| Add X | Introduce X, Expose X, Implement X |

**Body** — when the reason is not obvious from the diff. Blank line after the
subject, wrapped at 72, plain prose rather than bullets. Explain *why*: what
was wrong before, what was traded away, what was verified. A commit
implementing a spec names it — "Implements docs/specs/01-loader.md".

**No trailers.** This repository uses none: no `Co-Authored-By`, no generator
lines, no `Signed-off-by`.

## 4. Commit

```
git commit -m "<subject>" -m "<body>"
```

Then report:

```
Committed <hash> — <N> files, +<insertions>/-<deletions>
<subject>
```

Do not push. Do not amend. Do not reset or rebase. If an earlier commit looks
wrong, say so and let the human decide.
