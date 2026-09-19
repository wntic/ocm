# Manual E2E test plan — round 3

Target: ocm at `main` after specs 16–26 (v0.3.0 → v0.5.0).
Predecessors: [round-1 plan](./e2e-test-plan.md),
[round-1 findings](./e2e-findings.md),
[round-2 findings](./e2e-findings-round2.md) (F1–F63 + triage table).

Round 3 has three jobs, in this order of value:

1. **Close the loop** — every F-finding marked *fix* has a
   verification step here (Part A). A finding is only closed when a
   human saw the new behaviour, not when a unit test passed.
2. **Find what the fixes broke** — 11 specs changed ordering, streams,
   exit codes, discovery rules and teardown. Part B re-runs the
   functional surface with the *new* contract, and Part C hunts the
   specific seams where two fixes can disagree.
3. **Go where nobody has been** — Part D is the still-unvisited
   surface: the live TUI (most of round 2's "left for user" list),
   real in-session usage, upgrade-in-place, and environmental edge
   cases.

Ask the same three questions after every step:
did it tell me what happened · did it do what I expected · if it
failed, do I know what to do next.

---

## Setup

### S0. Build identity

```bash
ocm --version          # must print a semver (F33); note it in every finding
opencode --version
git --version; bun --version
```

If `ocm` is installed globally, **reinstall from HEAD before starting** —
round 2 burned a finding (F6) on a stale global binary:

```bash
bun install -g .        # from the repo root, or: bun install -g @wntic/ocm@<ver>
which ocm && ocm --version
```

### S1. Isolated homes

```bash
export OCM_T=/tmp/ocm-e2e3
mkdir -p $OCM_T
newhome() { export H=$OCM_T/home-$(date +%s%N); mkdir -p $H; echo $H; }
alias ocmt='HOME=$H ocm'
alias opencodet='HOME=$H opencode'
```

Every suite starts with `newhome` unless it says otherwise.

### S2. Fixtures — **must be rebuilt for spec 19**

`plugin.json` with a non-empty `description` is now **required** for
every plugin. Round-2 fixtures without one will now be refused — that
is correct behaviour, not a finding. Rebuild:

| Fixture | Contents | Purpose |
|---|---|---|
| **MP-A** `ocm-e2e3-alpha` | 2 plugins, full manifests, one command+agent+skill, one skill-only | main loop |
| **MP-B** `ocm-e2e3-exec` | 1 plugin: `plugin/notify.js` + `mcp.json` (+ a second `plugin/other.js` to add mid-round) | trust |
| **MP-C** local `~/ocm-e2e3/local-mp` | copy of `template/` | local source, relative paths |
| **MP-D** `ocm-e2e3-big` | 10 plugins, rich manifests (`extensions.dev.wntic.ocm` category/tags), distinct plugin names | search, scale, explicit |
| **MP-E** local `~/ocm-e2e3/broken-mp` | the validate defect matrix, incl. the two new rows (duplicate `plugins[]`, cross-plugin basename clash) | validate |
| **MP-F** `ocm-e2e3-collide` | ships a plugin name MP-D also ships, **plus** a second colliding name | collisions |
| **MP-G** local `~/ocm-e2e3/nomanifest-mp` | 2 plugins, **no** `plugin.json` | spec 19 refusal |
| **MP-H** local `~/ocm-e2e3/legacy-mp` | 1 plugin without `plugin.json`, to be **grandfathered** via a pre-seeded registry | spec 19 rule 4 |

Sanity before starting: `cd template && ocm validate` → **zero findings**
(spec 19 requires it).

### S3. Capture discipline

Round 2 needed stream separation to find F2. Keep it:

```bash
run() { echo "\$ $*"; "$@" >$OCM_T/out.txt 2>$OCM_T/err.txt; echo "exit=$?";
        echo "--stdout--"; cat $OCM_T/out.txt; echo "--stderr--"; cat $OCM_T/err.txt; }
```

Use `run ocm …` for anything in Part A §6 (stream discipline) and for
every exit-code assertion. For TTY-only behaviour (colour, prompts,
SIGINT) use `script`/`expect`, not a pipe.

---

# Part A — Regression gate (one step per fixed finding)

Work through this first; it is fast and it is what "fixed" means.
Each row names the finding, the spec section, and the check. Mark
**closed / still open / new defect**.

## A1 — Trust flow (spec 16) · F5, F13, F18, F19, F57, F58, F59

1. **F5 — SIGINT at the trust prompt.** `ocm add <MP-B>` in a real tty;
   press Ctrl+C at the trust prompt.
   Expect: a block naming what stands on disk and what was not done,
   **exit 130**, `~/.config/opencode/plugins/ocm-loader.js` **present**,
   `tui.json` present, `ocm doctor` clean, trust undecided.
   Then: `ocm remove <mp>` as the block suggests — it works.
2. **F5b — SIGINT during update's re-prompt.** Change `notify.js`
   upstream, `ocm update`, Ctrl+C at the re-prompt → same shape; the
   update's applied part is described; exit 130.
3. **F18 — `--yes`.** `ocm trust <mp> --yes </dev/null` → grants,
   components linked, exit 0. Re-run → `already trusted`, exit 0.
   `ocm trust <mp> </dev/null` (no flag) → **exit 1**, message names
   `--yes`, trust unchanged.
   `ocm trust <mp-with-no-code> --yes` → `nothing to trust`, exit 0.
4. **F13a — no nagging.** With trust undecided and nothing new upstream,
   run `ocm update` three times. Expect: **one reminder line** each
   (`trust pending for "…" (N executable components blocked) — run ocm
   trust …`), never the full risk block, never a prompt, no hang
   non-interactively.
5. **F13b — per-component decline.** Trust MP-B (2 executable
   components). Change only `notify.js` upstream. `ocm update` →
   re-prompt → answer **N**.
   Expect: `notify.js` blocked and unlinked; the untouched MCP server
   **keeps running**; a second `ocm update` prints neither block nor
   prompt (the decline is recorded per component).
6. **F57 — the decline states the cost.** In step 5 the report must say
   `notify.js was running under the previous grant and is now blocked`.
   A decline that blocks nothing previously-running says nothing extra.
7. **F58 — `--trust` is not blind.** `ocm add <MP-B> --trust` → the full
   component listing (type, plugin, path, command line) prints **before**
   the grant.
8. **F19 — MCP hint.** Deny trust on MP-B; the MCP warning must end with
   `— run ocm trust <mp> to approve`, same as the JS warning.
9. **F59 — `skip` documented.** `grep -n "skip" README.md` → the trust
   section explains y / N / skip and what each means for blocked
   components.

## A2 — Add integrity (spec 17) · F7, F23, F31, F45, F54, F55

1. **F7 — relative path.** `cd $HOME && ocm add ocm-e2e3/local-mp`
   (relative). Expect: registry holds an **absolute** path; every
   symlink resolves (`readlink -f`); `opencode debug config` sees the
   commands; `cd /tmp && ocm update` succeeds.
   Then add the same marketplace by its absolute spelling in a fresh
   home and **diff the two registries** — identical but for timestamps.
2. **F7b — `ocm add .`** from inside MP-C works.
   **F7c —** add a **symlinked** marketplace directory; registry stores
   the realpath; moving the symlink does not orphan the install.
3. **F54 — name limits.** Fixture with a 200-char command file name →
   one ocm-style error naming the offender and the limit, exit 1, and a
   **byte-compare of the whole home before/after** shows zero writes.
   Same for a >64-char plugin name and marketplace name.
4. **F54b — limit hit during update.** Upstream adds an over-long
   component name → that plugin is skipped with the named-limit warning;
   the rest of the update proceeds.
5. **F31 — private repo, tty.** `ocm add https://github.com/<private>`
   under `script`/`expect`. Expect: fails **in under 2 s** with
   `cannot access … private, unreachable, or the URL is wrong`, no
   username prompt, no clone directory left.
   Check `GIT_SSH_COMMAND` is respected when the user already set one.
6. **F45/F23 — provenance at add.** After `ocm add <url>` and after
   `ocm add <url> --ref v1.0.0`: `revision` non-null, `lastSync.ok`
   true immediately (`ocm list --all`, `ocm info`).
   Then `ocm search zzznope` → **no** "sync is stale or failed" hint.
   Same for a **local** marketplace (hint must never fire while its
   directory exists) — and it **does** fire when the directory is moved
   away.
7. **F55 — input shaping.** Each of these gives a clear, specific error
   or works: `ocm add "~/ocm-e2e3/local-mp"` (quoted tilde → works),
   `ocm add "  ~/ocm-e2e3/local-mp  "` (whitespace → works),
   `ocm add wntic/some-repo` (shorthand → URL hint),
   `ocm add ""`, `ocm add /nope`.

## A3 — Collisions & scan (spec 18) · F10, F14, F25, F32, F38, F39, F56

1. **F10a — refusal.** MP-D added; `ocm install <colliding>@MP-F` →
   **exit 1**, message names **both** marketplaces and the conflicting
   paths on both sides; nothing materialized; registry byte-identical.
2. **F10b — takeover.** Same with `--force` → incumbent's plugin
   disabled and unlinked, newcomer installed, report says
   `took over "<name>" from marketplace "<mp>"`. Re-run → `already
   installed`, no second takeover, no warnings.
3. **F10c — no silent flip.** After an explicit install (forced or not),
   `ocm update <mp>` must **not** flip `enabled` to false; a collision is
   reported as a line with the `--force` suggestion, not acted on.
   Check the registry `enabled` before/after.
4. **F56 — all colliding plugins named.** `ocm add <MP-F>` while MP-D
   holds both names → refusal lists **both**, each with paths (cap 10 +
   `… and N more` — build an 11-collision fixture if you want that half).
5. **F32 — doctor sees collisions.** With a collision recorded:
   `ocm doctor` prints the finding, exits non-zero, `--fix` changes
   nothing. Uninstall the disabled plugin → doctor still reports the
   record.
6. **F14 — scan truthfulness.** `ocm scan <uninstalled-plugin>@<mp>` →
   every component `would create`, executable ones annotated
   `(trust-gated)` (F39), **zero** `collision:` lines. Then `ocm install`
   the same plugin without `--force` → succeeds (proves there was none).
   Scan an **installed** plugin → `already linked` for each component.
   Scan a plugin whose destination holds a hand-written file →
   collision, the foreign file named.
7. **F38 — scan on an empty dir** → layout hint + validate/README
   pointer.
8. **F25 — validate's two new rows.** MP-E: duplicate `plugins[]` name →
   error naming the file and the ignored second entry; two plugins
   shipping the same command basename → error naming both plugins and
   the shared target. Both in one run (non-fail-fast).

## A4 — Mandatory manifests (spec 19) · U4, F48

1. `ocm add <MP-G>` (2 plugins, no manifests) → refusal listing **every**
   manifest-less plugin with its missing file path, the minimal-content
   hint, exit 1, **zero writes** (byte-compare the home).
2. Author the two `plugin.json` files → the same add now succeeds, and
   `ocm search <a word from the description>` finds the plugin.
3. `ocm validate` on MP-G → one error per missing manifest **plus** a
   copy-pasteable stub for the first.
4. `description: ""` → its own error. `name` ≠ directory → its own error.
   Malformed `plugin.json` → malformed error, **never** "missing".
5. Upstream adds a new manifest-less plugin → `ocm update` refuses that
   plugin, reports it, and updates its siblings normally.
6. **Grandfathering.** MP-H: pre-seed a registry with the manifest-less
   plugin installed (pre-spec state). Then:
   `ocm update` keeps it enabled; `ocm doctor` reports
   `legacy: "<plugin>" has no plugin.json …` **once**, and that warning
   is exit-code-neutral; opencode still resolves its components.
   Then change that plugin upstream → update now refuses it (the
   grandfather ends when the plugin changes). Confirm the message says
   why.
7. `template/` and the README: every plugin example carries
   `plugin.json` **with `$schema`** (F48). `cd template && ocm validate`
   → zero findings.

## A5 — Doctor & config safety (spec 20) · F1, F8, F26, F27, F28, F29, F30, F46, F52

1. **F1.** Fresh home, never initialized: `ocm doctor` → **exactly one**
   line (`ocm is not installed here — run ocm init`), exit 1.
   `ocm doctor --fix` → same one line; it must **not** silently init.
2. **F8 — the invariant.** Reproduce the chain: loader sync pulls a new
   `plugin/other.js` (trust-pending) → `ocm trust <mp> --yes` →
   `ocm doctor --fix`.
   Expect: **removes nothing**, exit 0, and the registry's
   `trust.components`, the per-plugin `components` record and disk all
   agree. Re-check after a plain `ocm update` too.
   Then force the disagreement by hand (edit the per-plugin record) →
   doctor reports `registry records are stale — run ocm update` instead
   of deleting.
3. **F26 — single-dash stray.** Drop `~/.config/opencode/plugins/ocm-stray.js`
   → doctor **warns** (naming that opencode loads it every start);
   `--fix` leaves the file in place. Confirm with `opencode debug config`
   that it is indeed loaded.
4. **F30 — orphan sweep.** `ocm loader uninstall` then `ocm init` (the
   registry is gone, links survive) → doctor reports each orphaned
   `ocm--…` link and skill mirror; `--fix` removes them **and** the
   `skills.paths` entry; a hand-written neighbour file in the same
   directory survives.
5. **F27 — `--fix` re-clones.** `rm -rf ~/.cache/ocm/marketplaces/<mp>`
   → `ocm doctor --fix` re-clones and re-materializes, exit 0 after the
   fix. (Round 2: it removed links and told you to run another command.)
6. **F46 — local marketplace remedy.** Move a local marketplace's
   directory away → doctor says restore-or-`ocm remove`, never "update
   re-clones"; `--fix` refuses to invent a clone.
7. **F28 — corrupt config.** Make `opencode.json` invalid JSON, then
   `ocm add <MP-A>`: **one** warning (not two), the exact JSON edit to
   make by hand printed, and the report states
   `skills.paths NOT written …` instead of counting the skill installed.
   Config byte-identical afterwards.
8. **F29 — read-only config.** `chmod 444 ~/.config/opencode/opencode.json`,
   then try `ocm install`, `ocm uninstall`, `ocm add`, `ocm remove`,
   `ocm update`. Each: refused **pre-flight** with the chmod hint, exit
   non-zero, registry **and** config byte-identical (no partial state).
   Repeat with a read-only `tui.json`.
9. **F52 — documented.** README's config-safety section states the
   2-space re-serialization plainly.

## A6 — Displaced originals (spec 21) · F9

1. Hand-write `~/.config/opencode/commands/<plugin>:greet.md`; remember
   its checksum.
2. `ocm install <plugin> --force` → report names the displacement and
   the cache path at the moment it happens.
3. `ocm remove <mp>` → the file is **restored byte-identical** to its
   original path, one report line says so, and the cache copy still
   exists (restore is a copy-back).
4. Occupied-target variant: before removing, re-create a *different*
   file at that path → no restore, the cache path is reported, your file
   intact.
5. `ocm uninstall <plugin>` (not the whole marketplace) → same restore
   behaviour.
6. Teardown with **no** displaced files → output unchanged, no noise.
7. `ocm doctor` with a live displacement → one informational line
   counting them; with an orphaned pre-spec displacement directory →
   reported with its path, never auto-deleted.
8. Idempotence: remove → restore → re-add → `--force` again → remove
   again; the same restore happens.

## A7 — Truthful reports (spec 23) · F2, F3, F11, F12, F16, F21, F33–F37, F42, round-1 #3

Use `run` (separated streams) for all of these.

1. **F2 — streams.** `ocm init`, `ocm add`, `ocm update`, `ocm install`:
   success lines and data on **stdout**; only warnings/errors on stderr.
   On a real tty (`script`) confirm no success line renders red.
2. **F3 — loader lines.** First `ocm init` → `installed auto-sync
   loader …`; re-run → `already current` (or nothing on a no-op update),
   never an unconditional "installed".
3. **F11 — no-ops.** Second `ocm install x` → `already installed`, exit
   0, **no** restart notice, no file list. Second `ocm uninstall x` →
   `not installed`. Same for `enable`/`disable`.
4. **F12 — explicit label.** Explicit-mode marketplace, new upstream
   plugin, `ocm update` → `available — ocm install <name> to activate`,
   **no** `+` file list, registry `enabled: false`.
5. **F16 / round-1 #3 — restart notice.** It prints for: a
   removal-only update, a skill-only install, a plugin uninstall. It
   does **not** print for a true no-op.
6. **F36 — ordering.** `add`, `uninstall`, `install`, `update` all print
   the headline **before** the restart notice.
7. **F21 — trust block placement.** With a pending trust change, the
   combined tty output reads: `updating <mp>…` header → trust block →
   report. Verify under `script` (combined stream), not two pipes.
8. **F35 — noise budget.** With an untrusted marketplace present, run an
   unrelated `ocm install`: exactly **one** blocked-components line per
   affected marketplace, printed once; no `0 created, 0 removed, 0
   skipped`; re-clone/"directory missing" events on **stdout**.
9. **F37.** Explicit-mode add ends with `N plugins available — ocm
   install <name> to activate`.
10. **F42.** `ocm update <plugin>@<mp>` — either the report is scoped to
    that plugin, or the form is gone from `ocm help`. Both are
    acceptable; a form that silently behaves as another is not.
11. **F33/F34.** `ocm --version` and `ocm -v` → semver, exit 0; `ocm help`
    mentions it and leads with `ocm add`.

## A8 — Validate hardening (spec 24) · F24, F49, F50, F51

1. `cd /tmp && ocm validate` → `not an ocm marketplace directory …`,
   exit 1, nothing else.
2. `cd <marketplace>/plugins/<p> && ocm validate` → pointer line
   `validating <root>` + normal findings.
3. A marketplace with `plugins/` but zero plugins → zero findings,
   exit 0.
4. `mcpServers: "../other/mcp.json"` → the **containment** message; the
   string "is not a JSON object" must not appear anywhere in the output.
5. Malformed `plugin.json` → `not valid JSON — fix it or remove it …`;
   malformed `marketplace.json` → warning ending `the entries below were
   not applied`.
6. **Documented-contract check:** pick five validate error strings at
   random and grep the README for the rule each states (spec 24 §3's
   invariant). Any rule not in the README is a finding.
7. README has the two new authoring subsections (command frontmatter;
   `extensions` category/tags) with a worked example.

## A9 — Display (spec 25) · F15, F17, F20, F43, F44, F47, F60

1. **F15.** Deny trust → `ocm list` marks the executable lines
   `(blocked — ocm trust <mp>)`; `--json` unchanged.
2. **F20.** Seed trust-pending via a loader sync → `ocm list` shows
   `(1 component awaiting trust)`; `--all` and `ocm info` list the
   pending components with the hint; `ocm doctor` errors on it.
3. **F17.** `ocm info` on a disabled/blocked plugin → `(not linked)` for
   absent targets; **no** arrows to nonexistent files. The trust line
   reads `granted` / `code changed since trust — run ocm trust <mp>` /
   `denied` matching reality — especially right after a declined
   re-trust.
4. **F43.** A plugin auto-installed by an update has `installedAt` = the
   update's time, not the marketplace's `addedAt`. An old registry with
   no `installedAt` → `info` omits the line rather than inventing one.
5. **F44.** `ocm list` shows `(pinned @ v1.0.0)` on a pinned marketplace.
6. **F44b — pin picker (new).** `ocm pin <mp>` with no ref, interactive:
   lists remote heads and tags, prompts, records the choice.
   Non-interactive with no ref: error **listing the available refs**, no
   hang (git prompt flags from spec 17 apply).
7. **F47.** `ocm search notify` (plugin JS), `ocm search everything`
   (MCP server) → results with `matched: plugin notify.js` /
   `matched: mcp everything`. A term matching both a plugin name and its
   MCP server → one result carrying both annotations.
8. **F60.** `ocm list --all` shows `synced 2h ago` / `never synced` /
   `sync failed 5m ago`; plain `ocm list` shows a failure marker
   (`! sync failed …`) but stays silent about mere age.

## A10 — Update hygiene (spec 26) · F22, F40, F41

1. **F22.** Create an untracked file **and** modify a tracked file inside
   `~/.cache/ocm/marketplaces/<mp>`. `ocm update` → one warning naming
   what was discarded; both are actually gone afterwards
   (`git status --porcelain` empty). Second update → **silent**.
   A clean clone → no `local changes` line at all.
2. **F40.** README has the background-sync paragraph (short-lived
   `opencode run`/`debug` may exit before the fetch; `ocm update` is
   deterministic). Verify the behaviour matches the paragraph:
   `opencode debug config` then immediately `ocm list --all` → lastSync
   may be unchanged, and that is documented.
3. **F41 (wontfix).** A no-op `ocm update` still advances `lastSync.at`
   — confirm it is the *only* change (diff the registry JSON).

## A11 — TUI fixes (spec 22) · F4, F61, F62, F63

Live TUI, real terminal. Run each at **80×24** and again at ~200×50.

1. **F4 — the empty-state route.** Fresh home + `ocm init` only. `/ocm`
   → the empty-state alert → **Enter** → the "Add marketplace" prompt
   appears → paste MP-C's path → the add runs, including its trust
   prompt → restart notice. This route was completely dead in round 2.
2. **F61 — sizing and scrolling.** Open a plugin-details view with many
   skills at 80×24: everything reachable by ↑/↓ (and j/k), a position
   indicator or scrollbar is visible, the action row stays fixed, and
   the uninstall button's help text is **fully readable** (no mid-
   sentence clip). Repeat at 200×50 — the dialog grows. Resize the
   terminal with a dialog open, then open a new dialog → correct size.
   At <40 columns → floor width, content wraps, nothing renders outside
   the terminal.
3. **F62 — back navigation.** Escape walks the stack one level at a
   time: details → plugin list → marketplace list → root → closes.
   Lists keep selection and scroll position on return. The details view
   shows a visible `← back`. In a text input, Escape clears first, then
   navigates back. Ctrl+C still aborts.
   **No view opened from `/ocm` may be a dead end** — visit every view
   and try to leave it.
4. **F63 — versions and pins.** A pinned marketplace's row reads
   `… (auto, pinned @ v1.0.0)`; its detail view shows the pin (or `not
   pinned`) and the current revision; the plugin detail view shows the
   version matching `ocm info`.

---

# Part B — Functional re-run under the new contract

Round 2 verified most of this, but 11 specs changed the surface. Re-run
these with the **new** expectations; they are where a regression would
hide.

## B1 — The main loop, end to end

1. Fresh home. `ocm add <MP-A>` → trust (no code here) → restart notice
   → **headline last-checked ordering (A7.6)**.
2. Start opencode in an unrelated directory. Verify: `/` autocomplete
   shows the namespaced commands; the agent picker lists
   `<plugin>:<agent>`; `/skills` lists `<plugin>:<skill>`; a skill
   actually loads via the `skill` tool; zero plugin-load errors in the
   log.
3. Add one command + one agent + one skill upstream, push, `ocm update`.
   Confirm **in the running session** that nothing changed, and that the
   tool said so.
4. Restart → all three present and working.
5. Delete the skill upstream, `ocm update` → removal reported **with the
   restart notice** (F16) → restart → gone from `/skills` and from
   `skills.paths`; `ocm doctor` clean.
6. Repeat 3–5 driving everything from `/ocm` instead of the CLI.

## B2 — Install granularity

1. MP-D (10 plugins, auto): uninstall three → only their components go;
   the other seven byte-identical.
2. Re-install offline (network down) → instant.
3. Every verb twice → no-op wording (A7.3).
4. `enable`/`disable` behave as install/uninstall.
5. Explicit mode: add → nothing materialized → install one → upstream
   new plugin → `available` label (A7.4) → `ocm mode <mp> auto` → next
   new plugin installs → an `uninstall` does **not** flip the mode.

## B3 — Trust, full matrix (post-spec-16)

1. First-sight prompt quality (per-component paths/command lines, shell
   warning, review path, default N) — unchanged and still good.
2. Deny → stuff installs, code blocked, list/info/search all mark it
   (A9.1).
3. Grant later with `ocm trust` (interactive) and with `--yes`.
4. Changed JS → re-prompt; changed MCP `command` → re-prompt; key
   reorder in `mcp.json` → **no** prompt; skill-only edit → **no**
   prompt; new `plugin/other.js` in a previously code-free marketplace →
   first-sight prompt.
5. `ocm untrust` → executable components unlinked immediately, stuff
   stays, and the display surfaces agree.
6. Loader startup sync with new executable code → never materialized,
   `trustPending` recorded **and now visible** (A9.2).

## B4 — Update mechanics

Revision transitions; per-plugin version changes; `+ ~ -` file lists;
`--quiet`; `--json` validity; scoped update forms; renames
(rename / null-drop / plain-delete / chain / cycle); pinning
(fetch-before-save, tag-following, deleted-ref isolation, `--clear`,
`add --ref`); failure isolation across three marketplaces with one
broken; recovery. All previously green — confirm none regressed under
the new reporting and cache-cleaning code.

## B5 — Discovery surfaces

Search ranking and `matched:` annotations (now including JS/MCP);
`(disabled)`/`(blocked)` markers; offline search with the clone deleted;
`ocm info` field-by-field including the new trust/link truth; `ocm list`
readability at 80 columns with 25+ plugins.

## B6 — Layout & interop

Spec 15 manifest-location cases (six); `mcpServers` base resolution and
the new containment message; `.claude` siblings ignored; Agent Plugins
`mcp.json` translation (stdio→local, http/sse→remote) and the
fingerprint over the **translated** servers; `extensions.dev.wntic.ocm`
category/tags used by search and TUI, top-level form still read with a
warning.

## B7 — Teardown & migration

`ocm remove` leaves zero traces (grep `ocm--` in configs, links, skills
paths, registry, clone) **and now restores displaced originals** (A6);
local directories never deleted; user keys byte-identical; migration
v1→v2 idempotent with the old→new skill mapping printed.

---

# Part C — Seams between the fixes (highest-yield new hunting)

These are places where two round-3 changes can disagree. Nothing here
was possible to test before this round.

## C1 — Loader-before-prompt vs read-only config

Spec 16 §1 installs the loader **before** the trust prompt; spec 20 §5
refuses any mutation pre-flight when `opencode.json`/`tui.json` is
read-only.

1. `chmod 444 tui.json`, then `ocm add <MP-B>` (has executable code).
   Expect: refusal **before** anything is written — including before the
   loader install and before the prompt. No partial state, no prompt
   shown after a refusal.
2. `chmod 444` only `opencode.json` (tui writable) → same single
   refusal, not a half-install with a loader present.

## C2 — SIGINT vs displaced originals vs takeover

1. `ocm install <colliding> --force` displacing a hand-written file;
   Ctrl+C **during** the operation (use `expect` timing around the
   prompt if one appears).
   Expect: either the displacement did not happen, or it happened and is
   reported/recoverable — never a file that is gone with nothing
   recorded. Check `~/.cache/ocm/displaced/` and the registry.
2. Take over from another marketplace (marketplace-to-marketplace, no
   user file involved) → **no** displacement lines printed (spec 21 edge
   table), and `ocm remove` of either marketplace prints nothing about
   displacements.

## C3 — Doctor's safety net vs the orphan sweep

Spec 20 §2 says a trust-approved link is never "stray"; §3 says an
unowned `ocm--` link is an orphan `--fix` removes. Construct the
ambiguous case:

1. Trust a component, then remove its marketplace's registry record by
   hand (simulating the F30 state) → is the link an orphan (removable)
   or protected? Whatever doctor decides, it must **say which rule
   applied**, and `--fix` must not destroy a file it called protected
   one line earlier.
2. Stale per-plugin records + a real orphan in the same home → doctor
   must report both distinctly, and `--fix` must remove only the orphan.

## C4 — Mandatory manifests vs grandfathering vs collisions

1. A grandfathered (manifest-less) plugin whose name **collides** with a
   new marketplace's plugin → what does add/install/doctor say? The
   collision message must still name both sides; the legacy warning must
   still appear; neither should suppress the other.
2. A grandfathered plugin is renamed upstream via `renames` **without**
   gaining a manifest → rename applies? refused? The report must state
   which, and the registry must not end up with both records.

## C5 — Per-component trust decline vs update reporting

1. Decline `notify.js` (A1.5), then upstream **reverts** `notify.js` to
   exactly the previously-trusted content. Does the old grant apply
   again (fingerprint matches) without a prompt, or does the recorded
   decline stick? Either is defensible — the output must make it
   unambiguous, and `ocm info`'s trust line must match what is on disk.
2. Decline a component, then `ocm untrust` + `ocm trust --yes` → the
   declined component's state resets cleanly, no stale per-component
   record.

## C6 — Restart-notice rule vs no-op rule

Spec 23 §3 says no-ops report no-ops; §5 says the notice prints when
anything was created *or* removed. Find the boundary:

1. `ocm install x` where x is enabled but its links were deleted by hand
   → it re-creates links: is that a no-op ("already installed") or a
   repair (with the notice)? The right answer is the repair, reported as
   such; a bare `already installed` while it silently relinked is a
   finding.
2. `ocm update` that only cleans a dirty cache (spec 26) and changes no
   component → no restart notice, one cleaning warning.

## C7 — Provenance at add vs failure isolation

1. Add a marketplace whose clone succeeds but whose discovery then fails
   (e.g. one plugin over the name limit, spec 17 §2) → the atomicity
   rule wins: no registry entry, no `revision` recorded, no clone left.
2. `ocm add --ref <tag>` where the tag exists but the clone is shallow →
   `revision` is the tag's tip, not the default branch's.

---

# Part D — Unvisited surface

## D1 — Live in-session usage (round 2's "left for user" list)

1. Run `/demo-kit:tdd` with arguments; confirm `$ARGUMENTS`, `$1`, `!`
   shell blocks and `@` file references all behave.
2. `echo $OCM_PLUGIN_ROOT` and `$CLAUDE_PLUGIN_ROOT` inside a command's
   `!` block → both point at the marketplace root; a command invoking
   `"${OCM_PLUGIN_ROOT}/plugins/<p>/scripts/x.sh"` runs.
3. Use an installed agent for a real turn; use an installed skill via
   model invocation (not the picker) — does the description make the
   model pick it?
4. With 25+ installed commands, judge `/` autocomplete usability; note
   the MCP prompt naming (`/ocm--<p>--<s>:prompt:mcp`) — by design, but
   record if it reads badly at scale.
5. Confirm project `.opencode/` still beats an ocm-installed component
   of the same name.

## D2 — Upgrade in place (never tested)

The most realistic user path, and untested end to end.

1. Install the **published v0.2.0** globally into a fresh home; add MP-A
   and MP-B; trust; use them.
2. Upgrade to current (`bun install -g .`).
3. First `ocm` command → migration output; nothing lost; `ocm doctor`
   clean; opencode still resolves everything.
4. Specifically check the spec-19 boundary: a v0.2-era marketplace whose
   plugins have no `plugin.json` must be **grandfathered**, not bricked
   (A4.6) — this is the upgrade story for every early adopter.
5. Downgrade attempt (install v0.2.0 over a v0.5 home) → does it fail
   loudly or corrupt? Record the behaviour; a registry-version guard is
   the expected shape.

## D3 — Concurrency and interruption

1. Two `ocm update` processes at once (same home) → no corrupted
   registry; the loser either waits or fails cleanly. Check the JSON
   parses and every marketplace record survives.
2. `ocm add` in one terminal while opencode's loader sync runs in
   another → same.
3. `kill -9` an `ocm install` mid-run → next command recovers or reports
   cleanly; no half-written registry (the atomic-write claim).
4. Run `ocm update` while opencode is running, then check that the
   running session is unaffected and the next start is current.

## D4 — Environment edges

1. A path with spaces (`~/ocm e2e/local mp`) → add, install, update,
   remove all work; symlink targets are correct.
2. Unicode in plugin descriptions and skill bodies → renders in list,
   search, info and the TUI without breaking layout.
3. `$HOME` that is itself a symlink → registry and links stay valid.
4. Case-insensitive filesystem: two plugins differing only in case →
   detected as a collision or refused, not silently merged.
5. `OPENCODE_PURE=1` → `/ocm` absent, ocm's JS plugins not loaded,
   everything else intact.
6. `XDG_CONFIG_HOME` set to a non-default location → does ocm follow it?
   Record the answer either way; the README should state it.
7. No `git` on PATH → every command that needs git fails with an
   ocm-style error (doctor's first check).
8. Full disk / unwritable `~/.cache` → clean error, no partial state.

## D5 — Scale

1. 5 marketplaces, ~40 plugins: time `ocm list`, `ocm search`, `/ocm` →
   Browse; opencode startup with all syncing (`OCM_SYNC_INTERVAL_MS=0`).
2. A single plugin with 30 skills → `ocm info`, the TUI details view
   (scrolling, A11.2) and `/skills` all stay usable.
3. A marketplace with 50 plugins → add/refusal messages cap correctly
   (`… and N more`), list output stays readable.

## D6 — Author experience, timed

1. From a clean machine and the README only, author a marketplace with
   one plugin carrying a command, an agent and a skill; publish it;
   install it; use it. **Time each stage and note every hesitation.**
2. Break it deliberately in three ways and see whether `ocm validate`
   explains each well enough to fix without reading the specs.
3. Confirm the round-2 docs gaps are closed: `$schema` in every example
   (F48), command frontmatter and `extensions` documented (F49), trust
   answers documented (F59), background sync documented (F40),
   config re-serialization documented (F52).

---

# Cross-cutting invariants — assert after every suite

Run this block as a script at the end of each suite; any hit is a
finding regardless of which test produced it.

```bash
# 1. never writes outside its own namespaces
ls -la $H/.claude $H/.agents 2>&1 | grep -v "No such file" && echo "VIOLATION"
# 2. only ocm-loader.js in plugins/ (plus ocm-- links)
ls $H/.config/opencode/plugins
# 3. no broken symlinks anywhere ocm owns
find $H/.config/opencode/{commands,agents,plugins} -type l ! -exec test -e {} \; -print
# 4. configs parse
for f in opencode.json tui.json; do jq . $H/.config/opencode/$f >/dev/null || echo "BAD $f"; done
# 5. user keys survive
diff <(jq 'del(.mcp|keys[]|select(startswith("ocm--")))|del(.skills)' $H/.config/opencode/opencode.json) $OCM_T/user-config-baseline.json
# 6. doctor agrees
HOME=$H ocm doctor; echo "doctor exit=$?"
```

Plus, by eye:

- **Exit codes:** 0 only on success; 1 on refusal/error; 130 on SIGINT.
- **Streams:** no success line on stderr; no warning on stdout.
- **Every printed line states a true fact** (spec 23's rule) — the
  single most productive lens in round 2.

---

# Findings log template

```
## F<n> — <one-line title>   (area: CLI|TUI|loader|docs, severity: high|med|low)

Test:        Part X / <test id>, step K
ocm version: <ocm --version>
Command:     <exact command or keystrokes>
Expected:    <spec section + what it promises>
Actual:      <verbatim output, both streams, exit code>
Impact:      <what a real user concludes>
Spec ref:    docs/specs/NN-xxx.md §N
Regression?: <was this green in round 2 — cite the finding or "Verified good" bullet>
```

## Round-2 closure scoreboard

Fill this in as Part A completes; it is the deliverable of this round.

| Finding | Spec | Verified by | Verdict |
|---|---|---|---|
| F1 | 20 §1 | A5.1 | closed |
| F2 | 23 §1 | A7.1 | closed |
| F3 | 23 §2 | A7.2 | closed |
| F4 | 22 §1 | A11.1 | closed (user TUI pass) |
| F5 | 16 §1 | A1.1–A1.2 | closed |
| F7 | 17 §1 | A2.1–A2.2 | closed |
| F8 | 20 §2 | A5.2 | closed (new: F85, F86) |
| F9 | 21 | A6 | closed |
| F10 | 18 §1 | A3.1–A3.3 | closed |
| F11 | 23 §3 | A7.3 | closed |
| F12 | 23 §4 | A7.4 | closed |
| F13 | 16 §3 | A1.4–A1.5 | closed (new: F91) |
| F14 | 18 §4 | A3.6 | closed |
| F15 | 25 §1 | A9.1 | closed (new: F78 narrows the marker) |
| F16 | 23 §5 | A7.5 | closed (new: F102 at the edges) |
| F17 | 25 §3 | A9.3 | closed |
| F18 | 16 §2 | A1.3 | closed |
| F19 | 16 §4 | A1.8 | closed |
| F20 | 25 §2 | A9.2 | closed |
| F21 | 23 §6 | A7.7 | closed |
| F22 | 26 §1 | A10.1 | closed (new: F99) |
| F23 | 17 §4 | A2.6 | closed |
| F24 | 24 §1 | A8.1 | closed |
| F25 | 18 §6 | A3.8 | closed |
| F26 | 20 §3 | A5.3 | closed |
| F27 | 20 §4 | A5.5 | closed (new: F97) |
| F28 | 20 §5 | A5.7 | closed |
| F29 | 20 §5 | A5.8 | partial — opencode.json closed; tui.json only guards add/update (F95) |
| F30 | 20 §3 | A5.4 | closed (new: F80 one layout over) |
| F31 | 17 §3 | A2.5 | closed |
| F32 | 18 §3 | A3.5 | closed (new: F70, F92) |
| F33 | 23 §9 | A7.11 | closed |
| F34 | 23 §10 | A7.11 | closed |
| F35 | 23 §7 | A7.8 | open, narrowed — zero lines for unrelated mutations (F100) |
| F36 | 23 §6 | A7.6 | closed |
| F37 | 23 §8 | A7.9 | closed |
| F38 | 18 §5 | A3.7 | closed |
| F39 | 18 §4 | A3.6 | closed |
| F40 | 26 §2 | A10.2 | closed |
| F42 | 23 §8 | A7.10 | open, narrowed — scoped update skips others' materialization (F88, F101) |
| F43 | 25 §4 | A9.4 | closed |
| F44 | 25 §5 | A9.5–A9.6 | closed |
| F45 | 17 §4 | A2.6 | closed |
| F46 | 20 §3 | A5.6 | closed |
| F47 | 25 §7 | A9.7 | closed (new: F122) |
| F48 | 19 | A4.7 | closed |
| F49 | 24 §3 | A8.7 | closed |
| F50 | 24 §2 | A8.4 | closed |
| F51 | 24 §2 | A8.5 | closed |
| F54 | 17 §2 | A2.3–A2.4 | closed (new: F69) |
| F55 | 17 §5 | A2.7 | closed |
| F56 | 18 §2 | A3.4 | closed |
| F57 | 16 §4 | A1.6 | closed |
| F58 | 16 §4 | A1.7 | open, narrowed — string-form command blank (F68) |
| F59 | 16 §4 | A1.9 | closed |
| F60 | 25 §6 | A9.8 | closed |
| F61 | 22 §2 | A11.2 | FAILED (user TUI pass) — scrolling ok, rows truncate at 80 cols (F124) |
| F62 | 22 §3 | A11.3 | closed (user TUI pass; double-Esc = one layer per view, by design) |
| F63 | 22 §4 | A11.4 | closed (user TUI pass) |
| round-1 #3 | 23 §5 | A7.5 | closed |
| U4 / mandatory manifests | 19 | A4 | closed with new boundary holes (F71–F73, F75) |
| F41, F52 (wontfix) | 26 §3, 20 §5 | A10.3, A5.9 | confirmed documented, not fixed |

Verdicts are backed by the agent logs in `docs/e2e-round3/`; new
findings and narrowed re-opens are in [the round-3 findings
file](./e2e-findings-round3.md) (F64–F123).
