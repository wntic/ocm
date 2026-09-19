# E2E findings — round 3 (2026-09-15)

Round 3 against ocm v0.5.0 (repo HEAD `4eb4df0`, "Mark v0.5.0 as
published"), per [the round-3 plan](./e2e-test-plan-round3.md). Part A
regression gate (one step per round-2 fix), Part B functional re-run, Part
C seams between the fixes, Part D unvisited surface. Raw per-agent logs
with verbatim output are in `docs/e2e-round3/a1.md` … `d3.md` (method
brief in `docs/e2e-round3/BRIEF.md`); this file is the consolidated view.

Environment: opencode 1.18.31, git 2.50.1 (Apple Git), bun 1.4.2, macOS
(APFS, case-insensitive). `ocm` = global symlink to repo HEAD (verified
not stale — S0). Fixture upstreams are local git repos added via `file://`
URLs (same clone/fetch/reset code path as https; upstream change = commit
in the source repo) plus local-directory fixtures; no GitHub-hosted
fixtures this round.

Headline: **54 of 55 round-2 findings closed** (F61 failed the user's TUI
pass — see F124; F29 closed for `opencode.json` only; F35/F42/F58 still
open in narrowed form). 62 new findings: 4 high, 28 medium, 30 low —
dominated by two clusters: **truthfulness of reports against on-disk
state** (the round-2 theme, now at the boundaries: skipped plugins,
refused renames, local marketplaces, concurrent writes) and **error
misdiagnosis** (four distinct conditions all rendering as "the repository
is private, unreachable, or the URL is wrong").

Round corrections / method notes:

- **Fixture defect, mid-round fix:** the shared MP-B (`exec-src`) fixture
  initially shipped a pre-1.18 mcp.json shape and a named-export plugin
  module. Both are authoring errors against opencode 1.18.31 (the repo's
  own `template/` uses the correct shapes), and were fixed in the fixture
  after Part A. Findings a5-FD1/FD2 were fixture artifacts and are
  **withdrawn**; the ocm-side gaps they exposed are kept (F68, F90).
- `opencode debug config` does **not** run the loader's startup sync (it
  loads no server plugins). Agents forced syncs with short headless TUI
  sessions under `expect`. The round-3 plan's A9.2/A5.2 wording assumes
  otherwise — noted for the next plan.
- The registry lives at `$H/.config/opencode/ocm/registry.json` (not
  `.config/ocm/`); the BRIEF was corrected mid-round.
- Every ocm defect below was verified on disk (registry JSON, symlinks,
  `opencode debug config`), not just from CLI output. Cross-cutting
  invariants (no `.claude`/`.agents` writes, plugins/ hygiene, no broken
  symlinks, config parses, doctor agreement) held on **all** homes at
  suite end except where a finding says otherwise.
- **Post-round real-GitHub pass** (user-requested supplement to the
  `file://` deviation): fixtures pushed to `github.com/wntic/ocm-e2e-alpha`
  (public) and `github.com/wntic/ocm-e2e-private` (private), both kept for
  future rounds. Public https add (1.2s), network update with version
  transition + new plugin, pin holding through an upstream advance,
  unpin + advance, remove and doctor green — all pass. The private repo
  is refused cleanly in 0.5s with no credential prompt (the round-2
  in-session hang is confirmed fixed over real GitHub: `loader/git.js`
  sets `GIT_TERMINAL_PROMPT=0` and BatchMode ssh). A 404 and a
  private-without-auth are genuinely indistinguishable on GitHub, so the
  shared "private, unreachable, or the URL is wrong" message is honest
  for both over real https. Logs in `/tmp/ocm-gh/logs/`.
- **User's manual TUI pass** (post-round, against the `/tmp/ocm-tui`
  test bed): A11.1 pass (F4 closed), A11.3 pass (F62 closed — the
  occasional double-Esc is the designed view stack, one Escape per
  dialog layer, spec 22 §3), A11.4 pass (F63 closed), A11.2 fail (F61
  re-opened as F124). B1.2: the 8 reviewer agents load correctly
  (verified via `opencode debug config`, all `mode: subagent`) — they do
  not appear in the primary-agent picker because opencode only offers
  `mode: primary` agents there; subagents are invoked by `@` mention or
  by the primary agent's Task tool (opencode docs, verified Sep 2026).
  Fixture-expectation mismatch, not an ocm defect. B1.6 not conducted.

---

## High

## F64 — concurrent `ocm add` + `ocm update` silently loses the added marketplace (area: CLI, severity: high)

Test:        D3.2 (d1)
Command:     `HOME=$H ocm add file:///…/big-src & HOME=$H ocm update </dev/null & wait`
Expected:    plan D3.2 — no corrupted registry; every marketplace record survives
Actual:      both exit 0; add prints `added marketplace "ocm-e2e3-big"`;
             registry afterwards contains only `ocm-e2e3-alpha` — the new
             marketplace's record is gone; clone and links orphaned;
             `ocm doctor` exits 1 with 11 errors blaming a "loader
             uninstall". update's read-modify-write (registry loaded once,
             saved per-marketplace after each pull,
             `src/commands/update.ts:121`) overwrites the add's save. No
             locking in the CLI write path. Reproduced 3/3.
Impact:      a user who adds in one terminal while any write command runs
             elsewhere gets a silently vanished marketplace and cryptic
             doctor errors.
Spec ref:    docs/specs/02-registry.md (single-writer assumption)

## F65 — XDG_CONFIG_HOME ignored by ocm while opencode follows it (area: CLI, severity: high)

Test:        D4.6 (d2)
Command:     `HOME=$H XDG_CONFIG_HOME=$H/xdg ocm add file:///…/alpha-src`
Expected:    ocm follows XDG_CONFIG_HOME, or refuses, or documents it
Actual:      exit 0 — everything written under `$H/.config/opencode/`,
             `$H/xdg` untouched; `opencode debug config` with the same env
             sees none of it (opencode follows XDG). No mention of XDG
             anywhere in README/docs (grep clean).
Impact:      any user with XDG_CONFIG_HOME set gets a fully broken install
             that reports success — split brain between the two tools.
Spec ref:    docs/specs/00-contract.md (config locations)

## F66 — case-insensitive filesystem: case-folded duplicate plugin dirs silently merge; one plugin lost (area: CLI, severity: high)

Test:        D4.4 (d2)
Command:     `ocm add file:///Volumes/CSX/case-mp` (repo ships `plugins/case-Kit` and `plugins/case-kit`)
Expected:    "detected as a collision or refused, not silently merged"
Actual:      exit 0, `added marketplace "case-mp" / case-kit (1 commands)`,
             empty stderr. The clone has ONE dir (case-Kit) holding
             case-kit's files; `case-Kit` is unregistered; cache left
             permanently dirty; doctor all green; the discard/name-mismatch
             warnings only appear at the next update (which still exits 0).
Impact:      a marketplace authored on Linux installs "successfully" on
             macOS with a missing plugin and a mislabeled registry entry;
             nothing at add time says so.
Spec ref:    docs/specs/18-collisions.md §2

## F67 — ocm's own template agent is broken as a subagent (`model: inherit`) (area: docs/template, severity: high)

Test:        D1.3 (d3)
Command:     `opencode run "use the reviewer agent (subagent) to review billing.py…"`
Expected:    the demo-kit reviewer agent runs
Actual:      `✗ Review billing.py failed Demo-Kit:Reviewer Agent / Error:
             Model not found: inherit/.` — opencode falls back to a General
             Agent. `template/plugins/demo-kit/agents/reviewer.md:8` ships
             `model: inherit` (a Claude Code-ism); `ocm validate` passes
             the template clean; the README never states the `model` value
             format or that omitting `model` is the inherit form.
Impact:      every user who copies the reference plugin ships a broken
             agent with zero warnings anywhere.
Spec ref:    docs/specs/06-manifests.md (agent frontmatter), template/

---

## Medium

## F68 — trust listing prints a blank command line for string-form MCP entries (area: CLI+TUI, severity: med)

Test:        A1.7 / F58; A9.1 (a1, a8)
Command:     `ocm add <mp> --trust` (mcp.json with `"command": "node", "args": […]`)
Expected:    F58 — the full component listing (type, plugin, path, command
             line) before the grant
Actual:      `  mcp     notify/everything (local server: )` — empty parens.
             Array-form `command` renders fine. Root cause:
             `src/commands/trust-prompt.ts:16` and `loader/ui-trust.js:15`
             join only when `Array.isArray(command)`. The string form is
             exactly what Agent Plugins translation consumes (B6), so
             translated marketplaces hit it too.
Impact:      the security-review surface understates what will run for the
             common string-command form; `--trust` is blind there. F58
             stays open, narrowed.
Spec ref:    docs/specs/16-trust-flow.md §4

## F69 — plugin "skipped" for an over-long name still has its command materialized (area: CLI, severity: med)

Test:        A2.4 / F54b (a2)
Command:     `ocm update` after upstream adds a 70-char-named plugin
Expected:    skipped plugin leaves nothing behind
Actual:      stderr warns `plugin "qqq…" exceeds 64 chars (70); rename it…`
             and the registry omits it — but
             `$H/.config/opencode/commands/qqq…:nope.md` is linked and
             `opencode debug config` exposes `/qqq…:nope`. Doctor silent.
Impact:      the user is told it was skipped while opencode serves its
             command — exactly what the limit exists to prevent.
Spec ref:    docs/specs/17-add-integrity.md §2

## F70 — stale collision record after `ocm remove` of the incumbent; doctor names a removed marketplace (area: CLI, severity: med)

Test:        A3.5 follow-up (a3)
Command:     `ocm remove ocm-e2e3-big` (after a --force takeover)
Expected:    no dangling collision record; doctor must not claim ownership
             by a marketplace that no longer exists
Actual:      `error plugin "big-07" from marketplace "ocm-e2e3-collide" is
             disabled — the name is owned by marketplace "ocm-e2e3-big"`
             — which was just removed. Recovery works (plain install
             clears it), so the record is stale, not blocking.
Impact:      doctor's diagnosis is false at that moment.
Spec ref:    docs/specs/18-collisions.md §1

## F71 — add and update route around a malformed plugin.json (area: CLI, severity: med)

Test:        A4.4 lens (a4)
Command:     `ocm add /tmp/ocm-e2e3/fixtures/broken/bad-plugin-json`
Expected:    spec 19 — refused at every boundary (add, update, validate)
Actual:      exit 0, `added marketplace "bad-plugin-json" / p-one (1
             commands)` + a warning; plugin installs with `manifest: {}`.
             `ocm validate` on the same tree exits 1 — add and validate
             disagree. Root cause: the manifest-refusal check
             (`loader/limits.js:38`) tests file existence only.
Impact:      the search-blind state spec 19 was decided to prevent ships
             anyway, with contradictory answers from add vs validate.
Spec ref:    docs/specs/19-mandatory-manifests.md

## F72 — add and update accept `description: ""` (area: CLI, severity: med)

Test:        A4.4 lens (a4)
Command:     `ocm add …/broken/empty-desc`
Expected:    refusal (non-empty description is the one hard requirement)
Actual:      exit 0, no warning; registry records `description: ""`;
             upstream changes update it with no warning either.
Impact:      same class as F71 — validate errors where add succeeded.
Spec ref:    docs/specs/19-mandatory-manifests.md

## F73 — local marketplaces: the manifest grandfather never ends (area: CLI, severity: med)

Test:        A4.6 (a4), C4.2 (c2)
Command:     edit a local marketplace's manifest-less installed plugin → `ocm update`
Expected:    spec 19 edge — grandfather ends when the plugin changes; update refuses
Actual:      exit 0, silent; plugin stays enabled, changed content live via
             symlink. Renames-map renames apply silently too. Root cause:
             the changed-set derives only from the git revision pair
             (`src/commands/update-report.ts:46` returns an empty map for
             local entries). The identical scenario on a git marketplace
             refuses correctly.
Impact:      for a first-class source type the spec's migration boundary
             does not exist.
Spec ref:    docs/specs/19-mandatory-manifests.md (edge cases)

## F74 — refused rename silently unlinks all of the plugin's components; surfaces misreport the aftermath (area: CLI, severity: med)

Test:        B4 S2 collision (b3)
Command:     `ocm update` (rename target name owned by another marketplace)
Expected:    "refused, reported; the old record stays" (spec 08 rule 5)
Actual:      warning `refused rename greet-kit → stolen-name: … already
             provided by marketplace "ocm-e2e3-rival"`, exit 0 — but
             commands/ and agents/ are now EMPTY, the skill mirror is gone,
             `ocm list` still shows the old components, and doctor
             misdiagnoses the plugin as legacy manifest-less.
Impact:      the user's command and agent vanish with a one-line report
             that mentions no removal; every surface then lies about it.
Spec ref:    docs/specs/08-update.md §5

## F75 — rename of a manifest-less plugin reports "renamed" while the plugin is refused and dropped (area: CLI, severity: med)

Test:        C4.2 (c2)
Command:     `ocm update` (git marketplace, renames-map rename, no plugin.json)
Expected:    the report states which outcome applied; registry not left
             with both records
Actual:      stdout: `renamed legacy-tool → legacy-tool-2` + restart
             notice; stderr: manifest-missing warning; registry afterwards
             `plugins: {}` — the record was migrated then dropped; the
             old link came down. Net effect (plugin removed) stated
             nowhere.
Impact:      "renamed" reads as "moved and working"; it is uninstalled.
Spec ref:    docs/specs/19-mandatory-manifests.md, 08-update.md

## F76 — skipped skills still claimed by registry, list and report (area: CLI, severity: med)

Test:        B4 S1 (b3); also b2-F2
Command:     `ocm update` (upstream SKILL.md without frontmatter `name`)
Expected:    truthful records — a skipped component is not reported installed
Actual:      report `~ skills/greeting/SKILL.md`; registry keeps the skill;
             `ocm list` prints `skills: greeting`; `opencode debug config`
             → `.skills.paths` null. Only the stderr skip warning is true.
             Mirror case at install time: `+ skills/notes-12/SKILL.md`
             listed under `installed (auto)` while the mirror was never
             created.
Impact:      user believes the skill is installed; opencode silently has
             none.
Spec ref:    docs/specs/23-truthful-reports.md

## F77 — `ocm scan` green-lights marketplaces `ocm add` refuses (area: CLI, severity: med)

Test:        B6.1 cases 6 & 8 (b4)
Command:     `ocm scan <dir>` on a manifest-less / dir-clash marketplace
Expected:    scan is a dry-run of add
Actual:      `3 plugin(s) would be installed` — the subsequent `ocm add`
             refuses both (missing plugin.json; component name clash).
Impact:      a user who scans first gets a false green; the add-time
             refusal is the first signal.
Spec ref:    docs/specs/18-collisions.md §4, 19

## F78 — trust-undecided ("none") executables render as installed in `ocm list` (area: CLI, severity: med)

Test:        A9.1 follow-up (a8, b4)
Command:     `ocm add <mp-with-code> </dev/null` (EOF default) → `ocm list` / `ocm list --all`
Expected:    spec 25 §1/§2 — untrusted executables marked
Actual:      list shows `mcp: everything` etc. with no marker; registry
             `trust.code: "none"`. The marker keys on `"denied"` only
             (`src/commands/list.ts:63`). A tty `n` (→ denied) or
             `--no-trust` marks correctly; `ocm info` is truthful; doctor
             silent.
Impact:      after any scripted/piped add (the default path for
             automation), list reads as if the code is installed; search
             and list disagree.
Spec ref:    docs/specs/25-display.md §1–2

## F79 — SIGINT between rename and record leaves a displaced original with no record; records file not atomic (area: CLI, severity: med)

Test:        C2.1 (c1)
Command:     expect: `ocm install big-03@ocm-e2e3-collide --force`, `\x03` during the operation
Expected:    displacement either did not happen or is recorded/recoverable
Actual:      (1-in-40 timing window, reproduced) user's
             `commands/big-03:clash.md` gone; content present under
             `.cache/ocm/displaced/<ts>/…`; `displaced-records.json` 0
             bytes (truncated mid-write — it is a bare `writeFileSync`);
             doctor names the cache copy but misattributes ("removed by an
             older ocm?") and no verb ever restores it.
Impact:      a Ctrl+C at the wrong sub-millisecond loses the user's file
             from view; the same interrupt can wipe previously recorded
             displacements.
Spec ref:    docs/specs/21-displaced-originals.md

## F80 — command/agent links of an unregistered marketplace are outside the orphan sweep; with the clone gone, doctor disclaims ocm's own links (area: CLI, severity: med)

Test:        A5.4 / C3.1 (a5, c1)
Command:     registry record removed by hand (the F30 state) → `ocm doctor [--fix]`
Expected:    plan F30 — orphaned ocm links reported and swept by --fix
Actual:      `commands/greet-kit:greet.md` / `agents/…` reported by
             NOTHING while the clone exists (no verb can remove them); with
             the clone deleted: `error …: broken symlink → …/.cache/ocm/
             marketplaces/… (not ocm's, left in place)` — --fix removes
             nothing, ever. The links provably point into ocm's own cache
             namespace; only the `ocm--` and skill-mirror layouts are
             swept.
Impact:      the exact F30 harm, one link-layout over: permanent broken
             symlinks doctor actively disowns.
Spec ref:    docs/specs/20-doctor-config-safety.md §3

## F81 — concurrent-update loser gets a network-flavoured diagnosis for git lock contention (area: CLI, severity: med)

Test:        D3.1 (d1)
Command:     two `ocm update` at once (same home)
Expected:    loser fails cleanly, naming the contention
Actual:      `failed: cannot access file:///… — the repository is private,
             unreachable, or the URL is wrong` — underlying error (never
             shown) is `cannot lock ref 'refs/remotes/origin/main'`.
             `pullRepo` maps every failed fetch to this message
             (`loader/sync.js:24-29`).
Impact:      the user debugs access/URLs instead of the second ocm process.
Spec ref:    docs/specs/17-add-integrity.md §3

## F82 — first retry after a killed `ocm add` fails with the same misleading "cannot access" (area: CLI, severity: med)

Test:        D3.3 (d1)
Command:     `kill -9` mid-add, then retry the same add once
Expected:    next command recovers or reports cleanly (registry itself was
             never corrupted in ~35 kills — atomic write holds)
Actual:      retry: `cannot access file:///… — the repository is private,
             unreachable, or the URL is wrong`, exit 1 (orphan clone dir
             from the killed attempt); the SECOND retry succeeds — the
             failed attempt's cleanup is what removes the orphan.
Impact:      a user who interrupted an add concludes the URL is broken.
Spec ref:    docs/specs/17-add-integrity.md, 05-install.md

## F83 — raw node errors leak when ~/.cache is unwritable or not a directory (area: CLI, severity: med)

Test:        D4.8 (d2)
Command:     chmod 555 `$H/.cache` (or make it a file) → `ocm add`
Expected:    ocm-style error naming the thing and next action
Actual:      `EACCES: permission denied, mkdir '…/.cache/ocm'` /
             `ENOTDIR: not a directory, mkdir '…'` on stderr, exit 1. No
             partial state.
Impact:      raw Bun/node internals surfaced to the user — the exact
             information-exposure class this round was asked to hunt.
Spec ref:    docs/specs/23-truthful-reports.md §1

## F84 — OCM_PLUGIN_ROOT/CLAUDE_PLUGIN_ROOT unset inside command `!` blocks; README claim unscoped (area: docs/loader, severity: med)

Test:        D1.2 (d3)
Command:     a command whose `!` block echoes `$OCM_PLUGIN_ROOT`
Expected:    plan D1.2 — both vars point at the marketplace root inside `!` blocks
Actual:      both empty inside `!` template execution; the loader's
             `shell.env` hook fires only for the model's bash tool (where
             the vars are set and `"${OCM_PLUGIN_ROOT}/plugins/<p>/
             scripts/x.sh"` runs fine). README.md:134–137 states the
             export without scoping.
Impact:      an author following the README writes a silently broken
             command.
Spec ref:    docs/specs/11-cross-tool.md

## F85 — doctor --fix under a corrupt registry promises removals it never performs (area: CLI, severity: med)

Test:        A5.2 extra probe (a5)
Command:     corrupt registry JSON → `ocm doctor --fix`
Expected:    error text matches what --fix actually does
Actual:      `… no marketplace owns this link (orphaned by a loader
             uninstall?) — ocm doctor --fix removes it` (×2), exit 1 —
             mirrors still on disk after --fix; the cause guess is also
             wrong (registry is corrupt).
Impact:      user runs --fix as instructed, nothing changes, same errors
             repeat.
Spec ref:    docs/specs/20-doctor-config-safety.md

## F86 — corrupt-registry remedy "(ocm update)" is a dead end that exits 0 (area: CLI, severity: med)

Test:        A5.2 extra probe (a5)
Command:     `ocm update` with a corrupt registry
Expected:    a recovery path that addresses the corruption
Actual:      exit 0, `no marketplaces added yet (ocm add <url|path>)` —
             registry still corrupt.
Impact:      doctor's suggested remedy silently no-ops with a success exit
             code and masks the corruption.
Spec ref:    docs/specs/20-doctor-config-safety.md, 23 §9

## F87 — stale displacement records re-reported as live on every later teardown (area: CLI, severity: med)

Test:        A6.6/A6.7 (a6)
Command:     `ocm remove` after a displacement was already restored
Expected:    teardown with no live displaced files → no noise
Actual:      `your commands/greet-kit:greet.md was displaced … and the path
             is taken — original kept at …` on every remove (the path is
             taken by the already-restored original itself); doctor's
             displacement count overstates live copies. Records are never
             consumed/pruned on restore.
Impact:      alarming, untrue reporting; no data loss.
Spec ref:    docs/specs/21-displaced-originals.md, 23 §3

## F88 — plugin-scoped update leaves other plugins' mirrors stale, unreported (area: CLI, severity: med)

Test:        A7.10 / F42; B4 S4 (a7, b3)
Command:     `ocm update greet-kit@ocm-e2e3-alpha` (both plugins changed upstream)
Expected:    spec 23 §8 — same action as the marketplace-wide form, report narrowed
Actual:      whole repo pulled, only greet-kit materialized; tip-kit's
             skill mirror stays rendered at the old revision while the
             registry records the new one; the deferred content is applied
             silently by whichever full update comes later (or never).
             Follow-on (F101): the next full update prints `already up to
             date` **plus** a restart notice. F42 stays open in this
             narrowed form.
Impact:      user believes the marketplace is current; the other plugin's
             content is old.
Spec ref:    docs/specs/23-truthful-reports.md §8

## F89 — local add of a case-collision proceeds with a cross-wired command link (area: CLI, severity: med)

Test:        D4.4 (d2)
Command:     `ocm add` a local dir with `case-Kit`/`case-kit` plugin dirs
Expected:    refused, or merged consistently
Actual:      exit 0 with two warnings (name/dir mismatch; `case-kit:run.md
             conflicts with case-Kit:run.md`) — but the registered
             plugin's command link serves the OTHER plugin's command
             content; `case-Kit` never registered.
Impact:      a marketplace whose command runs code belonging to a plugin
             that isn't the one listed.
Spec ref:    docs/specs/18-collisions.md §2

## F90 — no mcp.json shape guard at add/trust; an old-shape entry bricks opencode after a trusting add (area: loader, severity: med)

Test:        A9.2 setup (a8, environment discovery)
Command:     trust a marketplace whose mcp.json predates opencode's
             `{type, command[], enabled}` shape
Expected:    ocm only writes config that opencode accepts
Actual:      opencode refuses to start: `Configuration is invalid at
             …/opencode.json … got {"command":"node","args":[…]} / Missing
             key mcp.ocm--…--….enabled`. `ocm validate` flags the entry
             (`entry "everything" is missing "type"`), but nothing in
             add/trust does — the pass-through is raw (`loader/mcp.js`).
Impact:      a real marketplace authored the old way bricks opencode after
             a trusting add, with no warning at decision time. (Found via
             a wrongly-authored fixture — the shape is the author's error,
             the missing guard is ocm's gap.)
Spec ref:    docs/specs/06-manifests.md (mcp entry shape), 07-trust.md

## F124 — /ocm dialog too tight at 80 columns: details-view rows truncate descriptions (area: TUI, severity: med)

Test:        A11.2 / F61 (user's manual TUI pass, home-main, 80×24)
Command:     open /ocm → Browse → skill-kit → Details (30 skills)
Expected:    F61 — content wraps or scrolls, never clipped (spec 22 §2)
Actual:      scrolling works, but skill descriptions are truncated on
             the right: at an 80-col terminal only the medium bucket
             (60-col frame) qualifies — large is 88 > terminal−2 — and
             select rows ellipsize past frame−9 = 51 characters
             (`loader/ui-dialog.js` BUCKETS/ROW_CHROME; the wrap model
             exists but option rows go through the widget's ellipsizer).
             The dialog also never grows into a wide terminal beyond what
             the shortest fitting bucket allows.
Impact:      on the default terminal size the details view — the one
             place long text belongs — is the least readable view.
Spec ref:    docs/specs/22-tui.md §2

---

## Low

## F91 — duplicate pending-trust lines on every update (area: CLI, severity: low)
Test: A1.4 (a1). `trust pending for "…" (N executable components blocked)…` followed by `warning: N components blocked pending trust…` — two lines restating one fact on every run. F13a itself passes (one reminder, no block, no prompt, no hang).

## F92 — incumbent-side update records a collision silently (area: CLI, severity: low)
Test: A3.3 (a3). After a --force takeover, `ocm update` of the incumbent writes `"collision": "…"` into the registry with zero output about the state change. (a3)

## F93 — grandfather-end refusal doesn't say why-now; the removal itself is unreported (area: CLI, severity: low)
Test: A4.6 (a4). The manifest-missing warning is indistinguishable from a new broken plugin; a previously-working plugin vanishes from `ocm list` with only that warning as trace.

## F94 — bogus version-transition line for an unchanged grandfathered plugin (area: CLI, severity: low)
Test: A4.6 (a4). `legacy-tool   0.1.0 → ?` printed on every update (record.version null once the manifest is gone).

## F95 — read-only tui.json: only add/update refuse; install/uninstall/remove proceed (area: CLI, severity: low)
Test: A5.8 (a5). Refusals are limited to the commands that write tui.json; no partial state in any case. Narrower than the plan text; needs adjudication (arguably correct-by-design).

## F96 — `ocm remove` omits the restart notice (area: CLI, severity: low)
Test: A5.8 (a5). `ocm uninstall` prints it after removing links; `ocm remove` does not.

## F97 — unprefixed progress line in doctor --fix re-clone output (area: CLI, severity: low)
Test: A5.5 (a5). `clone directory missing, re-clone from …...` — the only actionable line without an error/warning/fixed/loader prefix.

## F98 — `install --force` on an installed plugin says "already installed" while it displaces a file (area: CLI, severity: low)
Test: A6.2/A6.8 (a6). Headline reads as a no-op; the only truthful signal is the stderr displacement warning.

## F99 — dirty-cache warning names counts, not the discarded files (area: CLI, severity: low)
Test: A10.1 (a6, c3). `discarded 1 local change and 1 untracked file` — with several edits the user cannot tell what was thrown away; after the clean they are unrecoverable.

## F100 — unrelated mutations print zero blocked-trust lines (area: CLI, severity: low)
Test: A7.8 / F35 (a7). With an untrusted marketplace present, `ocm install <other-mp's plugin>` prints no blocked-components line (the summary only covers the mutation's own marketplace, `src/commands/plugins.ts:27,37`). Too-quiet direction of the original F35 noise bug; spec 23 §7 says once per run.

## F101 — post-scoped-update "already up to date" + restart notice contradiction (area: CLI, severity: low)
Test: A7.10 follow-on (a7). Substantively honest (that run applied the deferred change) but reads as a contradiction. Consequence of F88.

## F102 — restart notice coupled to skill-mirror revision stamps, not actual changes (area: CLI/loader, severity: low)
Test: A7.5 edge (a7). A command/agent-only change prints NO notice (running session keeps stale content); a skill present prints the notice on EVERY revision advance (the rendered `@ <rev>` trailer counts as "created"; `loader/links.js:118-145`, gate `src/commands/update-report.ts:135`). Spec §5's letter met, its rationale not.

## F103 — repeat `ocm add` prints "cloning" before refusing (area: CLI, severity: low)
Test: B2.3 (b2). `cloning …` on stdout, then `already added` on stderr — implies work was done before the refusal.

## F104 — auto-install lists a skipped file as added (area: CLI, severity: low)
Test: B2.5 (b2). `+ skills/notes-12/SKILL.md` in the installed list while the stderr skip warning says it was not created. Same truthfulness class as F76 at install time.

## F105 — uninstall of one plugin re-emits another plugin's warning (area: CLI, severity: low)
Test: B2.5 (b2). An unrelated skill-frontmatter warning reprints on every verb that re-materializes.

## F106 — local-marketplace no-change update is silent (area: CLI, severity: low)
Test: B3.4 setup (b2). `updating demo-marketplace...` then nothing — git marketplaces print `already up to date`.

## F107 — invalid-opencode.json warning printed 3× per update (area: CLI, severity: low)
Test: B4 S1 (b3). Two phrasings for one fact, three lines.

## F108 — opencode splices `$schema` into empty `{}` with a trailing comma; ocm's skills paths freeze (area: loader/interop, severity: low)
Test: B4 S1 (b3). ocm legitimately writes `{}` when the last skills path goes; opencode 1.18.31 rewrites it as `{"$schema": …,}` (invalid). ocm's defense is correct (warn + leave untouched) but the user is stuck with a hand edit — `doctor --fix` does not fix it. Root cause opencode-side; recorded for the interop file.

## F109 — deleted-ref error tail misleads (area: CLI, severity: low)
Test: B4 S3 (b3). Tag deleted upstream → `cannot access … (ref "v1.0.0") — the repository is private, unreachable, or the URL is wrong`. The repo is fine; only the tag is gone.

## F110 — bare plugin name to `ocm update` gets the marketplace-intent error (area: CLI, severity: low)
Test: B4 S4 (b3). `marketplace "tip-kit" not found (ocm list)` — no hint at the `plugin@mp` form.

## F111 — dotfile components accepted and linked as degenerate names (area: loader, severity: low)
Test: B5 fixture build (b4). `commands/.md` → link `linter:.md`, command `/linter:`; `plugin/.js` similarly. No warning anywhere.

## F112 — deleted cache clone invisible to list/info until update (area: CLI, severity: low)
Test: B5.4 (b4). `ocm list --all` says `synced just now`; `ocm info` says `(not linked)` with no cause and no `run ocm update` suggestion while 32 ocm-owned symlinks are broken.

## F113 — unbounded search/list lines at 80 columns (area: CLI, severity: low)
Test: B5.5 (b4, d2). Search head embeds the full description (190 chars → mid-word wrap); `list --all` skills line for 30 skills is 460 chars; `ocm info` component lines 98–136 chars.

## F114 — add-without-init interleaves install messages and a duplicate restart notice (area: CLI, severity: low)
Test: B6.1 (b4). Loader-install + TUI-plugin lines land mid-report; `restart opencode to activate` prints twice.

## F115 — list and search name the same component differently (area: CLI, severity: low)
Test: B5 (b4). `commands: parse.md` (list) vs `commands: parse` (search); mcp/plugins/skills bare in both.

## F116 — `ocm untrust` removing an MCP key prints no restart notice (area: CLI, severity: low)
Test: C5.2 (c2). The just-untrusted MCP server stays live in a running session with no notice — MCP key removals never gate the restart line (`loader/materialize.js:172` counts them separately).

## F117 — install repair mislabeled "already installed" (area: CLI, severity: low)
Test: C6.1 (c3). Links deleted by hand, plugin still enabled → `ocm install x` relinks 3 components, prints `already installed`. The restart notice does print (so not the plan's silent-relink variant), but "nothing to do" and "repaired 3 links" are indistinguishable.

## F118 — downgrade neither guards nor fails loudly (area: CLI, severity: low)
Test: D2.5 (d1). 0.2.0 binary over a 0.5 home: exit 0, silently reverts the loader to the single-file 0.2 shape; 0.5's doctor then reports 23 stale-core errors. Nothing lost; `ocm init` recovers. A registry-version guard is the expected shape (cannot be retrofitted into published 0.2.0).

## F119 — missing git / unwritable cache misreported as a repository access problem (area: CLI, severity: low)
Test: D4.7/D4.8 (d2). With git off PATH, add/update print the "private, unreachable, or the URL is wrong" message. Doctor reports git correctly. Same family as F81/F82/F109.

## F120 — `ocm add file://<local-dir>` fails with a git-shaped misleading error (area: CLI, severity: low)
Test: D3 setup (d3). `cannot access file:///…/d3-mp — the repository is private…` for an existing readable directory; plain-path add works. One sentence would fix it.

## F121 — marketplace.json README example has no $schema; the pinned schema URL is undocumented (area: docs, severity: low)
Test: D6.3 follow-up (d3). plugin.json examples carry it (F48 closed); the marketplace.json example does not, and validate does not warn on its absence.

## F122 — search `matched:` annotations suppressed when the query equals the plugin name (area: CLI, severity: low)
Test: A9.7 edge (a8). rank-0 name match short-circuits component matching (`loader/search.js`); with a non-colliding name both annotations render.

## F123 — empty cache directories survive a full teardown (area: CLI, severity: low)
Test: B7 (b5). `~/.cache/ocm/links/` (sometimes `marketplaces/`) remain as empty dirs. Documented reconstructible cache namespace — observation, not a functional trace.

## F125 — `ocm info` prints "trust: none" for marketplaces that ship no code (area: CLI, severity: low)
Test: user's manual pass (home-main). `ocm info <plugin>@tui-scale` prints `trust none`, which reads as "untrusted" though it means "no executable components exist, no decision recorded". Confused a real user into re-checking a grant they had already made. "n/a — no executable components" would not read as a security state.

---

## Awaiting the user's TUI pass — results and remainder

Completed by the user (see the method notes above): **A11.1 pass** (F4
closed), **A11.3 pass** (F62 closed; double-Esc is the view stack, one
Escape per dialog layer), **A11.4 pass** (F63 closed), **A11.2 fail**
(F61 re-opened as F124), **B1.2 explained** (subagents live in `@`
autocomplete, not the primary-agent picker — the agents load correctly).

Still open for a future pass:

- **B1.6** the whole add/update/remove cycle driven from `/ocm`
  (home-cycle in `/tmp/ocm-tui` is still pristine).
- TUI rendering of: trust prompt and awaiting-trust state (a1, b2),
  collision-takeover prompt (c2 — stage it with `/tmp/ocm-tui/advance.sh`
  + `ocm update`, then install collide-b's shared-tool from /ocm),
  category/tags grouping (b4), `/ocm` Browse dialog clipping at 80 cols
  (b4, d2 — now also F124), unicode at 80 cols (d2), `/ocm` absent under
  `OPENCODE_PURE=1` (d2), `/skills` and the details view for a 30-skill
  plugin (d2), MCP prompt naming at 28-command scale (d3).
- **D6.1** timed authoring from a clean machine with hesitation points
  (README read-through notes in d3's transcript: agent `model` format is
  the weak spot — see F67; `renames` never explained; `!` backtick syntax
  never shown).

---

## Triage (2026-09-19)

Every round-3 finding dispositioned. Owner decisions were taken on the
four open questions (below); specs 27–35 carry the fixes. Decisions
marked **wontfix**/**dismissed** are recorded so they stay findable.

### Owner decisions

1. **XDG_CONFIG_HOME (F65): follow it.** ocm resolves its config root
   the way opencode does — `$XDG_CONFIG_HOME/opencode` when set,
   `~/.config/opencode` otherwise — with a doctor check that reports an
   install stranded in the other location. Refusing when the variable is
   set was rejected: it leaves the user with no working path.
2. **`${OCM_PLUGIN_ROOT}` in `!` blocks (F84): substitute at
   materialization time.** The `shell.env` hook only fires for the
   model's bash tool; opencode's command-template engine never calls it,
   so no hook can reach a `!` block. Worse, the flat `OCM_PLUGIN_ROOT`
   exists only when exactly one marketplace is added
   (`loader/registry.js:127-129`) — a variable cannot say which root it
   means, a render can. ocm therefore **renders** a command or agent
   file whose body references `${OCM_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_ROOT}`,
   substituting that plugin's marketplace root, exactly as spec 03
   already renders `SKILL.md`. Files without the variables keep their
   symlink, so local authoring stays live-edit. The env hook stays for
   bash-tool use.
3. **`ocm update <plugin>@<mp>` (F88, F42): drop the form.** A
   marketplace is one git working tree, one revision, one pin — spec 08
   already recorded per-plugin pinning as a non-goal on that basis, and
   per-plugin update is the same incoherence. (Claude Code takes the
   same position: marketplaces update as a unit; plugins are only
   enabled or disabled individually.) The implementation's attempt at it
   — pull everything, materialize one — is what strands the other
   plugins' mirrors. Removed from the CLI and from help; a bare plugin
   name to `ocm update` names its marketplace instead (closes F110).
4. **Read-only `tui.json` (F95): wontfix, documented.** Only the
   commands that write `tui.json` refuse; the others proceed and leave
   no partial state. That is the pre-flight rule working as designed —
   a mutation refuses over files it will actually touch. The README's
   config-safety section states which commands write which files.

### Severity re-grades

| Finding | Was | Now | Why |
|---|---|---|---|
| F69 | med | **high** | a plugin reported *skipped* has its command linked and served by opencode — the limit exists to prevent exactly that |
| F74 | med | **high** | a refused rename silently unlinks the user's command and agent; every surface then denies it happened |
| F90 | med | **high** | a trusting add can leave opencode refusing to start, and `validate` already knows the shape is wrong |

### Root-cause clusters

The 62 findings reduce to six causes plus three singletons. Specs are
written per cause, not per symptom.

| Cluster | Cause | Spec |
|---|---|---|
| Concurrency | no single-writer discipline; registry read-modify-write and `displaced-records.json` are unguarded | 27 |
| Platform | config root and filesystem assumptions (XDG, case-folding) | 28 |
| Manifest gate | spec 19's check tests file existence, not validity; `scan` and `add` disagree | 29 |
| Local sources | the changed-set comes from a revision pair, which local marketplaces do not have | 30 |
| Report truth | reports and registry records derive from *intent* (git diff + desired set), not from what the materializer actually did | 31 |
| Diagnosis | every git failure renders as one access-denied sentence; raw node errors leak | 32 |

Singletons: doctor's ownership model is narrower than ocm's footprint
(33), MCP shape and trust listing (34), authoring surface — the broken
reference agent, command rendering, docs (35).

### Disposition table

| Finding | Disposition | Spec | Release |
|---|---|---|---|
| F64 concurrent add+update loses a marketplace | fix — registry lock + re-read under lock | 27 §1 | v0.6.0 |
| F65 XDG_CONFIG_HOME ignored | fix — follow it; doctor reports a stranded install | 28 §1 | v0.6.0 |
| F66 case-folded plugin dirs merge silently | fix — case-insensitive duplicate detection at discovery; refuse | 28 §2 | v0.6.0 |
| F67 template agent `model: inherit` | fix — template + README agent frontmatter; validate rule | 35 §1 | **v0.5.1** |
| F68 blank command line for string-form MCP | fix — render both `command` forms (F58 narrowed) | 34 §2 | v0.6.0 |
| F69 skipped plugin still materialized | fix — skip means skip; outcome record gates the link | 31 §2 | v0.7.0 |
| F70 stale collision record after remove | fix — drop collision records naming a removed marketplace | 33 §3 | v0.8.0 |
| F71 malformed `plugin.json` routes around add/update | fix — one manifest gate: parse + validate, not existence | 29 §1 | v0.6.0 |
| F72 `description: ""` accepted | fix — same gate | 29 §1 | v0.6.0 |
| F73 local grandfather never ends | fix — content-hash changed-set for local marketplaces | 30 §1 | v0.7.0 |
| F74 refused rename unlinks everything | fix — rename refusal is inert; outcome record | 31 §3 | v0.7.0 |
| F75 "renamed" while dropped | fix — report the net outcome | 31 §3 | v0.7.0 |
| F76 skipped skills claimed installed | fix — outcome-derived records | 31 §2 | v0.7.0 |
| F77 scan green-lights what add refuses | fix — scan runs the add gate | 29 §2 | v0.6.0 |
| F78 `trust: "none"` renders as installed in list | fix — marker keys on "not granted", not "denied" | 34 §3 | v0.6.0 |
| F79 SIGINT truncates `displaced-records.json` | fix — atomic write for every ocm-owned JSON | 27 §2 | v0.6.0 |
| F80 unregistered `<plugin>:<name>` links unswept | fix — sweep every ocm link layout, incl. cache-pointing targets | 33 §1 | v0.8.0 |
| F81 lock contention → "cannot access" | fix — classify the git error | 32 §1 | v0.8.0 |
| F82 killed-add retry → "cannot access" | fix — clean the orphan clone on the next add; classify | 32 §2 | v0.8.0 |
| F83 raw EACCES/ENOTDIR from `~/.cache` | fix — ocm-style error, name the path and the action | 32 §3 | v0.8.0 |
| F84 plugin-root vars empty in `!` blocks | fix — render-time substitution (decision 2) | 35 §2 | v0.7.0 |
| F85 `--fix` promises removals it never does | fix — message states what `--fix` will actually do | 33 §2 | v0.8.0 |
| F86 corrupt registry: `ocm update` exits 0 | fix — corruption is an error with a recovery path | 32 §4 | v0.8.0 |
| F87 stale displacement records re-reported | fix — consume/prune records on restore | 27 §3 | v0.6.0 |
| F88 plugin-scoped update strands mirrors | fix — form dropped (decision 3) | 31 §5 | v0.7.0 |
| F89 case collision cross-wires a command link | fix — with F66 | 28 §2 | v0.6.0 |
| F90 old-shape mcp.json bricks opencode | fix — shape guard at add/trust, same rules as validate | 34 §1 | v0.6.0 |
| F91 duplicate pending-trust lines | fix — one line | 31 §6 | v0.7.0 |
| F92 incumbent update records collision silently | fix — report the state change | 33 §3 | v0.8.0 |
| F93 grandfather-end refusal doesn't say why | fix — name the transition and the removal | 29 §3 | v0.6.0 |
| F94 `0.1.0 → ?` version line | fix — omit unknown transitions | 31 §6 | v0.7.0 |
| F95 read-only tui.json scope | **wontfix** — documented (decision 4) | 35 §4 | v0.5.1 |
| F96 `ocm remove` omits restart notice | fix — outcome gate covers removals | 31 §4 | v0.7.0 |
| F97 unprefixed re-clone progress line | fix — prefix it | 32 §5 | v0.8.0 |
| F98 `--force` on installed says "already installed" | fix — report the displacement as the headline | 31 §4 | v0.7.0 |
| F99 dirty-cache warning names counts only | fix — name the files | 32 §5 | v0.8.0 |
| F100 blocked lines never print on unrelated mutations | fix — once per run, all marketplaces (F35 narrowed) | 31 §6 | v0.7.0 |
| F101 "already up to date" + restart notice | fix — falls out of F88's removal | 31 §5 | v0.7.0 |
| F102 notice keyed to skill revision stamps | fix — notice follows real component changes | 31 §4 | v0.7.0 |
| F103 "cloning" before "already added" | fix — check the registry first | 29 §4 | v0.6.0 |
| F104 skipped file listed as added | fix — outcome-derived (with F76) | 31 §2 | v0.7.0 |
| F105 unrelated plugin's warning re-emitted | fix — scope warnings to the mutation | 31 §6 | v0.7.0 |
| F106 local no-change update silent | fix — with F73's changed-set | 30 §2 | v0.7.0 |
| F107 invalid-config warning printed 3× | fix — deduplicate | 31 §6 | v0.7.0 |
| F108 opencode mangles `{}` with `$schema` | **upstream** — file against opencode; record in the contract doc | 00 (contract) | — |
| F109 deleted ref → "cannot access" | fix — classify (ref vs repo) | 32 §1 | v0.8.0 |
| F110 bare plugin name to update | fix — name its marketplace (decision 3) | 31 §5 | v0.7.0 |
| F111 dotfile components linked as `<plugin>:` | fix — refuse degenerate component names | 29 §5 | v0.6.0 |
| F112 deleted clone invisible until update | fix — list/info check the clone; doctor already does | 33 §4 | v0.8.0 |
| F113 unbounded lines at 80 columns | fix — wrap/truncate with a width budget | 36 §1 | v0.9.0 |
| F114 add-without-init interleaving, double notice | fix — one notice, loader lines first | 31 §6 | v0.7.0 |
| F115 list and search name components differently | fix — one renderer | 36 §2 | v0.9.0 |
| F116 untrust of an MCP key: no restart notice | fix — MCP removals count (with F102) | 31 §4 | v0.7.0 |
| F117 repair mislabeled "already installed" | fix — "repaired N links" (with F98) | 31 §4 | v0.7.0 |
| F118 downgrade neither guards nor fails | fix **forward-only** — registry-version guard; cannot reach published 0.2.0 | 27 §4 | v0.6.0 |
| F119 missing git → "cannot access" | fix — classify; check git once, early | 32 §1 | v0.8.0 |
| F120 `file://` local dir → git-shaped error | fix — classify | 32 §1 | v0.8.0 |
| F121 marketplace.json example lacks `$schema` | fix — README + validate nudge | 35 §3 | v0.5.1 |
| F122 `matched:` suppressed on exact name match | fix — annotate regardless of rank | 36 §3 | v0.9.0 |
| F123 empty cache dirs survive teardown | **dismissed** — reconstructible cache namespace, no trace | — | — |
| F124 details rows ellipsize at 80 cols | fix — wrap option rows; grow into wide terminals (F61 re-opened) | 36 §4 | v0.9.0 |
| F125 `trust: none` reads as a security state | fix — `n/a — no executable components` | 36 §5 | v0.9.0 |

### Release plan

| Release | Contents | Shape |
|---|---|---|
| **v0.5.1** | 35 §1, §3, §4 — broken template agent, `$schema` in the marketplace example, config-safety docs | docs/template only, no code |
| **v0.6.0** | 27 (write safety), 28 (platform), 29 (manifest gate), 34 (MCP shape & trust listing) | correctness and data safety |
| **v0.7.0** | 31 (outcome-derived reports — the large one), 30 (local changed-set), 35 §2 (render-time plugin root) | the round-2/3 truthfulness theme, fixed at the root |
| **v0.8.0** | 32 (error classification), 33 (doctor completeness) | diagnosis |
| **v0.9.0** | 36 (display & TUI) | polish |

Spec 31 is deliberately one spec covering ~20 findings: they share a
single cause — reports and registry records computed from intent rather
than from the materializer's outcome — and patching them individually
would leave the cause in place.

### Carried into the next round's plan

- Method corrections from this round: `opencode debug config` does not
  run the loader's startup sync (force one with a headless TUI session);
  the registry is at `$H/.config/opencode/ocm/registry.json`.
- Round-3 tests not conducted: **B1.6** (the full cycle driven from
  `/ocm`), **D6.1** (timed authoring), and the TUI-rendering remainder
  listed above.
- Fixtures worth keeping: `github.com/wntic/ocm-e2e-alpha` (public) and
  `ocm-e2e-private` — the real-GitHub pass is the only place the access
  error message is honest, and it must stay in the plan alongside the
  `file://` fixtures.
