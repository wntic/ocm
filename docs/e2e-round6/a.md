# e2e round 6 — part a: brief 32 (error classification) and 46 §1

Tester: subagent a. Harness: `PATH=/tmp/ocm-e2e6/bin:$PATH`, `ocm` 0.7.1
(`ocm --version` → `0.7.1`, exit 0). One home per scenario under
`/tmp/ocm-e2e6/homes/a-*`. Streams captured separately as
`/tmp/ocm-e2e6/work/a/<step>.out` / `.err`; exit codes recorded per call.

New fixtures created under `/tmp/ocm-e2e6/fixtures/a-*` (nothing under the
repo was touched except this report file):

- `a-root-mp-tagged` — copy of `root-mp` with tag `v1` (deleted during step 4)
- `a-second-mp` — minimal git repo, plugin `other-kit` (step 5)
- `a-broken-mp` — git repo: `good-kit` (valid) + `bad-kit` (broken
  `plugin.json` **with** a command) — step 10, with-components variant
- `a-broken2-mp` — git repo: `good-kit` (valid) + `bad-kit` (broken
  `plugin.json`, **no** components) — step 10, matching variant

Note on the root cache dir: `ocm doctor` only prints its `cache` line after a
marketplace exists. The slug is `default-` + first 6 hex of sha256 of the
canonical (realpath) config-opencode path (read from `loader/paths.js`), so
each home's slug was derived with that formula and then confirmed by the
paths ocm itself printed in its messages.

## Step 1 — stale git lock (index.lock, shallow.lock)

Home `a-1`. `ocm init`, then `ocm add file:///tmp/ocm-e2e6/fixtures/root-mp
--name root-mp` (exit 0, normal output). Clone at
`/tmp/ocm-e2e6/homes/a-1/.cache/ocm/roots/default-24540f/marketplaces/root-mp`.

`touch $C/.git/index.lock` then:

```
$ HOME=$H ocm update
```

stdout:
```
updating root-mp...
```
stderr:
```
  failed: /tmp/ocm-e2e6/homes/a-1/.cache/ocm/roots/default-24540f/marketplaces/root-mp holds a git lock left by an interrupted git process (/private/tmp/ocm-e2e6/homes/a-1/.cache/ocm/roots/default-24540f/marketplaces/root-mp/.git/index.lock)
  remove that file, then re-run
update failed for 1 marketplace(s): root-mp
```
exit=1

`rm .git/index.lock; touch .git/shallow.lock` then:

stdout:
```
updating root-mp...
```
stderr:
```
  failed: /tmp/ocm-e2e6/homes/a-1/.cache/ocm/roots/default-24540f/marketplaces/root-mp holds a git lock left by an interrupted git process (/private/tmp/ocm-e2e6/homes/a-1/.cache/ocm/roots/default-24540f/marketplaces/root-mp/.git/shallow.lock)
  remove that file, then re-run
update failed for 1 marketplace(s): root-mp
```
exit=1

**Verdict: pass.** Both lock files produce the stale-lock message naming the
lock file; the cause is "an interrupted git process"; there is no mention of
another ocm running. Exit 1 in both cases.

## Step 2 — pre-existing non-empty clone dir before first add

Home `a-2`. `ocm init` (exit 0). Throwaway home `a-2t` (init + add + doctor)
confirmed the layout: `<root cache>/marketplaces/<name>`. Derived a-2's slug
`default-af380e`. Pre-created
`$R/marketplaces/root-mp/junk.txt` (`echo junk > …`), then the first add:

```
$ HOME=$H ocm add file:///tmp/ocm-e2e6/fixtures/root-mp --name root-mp
```

stdout:
```
cloning file:///tmp/ocm-e2e6/fixtures/root-mp...
added marketplace "root-mp"
  plain-kit (1 command)
  root-kit (2 commands)
commands and agents are available as /<plugin>:<name> in every project
restart opencode to activate
```
stderr:
```
warning: removing an incomplete clone at /tmp/ocm-e2e6/homes/a-2/.cache/ocm/roots/default-af380e/marketplaces/root-mp left by an interrupted ocm add
```
exit=0

On disk: `junk.txt` gone; the dir is a real clone (`.git/`, `plugins/`);
`registry.json` has `root-mp` with `revision de29ae739675b4c403f7d3841c30f4fcfe119e0d` and `lastSync.ok: true`.

**Verdict: pass.** First add succeeds (exit 0) with a warning about an
incomplete clone.

## Step 3 — unwritable cache; read failure must not say "cannot write"

Home `a-3`. `ocm init` (exit 0; init does not create `.cache`). `mkdir -p
$H/.cache; chmod 555 $H/.cache`, then:

```
$ HOME=$H ocm add file:///tmp/ocm-e2e6/fixtures/root-mp --name root-mp
```

stdout:
```
refreshed the auto-sync loader to 0.7.1 (restart opencode to activate)
cloning file:///tmp/ocm-e2e6/fixtures/root-mp...
```
stderr:
```
cannot create /tmp/ocm-e2e6/homes/a-3/.cache/ocm — permission denied
  fix the permissions on /tmp/ocm-e2e6/homes/a-3/.cache, then re-run
```
exit=1

Mode restored with `chmod 755 $H/.cache` afterwards.

On disk: `$H/.cache/` is empty (no `ocm/` created);
`$H/.config/opencode/ocm/registry.json` does not exist (`ls` → "No such file
or directory") — no registry left behind. No `EACCES:` prefix anywhere in
the message; the path and the remedy are both named.

Read-failure variant — registry replaced by a directory
(`mkdir -p $H/.config/opencode/ocm/registry.json`):

`ocm list` stdout: (empty), stderr:
```
error: registry at /tmp/ocm-e2e6/homes/a-3/.config/opencode/ocm/registry.json is not valid JSON — ocm will not overwrite it
  inspect or move the file, then run ocm doctor; to start over, remove it and re-add your marketplaces
```
exit=1

`ocm update` stdout: (empty), stderr: identical to the above. exit=1

**Verdict: pass.** Write failure names path + remedy with no `EACCES:`
prefix and leaves no registry; the read failure does not say "cannot write"
(it says "is not valid JSON — ocm will not overwrite it").

## Step 4 — pinned ref deleted upstream

Fixture copy `a-root-mp-tagged` (`git tag v1`). Home `a-4`: init, add from
the copy (exit 0), `ocm pin root-mp v1` (exit 0, `marketplace "root-mp"
pinned to v1`). Deleted the tag in the fixture (`git tag -d v1` → `Deleted
tag 'v1' (was de29ae7)`), then:

```
$ HOME=$H ocm update
```

stdout:
```
updating root-mp...
```
stderr:
```
  failed: file:///tmp/ocm-e2e6/fixtures/a-root-mp-tagged has no ref "v1" — it may have been deleted or renamed upstream
  ocm pin root-mp v1 to follow another, or ocm pin root-mp to follow the default branch
update failed for 1 marketplace(s): root-mp
```
exit=1

This is the `ref-missing` class (confirmed against `loader/git-errors.js`
TABLE: recogniser `couldn't find remote ref` / `not found in upstream`,
message `has no ref "<ref>"`).

On disk after the failure:
- `registry.json` still lists exactly `['root-mp']` with `"ref": "v1"` (jq/python check).
- Links survive: `plain-kit:quiet.md` and `root-kit:plain.md` symlinks still
  point into the clone; `root-kit:hello.md` (rendered file) still present;
  clone contents intact (`hello.md`, `plain.md`).

**Verdict: pass.** `ref-missing` message names the ref and gives both pin
remedies; entry and links survive.

## Step 5 — git off PATH, two git marketplaces

Home `a-5`: init, add `root-mp` (file:// git repo) and `second-mp`
(`a-second-mp`, file:// git repo) — both exit 0. Then:

```
$ PATH=/tmp/ocm-e2e6/bin:/Users/yegorvorobyev/.bun/bin HOME=$H ocm update
```

stdout: (empty)
stderr:
```
git is not on PATH — ocm needs git to clone and update marketplaces
  install git, then re-run
```
exit=1

`grep -c "git is not on PATH"` over both streams: exactly 1 (in stderr), 0
in stdout.

Side note: `fold-mp.git` could not be used as the second marketplace — it is
a bare repo, and ocm's file:// pre-check (`isGitRepo` looks for a `.git`
entry) refuses it with `local-not-a-repo`; a non-bare clone of it trips the
case-collision gate. A fresh minimal git fixture was used instead.

**Verdict: pass.** Exactly one `git is not on PATH` error, exit 1.

## Step 6 — file:// URL to a non-repo directory

Home `a-6`. init, then:

```
$ HOME=$H ocm add file:///tmp/ocm-e2e6/fixtures/local-mp
```

stdout:
```
cloning file:///tmp/ocm-e2e6/fixtures/local-mp...
```
stderr:
```
/tmp/ocm-e2e6/fixtures/local-mp is a directory, not a git repository
  add a local directory by path: ocm add /tmp/ocm-e2e6/fixtures/local-mp
```
exit=1

On disk: `$H/.config/opencode/ocm/registry.json` does not exist — nothing
left behind.

**Verdict: pass.** Refused with the plain-path form suggested.

## Step 7 — unrecognised git failure (corrupt .git/HEAD)

Home `a-1` (locks cleaned). `echo "garbage" > $C/.git/HEAD` (backup kept),
then:

```
$ HOME=$H ocm update
```

stdout:
```
updating root-mp...
```
stderr:
```
  failed: cannot access file:///tmp/ocm-e2e6/fixtures/root-mp — the repository is private, unreachable, or the URL is wrong
  git: fatal: not a git repository (or any of the parent directories): .git
update failed for 1 marketplace(s): root-mp
```
exit=1

HEAD restored from backup afterwards.

**Verdict: pass.** The old access sentence plus a `git:` line carrying git's
own words (the `unknown` fallback class).

## Step 8 — doctor --fix with the clone deleted

Home `a-8`: init, add root-mp (exit 0), `rm -rf` the clone dir, then:

```
$ HOME=$H ocm doctor --fix
```

stdout:
```
doctor
  loader  core.js (current)
  loader  ocm-loader.js (current)
  loader  ui.js (current)
  cache   default-5739df (/tmp/ocm-e2e6/homes/a-8/.cache/ocm/roots/default-5739df)
  fixed   marketplace "root-mp": clone directory missing, re-cloned from file:///tmp/ocm-e2e6/fixtures/root-mp (restart opencode to activate)
```
stderr: (empty)
exit=0

On disk: the clone is really back —
`…/marketplaces/root-mp/plugins/root-kit/commands/` contains `hello.md`,
`plain.md`; `git log` in the clone shows `de29ae7 root-mp initial`.

**Verdict: pass.** A `fixed` finding names the re-clone and carries "restart
opencode to activate"; the re-clone is real on disk.

## Step 9 — dirty clone: 3 modified + 12 untracked

Home `a-1`. Appended to 3 tracked files, created 12 untracked files under
`plugins/root-kit/commands/`; `git status --porcelain | wc -l` → 15 before
the update. Then:

```
$ HOME=$H ocm update
```

stdout:
```
updating root-mp...
  already up to date
```
stderr:
```
  warning: /tmp/ocm-e2e6/homes/a-1/.cache/ocm/roots/default-24540f/marketplaces/root-mp has local changes; discarded 3 local changes and 12 untracked files (the cache is not an editing surface)
    plugins/plain-kit/plugin.json
    plugins/root-kit/commands/hello.md
    plugins/root-kit/plugin.json
    plugins/root-kit/commands/untracked-1.md
    plugins/root-kit/commands/untracked-10.md
    plugins/root-kit/commands/untracked-11.md
    plugins/root-kit/commands/untracked-12.md
    plugins/root-kit/commands/untracked-2.md
    plugins/root-kit/commands/untracked-3.md
    plugins/root-kit/commands/untracked-4.md
    … and 5 more
```
exit=0

10 files listed, `… and 5 more` = 15 − 10. On disk after:
`git status --porcelain | wc -l` → 0 (clone actually cleaned).

**Verdict: pass.** Files named, 10 shown, `… and N more`, exit 0.

## Step 10 — broken plugin.json beside a valid plugin

The brief does not say whether the broken plugin ships components; both
readings were tested.

Variant A — broken plugin **with** a command (`a-broken-mp`: `good-kit`
valid, `bad-kit` has `{` as plugin.json plus `commands/nope.md`):

```
$ HOME=$H ocm add file:///tmp/ocm-e2e6/fixtures/a-broken-mp --name broken-mp
```

stdout:
```
cloning file:///tmp/ocm-e2e6/fixtures/a-broken-mp...
```
stderr:
```
  warning: /tmp/ocm-e2e6/homes/a-10/.cache/ocm/roots/default-892b7d/marketplaces/broken-mp/plugins/bad-kit/plugin.json: not valid JSON — fix it or remove it; ocm requires this file to be readable
marketplace "broken-mp" is not installable — 1 manifest finding
  plugins/bad-kit/plugin.json: not valid JSON — fix it or remove it; ocm requires this file to be readable
  each needs at least { "description": "…" }; see ocm validate and the README
```
exit=1 — the whole add is refused.

Variant B — broken plugin with **no** components (`a-broken2-mp`: `good-kit`
valid, `bad-kit` has `{` as plugin.json, nothing else), home `a-10c`:

```
$ HOME=$H ocm add file:///tmp/ocm-e2e6/fixtures/a-broken2-mp --name broken2-mp
```

stdout:
```
cloning file:///tmp/ocm-e2e6/fixtures/a-broken2-mp...
added marketplace "broken2-mp"
  good-kit (1 command)
commands and agents are available as /<plugin>:<name> in every project
restart opencode to activate
```
stderr:
```
  warning: plugins/bad-kit/plugin.json: not valid JSON — fix it or remove it; ocm requires this file to be readable
  plugins/bad-kit has no components — nothing installs, so users are unaffected
```
exit=0

On disk (variant B): `commands/good-kit:ok.md` symlink → the clone's
`good-kit/commands/ok.md`; registry plugins for `broken2-mp` = `['good-kit']`.

Variant B matches the brief exactly and matches the shape of the canonical
`bad-mp` fixture (`broken-json` there also has no components). Variant A's
refusal is the manifest gate (brief 29) working as designed: a broken plugin
that would install something blocks the add; one that installs nothing is a
warning. Not filed as a finding.

**Verdict: pass** (variant B, the reading that matches the brief and the
canonical fixture; variant A documented above).

## Step 11 — brief 46 §1: invalid MCP entry + corrupt registry

Home `a-11`: init, add `schema-mp` by path (exit 0; MCP component blocked
pending trust), `ocm trust schema-mp --yes` (exit 0) — this wrote
`ocm--schema-kit--real-server` into `opencode.json`. Then edited that key to
`"not-an-object"` and `echo '{' > $H/.config/opencode/ocm/registry.json`.
Then:

```
$ HOME=$H ocm doctor --fix
```

stdout:
```
doctor
  loader  core.js (current)
  loader  ocm-loader.js (current)
  loader  ui.js (current)
  cache   default-a7079b (/tmp/ocm-e2e6/homes/a-11/.cache/ocm/roots/default-a7079b)
  error   /tmp/ocm-e2e6/homes/a-11/.config/opencode/ocm/registry.json: not valid JSON — restore it from a backup, or remove it and re-add your marketplaces
  error   ocm--schema-kit--real-server: orphaned MCP key — plugin "schema-kit" is not in the registry
  error   ocm--schema-kit--real-server: invalid MCP entry — plugin "schema-kit", server "real-server" not a JSON object; opencode would refuse to start
    cannot verify ownership — the registry is unreadable; fix /tmp/ocm-e2e6/homes/a-11/.config/opencode/ocm/registry.json, then run ocm doctor --fix
3 errors, 0 warnings
```
stderr: (empty)
exit=1

On disk after: `opencode.json` still contains
`"ocm--schema-kit--real-server": "not-an-object"` (nothing removed);
`registry.json` still `{`.

**Verdict: pass.** The "invalid MCP entry … opencode would refuse to start"
diagnosis is kept, the registry is named as what to repair ("fix
…/registry.json, then run ocm doctor --fix"), and nothing was removed.
Reading taken for "names the registry repair": doctor names the registry as
the repair it needs from the user — doctor never rewrites a corrupt registry
itself (per `src/commands/doctor.ts`, a corrupt registry is always a
user-action error), so no `fixed` registry line can exist here.

## Not run

- `opencode debug config` / `debug skill` probes: none of the eleven steps in
  this part asks for an opencode-level check; all checks are ocm-level
  (messages, exit codes, on-disk state), so no probe was run.

## Summary

| Step | Scenario | Verdict |
|---|---|---|
| 1 | stale git lock (index.lock / shallow.lock) | pass |
| 2 | pre-existing non-empty clone dir | pass |
| 3 | unwritable cache; registry-is-a-directory read failure | pass |
| 4 | pinned ref deleted upstream | pass |
| 5 | git off PATH, two git marketplaces | pass |
| 6 | file:// URL to non-repo dir | pass |
| 7 | corrupt .git/HEAD (unknown git failure) | pass |
| 8 | doctor --fix, clone deleted | pass |
| 9 | dirty clone 3+12 | pass |
| 10 | broken plugin.json beside valid plugin | pass (no-components reading; with-components variant documented) |
| 11 | 46 §1 invalid MCP entry + corrupt registry | pass |

No findings filed: every step matched its expected behaviour, and nothing
observed differs from the backlog descriptions.
