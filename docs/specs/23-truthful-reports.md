# 23 — Truthful CLI reports

Depends on: [10a — Shared mutation core](./10a-core-mutations.md),
[08 — Update engine](./08-update.md), [05 — Per-plugin install](./05-install.md).

Release: **v0.5.0** (batch with [24](./24-validate-hardening.md),
[25](./25-display.md), [26](./26-update-hygiene.md)).
Branch: `spec/23-truthful-reports`.

Evidence: F2, F3, F11, F12 (round-1 #5), F16 (U3.1), round-1 #3,
F21 (round-1 #6), F35, F36, F37, F42, F33, F34
([round 2](../e2e-findings-round2.md)); transcripts across all agent
logs in `docs/e2e-round2/`.

## Goal

One rule, applied everywhere: **every line ocm prints states a true
fact.** Today the reports lie in a dozen small ways — success
messages render red on a TTY because they go to stderr, no-op
installs claim they installed, an explicit-mode update claims
`(auto)`, a removal that requires a restart prints no notice, zero-
count lines pad every update, and there is no `--version` to report a
bug against. Each lie is small; together they teach the user not to
trust the tool's output — the one asset a CLI cannot lose.

This spec is deliberately mechanical: no behaviour changes beyond
what the printed lines describe.

## 1. Stream discipline: stdout is for facts, stderr for problems (F2)

`installed auto-sync loader (…)` and `installed TUI plugin (…)` are
`console.error` (`src/loader.ts`) — on a TTY Bun renders them ANSI
red, styled exactly like errors; scripts capturing stdout see
nothing.

**Rule:** success messages, data and notices go to stdout. Warnings
and errors go to stderr. Applied to every print in `src/` and the
loader's CLI-facing paths. The red-on-TTY failure disappears as a
side effect — it was never styling, it was the wrong stream.

## 2. Loader lines state what happened (F3)

"installed auto-sync loader" prints even when the files were already
current (they are not rewritten). The lines become conditional:
written → `installed auto-sync loader (…)`, already current → nothing
on a no-op update (a no-op reports nothing), or
`auto-sync loader already current` where the user expects
acknowledgement (`ocm init` re-run, `doctor --fix`).

## 3. No-op mutations report no-ops (F11)

Second `ocm install x` → `already installed` (exit 0, no restart
notice, no file list). Second `ocm uninstall x` → `not installed`.
Same for `ocm enable`/`disable` on the current state. Today both
print the full success line for an action that did not happen — and
the second install even contradicts itself by omitting the restart
notice its own claim implies.

## 4. Mode-aware labels (F12, round-1 #5)

In an `explicit` marketplace, a new upstream plugin is reported
`installed (auto)` with a `+` file list — while registered
`enabled: false` and nothing materialized. The label becomes
`available — ocm install <name> to activate`, with no file list
(nothing was created). Auto mode keeps `installed (auto)`.

## 5. The restart notice follows actual changes (F16, round-1 #3)

- Removal-only updates print `restart opencode to activate`: the
  running session keeps the stale command/skill until restart, and
  the report must say so (U3.1).
- Skill-only installs print it too (round-1 #3): the skill components
  created inside `mirror` (`loader/links.js`) count toward
  `report.created`, so the `reportRestart` gate fires. The uninstall
  direction already counts correctly.
- Rule: the notice prints when **anything** was created *or* removed
  by the mutation — never on a true no-op (rule 3).

## 6. Ordering: headline first, notices after, trust block inside its
marketplace's section (F21, F36)

- Every verb prints its headline (`added marketplace "x"`, `updated
  "mech"`, `uninstalled x`) **before** the restart notice — matching
  `ocm install`'s existing order. Add and uninstall currently invert
  it.
- The stderr trust block no longer interleaves before the stdout
  `updating <name>...` header: the trust diff/prompt for a
  marketplace renders after that marketplace's header (buffer the
  block until the header is out), so a report reads top to bottom.

## 7. Noise budget (F35)

- With an untrusted marketplace present, every mutation re-prints its
  blocked-component warnings before the actual result. Once per run
  instead: `2 components blocked pending trust — run ocm trust <mp>`
  (one line per affected marketplace), never repeated within the same
  command's output.
- Zero-count lines are dropped: `0 created, 0 removed, 0 skipped`
  never prints; `created 2, removed 1` keeps its shape.
- The events of an update run (re-cloned, directory missing) move to
  stdout — they are facts of the report, not warnings; today they are
  stderr while the bare counts are stdout, splitting one report
  across two streams.

## 8. Small truths (F37, F42)

- Explicit-mode `ocm add` ends with `N plugins available — ocm
  install <name> to activate` instead of "commands and agents are
  available…" (nothing is installed).
- `ocm update <plugin>@<mp>` scopes its report to that plugin (same
  action as the marketplace-wide form today; only the report
  narrows). If scoping proves awkward in the core, drop the form from
  help instead — do not keep an argument that behaves as another.

## 9. `--version` (F33)

`ocm --version` and `ocm -v` print the package version, read from
`package.json` resolved relative to the module (works for a global
install and a repo checkout). Exit 0. `ocm help` mentions it.

## 10. Help leads with the first command (F34)

The usage line and examples put `ocm add` first — it is step one for
every new user; `ocm init` follows (it is what the loader installer
does for you).

## Tests (`test/phase23-truthful-reports.mjs`)

Every test captures stdout and stderr separately.

1. `ocm init`: success lines on stdout; nothing red-classified (ANSI
   escape assert) on either stream.
2. Re-install / re-uninstall / re-init: no-op wording, exit 0, no
   restart notice.
3. Explicit-mode update with a new upstream plugin: `available — ocm
   install` label, no file list, registry `enabled: false`.
4. Removal-only update: restart notice present; skill-only install
   (fixture): notice present; no-op update: absent.
5. Add/uninstall headline before the restart notice.
6. Trust block renders after the `updating <name>` header (assert on
   combined-order via pty or on the buffered call order).
7. Untrusted marketplace + unrelated mutation: exactly one blocked
   line; zero-count lines absent; re-clone event on stdout.
8. `ocm --version` prints a semver string; exit 0.
9. Help: `ocm add` first in usage and examples.
