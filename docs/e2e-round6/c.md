# e2e round 6 — part c (brief 45: headlines and exit codes)

Tester: subagent c. Never edited `src/`, `loader/`, `bin/`, `test/`, `.opencode/`;
never committed. All `ocm` calls via `/tmp/ocm-e2e6/bin` with `HOME` under
`/tmp/ocm-e2e6/homes/c-*`. Raw stream captures in `/tmp/ocm-e2e6/work/c/`.

New fixtures created (outside the repo): `/tmp/ocm-e2e6/fixtures/c-noskill-mp`,
`c-exec-gone-mp`, `c-edit-mp`, and `/Volumes/CSX5/c-case-mp`.

Verdict summary: 9 of 9 steps run, 9 pass. One low-severity finding (F-c1, step 7).

---

## Step 1 — hand-written command file, then `ocm install` (home c-1)

Setup: `ocm add /tmp/ocm-e2e6/fixtures/local-mp --explicit` (exit 0, nothing
auto-installed), then hand-wrote
`~/.config/opencode/commands/demo-kit:tdd.md`:

```
---
description: My own hand-written tdd command
---

HAND-WRITTEN BODY c-1 step1
```

sha256 before install:
`4ff221ac3c8a6cdc41afd06d6e43c55a31a3712ad175efd0c32ac23cee435c8c`

Command: `HOME=$H ocm install demo-kit`

exit=1

stdout:
```
installed demo-kit@demo-marketplace partially — 1 component withheld
restart opencode to activate
```

stderr:
```
  warning: skipped /tmp/ocm-e2e6/homes/c-1/.config/opencode/commands/demo-kit:tdd.md: not managed by ocm — re-run with --force to displace it
  warning: 2 components blocked pending trust — run `ocm trust demo-marketplace`
```

On-disk evidence:
- sha256 after install: `4ff221ac3c8a6cdc41afd06d6e43c55a31a3712ad175efd0c32ac23cee435c8c`
  — byte-identical to the pre-install hash.
- `ls ~/.config/opencode/commands/ ~/.config/opencode/agents/`:
  `demo-kit:reviewer.md` (symlink, installed) and `demo-kit:tdd.md` (82B,
  regular file — the hand-written one, not a symlink).
- registry `plugins.demo-kit.components`:
  `{"agent": ["reviewer.md"], "skill": ["code-review"]}` — `tdd.md` absent,
  `enabled: true`.

Verdict: **pass** — exit 1, "installed … partially — 1 component withheld",
stderr names the file and `--force`, file untouched.

## Step 2 — same with `--force` (home c-1)

Command: `HOME=$H ocm install demo-kit --force`

exit=0

stdout:
```
installed demo-kit@demo-marketplace (1 command, 1 agent, 1 skill), displaced your commands/demo-kit:tdd.md → /tmp/ocm-e2e6/homes/c-1/.cache/ocm/roots/default-c4e8e7/displaced/2026-09-23T19-49-06-365Z/tmp/ocm-e2e6/homes/c-1/.config/opencode/commands/demo-kit:tdd.md
restart opencode to activate
```

stderr:
```
  warning: 2 components blocked pending trust — run `ocm trust demo-marketplace`
```

On-disk evidence:
- `grep -c displaced` on stdout = 1, on stderr = 0 — displacement printed
  exactly once, on stdout, absent from stderr.
- Displaced-cache copy exists at the printed path; its sha256 is
  `4ff221ac3c8a6cdc41afd06d6e43c55a31a3712ad175efd0c32ac23cee435c8c` — the
  original hand-written bytes.
- `displaced-records.json`:
  ```json
  [
    {
      "marketplace": "demo-marketplace",
      "plugin": "demo-kit",
      "dest": "/tmp/ocm-e2e6/homes/c-1/.config/opencode/commands/demo-kit:tdd.md",
      "dir": "/tmp/ocm-e2e6/homes/c-1/.cache/ocm/roots/default-c4e8e7/displaced/2026-09-23T19-49-06-365Z"
    }
  ]
  ```
- `commands/demo-kit:tdd.md` is now a symlink to the fixture's `tdd.md` (72B).

Verdict: **pass**.

## Step 3 — uninstall then install → headline with counts (home c-1)

First attempt (documented because it shows an interaction):
`ocm uninstall demo-kit` printed
```
uninstalled demo-kit@demo-marketplace
restored your commands/demo-kit:tdd.md (was displaced by demo-kit)
restart opencode to activate
```
(exit 0, stderr empty) — the displaced hand-written file was restored, so the
immediately following `ocm install demo-kit` again hit the collision (exit 1,
"partially — 1 component withheld"). Consistent with the displacement record,
not a failure. I removed my hand-written file and re-ran the pair cleanly.

Clean run — `HOME=$H ocm uninstall demo-kit`:

exit=0

stdout:
```
uninstalled demo-kit@demo-marketplace
restart opencode to activate
```

stderr: (empty)

Then `HOME=$H ocm install demo-kit`:

exit=0

stdout:
```
installed demo-kit@demo-marketplace (1 command, 1 agent, 1 skill)
restart opencode to activate
```

stderr:
```
  warning: 2 components blocked pending trust — run `ocm trust demo-marketplace`
```

On-disk evidence: `commands/` has `demo-kit:tdd.md` (symlink, 72B) and
`agents/` has `demo-kit:reviewer.md` (symlink, 75B).

Verdict: **pass** — headline carries counts `(1 command, 1 agent, 1 skill)`;
no `()` anywhere in the output.

## Step 4 — trust-blocked component, install without trust (home c-2)

Setup: `ocm add /tmp/ocm-e2e6/fixtures/exec-mp --explicit` (exit 0; the trust
prompt on stderr defaulted to no in a non-tty).

Command: `HOME=$H ocm install exec-kit`

exit=0

stdout:
```
installed exec-kit@exec-mp
```

stderr:
```
  warning: 3 components blocked pending trust — run `ocm trust exec-mp`
```

On-disk evidence:
- registry `plugins.exec-kit.components` = `{}` and `enabled: true` — plugin
  recorded, nothing materialized.
- `~/.config/opencode/plugins/` contains only `ocm-loader.js` — no
  `ocm--exec-kit--*.js` links.
- `~/.config/opencode/opencode.json` does not exist — the untrusted mcp server
  was never written to config.

Verdict: **pass** — exit 0, install does not fail when every component is
trust-blocked. (Headline is bare, no parenthetical — correct, since zero
components were materialized; not `()`.)

## Step 5 — collision at `ocm add`, then standing skip at `ocm update` (home c-3)

Setup: hand-wrote `~/.config/opencode/commands/demo-kit:tdd.md`
(sha256 `ad032247b5a2fcb463dedd41e55f9967580781353e71ff89b011f359f40b2637`)
before adding.

Command: `HOME=$H ocm add /tmp/ocm-e2e6/fixtures/local-mp` (auto mode)

exit=1

stdout:
```
marketplace "demo-marketplace" ships code that opencode will execute:
  mcp     demo-kit/everything (local server: npx -y @modelcontextprotocol/server-everything)
  plugin  demo-kit/notify (plugins/demo-kit/plugin/notify.js)
this code runs with your shell's permissions on every opencode start.
review it at /private/tmp/ocm-e2e6/fixtures/local-mp
added marketplace "demo-marketplace"
  demo-kit installed partially — 1 component withheld
  release-kit (1 command, 1 skill)
commands and agents are available as /<plugin>:<name> in every project
installed auto-sync loader (/tmp/ocm-e2e6/homes/c-3/.config/opencode/plugins/ocm-loader.js)
installed TUI plugin (/ocm in the opencode TUI)
restart opencode to activate
```

stderr:
```
trust this marketplace to run code? [y/N/skip]
  warning: skipped /tmp/ocm-e2e6/homes/c-3/.config/opencode/commands/demo-kit:tdd.md: not managed by ocm — re-run with --force to displace it
  warning: blocked (untrusted): demo-kit:notify.js not linked — run `ocm trust demo-marketplace` to approve
  warning: blocked (untrusted): demo-kit:mcp/everything not installed — run `ocm trust demo-marketplace` to approve
  warning: 2 components blocked pending trust — run `ocm trust demo-marketplace`
```

Then `HOME=$H ocm update`:

exit=0

stdout:
```
updating demo-marketplace...
  already up to date
```

stderr:
```
  warning: skipped /tmp/ocm-e2e6/homes/c-3/.config/opencode/commands/demo-kit:tdd.md: not managed by ocm — re-run with --force to displace it
  warning: 2 components blocked pending trust — run `ocm trust demo-marketplace`
```

On-disk evidence: sha256 of the hand-written file is
`ad032247b5a2fcb463dedd41e55f9967580781353e71ff89b011f359f40b2637` after both
commands — untouched.

Verdict: **pass** — add exits 1 partial; update with the standing skip exits 0
with a warning only.

## Step 6 — skill without `name` in frontmatter (home c-4, fixture c-noskill-mp)

Fixture: plugin `quiet-kit` with one command (`quiet.md`) and one skill
(`skills/no-name-skill/SKILL.md` whose frontmatter has only `description`).

Command: `HOME=$H ocm add /tmp/ocm-e2e6/fixtures/c-noskill-mp` (auto mode)

exit=0

stdout:
```
added marketplace "c-noskill-mp"
  quiet-kit (1 command)
commands and agents are available as /<plugin>:<name> in every project
installed auto-sync loader (/tmp/ocm-e2e6/homes/c-4/.config/opencode/plugins/ocm-loader.js)
installed TUI plugin (/ocm in the opencode TUI)
restart opencode to activate
```

stderr:
```
  warning: skipped /private/tmp/ocm-e2e6/fixtures/c-noskill-mp/plugins/quiet-kit/skills/no-name-skill/SKILL.md: no name in frontmatter
```

On-disk evidence:
- `commands/` has `quiet-kit:quiet.md` (symlink, 79B); no SKILL.md anywhere
  under `~/.cache/ocm` for this home.
- registry `plugins.quiet-kit.components` = `{"command": ["quiet.md"]}` — the
  skill is not counted.

Verdict: **pass** — exit 0, headline does not count the skill, singular
"1 command".

## Step 7 — `ocm untrust` in three states (homes c-5, c-5b)

State c — never trusted (home c-5; add answered N at the non-tty prompt):

Command: `HOME=$H ocm untrust exec-mp`

exit=0

stdout:
```
marketplace "exec-mp" was not trusted; nothing changed
```

stderr: (empty)

State a — granted, executables linked (home c-5; `ocm trust exec-mp --yes`
exit 0, then `ocm install exec-kit` exit 0 with
`installed exec-kit@exec-mp (2 plugins, 1 mcp)`; links
`ocm--exec-kit--notify.js`, `ocm--exec-kit--other.js` present):

Command: `HOME=$H ocm untrust exec-mp`

exit=0

stdout:
```
marketplace "exec-mp" no longer trusted; executable components removed
restart opencode to activate
```

stderr:
```
  warning: 3 components blocked pending trust — run `ocm trust exec-mp`
```

On-disk evidence: after untrust, `plugins/` contains only `ocm-loader.js`;
registry `trust.code` = `"denied"`.

State b — granted, nothing executable linked (home c-5; re-trusted with
`--yes`, which re-linked the two plugin files, then `ocm uninstall exec-kit`
exit 0 removed them; registry `trust.code` still `"granted"`):

Command: `HOME=$H ocm untrust exec-mp`

exit=0

stdout:
```
marketplace "exec-mp" no longer trusted; it ships nothing executable, nothing was removed
```

stderr: (empty)

On-disk evidence: registry `trust.code` = `"denied"` afterwards.

Cross-check of state b via the other route (home c-5b, fixture c-exec-gone-mp):
trusted, installed, then deleted `plugin/notify.js`, `plugin/other.js`,
`mcp.json` from the fixture and ran `ocm update` (exit 0;
`exec-kit removed (no longer in the marketplace)`), then `ocm untrust`:

exit=0

stdout:
```
marketplace "c-exec-gone-mp" no longer trusted; it ships nothing executable, nothing was removed
```

For that route the sentence is accurate — the marketplace genuinely ships
nothing executable. For the c-5 route (plugin merely uninstalled) the same
sentence is false: `ocm add` had listed three executable components for
exec-mp. See finding F-c1.

Verdict: **pass** on the brief's expectations — three distinct lines, and an
actual removal ("executable components removed") is claimed only in state a.
Note the literal word "removed" also occurs in state b's line as "nothing was
removed" (a negation, not a removal claim).

## Step 8 — case collision on /Volumes/CSX5 (home c-6, fixture /Volumes/CSX5/c-case-mp)

Volume verified: `diskutil info /Volumes/CSX5` →
`File System Personality:   Case-sensitive APFS`.

Setup: marketplace `c-case-mp` with `plugins/case-kit` (command `run.md`);
`ocm add /Volumes/CSX5/c-case-mp` (exit 0) auto-installed it
(`case-kit:run.md` symlink present). Then added `plugins/Case-Kit` (command
`run.md`, different body) plus a manifest entry, and ran update.

Command: `HOME=$H ocm update`

exit=0

stdout:
```
updating c-case-mp...
  case-kit   uninstalled — plugins/Case-Kit and plugins/case-kit differ only in case
  restart opencode to activate
```

stderr:
```
  warning: plugin "case-kit": plugin.json name "Case-Kit" disagrees with the directory name "case-kit"; the directory name wins — rename the directory or fix plugin.json
  warning: plugins/Case-Kit and plugins/case-kit differ only in case — plugin "case-kit" skipped; ask the author to rename one and update again
```

On-disk evidence:
- `~/.config/opencode/commands/` is empty — the `case-kit:run.md` link is gone.
- registry `marketplaces.c-case-mp.plugins` = `[]` — neither plugin remains.

Assessment: not "already up to date" ✓; the drop is named with its reason
(`plugins/Case-Kit and plugins/case-kit differ only in case — plugin "case-kit"
skipped; ask the author to rename one and update again`) ✓; the restart notice
prints ✓. The installed `case-kit` being uninstalled is the documented
"skipped or stopped at update" behaviour (README §Names must not differ only
in case), so I count it as intended, not a failure.

Verdict: **pass**.

## Step 9 — upstream edit to a command body only (home c-7, fixture c-edit-mp)

Setup: `ocm add /tmp/ocm-e2e6/fixtures/c-edit-mp` (copy of local-mp; exit 0,
auto-installed). Rendered `demo-kit:tdd.md` sha256
`6c6e241472eadb62d8e9cded77259d85f907ee04c382b1d5e69915a564f5e59e`. Then
appended a line to the fixture's `commands/tdd.md` body only — frontmatter
untouched.

Command: `HOME=$H ocm update`

exit=0

stdout:
```
updating demo-marketplace...
  demo-kit
    ~ commands/tdd.md
  restart opencode to activate
```

stderr:
```
  warning: 2 components blocked pending trust — run `ocm trust demo-marketplace`
```

On-disk evidence: rendered `demo-kit:tdd.md` sha256 changed to
`105b7021c577617cae4ad98269fe41ace591b1ebfc567520ee5439af6a843fc3` and its
tail now reads
`5. UPSTREAM EDIT: body only, frontmatter untouched`.

Verdict: **pass** — the restart notice prints for a body-only command edit.

---

## Findings

### F-c1 (low) — `ocm untrust` claims "it ships nothing executable" when the marketplace does ship executables that are merely not linked

- Test: step 7, state b (home c-5).
- Command: `HOME=/tmp/ocm-e2e6/homes/c-5 ocm untrust exec-mp` after
  `ocm trust exec-mp --yes` and `ocm uninstall exec-kit`.
- Expected: a line that does not falsely describe the marketplace's contents
  (the brief expected three distinct lines, "removed" only in the first —
  that part holds).
- Actual (verbatim):
  ```
  marketplace "exec-mp" no longer trusted; it ships nothing executable, nothing was removed
  ```
- Impact: `ocm add` for the same marketplace had listed three executable
  components (`exec-kit/exec-mcp`, `exec-kit/notify`, `exec-kit/other`), so
  the sentence is false whenever the executable components exist upstream but
  are not currently linked (plugin uninstalled, or never installed). A user
  could conclude the marketplace carries no code. The revocation itself is
  correct (`trust.code` becomes `"denied"`, exit 0), and the same line is
  accurate when upstream really removed the executables (verified on home
  c-5b), so the message conflates "nothing linked to remove" with "ships
  nothing executable". Source: `src/commands/trust.ts:169` picks this line
  whenever trust was granted and no `removed` outcome occurred.
- Severity: low (wording — a false statement in a terminal-state message; no
  wrong exit code, no file impact, and any future re-trust re-lists the code).
