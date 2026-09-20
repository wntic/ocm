# E2E findings — round 4 (2026-09-20)

> **Brief paths in this document** (`docs/specs/NN-…`, `.work/briefs/NN-…`)
> refer to briefs that are no longer tracked: they live untracked in
> `.work/briefs/`, and in git history up to the commit that removed them.

Round 4 against **published ocm v0.6.0** (npm `@wntic/ocm@0.6.0`) and
published **0.5.1** for the upgrade scenarios, per
[the round-4 plan](../.work/briefs/T3-round4-plan.md). Both versions were
installed side by side in isolated npm prefixes (`/tmp/ocm-e2e4/v060`,
`v051`) — switching version = switching which prefix's binary runs,
equivalent to `npm i -g` for everything ocm does, while leaving the
user's global ocm (a repo symlink) untouched. `ocm --version` was
confirmed before every scenario.

Environment: opencode 1.18.31 (real binary), git 2.50.1 (Apple Git), bun
1.4.2, macOS (APFS, case-insensitive; a case-sensitive APFS volume was
mounted for the fold fixtures). MP-A =
`https://github.com/wntic/ocm-e2e-alpha` (public, registers as
`gh-alpha` — its manifest name, not the URL's). Raw per-agent reports
with verbatim output are in `docs/e2e-round4/a1-a2.md`, `a3-a5.md`,
`b1.md`, `b2-b4.md`, `b3-b5.md`; this file is the consolidated view.

Part C (TUI visual rendering, timed authoring from the README) was not
run — see "Delegated to human".

---

## Summary

- **Part A (the 17 findings v0.6.0 closed): 15 closed, 2 closed with new
  defects in the fix, 0 still open.** Every round-3 fix in briefs 27, 28,
  29, 34 behaves as specified on its own ground; the defects below are in
  adjacent paths the fixes introduced or never covered.
- **Part B (the changed surface, in anger):** upgrade-in-place and the
  shared cache across config roots produced most of this round's
  findings, including both highs.
- **New findings: 13** (2 high, 6 med, 5 low), numbered F126–F129, F146,
  F166–F168, F186–F191, F206. Duplicates filed independently by two
  agents are merged below and marked.

### Verdicts — Part A regression gate

| Step | Finding | Verdict |
|---|---|---|
| A1-1 | F64 concurrent add/update + opencode-start race | closed |
| A1-2 | F79 killed install / displaced-records.json | closed |
| A1-3 | F86 corrupt registry | closed except `init` (F126) and `loader uninstall` (F127) |
| A1-4 | F87 stale displacement records | closed |
| A1-5 | F118 downgrade guard | closed as designed (forward-only); published-0.5.1 repro unchanged, as the brief predicted |
| A2-6 | F65 XDG_CONFIG_HOME | closed |
| A2-7 | F66/F89 case-folded plugin dirs | closed at add and git update; **new defect at local update** (F128) |
| A2-8 | component-level folds | closed |
| A3-9 | F71/F72 unreadable/empty plugin.json, add vs validate | closed (caveat: F146) |
| A3-10 | F77 scan exit code predicts add | closed |
| A3-11 | F93 grandfathered manifest-less plugin dropped on change | closed |
| A3-12 | F103 no `cloning` before already-added refusal | closed |
| A3-13 | F111 `commands/.md` refused, named | closed |
| A4-14 | F90 old-shape mcp blocked, sibling installs, opencode starts | closed |
| A4-15 | F68 string-form command line shown on trust surfaces | closed |
| A4-16 | F78 blocked components in `list` | closed |
| A5-17 | lock release ownership (foreign overwrite) | closed |
| A5-18 | TUI mutations take the lock | **verified via B3 step 13** (ceiling toast names holder, no hang, no write underneath) — the `/ocm` dialog was driven under a sized pty |
| A5-19 | stranded 0.5.1-era install (no roots.json) under XDG | closed |
| A5-20 | `$schema` never shown as a server | closed |
| A5-21 | `doctor --fix` removes only the exact bad key | closed |

### Verdicts — Part B

| Step | Scenario | Verdict |
|---|---|---|
| B1-1..3 | upgrade in place, same root | lossless, no trust re-prompts; but **doctor exits 1 with 34 stale-loader errors and the first command says nothing** (F166) |
| B1-4 | XDG set before 0.5.1 install | 0.5.1 lands in default root (known F65 shape); 0.6.0 stranded report verbatim per brief 28, remedies verified |
| B1-5 | XDG set only after upgrade | stranded report correct; "re-add here" remedy walks into **F168** |
| B2-7 | XDG set/unset/re-set | pass |
| B2-8 | relative XDG | warning fires (F186: only in doctor, not at add) |
| B2-9 | empty XDG | falls back to `$HOME/.config`, matches opencode |
| B2-10 | two roots, one cache | no split-brain, no migration; doctor --fix cross-root harm (F188 = F168) |
| B2-11 | same git marketplace under two roots | **fail** — F187 (high), F189 |
| B3-12 | update vs opencode start ×20 | pass (registry intact, doctor 0, no deadlock) |
| B3-13 | TUI mutation during startup sync | pass — clear refusal at the 10 s ceiling, no hang, no silent skip |
| B3-14 | SIGINT during held lock | pass — holder dies 130, corpse broken instantly, one warning |
| B3-15 | kill -9 + waiter; stub lock | pass — waiter recovers 0.2 s later; live-pid stub refused at 10.04 s; empty lock broken at 10.03 s |
| B3-16 | two updates at once | pass — one waits, both exit 0; **F81's shape has changed** (no network-flavoured error any more; status note, not a re-file) |
| B4-17 | 0.5.1-era workflow under 0.6.0 (26 steps) | pass — exit codes identical to 0.5.1 on every step |
| B4-18 | gate-failing marketplace installed under 0.5.1 | **fail for local sources** (F190); git-backed equivalent passes exactly per brief 29 §3 |
| B4-19 | `validate` on `template/` | pass, zero findings |
| B5-20..22 | MCP end to end (old shape trusted, fixed upstream, untrust) | pass |

---

## New findings

### High

## F187 — adding the same git marketplace under a second config root crashes with a raw `ENOTEMPTY`, leaks a stray clone, and retries with a misleading error   (area: CLI, severity: high)

Test:        B2 / step 11
ocm version: 0.6.0      opencode: 1.18.31
XDG:         root B active (root A holds `gh-alpha` from the same URL; one shared cache)
Command:     `HOME=$H XDG_CONFIG_HOME=$X ocm add https://github.com/wntic/ocm-e2e-alpha`
Expected:    brief 28 keeps `~/.cache/ocm` shared across roots; a duplicate
             against another root's registry should be a clean refusal naming
             the other root (the registry-duplicate message shape), never a
             stack dump
Actual:      uncaught `ENOTEMPTY: directory not empty, rename
             '…/.cache/ocm/marketplaces/wntic-ocm-e2e-alpha' ->
             '…/.cache/ocm/marketplaces/gh-alpha'`. The clone lands under its
             repo-derived name and is renamed to the declared marketplace name
             (`loader/source.js:141`); the duplicate check only reads the
             current root's registry, so a clone already in the shared cache
             from another root is invisible until the rename hits the existing
             target. The failed add leaves a stray clone behind; retrying the
             same command fails with `cannot access … — the repository is
             private, unreachable, or the URL is wrong` (cloning into the
             leftover dir fails, cleanup removes it, so a third attempt loops
             back to ENOTEMPTY). `--name gh-alpha-b` works around it; `ocm
             remove gh-alpha` in root A does not touch root B.
Impact:      a user acting on the stranded report's "re-add those marketplaces
             here" remedy with a git marketplace hits a crash whose retry
             message blames the network. The stray clone lingers in the cache.
Regression?: new defect — dual-root states cannot arise before 0.6.0 (0.5.x
             ignores XDG entirely).
Decision needed: clean cross-root duplicate refusal vs suffixed second clone
             vs shared-clone accounting (see b2-b4.md).

## F206 — `/ocm` TUI dialog freezes opencode entirely (100 % CPU, only kill −9 ends it) when the terminal reports 0 columns/rows — infinite loop in `wrapText` via `dialogSize`   (area: loader/TUI, severity: high)

Test:        B3 / step 13 setup
ocm version: 0.6.0      opencode: 1.18.31
XDG:         unset
Command:     `spawn opencode` under expect with an **unsized pty**
             (`process.stdout.columns`/`rows` are 0), then `/ocm\r`
Expected:    the dialog renders or degrades; the session stays responsive
Actual:      opencode freezes at 100 % CPU before any dialog pixels appear;
             ctrl-c does nothing; only `kill -9` ends it. Root-caused by
             bisection: `loader/ui-dialog.js` `fit()` → `dialogSize` computes
             `frame = min(bucket, width - 2)` = −2 at columns 0, then
             `wrapText(line, -11)` runs `while (rest.length > width)` with a
             negative width — `rest` never shrinks. Same drive works perfectly
             once the pty is sized (`stty rows 30 cols 100` before
             `exec opencode`).
Impact:      any embedder that allocates a pty without a size (CI harnesses,
             expect scripts, some multiplexers during resize) hard-freezes the
             whole opencode process. Real terminals at normal sizes are
             unaffected — every other TUI scenario in this round passed.
Regression?: new defect; round 3 never drove `/ocm` through a 0×0 pty.
Fix sketch:  clamp `frame` to a minimum, and make `wrapText` treat
             `width <= 0` as "return the line unwrapped".

### Medium

## F128 — local fold appearing at update leaves the skipped plugin's link cross-wired to the sibling's file; registry drops the plugin while the report says "0 removed"; doctor green   (area: CLI, severity: med)

Test:        A2 / step 7c
ocm version: 0.6.0      opencode: 1.18.31
XDG:         unset
Command:     local marketplace (case-sensitive volume) with `plain-kit` +
             `case-Kit`, add, then `plugins/case-kit` appears upstream, then
             `ocm update`
Expected:    brief 28 §3.3: the folded pair's plugins are skipped with the
             warning, the rest of the update proceeds, and the F89 harm (a
             command link serving the other plugin's content) does not survive
Actual:      exit 0; skip warning fires, but afterwards:
             `~/.config/opencode/commands/case-kit:run.md` still exists and
             points at `…/plugins/case-Kit/commands/run.md` (the exact F89
             cross-wire, now serving a plugin the registry no longer holds);
             the report says `0 created, 0 removed, 1 skipped` while a
             registered plugin and its link did go; `ocm doctor` exit 0, all
             green. The git-source update path is correct (whole marketplace
             stops at the previous revision).
Impact:      after an upstream rename-collision on a local marketplace,
             opencode keeps executing a command from an unregistered plugin,
             wired to the other plugin's file, with no verb but hand-editing
             to remove it, and doctor certifies the home clean.
Regression?: new defect in brief 28's skip rule (the round-3 F89 was
             refused-at-add cross-wiring; the local-update path is new).

## F166 — upgrade in place (0.5.1 → 0.6.0) leaves the loader stale; the first command says nothing; doctor exits 1   (area: CLI, severity: med)

Test:        B1 / steps 2–3 (same root)
ocm version: 0.5.1 → 0.6.0      opencode: 1.18.31
XDG:         unset
Command:     0.5.1 add ×3 + trust; switch to 0.6.0; `ocm list --all`, `ocm doctor`
Expected:    round-4 plan B1 step 3: "First command → migration output, no
             losses. `ocm doctor` clean."
Actual:      `ocm list --all` exit 0, correct data, **zero output about the
             loader**. `ocm doctor` exit 1, `34 errors, 0 warnings` — installed
             loader modules still stamped `// ocm-version: 0.5.1`, the four
             0.6.0-only modules (`lock.js`, `manifest-gate.js`, `mcp-line.js`,
             `atomic.js`) absent. `ocm update` (or `ocm init`) refreshes
             everything to 0.6.0 and doctor goes clean; nothing is lost and
             trust never re-prompts. The old loader still syncs (functionally
             never stranded in the same-root case) — it is merely old.
Impact:      a user who upgrades the CLI keeps executing 0.5.1 loader code
             (hardcoded config root, none of 0.6.0's loader fixes) at every
             opencode start until they happen to run a mutating command or
             doctor. The plan's "doctor clean" promise fails.
Regression?: new defect — round 3 tested only the downgrade direction (F118).

## F167 — read-only commands deny a stranded install exists, with no hint   (area: CLI, severity: med)

Test:        B1 / steps 3–5 (first 0.6.0 command with XDG set; install in the default root)
ocm version: 0.6.0      opencode: 1.18.31
XDG:         set; default root holds 3 marketplaces, trusted
Command:     `HOME=$H XDG_CONFIG_HOME=$X ocm list --all`; `ocm search hello`;
             `ocm info exec-kit`
Expected:    brief 28 §2.2 killed "the most misleading sentence ocm can
             produce in this state" for doctor; the plan expects the user to
             be told what happened
Actual:      `list` → stdout `no marketplaces added yet (ocm add <url|path>)`,
             exit 0, empty stderr. `search` → `no matches`, exit 1. `info` →
             `plugin not found in any marketplace`, exit 1. Only `doctor` and
             mutating commands mention the stranded install.
Impact:      the first command a user runs after upgrading tells them their
             marketplaces do not exist and suggests `ocm add` — the exact
             false state F65's fix set out to kill, one command away from the
             good doctor message. A user who trusts `list` re-adds and creates
             a second install.
Regression?: new defect (residue of the F65 fix); the read-only surface was
             not covered.

## F168 — `ocm doctor --fix` under one config root deletes the other root's skill mirrors in the shared cache, and prints a fix that did not happen   (area: CLI, severity: med)

*(Filed independently from B1 step 5 as F168 and from B2 step 10 as F188 —
same root cause; merged here. F188 is a duplicate.)*

Test:        B1 / step 5, B2 / step 10
ocm version: 0.6.0      opencode: 1.18.31
XDG:         set; default root holds the original install, XDG root a re-added marketplace (the stranded message's own remedy)
Command:     `ocm add …/exec-mp` under XDG (re-add here), then `ocm doctor --fix`
Expected:    brief 28 §1 anchors the cache to `$HOME` precisely because it is
             shared; a fix against one root must not destroy state belonging
             to a registry it cannot see. Doctor's claims must be true facts.
Actual:      doctor reports the other root's mirrors as
             `no marketplace owns this link (orphaned by a loader uninstall?) —
             ocm doctor --fix removes it`; `--fix` deletes both
             `…/links/<mp>/skills/` directories while the old root's
             `opencode.json` still lists both `skills.paths` — that root's
             opencode silently loses its skills. The printed
             `fixed …: removed from skills.paths` lines are false claims: no
             `opencode.json` exists in the active root (`setSkillsPath` no-ops
             on a missing file, `loader/config.js:27`; the "fixed" line is
             unconditional, `src/commands/doctor-orphans.ts:90`). `ocm update`
             in the old root recovers (`2 created`).
Impact:      following the stranded message's remedy, then doctor's own `--fix`
             suggestion, silently degrades the install the user was told to
             keep as an alternative. Cross-root, unexplained, recoverable.
Regression?: new defect — dual-root states cannot arise before 0.6.0.

## F189 — `ocm remove` in one root deletes shared-cache links and silently breaks the same marketplace in another root   (area: CLI, severity: med)

Test:        B2 / step 11b
ocm version: 0.6.0      opencode: 1.18.31
XDG:         two roots, each with the same local marketplace (`demo-marketplace`)
Command:     `ocm remove demo-marketplace` in root A
Expected:    removal scoped to the root being operated on
Actual:      the shared `cache/links/demo-marketplace/skills/` directory is
             deleted; root B is left with `orphaned ocm skills path — target
             is gone` and `2 materialized component(s) missing`. `ocm update`
             in root B re-creates the links. Same root cause as F168: cache
             links are namespaced per marketplace name across roots while
             ownership is per-root.
Impact:      removing a marketplace in one environment breaks another
             environment's install with no mention of it.
Regression?: new defect (dual-root is a 0.6.0 state).

## F190 — the manifest gate's "grandfather until changed" never fires for local marketplaces — it is grandfather forever   (area: CLI, severity: med)

Test:        B4 / step 18
ocm version: 0.5.1 (install) → 0.6.0      opencode: 1.18.31
XDG:         unset
Command:     local marketplace with `description: ""` installed under 0.5.1;
             upstream change under 0.6.0; `ocm update`
Expected:    brief 29 §3: a gate-failing plugin keeps working until it changes
             upstream, then is reported and dropped
Actual:      no change ever counts: change detection is git-revision-based
             (`pluginFileChanges` returns an empty map without before/after
             revisions, `src/commands/update-report.ts:47`; `pullMarketplace`
             never sets them for local entries, `src/commands/update.ts:85-87`;
             the loader sync path likewise). Strongest form: editing
             `plugin.json` itself refreshed the record (`release-kit 0.1.0 → `)
             yet kept the gate-failing plugin installed with links intact,
             exit 0. The git-backed equivalent passes exactly per brief 29 §3
             (uninstalled with the named remedy, sibling unaffected).
Impact:      on local marketplaces a plugin that fails today's gate stays
             installed indefinitely, even as its manifest visibly changes.
Regression?: scope question: brief 29's "changed upstream" arguably promised
             git semantics only — needs a decision whether local gate
             re-check is wanted (change signal from a manifest fingerprint,
             not git revisions).

### Low

## F126 — `ocm init` does not refuse on a corrupt registry   (area: CLI, severity: low)

Test:        A1 / step 3
Actual:      `echo '{' > registry.json`; `ocm init` exits 0 (`auto-sync loader
             already current`), and with the loader file removed it
             **reinstalls the loader** — a write — still without refusing. The
             registry itself is never touched (byte-identical).
Expected:    brief 27 §1.6 lists `init` in the mutating set that must refuse
             with the named error, exit 1.
Impact:      no data loss; a user poking at a corrupt home gets a green
             command instead of the diagnosis every other mutating command
             gives. Gap in coverage, not a regression.

## F127 — `ocm loader uninstall` deletes a corrupt registry instead of refusing   (area: CLI, severity: low)

Test:        A1 / step 3
Actual:      exit 0, `removed auto-sync loader`, afterwards `registry.json` no
             longer exists — `uninstallLoader` does
             `rmSync(OCM_DIR, { recursive: true })` without loading the
             registry (`src/loader.ts:190-196`), so the corruption guard
             cannot fire.
Expected:    brief 27 §1.6 includes `loader uninstall` in the must-refuse set
             with the file byte-identical afterwards.
Impact:      limited — deleting `ocm/` is this command's documented behaviour
             for valid registries too (round-2 F30) — but the brief/plan
             explicitly promise a refusal, and the output does not say the
             marketplace records went with it.

## F146 — component-less plugin directories are invisible to `add` and `validate`   (area: discovery, severity: low)

*(Filed independently from A3 step 9 as F146 and from B4 step 19 as F191 —
same root cause; merged here. F191 is a duplicate.)*

Test:        A3 / step 9 caveat; B4 / step 19 control
Actual:      a plugin directory whose only content is a broken `plugin.json`
             (invalid JSON, or `description: ""`) is never read — discovery
             reaches a plugin only through a component file
             (`loader/discovery.js`). `ocm validate` on such a tree exits 0
             clean; inside a mixed marketplace the broken manifests are
             silently ignored while the other plugins install; `ocm add` on
             the isolated tree refuses with "no plugins found" — so `validate`
             and `add` disagree.
Expected:    F71/F72's fix should report an unreadable `plugin.json` wherever
             the directory exists.
Impact:      an author who ships only a broken manifest gets no signal from
             `validate` (a false clean); users are unaffected (nothing
             installs either way). Missing diagnostic, not a wrong write.
Regression?: same behaviour in 0.5.x; visible now only because F71/F72 made
             the with-component case report.

## F186 — the relative-`XDG_CONFIG_HOME` hazard is warned about only by `doctor`, not at the `add` write boundary   (area: CLI, severity: low)

Test:        B2 / step 8
Actual:      `ocm add` under a relative XDG writes the registry (cwd-relative
             join, matching opencode) with no warning on either stream; the
             warning ("every ocm command run from a different directory sees
             a different install") fires only in `doctor`, and only if the
             user later runs it from a different cwd.
Impact:      the write boundary is where brief 28's mutation-notice pattern
             says the hazard belongs; a user who adds and never doctors never
             learns their install is cwd-dependent.

---

## Status notes on known-open findings (not re-filed)

- **F81** (error classification): the registry lock has changed its shape —
  the losing side of a concurrent update no longer surfaces a
  network-flavoured `cannot access` error; it waits and succeeds. Whether the
  underlying pull-race is fully gone would need a lock-free reproduction.
- **F65**: the 0.5.1 phase of the upgrade scenarios reproduced the known
  "0.5.1 ignores XDG" behaviour exactly as round 3 described; not re-filed.
- **F118**: the published-0.5.1-reverts-the-loader repro still exists and is
  unfixable (forward-only guard), exactly as brief 27 §4 predicted; the
  0.6.0-sees-newer-stamp direction was verified and holds every promise
  (refusal names both versions, read-only commands never refuse, loader sync
  skips writes silently).

## Runner incident (disclosed, no user impact)

During A3 setup, one `ocm init` was run without the `HOME=$H` override
against the real `~/.config/opencode`: it rewrote the loader modules under
`~/.config/opencode/ocm/` and `plugins/ocm-loader.js` with published-0.6.0
content — byte-identical to a legitimate `ocm init`'s output except the
version banner. `registry.json`, `opencode.json`, `tui.json`, `commands/`,
`agents/` were untouched; no restoration was needed. Recorded because the
round-4 protocol requires reporting every touch of the real home.

## Delegated to human (Part C, plus leftovers)

1. **C23 — the whole add → update → remove cycle driven from `/ocm`** in a
   real terminal. (Partially covered: `/ocm → Browse → demo-kit → Install`
   was driven under a sized pty in B3 step 13, happy path and lock refusal
   both verified; the full cycle with update and remove was not.)
2. **C24 — TUI rendering**: the trust prompt and awaiting-trust state, the
   collision-takeover prompt, category/tags grouping, Browse at 80 columns,
   unicode at 80 columns, `/skills` and the details view for a 30-skill
   plugin, `/ocm` absent under `OPENCODE_PURE=1`. Given F206, sizes near the
   wrap width are where further layout bugs would live; also worth one look
   at a small-but-nonzero size (e.g. 40×20).
3. **C25 — timed authoring from the README alone** (round 3's D6.1), now
   worth more: brief 29 changed what `add` refuses and brief 34 changed what
   `mcp.json` must look like. Note every hesitation.
4. Optional, low value: answering the trust prompt interactively (`y`) in a
   real terminal during `ocm add` / `ocm update` (both were auto-defaulted or
   `--yes`'d in this round).

Preserved setup for the `/ocm` lock scenario (A5-18) is no longer needed —
B3 step 13 verified it — but the home at `/tmp/ocm-e2e4/home-a35-15` and the
instructions in `docs/e2e-round4/a3-a5.md` remain if a human wants to see
the toast with their own eyes.

## Invariants

Held in every home of every scenario: no writes under `.claude`, `~/.claude`,
`.agents`, `~/.agents`; no broken ocm symlinks; `plugins/` dirs contain only
ocm-owned files; `opencode.json`/`tui.json` valid JSON wherever present;
success lines on stdout, warnings/errors on stderr; exit codes 0/1/130/137 as
specified; no `registry.lock` left behind by any completed scenario (the only
corpses were the deliberately signalled holders, each broken by the next
mutation with exactly one warning).

---

## Triage (2026-09-20)

Verified before dispositioning: F206's loop reproduces exactly as
described (`"word".slice(0, -11)` is `""` and `"word".slice(-11)` is
`"word"`, so `rest` never shrinks — a CPU spin with no output and no
allocation), and the real `~/.config/opencode` touched by the runner
incident is intact (both marketplaces present, loader stamped 0.6.0).

### The cluster that matters

**F187, F168/F188 and F189 are one defect wearing three faces.**
`~/.cache/ocm` holds clones, skill link trees and displaced records keyed
by **marketplace name and shared across every config root**, while the
registry and ownership are **per root**. Brief 28 anchored the cache to
`$HOME` on purpose — that is what makes the stranded-install check work
in both directions — but never decided what two roots referencing one
marketplace name should mean. Everything follows from that gap:

- adding the same marketplace under a second root renames a clone over
  the first root's (`ENOTEMPTY`, F187);
- `doctor --fix` in one root sees the other's link trees as unowned and
  deletes them (F168);
- `ocm remove` in one root removes the shared link tree out from under
  the other (F189).

Fixing them separately would leave the cause and invite a fourth face.
**Brief 38 owns the decision**, and the decision is the deliverable: it
must pick between namespacing the cache per config root, reference-
counting shared entries across roots, or refusing dual-root use — and
argue the choice, not just implement one.

My recommendation for that brief: **namespace the cache per root**
(`~/.cache/ocm/roots/<hash of root>/…`), keeping `roots.json` global so
the stranded check is unaffected. It makes all three findings
unrepresentable rather than handled, at the cost of one clone per root —
disk, which is cheap, in exchange for isolation, which is not.

### Disposition table

| Finding | Disposition | Brief | Release |
|---|---|---|---|
| F206 TUI freeze at 0 columns | fix — clamp the frame, and `wrapText` returns the line unwrapped when `width <= 0` | 38 §0 (hotfix) | **v0.6.1** |
| F166 upgrade leaves a 0.5.1 loader; doctor exits 1 | fix — a stale stamp refreshes the loader on any command (`installLoader` is idempotent), or the first command says so plainly | 38 §0 (hotfix) | **v0.6.1** |
| F187 cross-root add crashes with ENOTEMPTY | fix — with the cluster decision | 38 §1 | v0.7.0 |
| F168/F188 `doctor --fix` deletes another root's mirrors | fix — with the cluster decision; **plus** the unconditional "fixed" line, which is a false claim wherever `setSkillsPath` no-ops | 38 §1, §2 | v0.7.0 |
| F189 `remove` in one root breaks another | fix — with the cluster decision | 38 §1 | v0.7.0 |
| F167 read-only commands deny a stranded install | fix — the stranded notice fires on read-only commands too when the active root holds no registry | 38 §3 | v0.7.0 |
| F186 relative-XDG warned only by doctor | fix — warn at the write boundary, per brief 28's own mutation-notice pattern | 38 §3 | v0.7.0 |
| F128 local fold at update: cross-wired link, dropped record, "0 removed", doctor green | fix — the skip must unlink what it drops. The report half ("0 removed" while a link went) is [31](./31-outcome-derived-reports.md)'s cause, not a second fix | 39 | v0.7.0 |
| F190 local grandfather never ends | fix — **folds into brief 30**, same cause as F73: no changed-set for local sources. Confirms 30's premise with a second symptom | 30 | v0.7.0 |
| F146/F191 component-less plugin dirs invisible to add and validate | fix — discovery reaches a plugin only through a component file; `validate` must report a directory with a manifest and nothing else | 29-followup (fold into 39) | v0.7.0 |
| F126 `ocm init` does not refuse on a corrupt registry | fix — brief 27 §1.6 lists it in the mutating set | 39 | v0.7.0 |
| F127 `loader uninstall` deletes a corrupt registry | fix — refuse, or say plainly that the records went with it | 39 | v0.7.0 |
| F81 status note | **not re-filed** — the lock changed its shape; the losing side now waits and succeeds | 32 | v0.8.0 |

### Release plan

| Release | Contents | Why |
|---|---|---|
| **v0.6.1** | F206, F166 | Both hit users of the published release now: one hard-freezes opencode in any unsized pty, the other leaves every upgrader running 0.5.1 loader code with a red doctor and no explanation. Neither needs the cluster decision. |
| **v0.7.0** | briefs 30, 31, 35 §2 (already queued) + **38** (cross-root cache) + **39** (small correctness: fold skip, corrupt-registry verbs, component-less dirs) | 38 is the round's real work; 39 sweeps the low findings that need no decision. |

### What round 4 says about the process

Part A closed 15 of 17 outright, with the two exceptions being adjacent
paths the fixes never covered rather than the fixes failing. The five
review-only fixes — found after the build, verified by nobody but the
reviewer — all held. That is the first independent evidence that the
review step catches things the pipeline does not, rather than merely
restating it.

The new findings cluster where the plan predicted: upgrade-in-place and
the shared cache, the two areas named as "never run by anyone". The
plan's Part D (known-open, do not re-file) worked — three status notes,
zero re-files.
