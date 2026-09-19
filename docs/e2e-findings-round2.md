# E2E findings — round 2 (2026-09-13)

> **Brief paths in this document** (`docs/specs/NN-…`) refer to briefs that
> are no longer in the repository: they live untracked in `.work/briefs/`,
> and in git history up to the commit that removed them. See
> [project.md](./project.md).


Second round: a manual start (Suites 1–2, findings F1–F6) plus seven parallel
sub-agents covering Suites 1–10 and 12 against the real opencode binary.
Raw per-agent logs with verbatim output are in `docs/e2e-round2/a1.md` …
`a7.md`; this file is the consolidated, deduplicated view.

Environment: opencode 1.18.30, git 2.50.1, bun 1.4.2, ocm installed from
repo HEAD `10411d5` (spec 15). Fixture marketplaces on GitHub under
`wntic/ocm-e2e-{alpha,exec,big,search,mech,collide}` plus throwaways
(`a3-codefree`, `a7-mp5`, `a7-private`, `a7-empty`); MP-C local at
`~/ocm-e2e/local-mp`. Method notes: red-on-terminal was verified by
capturing stdout/stderr separately (Bun renders `console.error` red on a
TTY — confirmed with an ANSI dump via `expect`); Ctrl+C was sent through a
pty via `expect`; TUI-visual checks were not possible and are listed at
the bottom.

Round corrections:

- **F6 (resolved during the round):** the globally installed ocm was
  stale (predated spec 15), which produced a false finding (marketplace
  named `local-mp` instead of `demo-marketplace`). Reinstalled from HEAD;
  name derivation verified correct afterwards.
- **a2's claim that `ocm list --all` hides a failing sync is wrong** —
  `src/commands/list.ts:24-26` prints `last sync failed: …` in red when
  `lastSync.ok=false` is recorded (verified live). a2's failing sync was
  never recorded (see F40). What stands is F60: no sync age anywhere, and
  plain `ocm list` (without `--all`) hides the failure.

## High

## F5 — Ctrl+C at the trust prompt completes the add, skips the loader, prints nothing (area: CLI, severity: high)

Test:        Suite 2 / Test 3 (extended by a1 F9, a7 F5)
Command:     `ocm add <mp>` then `\x03` at `trust this marketplace? [y/N/skip]`
Expected:    a clean abort with the state explained, or the add completes
             with the normal summary.
Actual:      exit 0, output is only `^C`. On disk: registry written, all
             command/agent/skill links live, trust withheld (safe) — but
             `installLoader()` never ran: no `ocm-loader.js`, no `tui.json`.
             No summary, no blocked report, no restart notice.
Impact:      a user who interrupts "to think about it" has fully installed
             the marketplace with no auto-sync loader and no `/ocm` TUI,
             and no output tells them. `ocm list` then shows a healthy
             marketplace; only `ocm doctor` reports the missing loader.
Root cause:  the add flow saves the registry and materializes before
             `promptTrust` (`src/commands/marketplace.ts:26-41`);
             `installLoader()` and the summary run after the prompt, so
             SIGINT lands exactly between them.
Status:      new (extends round-1 F5)

## F7 — Relative-path `ocm add` installs dead symlinks and a cwd-dependent registry (area: CLI, severity: high)

Test:        Suite 12 / Test 43 case 8 (a7 F1)
Command:     `cd ~ && HOME=$FAKE ocm add ocm-e2e/local-mp`
Expected:    valid install; links resolve regardless of later cwd.
Actual:      "added marketplace …", exit 0 — but the registry stores
             `dir: "ocm-e2e/local-mp"` (relative) and every command
             symlink points at a relative target that resolves nowhere.
             `opencode debug config` sees 0 commands. From another cwd
             `ocm update` says "directory missing … skipping" and exits 0.
Impact:      a silently dead install, exit code 0 throughout.
Root cause:  the local path is not resolved to absolute at add time
             (`loader/source.js` `expandPath` handles `~` but not
             relative paths); link targets are built from the raw
             argument.
Status:      new

## F8 — `ocm doctor --fix` deletes a link the user just trusted (area: loader, severity: high)

Test:        Suite 5 / Test 16.5 follow-up (a3 F9)
Command:     loader sync pulls new `plugin/other.js` (trustPending) →
             `ocm trust exec` (approved) → `ocm doctor --fix`
Expected:    doctor clean; the trusted component's link is ocm-owned and
             stays.
Actual:      doctor flags `ocm--exec-kit--other.js` as "stray ocm file —
             no registry entry owns it" and `--fix` REMOVES the link the
             trust command just created. Registry afterwards:
             `trust.components` still lists other.js, the per-plugin
             record does not, `trustPending` still true — every layer
             disagrees with every other layer.
Root cause:  `loader/sync.js:138` materializes after pull without
             refreshing the per-plugin `components` records (only the CLI
             update/reconcile path does); `ocm trust` creates links from
             on-disk components without refreshing them either;
             `doctor-links.ts:53` then sees an unowned link.
Impact:      the only finding where ocm destroys something the user
             explicitly approved. Self-heals only if the user happens to
             run `ocm update` again.
Status:      new

## F9 — `ocm remove` after a `--force` takeover loses the hand-written file's path (area: CLI, severity: high)

Test:        Suite 4 / Test 11.5 (a3 F1)
Command:     `ocm install alpha-kit --force` (displaces the user's
             `alpha-kit:greet.md`), later `ocm remove alpha`
Expected:    "your original hand-written file (restored or left alone)
             must survive".
Actual:      the file is gone from `commands/`; remove's output never
             mentions it. The only copy is buried at
             `~/.cache/ocm/displaced/<ts>/<absolute-original-path>` —
             nothing ever points there again.
Root cause:  `loader/links.js:35` `takeOver` moves the file to the
             displaced dir; `removeMarketplace` has no mechanism to
             restore displaced originals.
Status:      new (data survives in cache, but effectively lost)

## F10 — Colliding install reports false success; next update silently reverts (area: CLI, severity: high)

Test:        Suite 4 / Test 12.5 (a3 F2)
Command:     `ocm install review-tools@collide` (name owned by "big")
Expected:    refusal naming both marketplaces, or a real install.
Actual:      `warning: review-tools:review.md conflicts with
             review-tools:review.md` (degenerate — same name both sides,
             marketplaces unnamed) followed by `installed
             review-tools@collide (1 command)`, exit 0. Nothing was
             materialized (the incumbent's symlink stands); the next
             `ocm update collide` prints "already up to date" while
             silently flipping the plugin back to disabled.
Status:      confirmed-known-#1

## Medium

## F1 — `ocm doctor` dumps 23 per-file errors on a never-initialized install (area: CLI, severity: med)

Test:        Suite 1 / Test 1.6
Command:     `ocm doctor` on a fresh home
Actual:      3 loader `(missing)` lines + one `not installed (ocm init)`
             error per core file, `23 errors, 0 warnings`, exit 1.
Expected:    one line — ocm is not installed here, run `ocm init`.
Status:      confirmed (re-verified by a1)

## F2 — Success messages go to stderr and render red (area: CLI, severity: med)

Test:        Suite 1 / Test 2
Command:     `ocm init` (and every add/update)
Actual:      `installed auto-sync loader (…)` / `installed TUI plugin (…)`
             are `console.error` (`src/loader.ts:174-175`); on a TTY Bun
             renders them ANSI red, styled exactly like errors. Scripts
             capturing stdout see nothing.
Impact:      a successful init looks like a failure.
Status:      confirmed (a1 pty-verified the ANSI codes; a4 corroborates)

## F11 — Second `ocm install`/`uninstall` prints a false claim on a no-op (area: CLI, severity: med)

Test:        Suite 3 / Test 8.6 (a1 F6)
Command:     `ocm install review-tools` twice; `ocm uninstall …` twice
Actual:      the second run prints `installed review-tools@big (1
             command, 1 skill)` / `uninstalled review-tools@big` —
             nothing happened (and the second install correctly omits the
             restart notice, contradicting its own claim).
Status:      new

## F12 — Update report says `installed (auto)` in an explicit-mode marketplace (area: CLI, severity: med)

Test:        Suite 3 / Test 9.6 (a1 F10)
Actual:      `brand-new-tools   installed (auto)` with `+` file list —
             registry is correct (`enabled: false`), only the text lies,
             reinforced by the file list under it.
Status:      confirmed-known-#5

## F13 — `ocm update` re-prints the full trust block on every run while trust is undecided; a declined non-TTY re-prompt loops forever (area: CLI, severity: med)

Test:        Suite 3 / Test 9 (a1 F11) + Suite 6 (a4 F9)
Actual:      with `trust.code: "none"`, EVERY update (including `already
             up to date`) prints the full "ships code that opencode will
             execute … [y/N/skip]" block; non-interactively the answer is
             silently "skipped" and no decision is recorded, so it never
             stops. Worse after a declined re-prompt of CHANGED code: the
             stale grant is left in place, so every later update re-prints
             "shipped code that changed since you trusted it" forever.
Root cause:  `src/commands/trust.ts:91-102` prompts whenever trust.code
             is "none"; `promptTrust` prints before checking isTTY;
             "skipped" records nothing.
Status:      new (extends known #6's fatigue problem)

## F14 — `ocm scan <plugin>@<mp>` reports a false collision for any path that does not exist yet (area: CLI, severity: med)

Test:        Suite 3 / Test 10.4 (a1 F14)
Actual:      scanning an UNINSTALLED plugin prints `(collision: install
             would refuse without --force)` for every component — the
             most common case (not yet installed) is labelled a
             collision. A real `ocm install` then succeeds without
             `--force`, proving there was none.
Root cause:  `src/commands/plugins.ts:120-126` — `readlinkSync` throws
             for a missing dest, "nothing there at all" and "occupied by
             a foreign file" share one message.
Status:      new

## F15 — `ocm list` shows untrusted executable components with no blocked marker (area: CLI, severity: med)

Test:        Suite 2 / Test 3.4 (a2 F1)
Actual:      after denying trust, `ocm list` prints `plugins: notify.js`
             / `mcp: everything` as if installed. No `(blocked)` marker
             in `list` or `list --all`; only `search` results and a
             one-time add warning carry it. The data is in `--json`
             (`trust: {code: "denied"}`) — the text renderer ignores it.
Status:      new

## F16 — Removal-only update prints no restart notice (area: CLI, severity: med)

Test:        Suite 2 / Test 5.7 (a2 F5, a4 F5)
Actual:      an upstream deletion reports `alpha-kit   - skills/new-skill/SKILL.md`
             with no "restart opencode to activate" — the running session
             keeps the stale command/skill, and the tool never says so.
Status:      confirmed-known-U3.1

## F17 — `ocm info` renders registry fiction: nonexistent target paths, and "trust granted" after a declined re-trust (area: CLI, severity: med)

Test:        Suite 7 / Test 23.4 (a5 F7) + Suite 5 / Test 15.2 (a3 F7)
Actual:      for a disabled or blocked plugin, the components block
             prints arrows to files that do not exist on disk, with no
             marker. After declining a re-trust of changed code, `info`
             says `trust granted` and lists the plugin link — which was
             unlinked (verified absent).
Root cause:  info renders components from the registry record, not from
             disk; the trust line does not compare the current code
             fingerprint.
Status:      new

## F18 — `ocm trust` cannot grant non-interactively and silently "succeeds" (area: CLI, severity: med)

Test:        Suite 5 / Test 16.4 (a3 F11, a4 F9)
Actual:      `ocm trust exec < /dev/null` prints the question, reads EOF,
             exits 0, grants nothing. No flag exists on `trust`. Combined
             with F13, a script context can neither grant nor detect that
             nothing was granted. Workaround: `ocm update --trust` does
             grant non-interactively.
Root cause:  `src/commands/trust.ts:47` — non-TTY returns "skipped",
             treated as success.
Status:      confirmed-known-#2

## F19 — MCP blocked warning lacks the `ocm trust` hint (area: CLI, severity: med)

Test:        Suite 5 / Test 14.4 (a2, a3, a5, a6 — all four hit it)
Actual:      `blocked (untrusted): exec-kit:notify.js not linked — run
             \`ocm trust exec\` to approve` (JS has the hint) next to
             `blocked (untrusted): exec-kit:mcp/everything not installed`
             (no hint; "not installed" reads like a failure and invites
             re-running `ocm install`, which cannot help).
Root cause:  `loader/materialize.js:152` has the hint; `loader/mcp.js:74`
             does not.
Status:      confirmed-known-#6

## F20 — `trustPending` is invisible in every surface (area: CLI, severity: med)

Test:        Suite 5 / Test 16.5 (a3 F10)
Actual:      loader sync records `trustPending: true` and blocks the new
             executable component (correct), but `ocm list`, `list --all`,
             `ocm doctor` and `ocm info` show nothing. The component
             stays disabled indefinitely unless the user happens to run
             `ocm update` and reads its output.
Status:      confirmed-known-#6

## F21 — stderr trust block interleaves mid-report, splitting the update output (area: CLI, severity: med)

Test:        Suite 6 / Test 17.7 (a4 F3)
Actual:      with a trust change pending, the combined terminal output
             reads: trust diff block → prompt → `updating mech…` →
             `warning: blocked …` → revision transition → plugin files →
             red loader lines. The revision transition is visually
             orphaned from its marketplace header; exit 0 despite blocked
             components.
Status:      confirmed-known-#6

## F22 — The "one-time" cache warning repeats forever and "discarded" is false for untracked files (area: CLI, severity: med)

Test:        Suite 6 / Test 21.3 (a4 F10)
Actual:      an untracked file in the cache clone triggers `warning: …
             has local changes; discarded (the cache is not an editing
             surface)` on EVERY update, while the file survives every
             time (`reset --hard` does not remove untracked files). The
             warning only stops once the user deletes the file by hand.
Root cause:  the dirty check is `git status --porcelain` (includes
             untracked); the remedy is `reset --hard` (excludes them).
             Needs `clean -fd` alongside, or a tracked-only check.
Status:      new

## F23 — Right after `ocm add`, every no-match search claims "a marketplace sync is stale or failed" (area: CLI, severity: med)

Test:        Suite 7 / Test 22.5 (a5 F1 + F2)
Actual:      `ocm add` leaves `lastSync: null, revision: null`; the
             no-match search hint fires on null, so a freshly added
             marketplace (cloned seconds ago) produces "a marketplace
             sync is stale or failed; run ocm update" — which then
             reports "already up to date". For a LOCAL marketplace the
             hint is permanent (lastSync stays null forever).
Status:      new (git-marketplace part) + confirmed-known-#6 (local part)

## F24 — `ocm validate` in a non-marketplace directory is silent and exits 0 (area: CLI, severity: med)

Test:        Suite 8 / Test 25.3 (a5 F9)
Actual:      `cd /tmp && ocm validate` → prints only the header, zero
             findings, exit 0 — a false "all good" for the wrong
             directory.
Status:      new

## F25 — `ocm validate` misses duplicate `plugins[]` names and cross-plugin component collisions (area: CLI, severity: med)

Test:        Suite 8 / Test 26 rows 5–6 (a5 F10)
Actual:      four shapes tried (duplicate `plugins[]` entries, colliding
             command basenames across plugins, duplicate namespaced
             skills, nested same-basename commands) — zero findings,
             exit 0 for every shape. 18 of the plan's 20 defect rows are
             detected with exact, actionable lines (full per-row table in
             `docs/e2e-round2/a5.md`); these two rows are entirely
             uncovered, and the duplicate entry also silently clobbers
             the registry record at add time.
Status:      new

## F26 — A stray single-dash `ocm-*.js` in plugins/ is invisible to doctor while opencode loads it (area: CLI, severity: med)

Test:        Suite 10 / Test 33.2 (a6 F4)
Actual:      `ocm-stray.js` in `plugins/`: doctor exit 0, no finding,
             survives `--fix` — yet `opencode debug config` shows the
             file IS loaded as a plugin on every start.
Root cause:  `src/commands/doctor-links.ts:50` checks only `ocm--`-prefixed
             names; the single-dash form matches neither the owned pattern
             nor any check.
Status:      new

## F27 — `doctor --fix` does not re-clone a missing marketplace; it removes links and hands you a second command (area: CLI, severity: med)

Test:        Suite 10 / Test 33.7 (a6 F5)
Actual:      with a missing clone, `--fix` removes the now-broken
             symlinks (install ends LESS materialized than before) and
             keeps the error `— ocm update re-clones`; exit stays 1 after
             `--fix`. `ocm update` does re-clone. Spec 12's findings
             table says doctor's fix is "re-clone".
Status:      new (spec/implementation disagreement)

## F28 — Corrupt `opencode.json`: no manual-change hint, warning printed twice, skills silently unloaded (area: CLI, severity: med)

Test:        Suite 10 / Test 34.4 (a6 F6)
Actual:      `warning: skipped …: not valid JSON, left untouched` (twice),
             then the add reports success with "1 skills" — but the
             `skills.paths` entry was never written and nothing says so.
             Spec 12 requires printing the change to make by hand.
Status:      new

## F29 — A read-only `opencode.json` is silently replaced via temp+rename (area: CLI, severity: med)

Test:        Suite 10 / Test 34.5 (a6 F7)
Actual:      `chmod 444` + `ocm uninstall` → exit 0, "uninstalled …",
             file rewritten (md5 changed). The atomic-write pattern
             (write temp + rename) defeats the read-only bit without a
             warning; a user who deliberately froze their config has it
             silently rewritten.
Status:      new

## F30 — After `loader uninstall` + `init`, working links are invisible to `ocm list` and `doctor` (area: CLI, severity: med)

Test:        Suite 10 / Test 36 (a6 F10)
Actual:      `loader uninstall` deletes `ocm/` including the registry (per
             spec 01); after `ocm init`, `ocm list` says "no marketplaces
             added yet" and doctor is clean — while `/demo-kit:tdd`,
             agents and skills still work in opencode. No ocm command can
             see or remove these links.
Status:      new (design consequence; needs a disk→registry orphan check
             in doctor, or a documented cleanup path)

## F31 — `ocm add` of a private/no-access repo hangs at git's raw username prompt in a tty (area: CLI, severity: med)

Test:        Suite 12 / Test 43.10 (a7 F2)
Actual:      non-tty fails cleanly (exit 1, no clone left). In a real tty
             the process sits forever at `Username for 'https://github.com':`
             — git's prompt, no timeout, no ocm-level context.
Root cause:  clone spawned without `GIT_TERMINAL_PROMPT=0`.
Status:      new

## F32 — `ocm doctor` does not report recorded plugin-name collisions (area: CLI, severity: med)

Test:        Suite 4 / Test 12.6 (a3 F3)
Actual:      with `collision: "big"` recorded in the registry, doctor
             prints only loader version lines, exit 0. A user who hit F10
             has no diagnostic surface that explains it.
Status:      confirmed-known-#4

## Low

## F3 — `ocm init` (and every add/update) unconditionally claims "installed" loader/TUI (area: CLI, severity: low)

Actual:      identical output on re-run; files not rewritten, only the
             message is unconditional. Every `ocm update` — including
             no-ops — appends the two red lines (a1 F12, a2 F6, a3 F5,
             a5 F5).
Status:      confirmed-known-#6

## F33 — No `ocm --version` at all (area: CLI, severity: low)

`ocm --version` → `unknown command "--version" (ocm help)`, exit 1.
A user reporting a bug cannot state their build. (a1 F1)

## F34 — Help does not make `ocm add` obviously step one (area: CLI, severity: low)

Usage leads with `ocm init`; examples at the bottom rescue it. (a1 F3)

## F35 — Output noise: blocked-trust warnings on every mutation, "0 created, 0 removed, 0 skipped" for unchanged marketplaces, re-clone/skip events stderr-only (area: CLI, severity: low)

With an untrusted marketplace present, every `ocm install/uninstall/enable/
disable/update` re-prints its blocked warnings — including other
marketplaces' — before the actual result (a1 F7, a2 F9, a5 F6). The
interesting events of an update run (re-cloned, directory missing) are on
stderr while stdout shows bare counts (a4 F12).

## F36 — Notice/summary ordering inconsistent across verbs (area: CLI, severity: low)

`ocm add`: restart notice before "added marketplace …"; uninstall:
restart notice before "uninstalled …"; install: after. The headline lands
last on add. (a1 F8, a2 F3)

## F37 — Explicit-mode add ends with "commands and agents are available …" though nothing is installed (area: CLI, severity: low)

(a1 F13)

## F38 — `ocm scan` on a no-plugins dir gives no expected-layout hint (area: CLI, severity: low)

`no plugins found in <dir>` — no layout, no `ocm validate` pointer. (a1 F15)

## F39 — `ocm scan` reports executable components as "would be installed" with no trust caveat (area: CLI, severity: low)

(a1 F16)

## F40 — Startup sync is fire-and-forget: short-lived opencode runs never complete it (area: loader, severity: low)

`void core.syncAll(...)` (`loader/ocm-loader.js:9-12`) — `opencode debug
config` (~0.5s) exits before the git fetch (~1–3s) completes; lastSync
silently stays stale. Fine for the TUI (long-lived); misleading for
one-shot `opencode run`/`debug` users, and it produced a2's false F7
(see round corrections). Worth a README line. (a2 F8, a6 F11, a7)

## F41 — No-op update rewrites the registry (mtime churn) (area: CLI, severity: low)

Only `lastSync.at` changes — a timestamp-only write that watchers see as
churn. (a4 F1)

## F42 — `ocm update <plugin>@<mp>` is exactly `ocm update <mp>` (area: CLI, severity: low)

Same action, same report — the plugin qualifier adds nothing. Either
scope the report to the plugin or drop the form from help. (a4 F2)

## F43 — Auto-installed plugins get `installedAt` = marketplace `addedAt` (area: CLI, severity: low)

`ocm info` reports a backdated install date for anything that arrived
via update. (a4 F6, a5 F8)

## F44 — Pin is invisible in `ocm list` (visible only in `ocm info`: `@ v1.0.0`) (area: CLI, severity: low)

Status:      confirmed-known-U2 (partially — info shows it, list does not)

## F45 — `ocm add --ref` leaves `revision` null until the first update (area: CLI, severity: low)

No provenance for a freshly added marketplace until a second network
round-trip. (a4 F8)

## F46 — Doctor's remedy is wrong for local marketplaces (area: CLI, severity: low)

"directory missing — ocm update re-clones", but update only skips local
marketplaces; the error can never clear. (a4 F11)

## F47 — Search does not match plugin-JS or MCP component names (area: CLI, severity: low)

`search hook` / `everything` / `notify` → no matches; commands, agents
and skills do match. (a5 F3)

## F48 — README omits `plugin.json` `$schema` (area: docs, severity: low)

Every README-only author gets a validate warning on first run; the field
appears in no README example. (a5 F11)

## F49 — README never documents command frontmatter requirements or `extensions` category/tags (area: docs, severity: low)

The rules are enforced by validate but stated only in the template.
(a5 F12)

## F50 — `mcpServers: "../…"` refused with a misleading "is not a JSON object" (area: CLI, severity: low)

The refusal is correct; the message names the wrong reason — the
plugin-containment rule is never stated. (a6 F1, `loader/manifest.js:128`)

## F51 — Malformed preferred manifest: add-time warning says "ignored" with no next action (area: CLI, severity: low)

Behaviour correct (no fallback); wording reads as if the manifest were
optional rather than broken. (a6 F3)

## F52 — User config re-serialized (2-space indent) on the first ocm write (area: CLI, severity: low)

Semantics and key order preserved exactly; bytes not. A diff-averse user
sees their whole file light up. (a6 F8)

## F53 — Plan/code disagreement: the v1 registry lives at `plugins/ocm-registry.json`, not `ocm/registry.json` (area: docs, severity: low)

Following the test plan's migration fixture literally destroys the v1
registry. The code (`src/paths.ts:17`, `src/loader.ts:160`) is the
truth. (a6 F9)

## F54 — 200-char plugin name crashes with raw `ENAMETOOLONG` and leaves a half-registered marketplace (area: CLI, severity: low-med)

No stated limit, no ocm-style error; `ocm list` then shows the plugin as
installed though nothing materialized (`ocm remove` recovers). Names
within per-component limits, unicode descriptions and 500-line bodies
all work. (a7 F3)

## F55 — Bare repo name / quoted `~` / whitespace args get "path does not exist" with no hint at the intent (area: CLI, severity: low)

The help's `ocm add ~/plugins/…` example only works unquoted; ocm itself
does not expand `~`. (a7 F4)

## F56 — Add-time collision refusal names only the first colliding plugin (area: CLI, severity: low)

collide ships two colliding plugins; only `alpha-kit` is named — an
author who renames just it hits the same wall again. (a3 F4)

## F57 — Re-trust report never states that functionality was reduced (area: CLI, severity: low)

A declined re-prompt conveys the block and next action, but never that a
previously-working component stopped working. (a3 F8)

## F58 — `ocm add --trust` grants without ever showing what is being trusted (area: CLI, severity: low)

No component list, no confirmation — only the materialized links imply
the grant. The interactive path prints the full risk block. (a3 F12)

## F59 — The trust prompt's `skip` answer is undocumented (area: docs, severity: low)

`[y/N/skip]` — what skip does vs N is stated nowhere. (a2)

## F60 — `ocm list` shows no sync age, and plain `list` (without `--all`) hides a failing sync (area: CLI, severity: low)

The red failure line itself works in `--all` (verified; see round
corrections). What is missing: any freshness/age display, and any
failure indication on the default listing. (a2 F7, corrected)

## F4 — `/ocm` empty state: the "add one here" route is dead (area: TUI, severity: high)

Test:        Suite 1 / Test 2.8 (user visual check)
Command:     `/ocm` on a fresh install → Enter on "No marketplaces
             added yet… Or add one here."
Expected:    the "Add marketplace" prompt appears.
Actual:      nothing appears — the alert dismisses and the flow ends.
             The only route to a first marketplace is `ocm add` in a
             terminal. Code intends the route (`loader/ui.js:16` chains
             the alert into `addMarketplaceFlow`), so the chain breaks
             somewhere between the alert's Enter handler and the flow.
Status:      confirmed (user visual check, 2026-09-13)

## F61 — TUI dialogs clip text and do not scroll, regardless of terminal size (area: TUI, severity: med)

Test:        Suite 11 / Tests 37–39 (user visual check)
Actual:      the dialog window stays small no matter how large the
             terminal is. Button help text clips mid-sentence (e.g. the
             uninstall button's description). A plugin-details view with
             many skills clips at the bottom — everything past the fold
             is unreachable, there is no scrolling.
Status:      confirmed-known-U1

## F62 — No back navigation: details views are dead ends (area: TUI, severity: med)

Test:        Suite 11 / Test 41 (user visual check)
Actual:      the plugin-details view has no back button or Escape route
             to the previous list; the only way out is closing the TUI
             dialog and re-running `/ocm` from scratch.
Status:      new

## F63 — Versions and pins are invisible throughout the TUI (area: TUI, severity: low)

Test:        Suite 11 / Test 39 (user visual check)
Actual:      a pinned plugin does not show which version the pin holds,
             and no view displays plugin versions at all — the user
             cannot tell which version is in use. (CLI shows the pin
             only in `ocm info` as `@ v1.0.0` — F44.)
Status:      confirmed-known-U2 (TUI half; extends F44)

## Known-issues scoreboard (from `docs/e2e-findings.md`)

| # | Issue | Verdict |
|---|---|---|
| 1 | False success on colliding install | **confirmed** — F10 |
| 2 | `ocm trust` cannot grant non-interactively | **confirmed** — F18 (workaround: `ocm update --trust`) |
| 3 | Skill-only install omits restart notice | not re-verified this round |
| 4 | doctor does not report collisions | **confirmed** — F32 |
| 5 | Update report says `installed (auto)` in explicit mode | **confirmed** — F12 |
| 6 | MCP hint / trustPending / interleaving / unconditional loader / stale-sync hint | **confirmed** — F19, F20, F21, F3, F23 |
| U1 | TUI dialogs cramped, no scrolling | **confirmed** — F61, F62 |
| U2 | Pin state invisible | **confirmed** — F44, F63 (CLI `info`-only and TUI-none) |
| U3 | Removal-only update may not print restart notice | **confirmed** — F16 |

## Verified good (no findings)

- Cold-start empty states (`list`/`search`/`info`), help, no tracebacks.
- `ocm init` file layout: only `ocm-loader.js` in plugins/, 22 files in
  `ocm/`, exactly one `./ocm/ui.js` in tui.json, opencode.json untouched.
- Trust prompt quality: per-component paths/command lines, shell-
  permissions warning, copy-pasteable review path, default N. All
  re-prompt scenarios correct (modified JS, changed MCP command,
  first-sight code in a code-free marketplace; key-reorder and skill-only
  edits correctly prompt nothing). Non-interactive add never hangs.
- Manifest-name precedence, namespaced symlinks and skills (the
  double-prefix observation did NOT reproduce), config hygiene (no
  `ocm--` keys when denied), local marketplace dir never modified.
- Update mechanics: revision transitions, version changes, `+ ~ -` file
  lists, `--quiet`, `--json` validity, scoped updates, all of renames
  (rename/null-drop/plain-delete/chain/cycle), all of pinning
  (fetch-before-save, tag-following, deleted-ref isolation, clear,
  `add --ref`), failure isolation (one broken marketplace never affects
  the others; recovery works).
- Install/uninstall granularity; enable/disable aliases; explicit mode
  (add/install/mode-switch/no-retroactive-install/uninstall-does-not-
  flip-mode); scan dry-run leaves zero writes.
- Search ranking (where distinguishable), `matched:` annotations,
  `(disabled)`/`(blocked)` markers in search, offline search.
- `ocm validate`: 18/20 defect rows fire with exact actionable lines;
  non-fail-fast; exit-code discipline.
- Spec 15 manifest location (all six cases), mcpServers base resolution,
  cross-tool `.claude` ignoring, Agent Plugins translation (stdio→local,
  http/sse→remote, fingerprint over translated servers).
- `ocm remove` (per-plugin summary, clone removal, user keys survive
  byte-identically); doctor's 9/11 corruption cases; migration v1→v2
  (idempotent, mapping printed); `OPENCODE_PURE` honoured and documented.
- Ownership invariant: no writes to `~/.claude`, `~/.agents`, `.claude`,
  `.agents` anywhere, in any scenario, including Ctrl+C aborts. Hand-
  written files survive every operation except F9's --force/remove path.
- Performance: list/search ~16ms with 25 plugins; opencode startup
  unaffected by sync (fire-and-forget); 22 commands, 0 plugin-load
  errors.

## Left for user (needs the visual TUI / a live session)

1. Suite 11 entirely (Tests 37–41): dialog sizing, clipping, scrolling
   (U1), filter box, per-plugin menu labels, busy indicators, TUI
   failure paths.
2. Test 1.2–1.3: `/ocm` absent before init (verified indirectly: no
   tui.json).
3. Test 2.7–2.8: `/ocm` in autocomplete; the empty-registry dialog not a
   dead end — **done: F4 confirmed, the route is dead**.
4. Test 4: running `/demo-kit:tdd`, `$ARGUMENTS`, `!` blocks, `@`
   references, agent picker, `/skills` picker rendering, skill
   auto-trigger, `/ocm` → Browse grouping.
5. Test 5.4: new command not visible in the already-running session.
6. Test 6 entirely: the TUI-only change loop.
7. Test 27: author-experience timing and hesitation (mechanical pass
   found exactly two docs gaps — F48, F49).
8. Test 30.3–30.5: `${OCM_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_ROOT}` live
   in a running command; `echo $OCM_PLUGIN_ROOT` in a shell block.
9. Test 42.4: `/` autocomplete usability with 22 namespaced commands —
   **partially done (user noted the MCP prompt names; see F64 note
   below if adopted)**.
10. Test 8.5: true network-kill reinstall (offline-from-cache verified by
    timing only).

User visual round done so far: Tests 37–39 (F61–F63), 2.8 (F4). The
MCP-prompt naming (`/ocm--demo-kit--everything:simple-prompt:mcp`) was
checked against spec 04 and is by design — not recorded as a finding
unless the user wants a naming-UX change.

## Fixture/plan discrepancies (not code bugs)

- `ocm-e2e-big` and `ocm-e2e-search` share all 10 plugin names — the
  plan's Test 42 assumed only alpha/collide collide (a7).
- The plan's "a plugin with both `command/` and `commands/` → error"
  overstates spec 03: distinct names merge; only a NAME clash errors (a7).
- v1 registry location (F53) — **dismissed**: a6 misquoted the plan;
  `docs/e2e-test-plan.md:596` already says `plugins/ocm-registry.json`,
  matching the code. No defect.
- `opencode debug command` does not exist (a5) — verify commands via
  `debug config` / symlinks.

## Triage (2026-09-13)

Every finding from both rounds, dispositioned. Specs live in
`docs/specs/16`–`26`; each names its release and branch. Decisions
marked **wontfix**/**dismissed** are recorded so they stay findable.
U4 was decided by the owner (2026-09-13): mandatory `plugin.json`.

| Finding | Disposition | Spec | Release |
|---|---|---|---|
| F1 doctor 23 errors on fresh home | fix — single "not installed" line | [20](./specs/20-doctor-config-safety.md) §1 | v0.4.0 |
| F2 success messages red/stderr | fix — stdout | [23](./specs/23-truthful-reports.md) §1 | v0.5.0 |
| F3 unconditional "installed" loader lines | fix — conditional wording | [23](./specs/23-truthful-reports.md) §2 | v0.5.0 |
| F4 TUI empty-state add route dead | fix — repair the chain | [22](./specs/22-tui-fixes.md) §1 | v0.4.0 |
| F5 Ctrl+C silent half-install | fix — loader before prompt, SIGINT summary, exit 130 | [16](./specs/16-trust-flow.md) §1 | v0.3.0 |
| F6 stale global install | resolved in-round (reinstall); no action | — | — |
| F7 relative-path dead symlinks | fix — absolute resolution pre-write | [17](./specs/17-add-integrity.md) §1 | v0.3.0 |
| F8 doctor --fix deletes trusted link | fix — record reconciliation + ownership guard | [20](./specs/20-doctor-config-safety.md) §2 | v0.4.0 |
| F9 displaced original lost on remove | fix — restore-if-free, always reported | [21](./specs/21-displaced-originals.md) | v0.4.0 |
| F10 colliding install false success (#1) | fix — refuse; --force takes over; no silent flip | [18](./specs/18-collisions.md) §1 | v0.3.0 |
| F11 no-op install/uninstall false claim | fix — "already installed"/"not installed" | [23](./specs/23-truthful-reports.md) §3 | v0.5.0 |
| F12 explicit mode "installed (auto)" (#5) | fix — mode-aware label | [23](./specs/23-truthful-reports.md) §4 | v0.5.0 |
| F13 trust re-prompt loop, stale grant | fix — per-component decline; prompt only on new | [16](./specs/16-trust-flow.md) §3 | v0.3.0 |
| F14 scan false collision on empty dest | fix — distinct destination states | [18](./specs/18-collisions.md) §4 | v0.3.0 |
| F15 untrusted components unmarked in list | fix — `(blocked — …)` marker | [25](./specs/25-display.md) §1 | v0.5.0 |
| F16 removal-only update no restart notice (U3.1) | fix — notice on removals | [23](./specs/23-truthful-reports.md) §5 | v0.5.0 |
| F17 info renders registry fiction | fix — disk truth + trust state | [25](./specs/25-display.md) §3 | v0.5.0 |
| F18 trust non-interactive impossible (#2) | fix — `--yes` flag; non-TTY exit 1 | [16](./specs/16-trust-flow.md) §2 | v0.3.0 |
| F19 MCP warning lacks trust hint (#6) | fix — hint suffix | [16](./specs/16-trust-flow.md) §4 | v0.3.0 |
| F20 trustPending invisible (#6) | fix — markers in list/info/doctor | [25](./specs/25-display.md) §2 | v0.5.0 |
| F21 trust block interleaving (#6) | fix — buffer behind marketplace header | [23](./specs/23-truthful-reports.md) §6 | v0.5.0 |
| F22 cache warning loop, "discarded" false | fix — `clean -fd`, once-only warning | [26](./specs/26-update-hygiene.md) §1 | v0.5.0 |
| F23 "sync is stale" after fresh add | fix — record revision/lastSync at add; local excluded | [17](./specs/17-add-integrity.md) §4 | v0.3.0 |
| F24 validate silent in wrong dir | fix — "not a marketplace directory" error | [24](./specs/24-validate-hardening.md) §1 | v0.5.0 |
| F25 validate misses 2 defect rows | fix — duplicate `plugins[]`, cross-plugin collisions | [18](./specs/18-collisions.md) §6 | v0.3.0 |
| F26 single-dash stray invisible to doctor | fix — warning (never auto-removed) | [20](./specs/20-doctor-config-safety.md) §3 | v0.4.0 |
| F27 doctor --fix doesn't re-clone | fix — re-clone, per spec 12 | [20](./specs/20-doctor-config-safety.md) §4 | v0.4.0 |
| F28 corrupt config: no manual hint, double warning | fix — single warning + manual edit + honest report | [20](./specs/20-doctor-config-safety.md) §5 | v0.4.0 |
| F29 read-only config silently replaced | fix — pre-flight writability, clean refusal | [20](./specs/20-doctor-config-safety.md) §5 | v0.4.0 |
| F30 orphan links after uninstall+init | fix — doctor orphan sweep, --fix removes | [20](./specs/20-doctor-config-safety.md) §3 | v0.4.0 |
| F31 private repo hangs at git prompt | fix — `GIT_TERMINAL_PROMPT=0`, ssh BatchMode | [17](./specs/17-add-integrity.md) §3 | v0.3.0 |
| F32 doctor silent on collisions (#4) | fix — finding per collision record | [18](./specs/18-collisions.md) §3 | v0.3.0 |
| F33 no `--version` | fix | [23](./specs/23-truthful-reports.md) §9 | v0.5.0 |
| F34 help doesn't lead with `add` | fix | [23](./specs/23-truthful-reports.md) §10 | v0.5.0 |
| F35 output noise (blocked lines, zero-counts, stderr events) | fix — once-per-run summary, drop zeros, events to stdout | [23](./specs/23-truthful-reports.md) §7 | v0.5.0 |
| F36 notice ordering inconsistent | fix — headline first everywhere | [23](./specs/23-truthful-reports.md) §6 | v0.5.0 |
| F37 explicit add "available" claim | fix — closing line names install | [23](./specs/23-truthful-reports.md) §8 | v0.5.0 |
| F38 scan gives no layout hint | fix — layout + validate pointer | [18](./specs/18-collisions.md) §5 | v0.3.0 |
| F39 scan no trust caveat | fix — `(trust-gated)` annotation | [18](./specs/18-collisions.md) §4 | v0.3.0 |
| F40 fire-and-forget sync | docs only — README paragraph | [26](./specs/26-update-hygiene.md) §2 | v0.5.0 |
| F41 no-op update rewrites registry | **wontfix** — lastSync.at is real state; recorded | [26](./specs/26-update-hygiene.md) §3 | — |
| F42 `update <plugin>@<mp>` == `update <mp>` | fix — scope the report to the plugin | [23](./specs/23-truthful-reports.md) §8 | v0.5.0 |
| F43 installedAt backdated | fix — real time on auto-install | [25](./specs/25-display.md) §4 | v0.5.0 |
| F44 pin invisible in list (U2) | fix — `(pinned @ …)`; + interactive ref picker | [25](./specs/25-display.md) §5 | v0.5.0 |
| F45 `add --ref` leaves revision null | fix — record clone revision | [17](./specs/17-add-integrity.md) §4 | v0.3.0 |
| F46 doctor wrong hint for local MPs | fix — restore-or-remove remedy | [20](./specs/20-doctor-config-safety.md) §3 | v0.4.0 |
| F47 search misses plugin-JS/MCP names | fix — searchable component types | [25](./specs/25-display.md) §7 | v0.5.0 |
| F48 README omits `$schema` | fix — every example carries it | [19](./specs/19-mandatory-manifests.md) (template & docs) | v0.3.0 |
| F49 README omits frontmatter/`extensions` | fix — authoring subsections | [24](./specs/24-validate-hardening.md) §3 | v0.5.0 |
| F50 `mcpServers ../` misleading error | fix — name the containment rule | [24](./specs/24-validate-hardening.md) §2 | v0.5.0 |
| F51 malformed manifest "ignored" | fix — fix-or-remove wording | [24](./specs/24-validate-hardening.md) §2 | v0.5.0 |
| F52 config re-serialized | **wontfix** — documented instead | [20](./specs/20-doctor-config-safety.md) §5 | — |
| F53 plan/code v1 registry location | **dismissed** — false finding (see above) | — | — |
| F54 200-char name ENAMETOOLONG | fix — pre-flight limits, atomic refusal | [17](./specs/17-add-integrity.md) §2 | v0.3.0 |
| F55 bare name / quoted `~` / whitespace | fix — expand `~`, trim, URL hint | [17](./specs/17-add-integrity.md) §5 | v0.3.0 |
| F56 collision refusal names only first | fix — list all colliding plugins | [18](./specs/18-collisions.md) §2 | v0.3.0 |
| F57 decline never states reduced functionality | fix — name what stopped running | [16](./specs/16-trust-flow.md) §4 | v0.3.0 |
| F58 `add --trust` grants blind | fix — print components before grant | [16](./specs/16-trust-flow.md) §4 | v0.3.0 |
| F59 `skip` undocumented | fix — README trust section | [16](./specs/16-trust-flow.md) §4 | v0.3.0 |
| F60 no sync age; plain list hides failure | fix — age in `--all`, failure marker in list | [25](./specs/25-display.md) §6 | v0.5.0 |
| F61 TUI clipping, no scroll (U1) | fix — size to terminal, wrap, scroll | [22](./specs/22-tui-fixes.md) §2 | v0.4.0 |
| F62 no back navigation | fix — Escape stack + visible back | [22](./specs/22-tui-fixes.md) §3 | v0.4.0 |
| F63 versions/pins invisible in TUI (U2) | fix — pin + version rendering | [22](./specs/22-tui-fixes.md) §4 | v0.4.0 |
| round-1 #3 skill-only install no notice | fix — count skill creations | [23](./specs/23-truthful-reports.md) §5 | v0.5.0 |
| round-1 U4 mandatory manifests | **decided (b)** — plugin.json required w/ description | [19](./specs/19-mandatory-manifests.md) | v0.3.0 |
| MCP prompt naming (`ocm--p--s:prompt:mcp`) | by design — ownership prefix + opencode's prompt rendering; no change | — | — |

Release plan and branch policy: `docs/specs/README.md` ("Releases &
versioning", "Branches"). Pending immediate action: publish **v0.2.0**
(specs 14–15, already implemented on `main`).
