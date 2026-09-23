# E2E findings — round 5 (2026-09-22)

> **Brief paths in this document** (`docs/specs/NN-…`, `.work/briefs/NN-…`)
> refer to briefs that are no longer tracked: they live untracked in
> `.work/briefs/`, and in git history up to the commit that removed them.

Round 5 against **published ocm v0.7.0** (npm `@wntic/ocm@0.7.0`, published
2026-09-22) and published **0.6.1** for the upgrade scenarios, per
[the round-5 plan](../.work/briefs/T4-round5-plan.md). Both versions were
installed side by side in isolated npm prefixes (`/tmp/ocm-e2e5/v070`,
`v061`) — switching version = switching which prefix's binary runs,
equivalent to `npm i -g` for everything ocm does, while leaving the user's
global ocm untouched. `ocm --version` was confirmed before every scenario.

Environment: opencode 1.18.32 (real binary), git 2.50.1 (Apple Git), macOS
(APFS, case-insensitive; a case-sensitive APFS volume was mounted at
`/Volumes/CSX5` for the fold fixtures). Fixtures: round 4's set (exec-mp,
local-mp, old-mp, schema-mp, bad-mp, nomanifest-mp, fold-mp.git, and
`https://github.com/wntic/ocm-e2e-alpha` as `gh-alpha`) plus this round's
new ones — root-mp (`${OCM_PLUGIN_ROOT}` render), rename-mp/rival-mp
(rename collision), local-gate-mp (gate-failing local plugin), many-mp
(25-skill plugin). Raw per-agent reports with verbatim output are in
`docs/e2e-round5/a1.md`, `a2.md`, `a3.md`, `b1.md`, `b2.md`; this file is
the consolidated view.

Part C (the full `/ocm` cycle, TUI rendering, timed authoring) was not run
— see "Delegated to human".

F207 is reserved for the human's round-4 manual runbook
(`.work/round4-manual-runbook.md`); this round's findings start at F208.

---

## Summary

- **46 plan steps run: 44 pass or closed, 2 fail** — both failures in
  Part B1, the cache migration's interrupt matrix and the dual-root
  migration (steps 4 and 6). These produced both highs.
- **Part A (the 29 regression steps over briefs 30, 31, 38, 39, 40, 41):
  all 29 closed or pass.** Every round-4 fix that v0.7.0 shipped behaves
  as specified on its own ground, including all six review-only fixes.
  The new defects are in adjacent paths the fixes never covered —
  reporting residue (F208, F209, F211, F221), a missing diagnostic on the
  loader's startup path (F222), and the `--version` bypass of the
  newer-home guard (F232).
- **Part B (the changed surface, in anger):** the rendered-command
  lifecycle, renames across restarts, and local-marketplace digests all
  pass end to end, including real `opencode run` executions. The upgrade
  path is where it breaks: a command killed inside the migration's
  rewrite window is never finished (F244, high), and in a dual-root home
  whichever root runs 0.7.0 first swallows the whole shared cache (F247,
  high).
- **New findings: 24** (2 high, 6 med, 16 low), numbered F208–F211,
  F220–F223, F232–F233, F244–F249, F256–F263. One duplicate pair —
  F210/F248, the doctor dual-root stranded error — was filed
  independently by two agents and is merged below.

### Verdicts — Part A regression gate

| Step | Finding | Verdict |
|---|---|---|
| A1-1 | every verb's report matches disk (brief 31) | pass — wording defects F208, F211 |
| A1-2 | F76/F104 skill without frontmatter `name` | closed (residue: F211) |
| A1-3 | F69 plugin name > 64 chars | closed |
| A1-4 | F96/F116/F102 restart notice | closed (residue: F209) |
| A1-5 | F117 install twice / repair hand-deleted links | closed |
| A1-6 | F110 `update <plugin>@<mp>` refused; bare name resolves | closed |
| A2-7 | F187 two roots, same marketplace | closed (residue: F210) |
| A2-8 | F168 `doctor --fix` cross-root + true `fixed` lines | closed (residue: F210) |
| A2-9 | F189 `remove` under root A vs root B | closed |
| A2-10 | F167/F186 stranded reporting by list/search/info; relative XDG warns at add | closed |
| A3-11 | refused rename survives an opencode restart | closed |
| A3-12 | doctor --fix / trust keep the refusal | closed |
| A3-13 | ordinary rename migrates; explicit mode keeps it enabled | closed |
| A4-14 | F190/F73 local manifest-less plugin changed → refused, reported | closed |
| A4-15 | F106 local no-change update prints `already up to date` | closed |
| A4-16 | first 0.7.0 pass: no digests → unknown, not changed | closed (CLI **and** loader paths) |
| A5-17 | F128 fold at local update | closed for F128's harm — new defect F221 on the report line |
| A5-18 | F126/F127 init / loader uninstall refuse corrupt registry | closed |
| A5-19 | F146 validate reports broken-only plugin.json; add matches | closed for the isolated tree — residual F223 on mixed trees |
| A6-20 | F84 plugin-root substitution on disk | closed |
| A6-21 | substituted command runs in a real session | closed |
| A6-22 | two marketplaces, per-root substitution | pass (adapted — the plan's literal same-plugin-name setup is refused at add, correctly per spec 18) |
| A6-23 | author drops the variable upstream → clean render-to-link transition | pass |
| A7-24 | lock release ownership | pass (aftermath defect F233) |
| A7-25 | TUI mutation takes the lock | closed |
| A7-26 | stranded install without breadcrumb | closed |
| A7-27 | `$schema` is not a server | closed |
| A7-28 | `doctor --fix` key precision | closed |
| A7-29 | a defect is visible | closed (with placement notes — see a3.md step 29) |

### Verdicts — Part B

| Step | Scenario | Verdict |
|---|---|---|
| B1-1 | build 0.6.1 three-marketplace home, old layout, displaced record | pass |
| B1-2 | first 0.7.0 command migrates the cache | pass (but F246: `--version` itself migrates) |
| B1-3 | post-migration verification (bytes, TUI, debug, forced sync) | pass — 39/40 files byte-identical, the 40th legitimately rewritten; no trust re-prompts |
| B1-4 | interrupt matrix during migration + recovery | **fail** — F244 (high), F245 (med), F246 (low) |
| B1-5 | local/exec-only variants (no git clone) | pass (but see F249) |
| B1-6 | dual-root home sharing the old cache | **fail** — F247 (high), F248 (med), F249 (low) |
| B2-7 | upstream edit refreshes the rendered command | pass (F257) |
| B2-8 | user edit of a rendered file reverted on update | pass as designed (F258: the revert is silent) |
| B2-9 | uninstall / remove take rendered files with them | pass |
| B2-10 | hand-written file at the rendered path: refused, `--force` displaces, remove restores | pass (F259, F260, F261) |
| B2-11 | rendered command served and executed by real opencode | pass — the `!` script ran; marker reaches the model (F262) |
| B3-12 | refused rename survives a real-session restart | pass |
| B3-13 | collision cleared → rename completes | pass |
| B3-14 | rename chain converges across two syncs | pass |
| B4-15 | timings: 26 components — loader sync 25–55 ms warm, throttled on ordinary restarts | pass |
| B4-16 | one component edited → only that plugin reports | pass (F263) |
| B4-17 | no-change update writes only `lastSync.at` | pass |

---

## New findings

### High

## F244 — a 0.7.0 command killed inside the migration's rewrite window is never finished by any later command; the displaced original is permanently stranded and doctor mislabels ocm's own broken links   (area: CLI, severity: high)

*(b1, Part B1 / step 4.)*

```
Test:        Part B1 / step 4
ocm version: 0.7.0      opencode: 1.18.32
XDG:         unset
Command:     zsh /tmp/ocm-e2e5/work-b1/interrupt.sh 6 13 list --all
             (kill -9 after 13 ms; deterministic repro: build061.sh + 4 renames
              + registry-dir rewrite only — home b1-sim3, recovery chain below)
Expected:    migration runs "before dispatch" on every command (0.7.0 release
             notes / migrate-cache.ts), so a later command should detect and
             finish a partial migration; nothing user-owned may be stranded.
Actual:      kill lands after rewriteRegistryDirs but before
             rewriteSkillsPaths / rewriteDisplacedRecords / repointSymlinks.
             From that moment cacheMigrationNeeded() is permanently false
             (registry dirs name the new path; links/displaced-records no
             longer sit at the old path), so no later 0.7.0 command re-runs
             any of it. Recovery chain, verbatim (b1-sim3):

  $ ocm list --all            exit=0 — no migration, no repair
  $ ocm doctor                exit=1 — 7 errors, 1 warning:
    error   …/commands/root-kit:plain.md: broken symlink → …/.cache/ocm/marketplaces/root-mp/… (not ocm's, left in place)
    error   …/commands/plain-kit:quiet.md: broken symlink → … (not ocm's, left in place)
    error   …/commands/root-kit:hello.md: broken symlink → … (not ocm's, left in place)
    warning …/roots/default-337177/displaced/2026-…: displaced copy with no record (removed by an older ocm?) — restore or remove it by hand
    error   marketplace "root-mp": 3 materialized component(s) missing (ocm update)
    error   marketplace "root-mp": plugin "plain-kit" records command "quiet.md" with no materialization — stale record (ocm update root-mp)
    error   marketplace "root-mp": plugin "root-kit" records command "hello.md" with no materialization — stale record (ocm update root-mp)
    error   marketplace "root-mp": plugin "root-kit" records command "plain.md" with no materialization — stale record (ocm update root-mp)
    7 errors, 1 warning
  $ ocm doctor --fix          exit=1 — "fixed  marketplace "root-mp":
    re-materialized 3 component(s)" (links repaired) but skills.paths and the
    displaced record untouched
  $ ocm update                exit=0 — appends skills.paths, leaving
    ["/tmp/…/b1-sim3/.cache/ocm/links/demo-marketplace/skills",     ← stale, dir does not exist
     "/tmp/…/b1-sim3/.cache/ocm/roots/default-337177/links/demo-marketplace/skills"]
    displaced record still points at …/.cache/ocm/displaced/2026-… (old path)
  $ ocm doctor                exit=0 — but the warning repeats forever:
    warning …/roots/default-337177/displaced/2026-…: displaced copy with no
    record (removed by an older ocm?) — restore or remove it by hand
    0 errors, 1 warning
Impact:      three defects in one window. (1) The user's displaced original —
             a hand-written file ocm promised to keep — is permanently
             stranded: no command repairs the record's dir, and the standing
             advice ("restore or remove it by hand") sends the user hunting
             for a file "removed by an older ocm" that ocm itself moved.
             (2) doctor labels ocm's OWN broken command links "(not ocm's,
             left in place)" — the opposite of the truth, and `doctor --fix`
             then fixes them anyway. (3) skills.paths keeps a dead entry
             pointing at a nonexistent directory that doctor never flags
             (possible Part D / brief-33 overlap — skills-paths semantics).
Regression?: new — the cache migration is new in 0.7.0; round 4 had no
             interrupted-migration test. Natural repro (run 6) and the
             deterministic repro agree.
```

## F247 — in a dual-root home, whichever root runs 0.7.0 first swallows the whole shared cache — the other root's clone and mirrors included — and that root is left broken while `list` exits 0 claiming health   (area: CLI, severity: high)

*(b1, Part B1 / step 6.)*

```
Test:        Part B1 / step 6
ocm version: 0.7.0      opencode: 1.18.32
XDG:         set to $H/xdg for the second root
Command:     HOME=$H ocm list --all        (default root, first 0.7.0 run)
             HOME=$H XDG_CONFIG_HOME=$H/xdg ocm list --all   (XDG root, after)
Expected:    each root's migration moves only what that root owns, or refuses
             to touch a cache it cannot attribute; brief 38 makes dual-root a
             supported configuration.
Actual:      default-root run moved the ENTIRE old cache into its own
             namespace — including root-mp2's clone, which belongs to the XDG
             root:
  moved …/.cache/ocm/marketplaces -> …/.cache/ocm/roots/default-d4d059/marketplaces
  moved …/.cache/ocm/links -> …/.cache/ocm/roots/default-d4d059/links
             (afterwards: roots/default-d4d059/marketplaces/{root-mp,root-mp2}
              both present; roots/xdg-31c2a4 never created)
             The XDG-root run then printed NO migration lines (nothing left to
             move), silently re-pointed the registry:
  root-mp2.dir = …/.cache/ocm/roots/xdg-31c2a4/marketplaces/root-mp2   ← does not exist
             and lied about health:
  $ HOME=$H XDG_CONFIG_HOME=$H/xdg ocm list --all
  exit=0
  root-mp2 (auto)
    source: file:///tmp/ocm-e2e5/work-b1/root-mp2
    revision: de29ae7
    synced just now                       ← clone is MISSING on disk
             All three command symlinks broken. Doctor: 5 errors, exit 1 —
             stranded error (F248) + "marketplace "root-mp2": directory
             missing (…roots/xdg-31c2a4/…) — ocm update re-clones" + three
             broken-symlink errors. Mirror image confirmed in reverse order
             (b1-dual2, XDG first): default root left with root-mp clone and
             demo-marketplace skill mirrors swallowed — 3 broken symlinks,
             "marketplace "demo-marketplace": 2 materialized component(s)
             missing". Recovery works: `ocm update` re-clones / re-materializes
             (exit 0, links OK afterwards).
Impact:      a dual-root user who upgrades one root first silently steals the
             other root's data. The broken root's `list` exits 0 and reports
             "synced just now", so the damage is invisible until a command or
             opencode actually fails. Data is recoverable only by re-fetching
             (re-clone/re-materialize); any local-only state in the swallowed
             clone is gone.
Regression?: new trigger of the round-4 shared-cache family: F168 (doctor
             --fix deletes the other root's mirrors) and F189 (ocm remove
             breaks the other root) share the root cause — one physical cache,
             two registries — but were fixed/documented for those commands;
             the 0.7.0 migration is a new, unsupervised writer of the same
             shared resource, and it runs automatically on every command.
```

### Medium

## F210 / F248 — doctor reports a healthy dual-root install as "an ocm install is stranded in another config root", exits 1 forever, with a false remedy   (area: CLI, severity: med)

*(Filed independently from A2 steps 7–8 as F210 (a1) and from B1 step 6 as
F248 (b1) — same root cause; merged here. F210 is the duplicate number.)*

```
Test:        A2 / steps 7–8; B1 / step 6
ocm version: 0.7.0      opencode: 1.18.32
XDG:         two fully-populated roots (root A default, root B XDG), same
             marketplace installed in both, per-root caches; both directions
Command:     `HOME=$H XDG_CONFIG_HOME=$H/xdg ocm doctor` (and the mirror
             direction under root A)
Expected:    brief 38 §1 made dual-root a supported, isolated configuration
             (per-root slugs); brief 38 §2.3's own comment in src/stranded.ts
             says "two live installs are a user decision, not a stranding" —
             doctor should apply the same predicate it gave every other
             command
Actual:      exit 1, on every run, in both directions:
  error   an ocm install is stranded in another config root
    installed at: …/b1-dual/xdg/opencode (2 marketplaces)
    this shell:   …/b1-dual/.config/opencode (XDG_CONFIG_HOME is not set)
    opencode reads the second; nothing in the first is visible to it
    set XDG_CONFIG_HOME to …/b1-dual/xdg to use the existing install, or re-add those marketplaces here
             — under a root that holds a complete, working install of its
             own. The remedy is false (those marketplaces *are* added here).
             Doctor's stranded check (src/commands/doctor.ts:27–41) pushes
             every strandedRoots() result unconditionally;
             reportStrandedNotice() (stranded.ts:89–95) correctly checks
             existsSync(OCM_REGISTRY_FILE) first. a1 verified the mirror
             direction on a home where both roots hold working installs
             (F187's fixed layout); b1 verified it before and after `ocm
             update` recovery on both b1-dual orders.
Impact:      the one user population brief 38 exists for — two config roots
             on one HOME — has a permanently red doctor telling them to redo
             something they already did, with advice that is false for their
             setup. Doctor exit 1 stops meaning "unhealthy"; it also drowns
             the one real signal in F247's doctor output.
Regression?: the code is identical in 0.6.1 (not a code regression), but
             brief 38 legitimizing dual-root makes the contradiction newly
             reachable in supported use; round 4 filed only the opposite
             direction (F167, read-only commands DENYING a stranded install
             exists — fixed in 0.7.0).
```

## F222 — the loader's startup sync discards its warnings: a grandfather-ended uninstall inside opencode is completely silent   (area: loader, severity: med)

*(a2, A4 / step 16 extra.)*

```
Test:        A4 / step 16 extra (loader-side sequence, home a2-7)
ocm version: 0.7.0      opencode: 1.18.32      XDG: unset
Command:     0.6.1-era seeded local marketplace (manifest-less
             `ancient-kit` installed, digests baselined by one 0.7.0
             session), plugin content edited, opencode restarted (TUI,
             sized pty)
Expected:    the same event via `ocm update` prints a careful explanation
             (warning: "changed upstream and still has no plugin.json —
             uninstalled / it predates the plugin.json requirement…" );
             brief 30 §3's startup path should surface the same signal
Actual:      the drop happens (registry record gone, link gone, opencode
             no longer sees the command) but nothing anywhere reports it:
             no stderr in the pty log, no TUI surface, and
             `lastSync: { ok: true, error: null }` — the registry records
             the sync as clean. Root cause: `loader/ocm-loader.js:11` runs
             `void core.syncAll({ reason: "startup" })`, discarding the
             result; `syncAll` collects reconcile warnings (fold skips,
             rename refusals, grandfather-ended drops) in
             `result.warnings` (`loader/sync.js:204-205`) and no consumer
             exists on the startup path.
Impact:      for a user who only runs opencode (the auto-sync loader's
             whole audience), a plugin silently disappears from their
             session after an upstream change, with no pointer to the
             remedy the CLI path prints. Disk state is correct; this is a
             missing diagnostic on the highest-traffic path.
Regression?: new defect — the warnings themselves (fold, refusal,
             grandfather-end) predate 0.7.0, but the grandfather can now
             end at startup for local marketplaces (brief 30), which makes
             the silence consequential for the first time.
```

## F232 — any command from an older ocm, even `--version`, downgrades a newer home's loader files   (area: CLI, severity: med)

*(a3, A7 runner incident + dedicated probe.)*

```
Test:        A7 runner incident + dedicated probe (homes a3-probe2)
ocm version: 0.6.1 running against a 0.7.0 install      opencode: 1.18.32
XDG:         unset
Command:     `HOME=$H ocm061 --version` on a home installed by 0.7.0
Expected:    a read-only `--version` writes nothing; the newer-home guard
             (`refuseNewerHome`) exists precisely to stop an older binary
             writing a newer installation
Actual:      v0.6.1 `--version` prints
             `refreshed the auto-sync loader: 0.7.0 → 0.6.1 (restart opencode to activate)`
             and rewrites all 33 shared loader files to 0.6.1 stamps
             (`// ocm-version: 0.6.1 …` in lock.js, core.js, ui.js, …) while
             the 4 v070-only files (defect.js, digest.js, gate.js, renames.js)
             keep 0.7.0 stamps — a **mixed-version install** the registry
             still records as `ocmVersion: 0.7.0`. A v061 *mutating* command
             is correctly refused (`error: this installation was last written
             by ocm 0.7.0; you are running 0.6.1`), but
             `refreshStaleLoader` (`src/index.ts:138`) runs for every command
             except `help`/`init` — including `--version` — and does not
             consult `refuseNewerHome`, which guards only `mutating()`
             (`src/index.ts:122`).
Impact:      anyone with two ocm versions on PATH (npx vs global, project vs
             user install) silently downgrades their loader files — and with
             the version set mixed, a subsequent opencode start runs 0.6.1
             modules next to 0.7.0-only ones. This is also what made the
             runner incidents below a ping-pong: whichever `--version` ran
             last won.
Evidence:    `/tmp/ocm-e2e5/homes/a3-probe2` (grep `ocm-version` there for
             the mixed stamps); the refusal contrast is one `ocm update` away.
```

## F245 — restarting opencode before running any 0.7.0 CLI command makes the migration run forever: every command re-prints a false "moved" claim and three warnings, and the old tree is never cleaned up   (area: loader/CLI, severity: med)

*(b1, Part B1 / step 4, restart-opencode-first variant.)*

```
Test:        Part B1 / step 4 (restart-opencode-first variant)
ocm version: 0.7.0 (CLI) with the un-refreshed 0.6.1 loader still installed
             opencode: 1.18.32
XDG:         unset
Command:     build 0.6.1 home → run opencode TUI (the 0.6.1 loader re-creates
             the skill mirrors at the OLD .cache/ocm/links path) → run any
             0.7.0 command. Reproduced on b1-sim2; re-run verbatim:
  $ HOME=$H ocm list --all          (third+ iteration, same output every time)
  exit=0
  --stdout--
  moved …/.cache/ocm/links -> …/.cache/ocm/roots/default-587738/links
  …full healthy listing…
  --stderr--
  warning: left …/.cache/ocm/links/demo-marketplace/skills/demo-kit--code-review/SKILL.md in place; …/roots/default-587738/links/…/SKILL.md already exists — move it by hand
  warning: left …/.cache/ocm/links/demo-marketplace/skills/release-kit--release-notes/SKILL.md in place; … already exists — move it by hand
  warning: …/.cache/ocm/links left in place — it may belong to another config root
Expected:    after one migration the predicate is false and nothing re-runs;
             printed lines state true facts.
Actual:      the 0.6.1 loader's startup sync re-creates `links/<name>` under
             the old cache path, which keeps cacheMigrationNeeded() true
             forever. Every subsequent 0.7.0 command re-runs the migration:
             the "moved … links" line is false both times after the first
             (nothing moves — the destination already exists), the two
             "already exists — move it by hand" warnings are self-inflicted
             (ocm's own loader created the "conflict"), and the old tree is
             never removed. Confirmed repeating across list and doctor runs
             ($W/…/b1-sim2/.out, .d2out, .o3 — identical output each time).
Impact:      a user who upgrades ocm and simply restarts opencode (the natural
             order — the loader tells them to) gets a cache that never
             converges: permanent warning noise on every command, a stale
             duplicate tree, and migration output that lies. Irony: this path
             DOES repair skills.paths and the displaced record (the re-run
             rewrites them), unlike the CLI-first path of F244.
Regression?: new — no round-4 finding covers the old loader re-creating
             mirrors at the old path post-upgrade.
```

## F258 — "already up to date" silently reverts a user-edited rendered file   (area: CLI, severity: med)

*(b2, Part B2 / step 8.)*

```
Test:        Part B2 / step 8
ocm version: 0.7.0      opencode: 1.18.32
XDG:         unset (scratch home b2-1)
Command:     append `MY LOCAL TWEAK` after the marker in the rendered
             `commands/root-kit:hello.md`, then `ocm update root-mp-a`
Expected:    plan step 8 verifies the revert happens; a revert of user bytes
             warrants a warning (content control is the marker's contract,
             but the output promises "nothing happened")
Actual:      `already up to date` on stdout, empty stderr, exit 0 — and the
             file on disk was reverted to the rendered body; the user's text
             is gone with no trace.
Impact:      user data loss with an explicit "nothing changed" message. The
             revert itself is by design; the missing warning is the defect.
Regression?: new (round 3/4 tested displacement, not post-marker edits).
```

### Low

## F208 — `ocm install` prints an empty component summary `()` on reinstall-after-uninstall   (area: CLI, severity: low)

*(a1, A1 / step 1.)*

```
Test:        A1 / step 1
ocm version: 0.7.0      opencode: 1.18.32
XDG:         unset
Command:     `ocm uninstall demo-kit` then `ocm install demo-kit`
Expected:    brief 31 — reports derived from outcomes; the install headline
             states the plugin's components
Actual:      `installed demo-kit@demo-marketplace ()` — exit 0. The plugin
             has 3 components and all 3 were materialized. Cause:
             `setEnabled` (loader/mutations.js) captures
             `const components = record.components` as the *pre-derive*
             snapshot; the preceding uninstall's `deriveComponents` emptied
             the record, so the reinstall headline prints the stale empty
             set. A fresh install prints correctly
             (`installed solo-kit@demo-marketplace (1 skill)`, home a1-12).
Impact:      a user re-enabling a plugin reads `()` as "no components";
             the line under-reports what was just created.
Regression?: new defect — brief 31's outcome-derived rewrite; the
             reinstall-after-uninstall path was not covered.
```

## F209 — `ocm untrust` on a marketplace with nothing to remove still says "executable components removed"   (area: CLI, severity: low)

*(a1, A1 / step 4.)*

```
Test:        A1 / step 4
ocm version: 0.7.0      opencode: 1.18.32
XDG:         unset
Command:     `ocm untrust demo-marketplace` on a never-trusted, skill-only
             marketplace (home a1-4)
Expected:    a true no-op states it is a no-op (the restart notice
             correctly stays absent — F96's fix); the success line should
             be outcome-derived like the rest of brief 31
Actual:      exit 0, stdout `marketplace "demo-marketplace" no longer
             trusted; executable components removed` — nothing was
             removed (trust was `none`, the plugin ships no executable
             components). The line is unconditional
             (src/commands/trust.ts:167).
Impact:      a false claim in exactly the place F96/F116 fixed the notice;
             a user cannot tell a no-op from a real revocation.
Regression?: new defect — adjacent to the F96 fix, same verb, uncovered
             path.
```

## F211 — the `add` headline counts skipped and trust-blocked components as shipped, always plural   (area: CLI, severity: low)

*(a1, A1 / steps 1–2.)*

```
Test:        A1 / steps 1–2
ocm version: 0.7.0      opencode: 1.18.32
XDG:         unset
Command:     `ocm add …/noname-mp` (skill missing frontmatter `name`)
Expected:    brief 31 — the report states outcomes; F76/F104's fix says the
             report reports the skill as skipped, not installed
Actual:      stdout `demo-kit (1 agents, 1 commands, 1 skills, 1 plugins,
             1 mcp servers)` while stderr says the skill was skipped and
             disk holds no skill (registry, links, `debug skill` all
             correct). The same headline also prints "1 agents, 1
             commands, 1 skills" — the add-side summary (src/commands/
             plugins.ts:116 → `scan`'s renderer shares it) never
             singularizes, unlike install's "1 skill". Two residues of the
             pre-brief-31 discovery summary surviving inside the
             outcome-derived report.
Impact:      the stdout summary and the stderr warnings contradict each
             other in the same run; a user reading only stdout believes a
             skill installed.
Regression?: new defect — F76/F104 closed the registry/list/opencode
             surfaces; the add headline was not rewritten.
```

## F220 — runner incident: two bare `ocm --version` calls ran against the real home; a third writer repaired it concurrently   (area: docs, severity: low)

*(a2, session start. Process breach, not a product defect — see "Real-home
incidents" below for the consolidated account.)*

```
Test:        session start, before any scratch home existed
ocm version: 0.7.0 (~21:00:25) and 0.6.1 (~21:02:13), both bare
Command:     `ocm --version` (real HOME, twice, ~2 min apart)
Expected:    SHARED.md: every ocm invocation under a scratch HOME
Actual:      my two commands ran against the real home. The deterministic
             effect of that exact pair was probe-verified in
             `/tmp/ocm-e2e5/homes/a2-probe`: full revert to the
             0.6.1-stamped loader plus four stray 0.7.0-only module files
             (`renames.js`, `digest.js`, `defect.js`, `gate.js`).
             The real home's **current** state is instead a coherent,
             complete published-0.7.0 loader (all 36 module stamps + entry
             `// ocm-version: 0.7.0 7a0130cd`); `registry.json` /
             `opencode.json` untouched (mtime 20:34, `ocmVersion` 0.6.1),
             `tui.json` Sep 15, no leftover `registry.lock`, cache already
             in 0.7.0 layout since Sep 20. The loader rewrite timestamp
             (~21:02:13) postdates my 0.6.1 call, so a **third** 0.7.0
             binary — not mine — rewrote it concurrently, most likely
             another round-5 participant making the same bare-command
             mistake.
Impact:      no user impact and no restoration needed (the current state
             is a valid 0.7.0 loader over an untouched registry), but the
             primary agent should know more than one participant is
             leaking commands into the real home.
Regression?: process breach, first occurrence for this agent. All
             subsequent invocations (every command in this report) ran
             under scratch homes; every home's invariants (no `.claude` /
             `.agents`, no dangling links, valid JSON) were checked at the
             end of each scenario.
```

## F221 — a local fold's dropped plugin is invisible to the update report: `already up to date` while a plugin is uninstalled   (area: CLI, severity: low)

*(a2, A5 / step 17.)*

```
Test:        A5 / step 17
ocm version: 0.7.0      opencode: 1.18.32      XDG: unset
Command:     local marketplace on case-sensitive APFS with `case-Kit`
             installed; lowercase `plugins/case-kit` appears; `ocm update`
Expected:    brief 28 §3.3: the folded pair's plugins are skipped with the
             warning and the rest of the update proceeds — F128's fix was
             supposed to make the report and the disk agree
Actual:      exit 0; the skip warning fires on stderr and the drop is real
             (record gone, link gone), but stdout prints
             `already up to date` + `restart opencode to activate`. Root
             cause: the fold filter removes the candidate from
             `registrable` (`loader/reconcile.js:90-96`) without pushing
             it to `dropped`/`pruned`/`removed`; the record then vanishes
             via `registerPlugins`' wholesale replacement of the plugins
             map, so `report.changed` stays false
             (`src/commands/update.ts:176-183`) and the per-item report
             never runs.
Impact:      a user reading stdout believes nothing changed while a
             plugin was just uninstalled; the stderr warning tells the
             truth but the summary contradicts it. Disk state is correct.
Regression?: round 4's F128 reported the same reporting half ("report
             says 0 removed") alongside the cross-wire; the cross-wire is
             fixed, the uncounted drop remains.
```

## F223 — `add` on a mixed tree silently ignores a component-less broken plugin.json while installing the sibling   (area: CLI, severity: low)

*(a2, A5 / step 19, beyond the plan's isolated-tree scope.)*

```
Test:        A5 / step 19 (beyond the plan's isolated-tree scope)
ocm version: 0.7.0      opencode: 1.18.32      XDG: unset
Command:     `ocm add` on a local tree with `broken-kit` (only content a
             broken plugin.json) + `good-kit` (valid, 1 command)
Expected:    F146's stated expectation — "report an unreadable
             plugin.json wherever the directory exists"
Actual:      `ocm validate` reports it (1 error, exit 1, same wording as
             the isolated tree), but `ocm add` exits 0, installs
             `good-kit`, and never mentions `broken-kit` in either stream.
             Registry holds only `good-kit`.
Impact:      an author who tests with `add` instead of `validate` inside a
             mixed marketplace gets no signal about the broken manifest;
             users are unaffected (nothing installs either way). Same
             shape round 4 recorded as F146's mixed-marketplace half.
Regression?: residual of F146 — the isolated-tree half (what round 5's
             step 19 names) is closed; the mixed-tree half at `add` is
             unchanged from round 4.
```

## F233 — doctor is silent about `plugin:name` links orphaned by registry loss, though the lock-break warning names it as the remedy   (area: CLI, severity: low)

*(a3, A7 / step 24 aftermath.)*

```
Test:        A7 / step 24 aftermath (home a3-3b)
ocm version: 0.7.0      opencode: 1.18.32
XDG:         unset
Command:     `ocm doctor`, `ocm list`, `ocm update` after a lock broken as
             stale mid-run let two `ocm add`s interleave
Expected:    the release warning says "its writes and ours may have
             interleaved — run ocm doctor"; doctor should surface the damage
Actual:      the loser's marketplace vanished from the registry (`list`
             shows only `slow-two`; `update` reports "already up to date"
             for it alone) while its five `plugin:name` command links and
             cache clone remain on disk and keep loading in opencode.
             `ocm doctor` exits 0 and prints nothing about them: the orphan
             sweep (`src/commands/doctor-orphans.ts`) covers `ocm--` links
             and skill mirrors, not command/agent mirrors. The user who
             follows the warning gets "all clean" and keeps zombie commands
             from a marketplace ocm no longer manages.
Scope note:  the registry clobbering itself is the known brief-37 lock-steal
             race (Part D, not re-filed); what is new is that the prescribed
             remedy does not detect the result. Trigger is rare (a hold
             >10 min broken as stale), hence low — but any registry-loss
             path leaves the same orphaned links.
Evidence:    `work-a3/step24b.py`, homes a3-3b (`ocm list` vs
             `ls commands/` diverge; doctor exit 0).
```

## F246 — `ocm --version` performs the cache migration and refreshes the loader: a version query mutates user data   (area: CLI, severity: low)

*(b1, Part B1 / steps 2/4.)*

```
Test:        Part B1 / steps 2/4
ocm version: 0.7.0      opencode: 1.18.32
XDG:         unset
Command:     HOME=$H /tmp/ocm-e2e5/v070/node_modules/.bin/ocm --version
             (fresh 0.6.1 home, one git marketplace, old layout)
Expected:    a --version query is read-only.
Actual:      exit=0
  --stdout--
  moved /tmp/ocm-e2e5/homes/b1-f246/.cache/ocm/marketplaces -> /tmp/ocm-e2e5/homes/b1-f246/.cache/ocm/roots/default-1df3d8/marketplaces
  refreshed the auto-sync loader to 0.7.0 (restart opencode to activate)
  0.7.0
  --stderr-- (empty)
             On disk afterwards: old `marketplaces/` gone, `roots/default-1df3d8/`
             present, loader modules rewritten.
Impact:      scripts that probe `ocm --version` (release tooling, CI matrices)
             silently migrate the invoking user's cache and rewrite their
             loader. Harmless in the happy path, surprising at best; it also
             widens F244's crash window to any version probe.
Regression?: new behaviour in 0.7.0 (migration-before-dispatch runs on every
             command including --version). Round 4's F166 fix (loader
             auto-refresh) is what made version queries mutating.
```

## F249 — doctor prints a `cache <slug> (<path>)` line for a namespace directory that does not exist   (area: CLI, severity: low)

*(b1, Part B1 / steps 5/6.)*

```
Test:        Part B1 / steps 5/6
ocm version: 0.7.0      opencode: 1.18.32
XDG:         unset (b1-local2) / set (b1-dual xdg root pre-recovery)
Command:     HOME=$H ocm doctor   (b1-local2: exec-mp only — no git clone, no
             skill mirrors, zero cache footprint)
Expected:    every printed line states a true fact.
Actual:      exit=0
  cache   default-8d46e9 (…/b1-local2/.cache/ocm/roots/default-8d46e9)
             followed by `ls …/b1-local2/.cache/ocm/roots/`:
  ls: …: No such file or directory
             Same shape on b1-dual's XDG root before recovery: the cache line
             named roots/xdg-31c2a4 while that directory did not exist.
Impact:     a user following the line to "find their own" cache (its stated
             purpose, brief 38) finds nothing. Minor, but the line asserts
             existence it never checks.
Regression?: new line in 0.7.0 (brief 38 added it).
```

## F256 — `ocm --version` mutates a stale auto-sync loader in the real home   (area: CLI, severity: low)

*(b2, disclosure / Part B2 preamble. Same mechanism as F246 and F232 —
a version query writes — observed from the real-home breach; kept as filed.)*

```
Test:        disclosure (pre-B2), Part B2 preamble
ocm version: 0.7.0      opencode: 1.18.32
XDG:         unset
Command:     bare `ocm --version` (real HOME, twice)
Expected:    `--version` is a read-only query; SHARED.md discipline assumes it cannot touch `~/.config/opencode`
Actual:      first call printed `0.7.0` silently; second printed `0.7.0` and
             `refreshed the auto-sync loader: 0.6.1 → 0.7.0`, rewriting loader
             modules under `~/.config/opencode/ocm/` and `plugins/ocm-loader.js`
             (stamped `// ocm-version: 0.7.0`). registry.json / opencode.json /
             tui.json untouched (older mtimes). The two calls behaved
             differently; the trigger for the second's refresh was not
             identified. `refreshStaleLoader` in `src/index.ts` runs for every
             command including `--version` (deliberate per code comment). Also
             ran bare `opencode --version` once (read-only).
Impact:      a version check silently upgrades files in the user's real opencode
             config; agents/tools that probe `--version` as a harmless query
             get a write. (Reported as my own discipline breach per SHARED.md;
             the write was ocm's, not mine.)
Regression?: not covered in rounds 3–4 findings; new observation.
```

## F257 — update omits the restart notice when only a refresh happened   (area: CLI, severity: low)

*(b2, Part B2 / step 7.)*

```
Test:        Part B2 / step 7
ocm version: 0.7.0      opencode: 1.18.32
XDG:         unset (scratch home)
Command:     `ocm update root-mp-a` after an upstream command edit
Expected:    consistent "restart opencode to activate" whenever the
             materialized output changed (the loader only reads at startup;
             nothing reloads in-session)
Actual:      the step-7 run printed it (`~ commands/hello.md … restart opencode
             to activate`), but the `--json` re-run of the same change class
             reports `"state":"refreshed"`, and `renderMarketplace`
             (`src/commands/update-report.ts`) prints the restart line only
             for created/removed components — a refresh-only change (e.g.
             body edit with no new/removed component) gets no notice, while
             `src/report.ts` `reportRestart` (install path) does include
             refreshed.
Impact:      a user whose command body changed on disk sees no notice; the
             change silently does not apply until restart, contradicting the
             notice shown for other change kinds.
Regression?: new; adjacent to F128/F190 (round 4) only in area.
```

## F259 — `installed root-kit@root-mp-a ()` — empty component summary   (area: CLI, severity: low)

*(b2, Part B2 / step 10. Same defect family as F208, hit from the install
path with a pre-existing file at the destination.)*

```
Test:        Part B2 / step 10
ocm version: 0.7.0      opencode: 1.18.32
XDG:         unset (scratch home b2-1)
Command:     `ocm install root-kit@root-mp-a` with a pre-existing
             hand-written file at the rendered path
Expected:    a component summary (e.g. `1 commands`) or nothing
Actual:      `installed root-kit@root-mp-a ()` — the record snapshot is
             taken before components are derived, so the summary is empty
             on re-install.
Impact:      cosmetic; looks broken.
Regression?: new.
```

## F260 — install exits 0 with an "installed" headline while a component was skipped   (area: CLI, severity: low)

*(b2, Part B2 / step 10.)*

```
Test:        Part B2 / step 10
ocm version: 0.7.0      opencode: 1.18.32
XDG:         unset (scratch home b2-1)
Command:     `ocm install root-kit@root-mp-a` with hand-written
             `commands/root-kit:hello.md` present, no `--force`
Expected:    the skip is only a stderr warning; success headline + exit 0
             implies the plugin is fully installed
Actual:      exit 0, stdout `installed root-kit@root-mp-a ()`, stderr
             `warning: commands/root-kit:hello.md exists and is not managed
             by ocm … skipped it; re-run with --force to displace it`; the
             hand-written file stayed. The plugin is NOT fully installed
             (its command is missing) yet the run reports success.
Impact:      a script checking the exit code believes the install succeeded;
             the user only finds out by reading stderr.
Regression?: new; F107-class family (success-shaped output for a partial
             operation).
```

## F261 — displacement fact printed on both stdout and stderr   (area: CLI, severity: low)

*(b2, Part B2 / step 10.)*

```
Test:        Part B2 / step 10
ocm version: 0.7.0      opencode: 1.18.32
XDG:         unset (scratch home b2-1)
Command:     `ocm install root-kit@root-mp-a --force` with the hand-written
             file present
Expected:    one report of the displacement (stderr per house convention:
             warnings to stderr, data to stdout)
Actual:      `displaced your commands/root-kit:hello.md → …/displaced/<ts>/…`
             appears both in the stdout report and as a stderr warning
             (`queueWarning` emits the same fact).
Impact:      cosmetic/duplicated; stdout consumers and terminal readers see
             it twice.
Regression?: F107-class; specific duplication not previously filed.
```

## F262 — ocm marker comment is sent to the model in every rendered-command invocation   (area: loader, severity: low)

*(b2, Part B2 / step 11; first direct evidence — a3 saw the same in the
step-21 session transcript.)*

```
Test:        Part B2 / step 11
ocm version: 0.7.0      opencode: 1.18.32
XDG:         unset (scratch home b2-2)
Command:     `opencode run --command root-kit:hello --format json`; read the
             stored user message from `opencode.db` (`part` table)
Expected:    the marker (`<!-- ocm: rendered from … @ <rev> -->`) is
             bookkeeping for update/revert logic
Actual:      the user message (model input) ends with the marker verbatim:
             `Say hello v3: hello-from-root-kit-script\n\n<!-- ocm: rendered
             from plugins/root-kit/commands/hello.md @ 694e071… -->`
Impact:      every invocation leaks the marketplace's source path layout and
             git rev into the prompt, and adds noise. Benign but inherent to
             the current design (marker lives in the file body).
Regression?: inherent since rendered commands shipped; first direct evidence
             (round 4 verified the marker exists, not that it reaches the
             model).
```

## F263 — rendered skill marker reads `@ unknown` for local marketplaces   (area: loader, severity: low)

*(b2, Part B4 / step 16. Also observed by a1 in step 1.)*

```
Test:        Part B4 / step 16
ocm version: 0.7.0      opencode: 1.18.32
XDG:         unset (scratch home b4-1)
Command:     `cat` the rendered
             `roots/default-*/links/many-mp/skills/many-kit--skill-07/SKILL.md`
             after an update
Expected:    marker names a revision, as the command markers do
             (`@ 694e071…`)
Actual:      `<!-- ocm: rendered from plugins/many-kit/skills/skill-07/SKILL.md @ unknown -->`
             — local (non-git) marketplaces have no rev, so the marker says
             `unknown`
Impact:      cosmetic; slightly weakens the marker's provenance story and
             (per F262) puts the word `unknown` in prompts for local
             marketplaces.
Regression?: new.
```

---

## Status notes on known-open findings (not re-filed)

- **F118** (older binary reverts the loader): the mutating-command half of
  the guard **holds** — a v0.6.1 `ocm update` against a 0.7.0 home is
  refused with both versions named. The bypass half — `--version` and
  every non-mutating command rewriting the loader anyway — is filed as
  new (F232), because `refuseNewerHome` exists and simply is not consulted
  by `refreshStaleLoader`.
- **F81 family** (error classification): the schema-mp fixture added via
  `file://` fails with the known "private, unreachable" diagnosis; bare
  paths work. Known family, not re-filed (a3).
- **The lock-steal race** (brief 37, Part D): reproduced as the *setup* of
  A7-24 exactly as recorded; the registry clobbering is not re-filed. What
  is filed is new (F233): the warning's own prescribed remedy, `ocm
  doctor`, does not detect the result.
- **Real-home doctor noise** (82 errors / 40 warnings): pre-existing
  `tui-scale` stale records documented in `.work/round4-manual-runbook.md`,
  present before round 5 started — not round-5 damage.

## Real-home incidents (disclosed in full)

The round-5 protocol required every ocm invocation to run under a scratch
`HOME`. It was breached — repeatedly, by the primary agent and by **all
five** subagents, always with bare `ocm --version` calls at session start
(and, in a1's case, the restoration `ocm init`). The consolidated timeline:

- **20:58:45** — primary agent ran bare `ocm --version` (0.7.0): refreshed
  the real home's loader 0.6.1 → 0.7.0.
- **~21:00–21:02** — a1 (0.7.0 then 0.6.1) and a2 (0.7.0 at ~21:00:25,
  0.6.1 at ~21:02:13) each ran bare version checks; the 0.6.1 calls
  downgraded the 33 shared loader modules to 0.6.1 stamps.
- **~21:02** — b1's first command (bare 0.7.0 `--version`) printed
  `refreshed the auto-sync loader: 0.6.1 → 0.7.0` — this is the "third
  writer" a2's F220 identified from timestamps.
- **21:04:28** — a1 restored the real home with the user's own global 0.7.0
  `ocm init` (`auto-sync loader already current`, exit 0; all 36 modules
  re-stamped 0.7.0). a3's own bare pair ran at the same moment and its
  forensics initially showed an unexplainable 0.7.0 win — explained by the
  concurrent restoration (the ping-pong is F232's mechanism: whichever
  `--version` ran last won).
- **b2** ran bare `ocm --version` twice early in its session (the second
  triggered the loader refresh it filed as F256) and one bare
  `opencode --version` (read-only).

What was and was not touched:

- **Loader modules** (`~/.config/opencode/ocm/`, `plugins/ocm-loader.js`):
  rewritten several times, ping-ponged between 0.6.1 and 0.7.0 stamps.
  Final state verified coherent: all 36 modules stamped
  `// ocm-version: 0.7.0`, byte-identical to published 0.7.0 content —
  equivalent to a legitimate `ocm init`. No mixed-version residue.
- **Registry** (`registry.json`): untouched — mtime 20:34, before any
  round-5 activity; `ocmVersion` still 0.6.1 as it was.
- **`opencode.json`, `tui.json`, `commands/`, `agents/`**: untouched
  (mtimes predate the round; verified by a1, a2, a3, b1, b2).
- **Cache**: already in the 0.7.0 `roots/` layout since Sep 20, so no
  migration ran there.
- The primary agent also ran one read-only `ocm doctor` against the real
  home (to confirm its state); disclosed here for completeness.

The real home's doctor reports 82 errors / 40 warnings — all pre-existing
`tui-scale` stale records documented in the round-4 manual runbook, present
before round 5 began. **No round-5 activity damaged user data.** The
proximate cause of every breach is ocm's own behaviour (F232/F246/F256:
`--version` writes), but the protocol failure is ours: the harness should
have made the scratch `HOME` impossible to forget.

## Delegated to human

1. **Part C, all of it** (steps 18–20 of the plan): the whole
   add → update → remove cycle driven from `/ocm` in a real terminal; TUI
   rendering (trust prompt, collision-takeover prompt, category/tags
   grouping, Browse at 80 columns, unicode, `/skills` for a 25-skill
   plugin, `/ocm` under `OPENCODE_PURE=1`); and **timed authoring from the
   README alone**, worth more than ever now that brief 41 changed what a
   command file becomes.
2. **The interactive trust prompt (`y`/`N`/`skip`) in a real TTY** — every
   trust decision this round was the piped-stdin default, `--no-trust` or
   `--yes` (a1's leftover; same as round 4).

## Invariants

Held in every home of every scenario across all five agents: no writes
under `.claude`, `~/.claude`, `.agents`, `~/.agents`; registry /
`opencode.json` / `tui.json` valid JSON wherever present; no
`registry.lock` left behind by any completed scenario; success lines on
stdout, warnings/errors on stderr; exit codes 0/1 as specified (130 not
exercised — no SIGINT scenario survived into this round's scope).

The exceptions are the findings themselves: broken ocm symlinks with
doctor exit 1 exist exactly on the F244/F245/F247 homes (until `update` /
`doctor --fix` repaired the links; the F244 displaced record and stale
`skills.paths` remain), and doctor exit 1 with no disk defect exists on
every dual-root home (F210/F248). Hand-written files survived every
operation including `ocm remove` (b2 step 10: bytes returned verbatim
after displacement restore); `opencode debug config` / `debug skill`, run
from a neutral cwd, matched disk in every home where they were checked.

---

# Triage (owner)

Read against the code, not only the reports. Verdicts below are decisions,
not suggestions: a brief that contradicts one of them is wrong.

## What this round actually established

Part A is the real result and it is good news: **29 of 29 regression steps
closed**, including all six review-only fixes that had never been exercised
outside their own unit tests. Every round-4 fix holds on its own ground.

The failures are all in one place — **the cache migration that shipped in
0.7.0** — and they share a shape worth naming: `migrate-cache.ts` is
careful about *when* it runs and careless about *what* it moves. The
predicate was reasoned about at length (three paragraphs of comment, two
brief revisions, my own broken `or` in brief 38) while the action beneath
it, `for (const item of OLD_ITEMS) moveItem(...)`, moves four whole trees
with no reference to the registry the predicate just consulted. F247 is
that gap exactly: the comment at `src/migrate-cache.ts:56` promises "moving
it is the cross-root harm this brief exists to end", and thirty lines later
the code moves it.

## Severity changes

- **F232 → high** (from med). It is the only finding this round that can
  leave a home in a state no single version can explain: 33 modules stamped
  0.6.1 beside 4 stamped 0.7.0, with the registry claiming 0.7.0. The
  loader's own error swallowing means a resulting import failure surfaces as
  "my plugins stopped working", with nothing to read. It is also the
  cheapest fix in the round — `refreshStaleLoader` must consult
  `refuseNewerHome`, which already exists and is already correct.
- **F245 stays med, but is fixed first.** Its impact is noise and a stale
  tree, not lost data, so the grade is right. Its *reachability* is what
  matters: F244 needs a `kill -9`, F247 needs two config roots, F245 needs
  only "upgrade, then restart opencode" — the order ocm's own message
  instructs. Nearly every 0.6.1 upgrader takes this path.
- Everything else stands as filed.

## Clusters

**C1 — the migration is not resumable (F244, F245, F246).** The predicate
is derived from the end state of the rewrites, so a half-done migration is
indistinguishable from a finished one (F244) or from an unstarted one
forever (F245). No amount of predicate tuning fixes this; the state must be
recorded rather than inferred. A journal file written before the moves and
cleared after the last rewrite makes both cases trivial: present ⇒ resume,
absent + old layout ⇒ start. F245's self-inflicted "move it by hand"
warnings also go away, because a destination ocm's own loader re-created is
not a conflict.

**C2 — the migration moves what it does not own (F247, F249).** Move
per-marketplace, by name, from the active root's registry; leave the rest
for `reportUnreferencedOldCache` to warn about. This is what the predicate
already believes the code does.

**C3 — read-only commands write (F232, F246, F256).** `--version` migrates
a cache and rewrites 33 files. Version queries and `help` print and exit;
`refreshStaleLoader` consults `refuseNewerHome`. Three findings, one small
change.

**C4 — doctor's stranded predicate (F210/F248).** `doctor.ts:27` pushes
every `strandedRoots()` result unconditionally where `reportStrandedNotice`
correctly checks for a local registry first. A supported dual-root install
has a permanently red doctor telling the user to do what they have already
done. One condition.

**C5 — headlines composed from intent, not outcomes (F208, F209, F211,
F221, F257, F259, F260, F261).** Eight findings, one cause, and it is the
same cause brief 31 fixed for the *per-item* lines: the summary line was
never rewritten to read the outcome records. F260 is the only one with
teeth — exit 0 with an "installed" headline over a skipped component — and
it belongs with the error-classification work in brief 32.

**C6 — the loader's startup path has no voice (F222).** `syncAll` collects
warnings that `ocm-loader.js:11` throws away with `void`. For the
opencode-only user this is the *only* path, and a plugin vanishing from
their session is the event most worth a word. Needs a surface decision, so
it goes with brief 36.

## Not defects

- **F262** (marker reaches the model). Checked: the marker is
  `<!-- ocm: rendered from <path-relative-to-marketplace> @ <rev> -->`, not
  an absolute path — `loader/links.js:132`. It is also load-bearing:
  `isRenderedFrom` proves ownership by the marker naming its own source, so
  the path cannot be dropped without giving up the guarantee that a
  hand-written file survives `ocm remove`. A few tokens of provenance in
  the prompt is the right trade. **Wontfix**, and the finding's framing
  ("leaks the source path layout") should not be carried forward.
- **F220, F256** as *process* findings — see below. The writes they
  describe are real defects (F232/F246); the discipline failure is not
  ocm's bug.

## Release plan

**v0.7.1 — migration safety. Everything else waits.** C1 + C2 + C3 + C4,
i.e. F232, F244, F245, F246, F247, F249, F256, F210/F248. Rationale: 0.7.0
is live on npm and the migration runs automatically, on every command, on
every 0.6.1 user's first upgrade. It is the only code in this round that
touches user data. Two briefs: one for the migration (C1+C2), one for the
read-only/predicate set (C3+C4), which is small enough to land first.

**v0.8.0** — briefs 32 (error classification, takes F260 and F223) and 33
(doctor completeness, takes F233), plus C5 as its own brief.

**v0.9.0** — brief 36 (display & TUI) takes C6 and F263. F258's missing
"reverted your edits" line goes here too; the revert itself is correct and
stays.

Unscheduled: brief 37 (lock-steal race). Still the right call — F233 is its
only round-5 trace and is cosmetic.

**Not deprecating 0.7.0 on npm.** F247 needs two config roots and F244
needs a signal mid-migration; the common upgrade path is F245, which is
loud and non-destructive. Shipping 0.7.1 quickly beats a deprecation notice
that most users would read after upgrading anyway.

## Before brief 32 or 33

`loader/materialize.js` is 469 lines against a 300-line budget and has been
flagged by four consecutive briefs. Split it before adding to it; the
error-classification work lands squarely in it.

## Harness (round 6)

All six agents breached the scratch-`HOME` rule, in the same way, with the
same command, within seven minutes. That is not six lapses of discipline,
it is a harness that permitted it. Round 6 puts a shim named `ocm` first on
`PATH` that refuses to exec unless `$HOME` is under the scratch prefix, so
the raw binary is unreachable from the test session; the guard function
becomes redundant, which is the point. The disclosure itself was handled
correctly and in full — that part of the protocol worked.

---

# v0.7.1 upgrade verification (2026-09-23)

Run against `main` at 6c4d4b8 (briefs 42 and 43 merged), upgrading homes
built by **published 0.6.1** in place — the condition the unit tests cannot
reproduce. Every call went through a function refusing any `$HOME` outside
`/tmp/ocm-e2e5/v071/homes/`; the real home was not touched.

| Scenario | Finding | Result |
|---|---|---|
| upgrade, then CLI three times | F245 | **fixed** — one migration, then silent; nothing left at the old path; `skills.paths` and the displaced record point into the namespace; doctor exit 0 |
| 0.6.1 TUI first (round 5's order), then CLI three times | F245 | **fixed** — same result |
| interrupted after the moves, before any rewrite (state `in-progress`) | F244 | **fixed** — resumes, doctor exit 0 |
| interrupted after the registry rewrite (the F244 window) | F244 | **fixed** — resumes, displaced record repointed, doctor exit 0 |
| dual root, default root upgrades first | F247, F210/F248 | **fixed** — each root keeps its own clone, doctor exit 0 in both |
| dual root, XDG root upgrades first | F247, F210/F248 | **fixed** — same |
| newer-written home, older binary, stale loader | F232 | **fixed** — `list`/`doctor` warn and skip; loader bytes unchanged; `--version` writes nothing |

Interrupts were built by hand: the whole command takes ~80 ms and the
migration finishes inside the first 30, so a timed `kill -9` never landed
in the window on this machine.

**Not reachable, so no follow-up:** the same marketplace in two roots of a
0.6.1 home. 0.6.1 cannot produce that state — the second `add` clones into
the directory the first root occupies, fails, and its cleanup deletes the
first root's clone. That is the shared-cache defect 0.7.0's per-root cache
already ended.

**Known residual, not fixed in v0.7.1:** a home that hit F244 *on 0.7.0*
— no state file, all four trees already moved whole — is not repaired,
because 0.7.1 sees neither a recorded state nor an old layout. It keeps a
stale `skills.paths` entry and a displaced record naming the old path; the
displaced copy itself is intact in the namespace and doctor names it.
`doctor --fix` repairs the three broken command links. Reaching this state
needed a kill inside a ~30 ms window of the first 0.7.0 command, so the
population is near zero; a repair that also runs the rewrites when
`skills.paths` or a displaced record still names the old layout is a small
brief if anyone reports it.
