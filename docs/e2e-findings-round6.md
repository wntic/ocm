# e2e round 6 — the v0.8.0 surface, the last broad round

Plan: `.work/briefs/T5-round6.md` (deleted once stable; the raw reports are
the durable record). Build under test: main's `ocm` at merge commit
`4ce7240` ("Merge pull request #32 from wntic/work/46-doctor-followups"),
run via `/tmp/ocm-e2e6/bin/ocm` with the HOME guard; `ocm071` is the
published 0.7.1 baseline. Raw reports, with every command, verbatim
stream capture and exit code: [`docs/e2e-round6/a.md`](e2e-round6/a.md),
[`b.md`](e2e-round6/b.md), [`c.md`](e2e-round6/c.md),
[`d.md`](e2e-round6/d.md). Scratch captures live under
`/tmp/ocm-e2e6/work/{a,b,c,d}/`.

Scope: briefs 32 (error classification), 33 (doctor ownership), 44
(internal split, no behaviour change — covered implicitly by every step),
45 (outcome-derived headlines, new exit codes) and 46 (doctor follow-ups).
The bar: **v0.8.0 ships when no high and no medium is found.**

## Verdict tables

### Part a — brief 32 and 46 §1 (error classification)

| Step | Scenario | Verdict |
|---|---|---|
| 1 | stale git lock (`.git/index.lock` / `.git/shallow.lock`) | pass |
| 2 | pre-existing non-empty clone dir before first add | pass |
| 3 | unwritable `~/.cache`; registry-is-a-directory read failure | pass |
| 4 | pinned ref deleted upstream (`ref-missing`) | pass |
| 5 | git off PATH, two git marketplaces | pass |
| 6 | `file://` URL to a non-repo dir | pass |
| 7 | corrupt `.git/HEAD` (unrecognised git failure) | pass |
| 8 | `doctor --fix` with the clone deleted | pass |
| 9 | dirty clone (3 modified + 12 untracked) | pass |
| 10 | broken `plugin.json` beside a valid plugin | pass (no-components reading; with-components variant documented in the raw report) |
| 11 | 46 §1: invalid MCP entry + corrupt registry, `doctor --fix` | pass |

Not run: `opencode debug config` / `debug skill` probes — no step in this
part asks for an opencode-level check. Findings: none.

### Part b — brief 33 and 46 §2–3 (doctor ownership)

| Step | Scenario | Verdict |
|---|---|---|
| 1 | registry entry jq-deleted; orphans reported; `--fix` removes exactly those; hand-written files survive | pass (scored on file:// add; local-path variant is F271) |
| 2 | same with the clone deleted (broken links) | pass |
| 3 | dual root: cross-root link reported, nothing removed, root B byte-identical | pass |
| 4 | corrupt registry + `doctor --fix`: nothing promised, nothing removed, byte-identical | pass |
| 5 | collisions: takeover line on update, freed-name line on remove, registry matches | pass |
| 6 | clone deleted: list marker, info cause once, `--json` shape unchanged | pass |
| 7 | 46 §2: rendered command whose record is removed | **fail** — F270 |

### Part c — brief 45 (headlines and exit codes)

| Step | Scenario | Verdict |
|---|---|---|
| 1 | hand-written command + `ocm install` → exit 1, partial, file byte-identical | pass |
| 2 | same with `--force` → exit 0, displacement once on stdout, original in displaced cache | pass |
| 3 | uninstall then install → headline with counts, never `()` | pass |
| 4 | trust-blocked component → exit 0 | pass |
| 5 | collision at add → exit 1 partial; standing skip at update → exit 0 warning only | pass |
| 6 | skill without `name` → add exit 0, not counted, singular counts | pass |
| 7 | `ocm untrust` in three states | pass (finding F272 on state b's wording) |
| 8 | case collision on `/Volumes/CSX5` | pass |
| 9 | upstream body-only command edit → restart notice | pass |

### Part d — in anger

| Step | Scenario | Verdict |
|---|---|---|
| 1.1 | build the 0.7.1 home (three marketplaces, exec-mp trusted, one displaced original) | pass |
| 1.2 | main's `ocm list` on it: no migration lines | pass |
| 1.3 | main's `ocm doctor`: exit 0, 0 errors | pass |
| 1.4 | main's `ocm update` | pass |
| 1.5 | `opencode debug config` / `debug skill` match disk | pass |
| 1.6 | displaced original restorable via `ocm remove`, byte-identical | pass |
| 2 | script contract: 14 verbs × success/failure/partial | pass (33 cases run; 1 not run — `init` failure has no trigger, duplicate init is an idempotent exit 0) |
| 3 | round trip add → install → update → uninstall → remove | pass on disk cleanup and hand-written files; **fail** on the remove report — F273; teardown leftover — F274 |

## Findings

### F270 — `ocm doctor --fix` removes a rendered orphan and re-materializes it in the same run; never converges

- **Test:** part b step 7 (brief 46 §2) — a rendered command
  (`commands/root-kit:hello.md`, regular file with the
  `ocm: rendered from` marker) whose plugin record is jq-deleted while the
  marketplace entry remains (home `b-7`).
- **Command:** `HOME=/tmp/ocm-e2e6/homes/b-7 ocm doctor --fix` (run twice,
  identical result both times).
- **Expected:** the orphan is reported and `--fix` removes it (brief 46 §2).
- **Actual (verbatim, both runs):**
  ```
  fixed   /tmp/ocm-e2e6/homes/b-7/.config/opencode/commands/root-kit:hello.md: removed
  fixed   marketplace "fixtures-root-mp": re-materialized 1 component(s) (restart opencode to activate)
  ```
  After the run the file is back on disk (644, 291B, same marker) while the
  registry still lists only `["plain-kit"]`; doctor exit stays 1 and every
  subsequent `doctor --fix` repeats the cycle.
- **Impact:** doctor claims "fixed … removed" but the orphan returns within
  the same run and no registry record is ever written for it — a false
  statement a user would act on, and a stuck state doctor can never clean.
- **Severity:** medium.

### F271 — with a local-path marketplace, `doctor --fix` does not remove orphaned symlinks

- **Test:** part b step 1 variant — root-mp added by path (no clone),
  registry entry jq-deleted (home `b-1`).
- **Command:** `HOME=/tmp/ocm-e2e6/homes/b-1 ocm doctor --fix`.
- **Expected:** brief 33 step 1 — "`--fix` removes exactly those" orphans.
- **Actual (verbatim):**
  ```
  error   /tmp/ocm-e2e6/homes/b-1/.config/opencode/commands/root-kit:plain.md: symlink → /private/tmp/ocm-e2e6/fixtures/root-mp/plugins/root-kit/commands/plain.md ; no marketplace owns it and the target is not ocm's — remove it by hand, or re-add the marketplace
  ```
  The symlinks survive `--fix`; exit stays 1.
- **Impact:** none destructive — the ownership model correctly refuses to
  auto-delete links whose target it cannot prove it owns, and the message
  says so. The brief's claim holds only for git/file:// installs whose
  links point into ocm's cache.
- **Severity:** low.

### F272 — `ocm untrust` claims "it ships nothing executable" when the marketplace does ship executables that are merely not linked

- **Test:** part c step 7, state b (home `c-5`).
- **Command:** `HOME=/tmp/ocm-e2e6/homes/c-5 ocm untrust exec-mp` after
  `ocm trust exec-mp --yes` and `ocm uninstall exec-kit`.
- **Expected:** a line that does not falsely describe the marketplace's
  contents (the three-distinct-lines / removal-only-in-first expectation
  itself holds).
- **Actual (verbatim):**
  ```
  marketplace "exec-mp" no longer trusted; it ships nothing executable, nothing was removed
  ```
- **Impact:** `ocm add` for the same marketplace listed three executable
  components (`exec-kit/exec-mcp`, `exec-kit/notify`, `exec-kit/other`), so
  the sentence is false whenever executables exist upstream but are not
  currently linked. The revocation itself is correct (trust → `denied`,
  exit 0), and the same line is accurate when upstream really removed the
  executables (verified on home `c-5b`). `src/commands/trust.ts:169`
  conflates "nothing linked to remove" with "ships nothing executable".
- **Severity:** low.

### F273 — `ocm remove` reports component counts for plugins that were never installed

- **Test:** part d step 3 — remove a marketplace whose plugins were never
  installed (`add --explicit`, nothing materialized; home `d-3b`, also seen
  in `d-3`).
- **Command:** `HOME=$H ocm remove demo-marketplace`.
- **Expected:** report only what was actually removed (or "not installed").
- **Actual (verbatim):**
  ```
  demo-kit: 1 agents, 1 commands, 1 skills, 1 plugins, 1 mcp servers removed
  release-kit: 1 commands, 1 skills removed
  ```
  with `commands/` and `agents/` empty and no cache links ever created.
- **Impact:** a user reading this believes files were deleted from their
  disk. 0.7.1 prints the same lines, so this is pre-existing, not a v0.8.0
  regression.
- **Severity:** medium.

### F274 — full teardown leaves `tui.json` behind, not restored to pre-ocm bytes

- **Test:** part d step 3 — full teardown (`remove` + `ocm loader
  uninstall`) with and without a hand-written `tui.json` (homes `d-3`,
  `d-3d`; 0.7.1 comparison on `d-3d071`).
- **Command:** `HOME=$H ocm loader uninstall`.
- **Expected:** no ocm-made file remains; a user-written `tui.json`
  restored byte-identically.
- **Actual (verbatim, file contents):** an ocm-created `tui.json` remains
  containing `{"plugin": []}`; a hand-written `{"theme": "my-theme"}` is
  left as `{"theme": "my-theme", "plugin": []}`.
- **Impact:** user data survives, but the file is not returned to its
  pre-ocm bytes. Identical in 0.7.1 — pre-existing, not a v0.8.0
  regression.
- **Severity:** low.

## Bar

Two mediums found this round: F270 (new in v0.8.0's doctor follow-up
surface) and F273 (pre-existing in 0.7.1). Per the plan's rule — no high
and no medium — the bar fails on both; whether F273's pre-existing status
changes the ship call is the human's judgement, not this report's.

v0.8.0 bar: NOT MET — F270 (medium: doctor --fix remove/re-materialize loop on a rendered orphan), F273 (medium: ocm remove reports counts for never-installed plugins; pre-existing in 0.7.1)

---

## Resolution (owner, 2026-09-24)

- **F270** (medium) — fixed in brief 47: a rendered file whose source still
  exists under a registered marketplace is stale records, not an orphan.
  Re-verified on home `b-7`: two `doctor --fix` runs print the same
  stale-records finding and remove nothing; `ocm update` then leaves doctor
  at exit 0 with 0 errors.
- **F273** (medium, pre-existing) — fixed in brief 47: `ocm remove` derives
  its lines from the teardown's removed outcomes.
- **F271** — by design, not a defect: a link into a local directory cannot
  be proven ocm's, so it is reported and never removed (brief 33). The plan
  over-stated brief 33.
- **F272, F274** — low; backlog.

**v0.8.0 bar: MET** after brief 47.
