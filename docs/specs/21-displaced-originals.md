# 21 — Displaced originals

Depends on: [03 — Materializer](./03-materializer.md),
[05 — Per-plugin install](./05-install.md),
[10a — Shared mutation core](./10a-core-mutations.md).

Release: **v0.4.0** (batch with [20](./20-doctor-config-safety.md),
[22](./22-tui-fixes.md)). Branch: `spec/21-displaced-originals`.

Evidence: F9 (high, [round 2](../e2e-findings-round2.md)); transcript
in `docs/e2e-round2/a3.md`.

## Goal

When `ocm install --force` displaces a user's hand-written file, the
file is moved to
`~/.cache/ocm/displaced/<timestamp>/<absolute-original-path>` — and
that is the last anyone ever hears of it. `ocm remove` of the
marketplace afterwards neither restores the file nor mentions it; the
user's original is effectively lost, buried in a timestamped cache
directory nothing points to. The ownership invariant ("a user's
hand-written file must survive every operation") is technically
preserved and practically broken.

This spec makes the displacement reversible and visible: teardown
surfaces every displaced original it can restore, and every other
surface at least names where the file lives.

## Behaviour

### `ocm remove <marketplace>` and `ocm uninstall <plugin>`

For every displaced original belonging to the scope being removed:

1. **Target free** (nothing at the original path): restore the file
   to its original location, byte-identical, recreating parent
   directories as needed. Report:
   `restored your commands/greet.md (was displaced by alpha-kit)`.
2. **Target occupied** (an ocm link or another file now lives there):
   do not restore; report the absolute cache path:
   `your commands/greet.md was displaced by alpha-kit and the path is
   taken — original kept at ~/.cache/ocm/displaced/<ts>/…`.

One line per file, either way — silence is the bug being fixed. A
teardown with no displaced files prints nothing extra (no noise).

### Displacement itself (`install --force`)

The takeover report gains, per displaced file:
`displaced your commands/greet.md → ~/.cache/ocm/displaced/<ts>/…` —
the user learns where their file went at the moment it moves, not
only at teardown.

### `ocm doctor`

Reports displaced originals whose marketplace is still installed as
an informational line only (they are normal state, not drift):
`2 displaced originals in ~/.cache/ocm/displaced/`. Orphaned
displacement directories whose marketplace was removed by older
versions (pre-this-spec removals) are reported with their paths; no
auto-deletion — the files are the user's.

## Why restore rather than only report

The user never asked ocm to move their file; `--force` did, with
consent to take over the *name*, not to keep the original. Restoring
when the path is free returns the system to the state the user last
chose. When the path is taken, restoring would overwrite something —
reporting is the only honest option. The cache copy is never deleted
by the restore (belt and braces: restore is a copy-back, not a move).

## Edge cases

| Case | Behaviour |
|---|---|
| restore target's parent directory no longer exists | recreated |
| target occupied by another ocm link | no restore; cache path reported |
| target occupied by a hand-written file (user re-created it) | no restore (theirs wins); cache path reported |
| two displaced files, one restorable, one not | both reported, each with its own line |
| `ocm remove` of a marketplace whose plugin took over from *another marketplace's* plugin (not the user) | no displacement involved (marketplace-to-marketplace takeover removes the incumbent link, displacing nothing); nothing printed |
| displaced file deleted from the cache by hand | reported as `displacement copy missing` if the restore was requested; not an error |
| idempotence: remove, restore, re-add, remove again | same restore happens again from the same cache path (copy, not move) |

## Consumed by

`loader/links.js` (takeOver — records and reports),
`loader/marketplace.js` / `loader/core.js` (remove, uninstall — the
restore pass), `src/commands/doctor-*.ts` (informational lines). The
TUI remove flow consumes the core pass for free ([10a](./10a-core-mutations.md)).

## Tests (`test/phase21-displaced-originals.mjs`)

1. Hand-written `commands/greet.md` → `ocm install alpha-kit --force`
   → report names the cache path; file gone from `commands/`.
2. `ocm remove alpha` → file restored byte-identical (compare
   content and mtime is irrelevant, content only); report line
   printed; cache copy still present.
3. Occupied target: re-create a different `greet.md` by hand before
   remove → no restore, cache path in the output, user's file intact.
4. Uninstall of just the plugin → same restore behaviour as
   marketplace remove.
5. No displaced files → teardown output unchanged from today (no
   noise), byte-compare the report.
6. Ownership invariants: nothing outside ocm's keys/links touched;
   the cache directory layout unchanged (so older caches still
   readable).
