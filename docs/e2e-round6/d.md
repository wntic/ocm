# e2e round 6 — part d: upgrade, script contract, round trip

Tester: subagent d. All `ocm` calls ran with `PATH=/tmp/ocm-e2e6/bin:$PATH`
(`ocm` = main's build, `ocm071` = published 0.7.1; both refuse to run unless
`HOME` is under `/tmp/ocm-e2e6/homes/`). Streams and exit codes captured
separately for every call under `/tmp/ocm-e2e6/work/d/`. Real opencode was
used read-only (`opencode debug config`, `opencode debug skill`) only.

Homes used: `d-1` (upgrade), `d-2`/`d-2b`/`d-2c` (script contract),
`d-3`/`d-3b`/`d-3c`/`d-3d` (+ `d-3c071`/`d-3d071` for 0.7.1 comparison,
round trip). Fixtures created by me: `d-broken2-mp` (git repo whose remote I
moved away mid-test, restored after), `d-badfix-mp` (bad-mp with the dotfile
command renamed).

`ocm --version` on main's build prints `0.7.1` (package.json not yet bumped),
so "refreshed the auto-sync loader to 0.7.1" below is main refreshing 0.7.1's
loader files to its own, not a downgrade.

## Part 1 — upgrade from 0.7.1

### 1.1 build the 0.7.1 home (`d-1`)

`HOME=$H ocm071 init` → exit 0

stdout:
```
installed auto-sync loader (/tmp/ocm-e2e6/homes/d-1/.config/opencode/plugins/ocm-loader.js)
installed TUI plugin (/ocm in the opencode TUI)
```
stderr: (empty)

`HOME=$H ocm071 add file:///tmp/ocm-e2e6/fixtures/root-mp` → exit 0

stdout:
```
cloning file:///tmp/ocm-e2e6/fixtures/root-mp...
added marketplace "fixtures-root-mp"
  plain-kit (1 commands)
  root-kit (2 commands)
commands and agents are available as /<plugin>:<name> in every project
restart opencode to activate
```
stderr: (empty)

`HOME=$H ocm071 add /tmp/ocm-e2e6/fixtures/local-mp` → exit 0

stdout:
```
marketplace "demo-marketplace" ships code that opencode will execute:
  mcp     demo-kit/everything (local server: npx -y @modelcontextprotocol/server-everything)
  plugin  demo-kit/notify (plugins/demo-kit/plugin/notify.js)
this code runs with your shell's permissions on every opencode start.
review it at /private/tmp/ocm-e2e6/fixtures/local-mp
added marketplace "demo-marketplace"
  demo-kit (1 agents, 1 commands, 1 skills, 1 plugins, 1 mcp servers)
  release-kit (1 commands, 1 skills)
commands and agents are available as /<plugin>:<name> in every project
restart opencode to activate
```
stderr:
```
trust this marketplace to run code? [y/N/skip]
  warning: blocked (untrusted): demo-kit:notify.js not linked — run `ocm trust demo-marketplace` to approve
  warning: blocked (untrusted): demo-kit:mcp/everything not installed — run `ocm trust demo-marketplace` to approve
  warning: 2 components blocked pending trust — run `ocm trust demo-marketplace`
```

`HOME=$H ocm071 add /tmp/ocm-e2e6/fixtures/exec-mp` → exit 0 (same shape as
above; exec-kit 2 plugins + 1 mcp, all blocked pending trust).

`HOME=$H ocm071 trust exec-mp --yes` → exit 0

stdout:
```
marketplace "exec-mp" ships code that opencode will execute:
  mcp     exec-kit/exec-mcp (local server: node -e console.log('exec-mcp'))
  plugin  exec-kit/notify (plugins/exec-kit/plugin/notify.js)
  plugin  exec-kit/other (plugins/exec-kit/plugin/other.js)
this code runs with your shell's permissions on every opencode start.
review it at /private/tmp/ocm-e2e6/fixtures/exec-mp
marketplace "exec-mp" trusted to run code
restart opencode to activate
```
stderr:
```
  warning: 2 components blocked pending trust — run `ocm trust demo-marketplace`
```

Displaced original: `ocm071 uninstall root-kit`, then hand-wrote
`.config/opencode/commands/root-kit:hello.md`
(`# my own hello\n\nhand-written original, do not touch\n`,
sha256 `6c3ae418d59f8be97e07b7fb361cbe936181f4ad409b8aeba579fba13741edfe`),
then `HOME=$H ocm071 install root-kit --force` → exit 0

stdout:
```
installed root-kit@fixtures-root-mp, displaced your commands/root-kit:hello.md → /tmp/ocm-e2e6/homes/d-1/.cache/ocm/roots/default-1aa203/displaced/2026-09-23T19-49-15-556Z/tmp/ocm-e2e6/homes/d-1/.config/opencode/commands/root-kit:hello.md
restart opencode to activate
```
stderr:
```
  warning: displaced your commands/root-kit:hello.md → /tmp/ocm-e2e6/homes/d-1/.cache/ocm/roots/default-1aa203/displaced/2026-09-23T19-49-15-556Z/tmp/ocm-e2e6/homes/d-1/.config/opencode/commands/root-kit:hello.md
  warning: 2 components blocked pending trust — run `ocm trust demo-marketplace`
```

On-disk evidence after the 0.7.1 build:
- `displaced-records.json`:
```json
[
  {
    "marketplace": "fixtures-root-mp",
    "plugin": "root-kit",
    "dest": "/tmp/ocm-e2e6/homes/d-1/.config/opencode/commands/root-kit:hello.md",
    "dir": "/tmp/ocm-e2e6/homes/d-1/.cache/ocm/roots/default-1aa203/displaced/2026-09-23T19-49-15-556Z"
  }
]
```
- displaced copy sha256 `6c3ae418…edfe` (matches the hand-written original).
- registry `ocmVersion`: `"0.7.1"`, three marketplaces
  (`fixtures-root-mp`, `demo-marketplace`, `exec-mp`).

**Verdict: pass** (0.7.1 home built as specified).

### 1.2 main's `ocm list` on the 0.7.1 home

`HOME=$H ocm list` → exit 0

stdout:
```
refreshed the auto-sync loader to 0.7.1 (restart opencode to activate)
fixtures-root-mp
  source: file:///tmp/ocm-e2e6/fixtures/root-mp
  revision: de29ae7
  plain-kit (0.1.0)
    commands: quiet.md
  root-kit (0.1.0)
    commands: hello.md, plain.md
demo-marketplace
  source: /private/tmp/ocm-e2e6/fixtures/local-mp
  demo-kit (0.1.0)
    agents: reviewer.md
    commands: tdd.md
    skills: code-review
    plugins: notify.js (blocked — ocm trust demo-marketplace)
    mcp: everything (blocked — ocm trust demo-marketplace)
  release-kit (0.1.0)
    commands: ship.md
    skills: release-notes
exec-mp
  source: /private/tmp/ocm-e2e6/fixtures/exec-mp
  exec-kit (0.1.0)
    plugins: notify.js, other.js
    mcp: exec-mcp
```
stderr: (empty)

No migration lines: `grep -i migrat` over all part-1 captures finds nothing.
The single first-run line is the loader refresh (main's loader modules differ
from 0.7.1's — e.g. main adds `error-message.js`, `gc.js`, `render.js` to
`.config/opencode/ocm/`), which is an upgrade refresh, not a cache migration.

**Verdict: pass** (no migration lines; all three marketplaces listed with
correct plugins/components; exit 0).

### 1.3 main's `ocm doctor`

`HOME=$H ocm doctor` → exit 0

stdout:
```
doctor
  loader  core.js (current)
  loader  ocm-loader.js (current)
  loader  ui.js (current)
  cache   default-1aa203 (/tmp/ocm-e2e6/homes/d-1/.cache/ocm/roots/default-1aa203)
  displaced  1 original in /tmp/ocm-e2e6/homes/d-1/.cache/ocm/roots/default-1aa203/displaced
```
stderr: (empty)

**Verdict: pass** (exit 0, 0 errors, 0 warnings; displaced original counted).

### 1.4 main's `ocm update`

`HOME=$H ocm update` → exit 0

stdout:
```
updating fixtures-root-mp...
  already up to date
updating demo-marketplace...
  already up to date
updating exec-mp...
  already up to date
```
stderr:
```
  warning: 2 components blocked pending trust — run `ocm trust demo-marketplace`
```

**Verdict: pass** (exit 0, no migration lines, per-marketplace report).

### 1.5 `opencode debug config` / `debug skill` match disk

Run from `$H` with `HOME=$H`, both exit 0, stderr empty.

`opencode debug config` reports:
- `skills.paths[0]` = `/tmp/ocm-e2e6/homes/d-1/.cache/ocm/roots/default-1aa203/links/demo-marketplace/skills`
  — exists on disk; contains `demo-kit--code-review/SKILL.md` and
  `release-kit--release-notes/SKILL.md`.
- `mcp` key `ocm--exec-kit--exec-mcp` — byte-equal (jq diff) to the `mcp`
  entry in `$H/.config/opencode/opencode.json` on disk.
- `plugin` entries `…/plugins/ocm-loader.js`, `…/ocm--exec-kit--notify.js`,
  `…/ocm--exec-kit--other.js` — all three exist on disk (the two
  `ocm--exec-kit--*` files are symlinks into the exec-mp fixture).
- commands `root-kit:hello`, `root-kit:plain`, `plain-kit:quiet`,
  `demo-kit:tdd`, `release-kit:ship` and agent `demo-kit:reviewer` — all
  present as files/symlinks under `.config/opencode/commands/` and `agents/`.

`opencode debug skill` lists `release-kit:release-notes` and
`demo-kit:code-review` with `location` pointing at the two mirror SKILL.md
files above (both exist on disk; the rendered `name:` frontmatter is
`demo-kit:code-review`, i.e. namespaced).

**Verdict: pass** (debug output matches disk exactly).

### 1.6 displaced original restorable via `ocm remove`

Before remove, the materialized `root-kit:hello.md` had sha256
`191ba3d7854936e83a7b8e6a8beecc70e1b41b88d4b725ca28b41d5527c0b318`
(ocm's rendered version, not the original).

`HOME=$H ocm remove fixtures-root-mp` → exit 0

stdout:
```
removed marketplace "fixtures-root-mp"
  plain-kit: 1 commands removed
  root-kit: 2 commands removed
restored your commands/root-kit:hello.md (was displaced by root-kit)
restart opencode to activate
```
stderr:
```
  warning: 2 components blocked pending trust — run `ocm trust demo-marketplace`
```

On-disk evidence after remove:
- `shasum -a 256 .config/opencode/commands/root-kit:hello.md` →
  `6c3ae418d59f8be97e07b7fb361cbe936181f4ad409b8aeba579fba13741edfe`
  (identical to the pre-displacement original); `cmp` against a saved copy of
  the original: byte-identical; file content is the hand-written
  `# my own hello …` again.
- `displaced-records.json` is now `[]`; the displaced tree under
  `roots/default-1aa203/displaced/` is empty.
- registry `marketplaces` keys: `demo-marketplace`, `exec-mp` only;
  `marketplaces/fixtures-root-mp` clone dir removed from cache.

**Verdict: pass.**

### Part 1 verdict: pass (6/6 steps).

## Part 2 — script contract

Home `d-2` (built up progressively with main's `ocm`), plus `d-2b` (empty)
and `d-2c` (badfix). Every call captured as `v-<name>.out`/`v-<name>.err`
with exit code. "Data→stdout" means the normal report/output lines;
"warn/err→stderr" means warning and error lines. The recurring
`warning: 3 components blocked pending trust — run "ocm trust exec-mp"`
line (exec-mp was deliberately left untrusted in d-2) appeared on stderr on
many calls and is omitted from the table cells for brevity — it was always
on stderr, never stdout.

| verb | case | exit | data→stdout | warn/err→stderr | notes | verdict |
|---|---|---|---|---|---|---|
| init | success (fresh home) | 0 | yes ("installed auto-sync loader…", "installed TUI plugin…") | yes (empty) | | pass |
| init | duplicate | 0 | yes ("auto-sync loader already current") | empty | idempotent, not a failure | pass |
| init | failure | — | — | — | **not run**: no failure trigger identified; duplicate init is an idempotent success | not run |
| add | success (git file:// root-mp) | 0 | yes (clone, "added marketplace", plugin list) | empty | | pass |
| add | failure (nonexistent path) | 1 | none | yes ("path does not exist: …") | | pass |
| add | failure (bad tree, bad-mp) | 1 | none | yes ("marketplace \"bad-mp\" is not installable — 1 manifest finding" + the dotfile-command error) | refuses whole tree; the "1" counts blocking findings only — after fixing just that one, add succeeds (exit 0) and reports the two non-blocking findings (broken-json, empty-desc) as stderr warnings (verified on `d-badfix-mp`/home `d-2c`) | pass |
| add | failure (manifest gate, local-gate-mp) | 1 | none | yes ("marketplace \"local-gate-mp\" is not installable — 1 manifest finding" + gate-fail-kit description error) | whole tree refused, nothing added (registry checked) | pass |
| add | partial (untrusted executable components, exec-mp) | 0 | yes (added, "exec-kit") | yes (trust prompt + 3 "blocked (untrusted)" warnings + summary) | marketplace added, exec components withheld | pass |
| remove | success | 0 | yes ("removed marketplace…", per-plugin lines, "restart opencode to activate") | yes (trust warning) | | pass |
| remove | failure (unknown name) | 1 | none | yes ("marketplace \"no-such-mp\" not found (ocm list)") | | pass |
| update | success (all up to date) | 0 | yes (per-mp "already up to date") | yes (withheld-component warning) | | pass |
| update | failure (unknown mp) | 1 | none | yes ("marketplace \"no-such-mp\" not found (ocm list)") | | pass |
| update | partial (1 of 3 mps fails: remote dir moved away) | 1 | yes (the two successful mps still report "already up to date") | yes ("  failed: /tmp/ocm-e2e6/fixtures/d-broken2-mp does not exist" + "update failed for 1 marketplace(s): fixtures-d-broken2-mp") | per-item report, run does not abort | pass |
| install | success (after uninstall) | 0 | yes ("installed root-kit@fixtures-root-mp (2 commands)") | yes (trust warning) | | pass |
| install | already installed | 0 | yes ("already installed root-kit@fixtures-root-mp") | yes (trust warning) | no-op success | pass |
| install | failure (unknown plugin) | 1 | none | yes ("plugin \"bogus-kit\" not found in any marketplace (ocm add <url|path>, or ocm update)") | | pass |
| install | partial (component withheld: hand-written file at destination, no --force) | 1 | yes ("installed plain-kit@fixtures-root-mp partially — 1 component withheld") | yes ("  warning: skipped …/plain-kit:quiet.md: not managed by ocm — re-run with --force to displace it") | hand-written file untouched on disk (content re-read) | pass |
| uninstall | success | 0 | yes ("uninstalled root-kit@fixtures-root-mp") | yes (trust warning) | | pass |
| uninstall | failure (unknown plugin) | 1 | none | yes ("plugin \"bogus-kit\" not found in any marketplace …") | | pass |
| trust | success (--yes) | 0 | yes (code review block + "marketplace \"exec-mp\" trusted to run code") | empty | | pass |
| trust | failure (unknown mp) | 1 | none | yes ("marketplace \"no-such-mp\" not found (ocm list)") | | pass |
| untrust | success | 0 | yes ("marketplace \"exec-mp\" no longer trusted; executable components removed") | yes (trust warning) | | pass |
| untrust | failure (unknown mp) | 1 | none | yes ("marketplace \"no-such-mp\" not found (ocm list)") | | pass |
| pin | success (pin to branch) | 0 | yes ("marketplace \"fixtures-root-mp\" pinned to main") | yes (trust warning) | | pass |
| pin | failure (bad ref) | 1 | none | yes ("cannot pin \"fixtures-root-mp\" to \"no-such-ref\": fatal: couldn't find remote ref no-such-ref") | | pass |
| pin | failure (unknown mp) | 1 | none | yes ("marketplace \"no-such-mp\" not found (ocm list)") | | pass |
| pin | --clear | 0 | yes ("marketplace \"fixtures-root-mp\" unpinned (following the default branch)") | yes (trust warning) | | pass |
| list | success | 0 | yes (full marketplace/plugin tree) | empty | | pass |
| list | empty home | 0 | yes ("no marketplaces added yet (ocm add <url|path>)") | empty | empty success, not a failure | pass |
| search | hit | 0 | yes ("root-kit@fixtures-root-mp  0.1.0  Plugin-root substitution fixture" + "  matched: commands/hello") | empty | | pass |
| search | miss | 1 | none | yes ("no matches for \"zzz-nomatch\"") | | pass |
| info | success | 0 | yes (full plugin record incl. component destinations) | empty | | pass |
| info | failure (unknown plugin) | 1 | none | yes ("plugin \"bogus-kit\" not found in any marketplace (ocm search <query>, or ocm update)") | | pass |
| validate | success (root-mp) | 0 | yes (report + "0 errors, 2 warnings") | empty | **note**: the two `warning plugins/…: no "$schema"` lines are printed on stdout — for validate the findings list *is* the data, so I do not count this as "errors on stdout"; no `error` lines ever appeared on stdout | pass |
| validate | failure (bad-mp) | 1 | yes (3 `error` lines + 1 warning + "3 errors, 1 warning") | empty | errors are report data on stdout; exit code carries the failure | pass |
| validate | mixed (local-gate-mp) | 1 | yes (1 error, 2 warnings) | empty | | pass |
| doctor | success (healthy home, from part 1) | 0 | yes (report, no error lines) | empty | | pass |
| doctor | failure (1 error: last sync failed) | 1 | yes (report incl. "  error   marketplace \"fixtures-d-broken2-mp\": last sync failed 0m ago: … does not exist" + "1 error, 0 warnings") | empty | errors are report data on stdout; exit code carries the failure | pass |
| doctor | failure (3 errors: missing cache dir, failed sync, broken symlink) | 1 | yes (3 `error` lines + "3 errors, 0 warnings") | empty | broken-symlink error names the fix ("ocm doctor --fix removes it") | pass |

No verb exited 0 on a failure, and no verb printed an `error` line on stdout.
The only stdout warning lines are validate's/doctor's finding reports, which
are those tools' data.

### Part 2 verdict: pass (33 cases run, 1 not run — init failure has no
identified trigger; duplicate init is an idempotent success).

## Part 3 — round trip (fresh home `d-3`)

Hand-written files planted in `.config/opencode/` **before** any ocm call
(shasums recorded in `work/d/p3-before.sha`):

```
edfc220197b7979a1086f3cf28a930890207a4f35382af05ed7e361496fd8e16  ./agents/my-agent.md
639de700e0b06b71bd1c3110f0274eee9493e85ae60a98fa272c901e68512c6a  ./commands/my-own.md
ede6069499706f67c1935f216288c3d517b1231cb777b44392775370f5d1e2bd  ./opencode.json
1d35ad98163b4e33700f52b2d11d275c0b7858a9dd56463d3c1f2cc08ae64dab  ./plugins/my-plugin.js
e5637724b430689ba9f2cacb632e7bea21906e399637694931e3356c1b24cea4  ./skills/my-skill/SKILL.md
```

### 3.1 add

`HOME=$H ocm add /tmp/ocm-e2e6/fixtures/local-mp --explicit` → exit 0

stdout:
```
marketplace "demo-marketplace" ships code that opencode will execute:
  mcp     demo-kit/everything (local server: npx -y @modelcontextprotocol/server-everything)
  plugin  demo-kit/notify (plugins/demo-kit/plugin/notify.js)
this code runs with your shell's permissions on every opencode start.
review it at /private/tmp/ocm-e2e6/fixtures/local-mp
added marketplace "demo-marketplace"
  demo-kit (1 command, 1 agent, 1 skill, 1 plugin, 1 mcp) — available, not installed
  release-kit (1 command, 1 skill) — available, not installed
2 plugins available — ocm install <name> to activate
installed auto-sync loader (/tmp/ocm-e2e6/homes/d-3/.config/opencode/plugins/ocm-loader.js)
installed TUI plugin (/ocm in the opencode TUI)
```
stderr:
```
trust this marketplace to run code? [y/N/skip]
```

Note: `add` implicitly installs the auto-sync loader + TUI plugin even
without `ocm init` (this is why the teardown below needs
`ocm loader uninstall` to leave a pristine config dir).

**Verdict: pass.**

### 3.2 install

`HOME=$H ocm install demo-kit` → exit 0

stdout:
```
installed demo-kit@demo-marketplace (1 command, 1 agent, 1 skill)
restart opencode to activate
```
stderr:
```
  warning: 2 components blocked pending trust — run `ocm trust demo-marketplace`
```

On-disk evidence (captured on the twin home `d-3c`, same steps):
`commands/demo-kit:tdd.md` and `agents/demo-kit:reviewer.md` are symlinks
into the fixture (`readlink` →
`/private/tmp/ocm-e2e6/fixtures/local-mp/plugins/demo-kit/commands/tdd.md`);
skills mirror
`roots/default-58b86e/links/demo-marketplace/skills/demo-kit--code-review/SKILL.md`
exists with rendered frontmatter `name: "demo-kit:code-review"`;
`opencode.json` gained exactly
`"skills": {"paths": ["…/roots/default-58b86e/links/demo-marketplace/skills"]}`.
`opencode debug config` (run from `$H`, exit 0) sees `demo-kit:tdd`,
`demo-kit:reviewer` and the skills path — matching disk.

**Verdict: pass.**

### 3.3 update

`HOME=$H ocm update` → exit 0

stdout:
```
updating demo-marketplace...
  already up to date
```
stderr:
```
  warning: 2 components blocked pending trust — run `ocm trust demo-marketplace`
```

**Verdict: pass.**

### 3.4 uninstall

`HOME=$H ocm uninstall demo-kit` → exit 0

stdout:
```
uninstalled demo-kit@demo-marketplace
restart opencode to activate
```
stderr: (empty)

**Verdict: pass.**

### 3.5 remove

`HOME=$H ocm remove demo-marketplace` → exit 0

stdout:
```
removed marketplace "demo-marketplace"
  demo-kit:  removed
  release-kit: 1 commands, 1 skills removed
```
stderr: (empty)

`release-kit` was never installed (explicit mode; only demo-kit was
installed, and it was uninstalled in 3.4) — see finding D-1.

**Verdict: pass on cleanup (see on-disk evidence), fail on the reported
component counts (finding D-1).**

### 3.6 post-remove state on disk

After `remove`:
- `commands/`, `agents/`, `skills/` contain only the hand-written files.
- `opencode.json` sha256 is `ede6069499706f67c1935f216288c3d517b1231cb777b44392775370f5d1e2bd`
  — identical to the pre-round-trip original; content re-read and equal to
  what I wrote (no `skills`/`mcp` keys left).
- registry `marketplaces` = `{}`; cache `links/` empty; the marketplace
  clone dir is gone from `roots/*/marketplaces/`.
- All five hand-written files byte-identical (`diff` of before/after shasum
  lists: `HAND-WRITTEN BYTE-IDENTICAL`).
- Still present (ocm-made, installed implicitly by `add` in 3.1):
  `plugins/ocm-loader.js`, the whole `ocm/` dir (loader modules +
  `registry.json`), and `tui.json`.

### 3.7 `ocm loader uninstall` (completing the teardown)

`HOME=$H ocm loader uninstall` → exit 0

stdout:
```
removed auto-sync loader
```
stderr: (empty)

After it, `.config/opencode/` contains exactly:
```
./agents/my-agent.md
./commands/my-own.md
./opencode.json
./plugins/my-plugin.js
./skills/my-skill/SKILL.md
./tui.json
```
i.e. every hand-written file byte-identical and no ocm-made files — **except
`tui.json`**, which ocm itself created in 3.1 and which remains behind, now
containing `{"plugin": []}` (finding D-2).

Variant test (home `d-3d`): a **hand-written** `tui.json`
(`{"theme": "my-theme"}`, sha `1d4ea1d4…b932`) is merged by `add` to
`{"theme": "my-theme", "plugin": ["./ocm/ui.js"]}` (correct), but after
`remove` + `ocm loader uninstall` it is left as
`{"theme": "my-theme", "plugin": []}` — the user's data survives, the file
is not restored byte-identically (finding D-2). Identical behaviour in
0.7.1 (checked on `d-3d071`), so pre-existing, not a v0.8 regression.

### Part 3 verdict: pass on the letter of the checks I could plant
(no ocm-made marketplace artifacts remain after remove; every hand-written
file byte-identical), with two findings below on the remove report (D-1)
and the tui.json leftover (D-2).

## Findings

**D-1 (medium, pre-existing in 0.7.1).** `ocm remove` reports component
counts for plugins that were never installed. Repro (home `d-3b`, also seen
in `d-3`): `ocm add …/local-mp --explicit` (nothing installed —
`commands/`/`agents/` empty, no cache links, registry `enabled: false` for
both plugins), then `ocm remove demo-marketplace` prints
`demo-kit: 1 agents, 1 commands, 1 skills, 1 plugins, 1 mcp servers removed`
and `release-kit: 1 commands, 1 skills removed` while nothing was ever
materialized. A user reading this believes files were deleted from their
disk. 0.7.1 prints the same lines.

**D-2 (low, pre-existing in 0.7.1).** After full teardown
(`remove` + `ocm loader uninstall`) ocm leaves `tui.json` behind: an
ocm-created `tui.json` remains as `{"plugin": []}`, and a user-written
`tui.json` keeps an ocm-added `"plugin": []` key instead of being restored
byte-identically. No data is lost (user keys survive); the file just is not
returned to its pre-ocm bytes.

No other findings. Nothing observed matched the backlog items (F262, F263,
F258, the untrust toast, doubled lock prefixes, the lock-steal race), and
nothing in `docs/project.md`'s accepted risks was hit.
