# Manual E2E test plan — ocm

> **Brief paths in this document** (`docs/specs/NN-…`) refer to briefs that
> are no longer in the repository: they live untracked in `.work/briefs/`,
> and in git history up to the commit that removed them. See
> [project.md](./project.md).


Purpose: find the problems agents cannot find — wording, ordering, surprise,
missing feedback, and anything that only shows up when a human sits in front
of the opencode TUI and tries to *use* a plugin.

Automated tests cover the data. **You are testing the experience.** After
every step ask the three questions:

1. Did it tell me what happened, in words I could act on?
2. Did what I typed do what I expected — and could I tell it worked?
3. If it failed, do I know what to do next?

Log findings as you go using the template at the bottom.

---

## Setup

### S0. Environment

```bash
opencode --version        # record it
ocm --version 2>/dev/null || bun --version
git --version
```

### S1. Isolated home (recommended)

Run every destructive scenario against a throwaway `$HOME` so your real
config is never at risk, and so "fresh machine" is reproducible:

```bash
export OCM_TEST_HOME=/tmp/ocm-e2e/home-$(date +%s)
mkdir -p "$OCM_TEST_HOME"
alias ocmt='HOME=$OCM_TEST_HOME ocm'
alias opencodet='HOME=$OCM_TEST_HOME opencode'
```

Anywhere below that says `ocm` / `opencode`, use `ocmt` / `opencodet` unless
the test explicitly says "real home".

Reset between suites: `rm -rf "$OCM_TEST_HOME"` and re-create it.

### S2. Test marketplaces to prepare up front

| Repo | Contents | Used by |
|---|---|---|
| **MP-A** `ocm-e2e-alpha` (GitHub, public) | 2 plugins: `alpha-kit` (command + agent + skill), `alpha-skills` (skill only). `.opencode-plugin/marketplace.json`. | most tests |
| **MP-B** `ocm-e2e-exec` (GitHub) | 1 plugin `exec-kit` with `plugin/notify.js` **and** `mcp.json` | trust, MCP |
| **MP-C** local dir `~/ocm-e2e/local-mp` | copy of `template/` | local-source tests |
| **MP-D** `ocm-e2e-big` (GitHub) | 10 plugins, mixed components, manifest with descriptions/tags/categories | scale, search, explicit mode |
| **MP-E** `ocm-e2e-broken` (local) | deliberately invalid: SKILL.md with no `description`, bad JSON, duplicate command names, empty command body, `plugin/*.js` with wrong export | `ocm validate` |

Seed MP-C from the shipped template:

```bash
mkdir -p ~/ocm-e2e && cp -R template ~/ocm-e2e/local-mp
cd ~/ocm-e2e/local-mp && git init && git add -A && git commit -m init
```

---

# Suite 1 — First contact

## Test 1 — The cold start (nothing installed)

1. Use a brand-new `$HOME`. Do **not** run `ocm add`.
2. `opencode` — start it, then type `/ocm`.
3. Expected: `/ocm` does not exist yet (the TUI plugin is installed by
   `ocm init` / `ocm add`). Note whether that is confusing.
4. Quit. Run `ocm` with no arguments.
5. Expected: help text. Read it as a first-time user: can you tell what to do
   first? Is `ocm add` obviously step one?
6. Run `ocm list`, `ocm search foo`, `ocm doctor`, `ocm info x` against the
   empty install.
7. Expected for each: a useful empty-state message naming the next action, not
   a stack trace, not silence, not a bare non-zero exit.

**Watch for:** any Node/Bun traceback leaking to the user; `doctor` reporting
a missing loader as an error when nothing was ever installed.

## Test 2 — `ocm init` on its own

1. `ocm init`
2. Expected: loader installed, message says where.
3. Inspect: `ls ~/.config/opencode/plugins/` — expect **only** `ocm-loader.js`.
   `ls ~/.config/opencode/ocm/` — core, ui, registry.
4. `cat ~/.config/opencode/tui.json` — exactly one entry `./ocm/ui.js`.
5. `cat ~/.config/opencode/opencode.json` — no junk; no `plugin` array written.
6. Run `ocm init` again. Expected: idempotent, and honest — it should not
   claim to have installed something it did not rewrite (known finding #6).
7. Start `opencode`, type `/`. Expected: `/ocm` appears in autocomplete.
8. `/ocm` with an empty registry → expected: an alert explaining `ocm add`,
   and an in-TUI route to Marketplaces → Add.

**Watch for:** the empty-state dialog being a dead end.

---

# Suite 2 — The main loop (add → use → change → update)

## Test 3 — Add a local marketplace

X
4. `ocm list` — both plugins enabled, executable components shown blocked.
5. `ls -l ~/.config/opencode/commands/` and `agents/` — namespaced names
   (`demo-kit:tdd.md`, `demo-kit:reviewer.md`), symlinks.
6. `cat ~/.config/opencode/opencode.json` — one `skills.paths` entry; **no**
   `ocm--` MCP keys (trust denied).
7. Verify the local directory was **not** modified: `cd ~/ocm-e2e/local-mp &&
   git status` clean, no new files.

## Test 4 — Use what was installed (the core UX test)

1. Start `opencode` in some unrelated project directory (no `.opencode/`).
2. Type `/` → expect `/demo-kit:tdd` and `/release-kit:ship` in autocomplete.
3. Run `/demo-kit:tdd`. Expected: the command template runs; arguments,
   `$ARGUMENTS`, `!` blocks and `@` references behave.
4. Switch agents (Tab / agent picker) → expect `demo-kit:reviewer` listed and
   selectable; use it for one message.
5. `/skills` picker → expect `demo-kit:code-review` and
   `release-kit:release-notes` under their **namespaced** names.
6. Ask the model something that should trigger the skill ("review this diff
   using the code-review skill"). Expect the `skill` tool to load it.
7. Check the opencode log for plugin-load errors: there should be none.
8. Type `/ocm` → Browse → confirm both plugins appear with descriptions and
   marketplace grouping.

**Watch for:** names that read badly in the picker; descriptions truncated;
a skill whose rendered `name:` is double-prefixed
(`demo-kit:demo-kit:code-review` — known observation).

## Test 5 — The change loop (the scenario you asked for)

1. Ensure MP-A is added and opencode restarted at least once.
2. In the MP-A repo, add **one of each**: a new command
   `plugins/alpha-kit/commands/newcmd.md`, a new agent
   `plugins/alpha-kit/agents/newagent.md`, a new skill
   `plugins/alpha-kit/skills/new-skill/SKILL.md`. Commit and push.
3. `ocm update` (or `/ocm` → Update all). Expected report: revision
   `before → after`, per-plugin `+ commands/newcmd.md` etc., and the restart
   notice.
4. **Without restarting**, check the running session: the new command must
   *not* appear. Confirm the tool said so clearly — this is the #1 source of
   "it's broken" reports.
5. Restart opencode. Expected: `/alpha-kit:newcmd`, agent
   `alpha-kit:newagent`, skill `alpha-kit:new-skill` all present and working.
6. Now **delete** the new skill upstream, commit, push.
7. `ocm update`. Expected: it reports the removal (`- skills/new-skill/...`)
   **and** prints the restart notice for a removal-only change (known gap
   candidate, finding U3.1).
8. Restart. Expected: the skill is gone from `/skills` and from
   `skills.paths`.
9. Repeat 6–8 for a deleted command and a deleted agent; verify no broken
   symlinks remain: `ocm doctor`.

## Test 6 — The change loop through the TUI only

Same as Test 5 but never touching the CLI:

1. Push an upstream change.
2. In opencode: `/ocm` → Marketplaces → select MP-A → Update.
3. Expected: busy indicator, then a summary naming what changed, then the
   restart notice.
4. `/ocm` → Update all with two marketplaces added; expect a per-marketplace
   summary (updated / unchanged / failed) with errors listed, not swallowed.
5. Restart and verify.

**Watch for (known U1):** dialog too small, clipped text, long component lists
overflowing with no scroll.

## Test 7 — Auto-sync on startup

1. `ocm list --all` — note `lastSync` age.
2. Push a change upstream.
3. Restart opencode **without** running `ocm update`. Wait for the loader's
   sync (throttle is 1h by default, so first force it):
   `OCM_SYNC_INTERVAL_MS=0 opencode`.
4. Quit, restart again. Expected: the change is live on this second start.
   Confirm the mental model "a sync makes the *next* start current" holds.
5. `OCM_SYNC_DISABLE=1 opencode` → no pull happens; verify via `lastSync`.
6. Set `syncIntervalMs: 0` on one marketplace in the registry; confirm it
   syncs every start while another marketplace stays throttled (per-marketplace
   throttle, not one global stamp).
7. Kill the network (or point a marketplace at an unreachable URL) and start
   opencode. Expected: opencode starts normally, no error dialog, installed
   plugins keep working, `lastSync.ok = false` recorded.

---

# Suite 3 — Per-plugin install

## Test 8 — install / uninstall round trip

1. `ocm add <MP-D url>` (10 plugins, auto mode). Expect all enabled.
2. `ocm uninstall <plugin>` for three of them. Expect per-plugin report and
   only their components removed.
3. `ls ~/.config/opencode/commands/` — the other seven survive intact.
4. `ocm list` (enabled only) vs `ocm list --all` (shows `(disabled)` + mode).
5. `ocm install <plugin>` again — instant, offline (try with network off).
6. Run each verb twice. Expected: second run is a clean no-op, not an error,
   and does not print a false "installed".
7. `ocm enable` / `ocm disable` — confirm they behave identically to
   install/uninstall (and that help says so).

## Test 9 — explicit mode

1. `ocm add <MP-D url> --explicit --name mp-explicit`
2. Expected: nothing materialized; the report lists plugins as *available*.
3. `ls ~/.config/opencode/commands/` — empty of that marketplace's names.
4. `ocm install <one plugin>` → only that one materializes.
5. Push a **new** plugin upstream, `ocm update mp-explicit`.
6. Expected: reported as available / registered disabled — **not**
   `installed (auto)` (known finding #5).
7. `ocm mode mp-explicit auto` → then push another new plugin and update;
   expect it to install automatically now.
8. `ocm uninstall` a plugin in an `auto` marketplace, then push a new upstream
   plugin: the mode must still be `auto` (a single uninstall does not flip it).

## Test 10 — scan (dry run)

1. `ocm scan <MP-A url>` on a marketplace not yet added.
2. Expected: full report of what would be installed; registry unchanged
   (`ocm list` identical before/after); no temp dirs left behind
   (`ls /tmp | grep -i ocm`).
3. `ocm scan ~/ocm-e2e/local-mp` — same, no writes.
4. `ocm scan <plugin>@<mp>` for an added marketplace — reports the components
   that plugin would materialize, including collisions it would hit.
5. `ocm scan` a repo with no `plugins/` dir → exit 0, explains why nothing was
   found and what layout is expected.

---

# Suite 4 — Collisions, precedence, ownership

## Test 11 — Hand-written file wins

1. Create `~/.config/opencode/commands/alpha-kit:mine.md` by hand.
2. Add a marketplace that materializes the same name.
3. Expected: collision reported and **skipped**; your file untouched
   (compare checksum).
4. `ocm install <plugin> --force`. Expected: takeover, the displaced path
   printed, file present under `~/.cache/ocm/displaced/<ts>/…`, nothing deleted.
5. `ocm remove <mp>` afterwards: your original hand-written file (restored or
   left alone) must survive. Nothing ocm does not own may be deleted, ever.

## Test 12 — Plugin name collision across marketplaces

1. Add MP-A. Add a second marketplace that ships a plugin with the same name.
2. Expected at add time: refusal naming **both** marketplaces, clone discarded,
   non-zero exit, registry unchanged.
3. Now create the collision *upstream* instead (push a colliding plugin into an
   already-added marketplace) and `ocm update`.
4. Expected: newcomer registered disabled, incumbent untouched, collision
   reported.
5. Try `ocm install <colliding>@<newcomer-mp>`. **Known finding #1:** it may
   report success while materializing nothing, and the next update silently
   flips it back. Verify whether that is fixed; if it reports success, check
   `ls ~/.config/opencode/commands/` to prove it.
6. `ocm doctor` — does it report the recorded collision? (known finding #4).

## Test 13 — Project beats global

1. In a test project create `.opencode/commands/alpha-kit:tdd.md` with
   distinctive content.
2. Start opencode in that project. Expected: the project version wins.
3. Confirm ocm wrote nothing into the project, and nothing into `~/.claude`,
   `.claude`, `~/.agents`, `.agents`:
   ```bash
   ls -la ~/.claude ~/.agents .claude .agents 2>&1 | head
   ```
   Run this again after a full add → install → update → remove cycle.

---

# Suite 5 — Trust

## Test 14 — Trust prompt at add

1. Fresh home. `ocm add <MP-B url>` (has `plugin/notify.js` + `mcp.json`).
2. Expected prompt: lists **each** executable component with its path / command
   line, says it runs with your shell's permissions, tells you where to review
   it, defaults to `N`.
3. Read it as a security-conscious user: is the risk clear, is the review path
   copy-pasteable?
4. Answer `N`. Expected: skills/commands/agents install; JS + MCP reported
   `blocked (untrusted)` **with the next action named** (known finding #6:
   the MCP warning may lack the `ocm trust <name>` hint).
5. Start opencode: confirm the plugin's JS did not load and the MCP server is
   absent from the tool list.
6. `ocm trust <mp>` interactively → approve. Expected: components materialize,
   restart notice.
7. Restart opencode: the MCP server's tools are available; the JS plugin's
   behaviour (e.g. notification) fires.
8. `ocm untrust <mp>` → executable components unlinked immediately, stuff stays.

## Test 15 — Trust re-prompt on change (the threat model)

1. With MP-B trusted, change the contents of `plugin/notify.js` upstream,
   commit, push.
2. `ocm update`. Expected: the report shows *what changed* (added / removed /
   modified paths), the component is **unlinked and blocked** pending approval,
   and the report says explicitly that functionality was reduced.
3. Confirm the changed code did **not** run on the next opencode start.
4. `ocm trust <mp>` → re-approve → restart → it runs.
5. Change an MCP server's `command` array upstream → same re-prompt.
6. Reorder keys in `mcp.json` without changing values → **no** re-prompt.
7. Edit a skill file only → no trust prompt at all.
8. Add a brand-new `plugin/other.js` to a previously code-free marketplace →
   expect a first-sight prompt, not silent execution.

## Test 16 — Non-interactive trust

1. `ocm add <MP-B url> --trust` → grants without prompting.
2. `ocm add <MP-B url> --no-trust` (fresh home) → installs stuff, blocks code,
   no prompt.
3. `ocm add <MP-B url> < /dev/null` (no TTY) → must not hang; prints what it
   would have asked; exit 0.
4. `ocm trust <mp> < /dev/null` → **known finding #2**: it may print the
   question and exit 0 with nothing granted. Check whether a flag now exists.
5. Loader startup sync with a new executable component: must never materialize
   it, must record `trustPending`, and the next `ocm` invocation / `/ocm`
   should surface it (known finding #6: `ocm list` may show nothing).

---

# Suite 6 — Update mechanics

## Test 17 — Reporting quality

1. Two-commit change touching a version bump, an added file, a modified file
   and a deleted file.
2. `ocm update` — read the report aloud. Does it tell you the revision
   transition, per-plugin version change and the `+ ~ -` file list?
3. `ocm update --quiet` → only changed marketplaces.
4. `ocm update --json` → valid JSON, parseable (`| jq .`).
5. `ocm update <mp>` (one marketplace) and `ocm update <plugin>@<mp>`
   (one plugin) — both scoped correctly.
6. `ocm update` with nothing changed → "already up to date", no churn:
   `stat` the registry file before/after; mtime should not change when nothing
   changed.
7. Ordering check: with a trust change pending, does the stderr trust block
   interleave badly with the stdout report (known finding #6)?

## Test 18 — Renames and removals

1. Upstream: rename `plugins/old-name` → `plugins/new-name` and add
   `"renames": {"old-name": "new-name"}` to `marketplace.json`. Push.
2. `ocm update`. Expected: `renamed old-name → new-name`, enabled state and
   `installedAt` preserved, links renamed, old links gone.
3. Restart opencode: `/new-name:cmd` works, `/old-name:cmd` gone.
4. Upstream: `"renames": {"dead-plugin": null}` → expect record dropped, links
   and MCP keys removed, reported.
5. Delete a plugin directory upstream **without** a renames entry → expect
   `removed (no longer in the marketplace)`, including for a plugin that was
   disabled.
6. Chain: `a→b` in one commit, `b→c` in the next; update once after both →
   converges to `c`.
7. Cycle `a→b`, `b→a` → warning, ignored, nothing corrupted.

## Test 19 — Pinning

1. `ocm pin <mp> v1.0.0` (an existing tag). Expected: validated by fetching
   *before* saving, success message.
2. `ocm list` / `ocm info <plugin>` — **is the pin visible anywhere?**
   (known finding U2: it may be invisible; that is the UX bug to confirm).
3. Push a new commit to the default branch → `ocm update` → stays on the tag.
4. Move the tag / push to the pinned branch → update follows the tip.
5. `ocm pin <mp> no-such-ref` → fails immediately, registry unchanged.
6. Delete the pinned ref upstream → update fails naming the ref; the
   marketplace stays at its current revision and keeps working.
7. `ocm pin <mp> --clear` → back to default branch.
8. `ocm add <url> --ref <branch>` at add time.

## Test 20 — Failure isolation

1. Three marketplaces added; break one (rename the remote / revoke access).
2. `ocm update`. Expected: the other two update, the broken one's links stay
   intact, `lastSync.ok = false` with the git error, one summary line, non-zero
   exit.
3. Start opencode: everything from the broken marketplace still works.
4. `ocm list --all` — failing sync shown (in red).
5. `ocm doctor` — reports it with the error and the age.
6. Fix the remote, `ocm update <mp>` → recovers.

## Test 21 — Cache / clone edge cases

1. `rm -rf ~/.cache/ocm/marketplaces/<mp>` then `ocm update`. Expected:
   re-cloned and reported.
2. Same for a `local: true` marketplace whose directory you moved away:
   expected reported and skipped, **never re-created**.
3. Edit a file inside `~/.cache/ocm/marketplaces/<mp>` by hand, then update.
   Expected: `reset --hard` discards it with a one-time warning naming the path
   ("the cache is not an editing surface").
4. `rm -rf ~/.cache/ocm` entirely, then `ocm doctor --fix` → recovers to a
   working state, or tells you exactly what to run.

---

# Suite 7 — Discovery surfaces

## Test 22 — search

1. `ocm search review` with MP-D added. Check ranking order: exact name >
   prefix > substring > tag/category > description > component name.
2. Search for a **command name** that exists in a plugin whose own name does
   not match → the plugin surfaces and the output says which component matched.
3. Disabled plugins shown with `(disabled)`; `--enabled-only` drops them.
4. Blocked (untrusted) plugins marked `(blocked)`.
5. `ocm search zzzznope` → exit 1, `no matches for "zzzznope"`. For a freshly
   added *local* marketplace, check the "sync is stale" hint is not shown
   misleadingly (known finding #6).
6. `ocm search x --json | jq .` valid.
7. Delete `~/.cache/ocm/marketplaces/<mp>` and search again → still works
   (registry cache only, no network).

## Test 23 — info

1. `ocm info <plugin>` — check every field: description, version, category,
   tags, homepage, license, enabled, installed date, marketplace URL + ref,
   revision + "synced Nh ago", trust state.
2. The `components` block must show **resulting opencode names**
   (`/alpha-kit:tdd`, skill `alpha-kit:code-review`), not just source paths —
   this is "what do I type to use this".
3. Origin annotations (`(plugin.json)` / `(marketplace.json)`) appear only when
   the two manifests disagree or a value was inferred.
4. `ocm info <plugin>@<mp>`, a disabled plugin, a blocked plugin, and a plugin
   with no manifest at all (zero-config) — all must render sensibly.
5. `ocm info nosuch` → error naming the fix (`ocm list`, `ocm add`).
6. `--json` includes source paths.

## Test 24 — list

1. `ocm list` — marketplaces, enabled plugins, version/revision, component
   summary. Readable at 80 columns?
2. `ocm list --all` — disabled markers, mode, red failing sync.
3. `ocm list --json | jq .` — the shape the TUI consumes.
4. With 10 marketplaces × 10 plugins: is the output still usable, or does it
   need paging/grouping? (scale UX judgement)

---

# Suite 8 — Author-side

## Test 25 — validate on a good marketplace

1. `cd template && ocm validate` → **zero findings**, exit 0.
2. `ocm validate ~/ocm-e2e/local-mp` (path argument form).
3. `ocm validate` in a directory that is not a marketplace → clear message.

## Test 26 — validate on MP-E (one finding class at a time)

Plant these one by one and confirm the exact finding line, then fix it:

| Planted defect | Expected |
|---|---|
| `SKILL.md` with no frontmatter / no `name` / no `description` | error |
| `description` of 0 or >1024 chars | error |
| invalid JSON in `plugin.json` | error with position |
| manifest `name` ≠ directory name; name with `_` or caps; >64 chars | error |
| two plugins producing the same command name | error naming both files |
| two skills resolving to the same namespaced name | error |
| command `.md` with an empty body | error |
| `plugins[]` entry whose `source` does not resolve, or uses `../` | error |
| `plugin/x.js` exporting `{ id, setup }` or `{ id, tui }` | error |
| `mcp.json` entry missing `type` | error |
| skill frontmatter with `allowed-tools` | warning naming the key + tool |
| `${CLAUDE_PLUGIN_ROOT}` without `plugins/<name>/` | warning |
| version disagreement between the two manifests | warning |
| `commands/x.md` with no frontmatter | warning |
| `skill/` next to `skills/`, `SKILLS.md`, `plugin.ts` at plugin root | warning (typo) |
| command template containing a `!` shell block | warning (surfaced as shell-executing) |
| both `.opencode-plugin/marketplace.json` and root `marketplace.json` | warning naming the ignored file |
| top-level `category`/`tags` in `plugin.json` (should be under `extensions`) | warning naming the move |
| `.opencode/` directory at the marketplace root | warning (it would inject project config) |
| marketplace `name` already added on this machine | informational |

Also: does it report **all** findings (not fail-fast), end with an
`N errors, M warnings` line, and exit 1 only when errors exist?

## Test 27 — Author round trip

1. Author a brand-new plugin from scratch in MP-C, using only the README as a
   guide. Time it. Where did you get stuck?
2. `ocm validate` → fix → push → `ocm update` → restart → use it.
3. This is the full author experience; log every moment of hesitation.

---

# Suite 9 — Layout, manifests, interop

## Test 28 — Manifest location (spec 15)

1. Marketplace with **only** `.opencode-plugin/marketplace.json` → adds,
   discovers, lists identically to a root-manifest one (metadata, renames,
   plugin entries all present).
2. Marketplace with **only** root `marketplace.json` → still works.
3. **Both** present → the `.opencode-plugin/` one wins; `ocm validate` warns
   naming the ignored file.
4. Malformed `.opencode-plugin/marketplace.json` **plus** a valid root one →
   reports the error, does **not** silently fall back.
5. `.opencode-plugin/` exists but empty → falls through to root, no error.
6. No manifest at all (zero-config marketplace) → plugins still discovered
   from the filesystem; name from directory; `list`/`info` still show origin.

## Test 29 — `mcpServers` path base (spec 15 §3)

1. `"mcpServers": "./mcp.custom.json"` resolving **inside the plugin
   directory** → servers materialize.
2. The same value resolving only marketplace-relative → still works, warns
   once naming both candidates.
3. `"mcpServers": "../other-plugin/mcp.json"` → refused.

## Test 30 — Cross-tool authoring (spec 11)

1. A plugin with `commands/`, `commands.claude/`, `agents/`, `agents.claude/`:
   ocm materializes only the unsuffixed ones; the `.claude` siblings are
   ignored, silently and without error.
2. A plugin with **only** `commands.claude/` + `skills/` → installs the skill,
   reports zero commands, no error.
3. In opencode, run a command whose body uses
   `"${OCM_PLUGIN_ROOT}/plugins/<name>/scripts/foo.sh"` → the script runs.
4. Same with `${CLAUDE_PLUGIN_ROOT}` → also runs (alias).
5. `echo $OCM_PLUGIN_ROOT` inside an opencode shell block → points at the
   marketplace root, for every added marketplace.
6. Optional: add the same repo to Claude Code via `.claude-plugin/marketplace.json`
   and confirm both tools coexist on one checkout without fighting.

## Test 31 — Agent Plugins interop (spec 14)

1. `mcp.json` in **Agent Plugins** shape (`$schema` + `mcpServers`, transport
   `stdio`) → translated to opencode's `type: "local"` form; server works.
2. `mcp.json` in **opencode-native** shape → unchanged behaviour.
3. `streamable-http` / `sse` entries → `type: "remote"`.
4. Changing a server inside the AP-shaped file re-triggers the trust prompt
   (fingerprint must be computed over the *translated* servers, not `$schema`).
5. `plugin.json` with `extensions["dev.wntic.ocm"].category/tags` → used by
   `search`/`info`; top-level `category`/`tags` still read, with a warning.

---

# Suite 10 — Teardown, repair, migration

## Test 32 — remove

1. `ocm remove <mp>` on a git marketplace with everything materialized.
2. Expected: per-plugin summary; then verify by hand:
   ```bash
   grep -c 'ocm--' ~/.config/opencode/opencode.json   # 0
   ls ~/.cache/ocm/links/                             # no <mp>
   ls ~/.config/opencode/commands ~/.config/opencode/agents ~/.config/opencode/plugins
   ```
   No `skills.paths` entry, no registry record, clone removed.
3. Your own hand-written command/agent files and your own `mcp` keys survive
   byte-identically (diff against a saved copy).
4. `ocm remove` a **local** marketplace → the directory on disk is **not**
   deleted.
5. `ocm remove nosuch` → clean error.
6. Restart opencode: nothing from the removed marketplace remains, no errors.

## Test 33 — doctor

Plant each corruption, run `ocm doctor`, then `ocm doctor --fix`:

1. Delete `~/.config/opencode/plugins/ocm-loader.js` → reports, `--fix`/`ocm init` restores.
2. Drop a stray `ocm-something.js` into `plugins/` → reported, removed.
3. Downgrade the version comment in `ocm/core.js` → "stale core" reported.
4. Break a symlink in `commands/` → reported, removed on confirm.
5. Orphan a `skills.paths` entry → reported, removed.
6. Add an `ocm--ghost--x` MCP key with no owning plugin → reported, removed.
7. Delete a marketplace clone directory → reported, re-cloned.
8. Set `lastSync.ok = false` → reported with error and age.
9. Create `~/.claude/something` → **loud** report (this should be impossible).
10. Confirm `--fix` never deletes a file ocm does not own (plant a foreign file
    in `commands/` and check it survives).
11. `ocm doctor` on a healthy install → exit 0, short output.

## Test 34 — Config-write hygiene

1. Before anything, write a rich `~/.config/opencode/opencode.json` (your own
   `mcp` keys, `model`, `provider`, `permission`, arbitrary keys) and a
   `tui.json` with theme + keybinds + your own TUI plugin. Save copies.
2. Run a full cycle: add → install → trust → update → uninstall → remove.
3. `diff` the saved copies against the live files: everything outside ocm's own
   keys must be **byte-identical** (ocm owns only `ocm--*`, its `skills.paths`
   entry, and the one `./ocm/ui.js` entry).
4. Corrupt `opencode.json` (invalid JSON) and run `ocm add` → expected: ocm
   refuses to rewrite it, warns, and prints the change to make by hand.
5. Make the config read-only and run a mutation → clean error, no partial
   state, original file intact.

## Test 35 — Migration from the old layout

1. Build a pre-migration `$HOME`: `plugins/ocm-core.js`, `plugins/ocm-ui.js`,
   `plugins/ocm-registry.json`, registry `version: 1` with absolute sources,
   `~/.cache/ocm/last-sync.json`, old skill links (`links/<mp>/skills/<plugin>`),
   `tui.json` pointing at `./plugins/ocm-ui.js`.
2. Run any `ocm` command. Expected: one line per thing moved; files land in
   `ocm/`; registry upgraded to v2 with relative sources; `tui.json` rewritten;
   skills relinked under namespaced names with the **old → new mapping printed**.
3. Run again → no output, no change (idempotent).
4. Restart opencode: everything still resolves under the new skill names.
5. Run the migration on a fresh home → no-op.

## Test 36 — Loader removal and escape hatches

1. `ocm loader uninstall` → loader gone from `plugins/`; installed components
   stay; restart opencode and confirm they still work but no sync happens.
2. `ocm init` → restores.
3. `OPENCODE_PURE=1 opencode` → `/ocm` absent, ocm's JS plugins not loaded;
   confirm that is documented and discoverable.

---

# Suite 11 — TUI detail pass (`/ocm`)

Run these deliberately, at a **small terminal size** (e.g. 80×24) and again
maximised, watching for clipping and overflow (known U1).

## Test 37 — Main menu

1. `/ocm` → four entries with accurate counts ("24 plugins across 3
   marketplaces"). Verify the counts against `ocm list`.
2. Escape / Back at every level returns where you expect; no dead ends.
3. Open `/ocm` twice in a row — no duplicated dialogs or stuck stack.

## Test 38 — Browse

1. Titles `plugin@marketplace`, descriptions present, grouped/filterable by
   marketplace, `(disabled)` and `(blocked)` suffixes correct.
2. Type in the filter box — does the built-in filtering match what you expect
   (name, description)?
3. Select a plugin → per-plugin menu: Install/Uninstall label reflects current
   state; Details; Trust (only when blocked); Update marketplace; Back.
4. Install from the dialog → confirmation first, toast after, list refreshes
   **in place** with the new state, restart notice shown.
5. Uninstall a plugin with executable components → the confirmation says so.
6. Details view on a plugin with many components → **scrollable?** (U1)

## Test 39 — Search in the TUI

1. Search → prompt → results in the same list shape as Browse.
2. Selecting a result opens the same per-plugin menu.
3. Empty query, no-match query, query with spaces/special chars → no crash.

## Test 40 — Marketplaces in the TUI

1. List → Update / Remove / Trust / Untrust / Pin / Back per marketplace.
2. Add via `DialogPrompt`: paste a GitHub URL; then try a local path; then a
   deliberately bad URL → error surfaced in the dialog, not swallowed.
3. Add a marketplace with executable components → the trust confirm shows the
   same component list the CLI prints.
4. Add a colliding marketplace → the collision error is shown in full.
5. Remove → confirmation shows what will be removed.
6. Pin → can you tell what the current ref is, and are available refs offered?
   (U2 — likely a gap.)

## Test 41 — TUI failure paths

1. Unreachable marketplace during Update all → per-marketplace error listed.
2. Install of a blocked plugin → clear explanation and the trust route.
3. Every mutation ends with the restart notice; an update that changed nothing
   must **not** print one.
4. Trigger an operation and immediately press Escape / start typing — no hang,
   no corrupted registry.

---

# Suite 12 — Stress and scale

## Test 42 — Many marketplaces

1. Add 5 marketplaces (~30 plugins total).
2. Time `ocm list`, `ocm search`, `/ocm` → Browse. Anything sluggish?
3. Start opencode cold with all 5 syncing (`OCM_SYNC_INTERVAL_MS=0`) —
   measure startup delay. Is sync blocking the UI?
4. `ls ~/.config/opencode/commands | wc -l` — does the `/` autocomplete stay
   usable with 30+ namespaced commands? This is a real UX cliff.

## Test 43 — Nasty inputs

1. `ocm add` with: a bare repo name, a URL with a trailing slash, `.git`
   suffix, `git@github.com:` SSH form, a `tree/<branch>/<subdir>` browse URL,
   a `file://` URL, `~/`-prefixed path, a relative path, a nonexistent path,
   a private repo without credentials.
2. Marketplace names: `--name` with caps/underscores/spaces → normalised or
   rejected with a clear message.
3. A repo with zero plugins → clone removed, error names the expected layout
   and suggests `ocm scan`.
4. A plugin directory with both `command/` and `commands/` → error (clash).
5. Very long plugin/skill names, unicode in descriptions, a 1000-line command
   body — nothing truncates badly or breaks the TUI.
6. Ctrl-C mid-`ocm add` / mid-update → no half-written registry; next command
   recovers or reports cleanly.

---

# Findings log template

```
## F<n> — <one-line title>   (area: CLI|TUI|docs, severity: high|med|low)

Test:        Suite N / Test M, step K
Command:     <exact command or keystrokes>
Expected:    <what the spec/README led you to expect>
Actual:      <what happened, verbatim output>
Impact:      <what a real user would conclude>
Spec ref:    docs/specs/NN-xxx.md §…
```

## Known issues to confirm or close while testing

Carried from `docs/e2e-findings.md` — check each explicitly:

| # | Issue | Test |
|---|---|---|
| 1 | False success on colliding install | 12.5 |
| 2 | `ocm trust` cannot grant non-interactively | 16.4 |
| 3 | Skill-only install omits the restart notice | 8 / 5 |
| 4 | `doctor` does not report collisions | 12.6 |
| 5 | Update report says `installed (auto)` in explicit mode | 9.6 |
| 6 | MCP blocked warning lacks hint; `trustPending` invisible in `ocm list`; stderr/stdout interleaving; unconditional "installed loader"; stale-sync hint for local marketplaces | 14.4, 16.5, 17.7, 2.6, 22.5 |
| U1 | TUI dialogs cramped, no scrolling | 37–40 |
| U2 | Pin state invisible | 19.2, 40.6 |
| U3 | Removal-only update may not print the restart notice | 5.7 |
