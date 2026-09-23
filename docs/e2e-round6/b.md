# E2E round 6 — part b (brief 33 doctor ownership, brief 46 §2–3)

Subagent b. Harness: `PATH=/tmp/ocm-e2e6/bin:$PATH`, one home per scenario under
`/tmp/ocm-e2e6/homes/b-*`, streams captured under `/tmp/ocm-e2e6/work/b/`.
All output below is verbatim from the captured files.

Verdicts: step 1 pass, step 2 pass, step 3 pass, step 4 pass, step 5 pass,
step 6 pass, step 7 **fail** (doctor --fix does not converge on a rendered
command whose plugin record is gone).

---

## Step 1 — registry entry removed by hand; doctor reports orphans; --fix removes exactly those; hand-written files survive

Two runs. The first (home `b-1`) added root-mp as a **local path**; the brief's
scenario needs the git install (step 2 says "the clone also deleted"), so the
scored run is `b-1b` with `file://`. The local-path variant is reported as an
observation below.

### Scored run (home b-1b, file:// add)

```
HOME=$H ocm add file:///tmp/ocm-e2e6/fixtures/root-mp
exit=0
cloning file:///tmp/ocm-e2e6/fixtures/root-mp...
added marketplace "fixtures-root-mp"
  plain-kit (1 command)
  root-kit (2 commands)
commands and agents are available as /<plugin>:<name> in every project
installed auto-sync loader (/tmp/ocm-e2e6/homes/b-1b/.config/opencode/plugins/ocm-loader.js)
installed TUI plugin (/ocm in the opencode TUI)
restart opencode to activate
```
stderr: empty.

On disk after add (`ls -la $H/.config/opencode/commands/`):
```
755  plain-kit:quiet.md -> /tmp/ocm-e2e6/homes/b-1b/.cache/ocm/roots/default-acdd6f/marketplaces/fixtures-root-mp/plugins/plain-kit/commands/quiet.md  122B
644  root-kit:hello.md  292B
755  root-kit:plain.md -> /tmp/ocm-e2e6/homes/b-1b/.cache/ocm/roots/default-acdd6f/marketplaces/fixtures-root-mp/plugins/root-kit/commands/plain.md  121B
```
`root-kit:hello.md` is a regular file (rendered; marker verified in step 7).

Registry entry removed by hand, then hand-written files planted:
```
jq 'del(.marketplaces["fixtures-root-mp"])' registry.json   # grep for fixtures-root-mp: 0 matches
commands/mine.md    (regular file, hand-written)
commands/x:y.md     (regular file, colon name, hand-written)
agents/mine.md      (regular file, hand-written)
```

`HOME=$H ocm doctor`:
```
exit=1
doctor
  loader  core.js (current)
  loader  ocm-loader.js (current)
  loader  ui.js (current)
  cache   default-acdd6f (/tmp/ocm-e2e6/homes/b-1b/.cache/ocm/roots/default-acdd6f)
  error   /tmp/ocm-e2e6/homes/b-1b/.config/opencode/commands/root-kit:plain.md: no marketplace owns this link → /tmp/ocm-e2e6/homes/b-1b/.cache/ocm/roots/default-acdd6f/marketplaces/fixtures-root-mp/plugins/root-kit/commands/plain.md — ocm doctor --fix removes it
  error   /tmp/ocm-e2e6/homes/b-1b/.config/opencode/commands/plain-kit:quiet.md: no marketplace owns this link → /tmp/ocm-e2e6/homes/b-1b/.cache/ocm/roots/default-acdd6f/marketplaces/fixtures-root-mp/plugins/plain-kit/commands/quiet.md — ocm doctor --fix removes it
  error   /tmp/ocm-e2e6/homes/b-1b/.config/opencode/commands/root-kit:hello.md: no marketplace owns this file — ocm doctor --fix removes it
3 errors, 0 warnings
```
stderr: empty.

`HOME=$H ocm doctor --fix`:
```
exit=0
doctor
  loader  core.js (current)
  loader  ocm-loader.js (current)
  loader  ui.js (current)
  cache   default-acdd6f (/tmp/ocm-e2e6/homes/b-1b/.cache/ocm/roots/default-acdd6f)
  fixed   /tmp/ocm-e2e6/homes/b-1b/.config/opencode/commands/root-kit:plain.md: removed
  fixed   /tmp/ocm-e2e6/homes/b-1b/.config/opencode/commands/plain-kit:quiet.md: removed
  fixed   /tmp/ocm-e2e6/homes/b-1b/.config/opencode/commands/root-kit:hello.md: removed
```
stderr: empty.

On disk after --fix:
```
commands/: mine.md (644, 64B), x:y.md (644, 51B)   — the three ocm files gone
agents/:   mine.md (644, 34B)
shasum -c before/after: mine.md OK, x:y.md OK, agents/mine.md OK
```

Real opencode (read-only, run from `$H`): `HOME=$H opencode debug config`
exit=0, and the surviving hand-written commands are visible:
```
    "x:y": {
      "description": "colon name",
      "template": "Also hand-written."
    }
```
(`mine` likewise appears twice, as command and agent.)

Note: root-mp ships no agents, so the "agents/ links" half of the claim had no
ocm-owned agent links to orphan; the hand-written `agents/mine.md` survived
untouched (shasum OK).

**Verdict: pass.**

### Observation (home b-1, local-path add — not the scored scenario)

`ocm add /tmp/ocm-e2e6/fixtures/root-mp` (local, no clone), registry entry
jq-deleted, doctor:
```
  error   /tmp/ocm-e2e6/homes/b-1/.config/opencode/commands/root-kit:plain.md: symlink → /private/tmp/ocm-e2e6/fixtures/root-mp/plugins/root-kit/commands/plain.md ; no marketplace owns it and the target is not ocm's — remove it by hand, or re-add the marketplace
  error   /tmp/ocm-e2e6/homes/b-1/.config/opencode/commands/plain-kit:quiet.md: symlink → /private/tmp/ocm-e2e6/fixtures/root-mp/plugins/plain-kit/commands/quiet.md ; no marketplace owns it and the target is not ocm's — remove it by hand, or re-add the marketplace
  error   /tmp/ocm-e2e6/homes/b-1/.config/opencode/commands/root-kit:hello.md: no marketplace owns this file — ocm doctor --fix removes it
```
`doctor --fix` removed only the rendered `root-kit:hello.md`; the two symlinks
stayed (2 errors remain, exit=1). This is the ownership model refusing to
auto-delete links whose target it cannot prove it owns (target outside
`~/.cache/ocm`), and the message says so accurately. Filed as low finding
F-B2 because the brief's "--fix removes exactly those" does not hold under a
local-path install.

---

## Step 2 — same, with the clone also deleted (broken links)

Home `b-2`. `ocm add file:///tmp/ocm-e2e6/fixtures/root-mp` exit=0 (output
identical in shape to step 1). Then jq-deleted the marketplace entry, deleted
the clone (`rm -rf .../marketplaces/fixtures-root-mp`), planted
`commands/mine.md`.

`HOME=$H ocm doctor`:
```
exit=1
doctor
  loader  core.js (current)
  loader  ocm-loader.js (current)
  loader  ui.js (current)
  cache   default-9b19f8 (/tmp/ocm-e2e6/homes/b-2/.cache/ocm/roots/default-9b19f8)
  error   /tmp/ocm-e2e6/homes/b-2/.config/opencode/commands/root-kit:plain.md: broken symlink → /tmp/ocm-e2e6/homes/b-2/.cache/ocm/roots/default-9b19f8/marketplaces/fixtures-root-mp/plugins/root-kit/commands/plain.md — ocm doctor --fix removes it
  error   /tmp/ocm-e2e6/homes/b-2/.config/opencode/commands/plain-kit:quiet.md: broken symlink → /tmp/ocm-e2e6/homes/b-2/.cache/ocm/roots/default-9b19f8/marketplaces/fixtures-root-mp/plugins/plain-kit/commands/quiet.md — ocm doctor --fix removes it
  error   /tmp/ocm-e2e6/homes/b-2/.config/opencode/commands/root-kit:hello.md: no marketplace owns this file — ocm doctor --fix removes it
3 errors, 0 warnings
```
stderr: empty.

`HOME=$H ocm doctor --fix`:
```
exit=0
doctor
  loader  core.js (current)
  loader  ocm-loader.js (current)
  loader  ui.js (current)
  cache   default-9b19f8 (/tmp/ocm-e2e6/homes/b-2/.cache/ocm/roots/default-9b19f8)
  fixed   /tmp/ocm-e2e6/homes/b-2/.config/opencode/commands/root-kit:plain.md: removed
  fixed   /tmp/ocm-e2e6/homes/b-2/.config/opencode/commands/plain-kit:quiet.md: removed
  fixed   /tmp/ocm-e2e6/homes/b-2/.config/opencode/commands/root-kit:hello.md: removed
```
stderr: empty. On disk after: `commands/` contains only `mine.md` (644, 64B).

**Verdict: pass.** Broken links get the distinct "broken symlink" cause and
are removed by --fix; the hand-written file survives.

---

## Step 3 — dual root: link into root B's cache namespace; doctor --fix in root A reports it, removes nothing; root B byte-identical

Home `b-3`. Root A = `$H/.config/opencode` (default), root B =
`$H/xdg/opencode` via `XDG_CONFIG_HOME=$H/xdg`.

Root A: `ocm add file:///tmp/ocm-e2e6/fixtures/root-mp` exit=0.
Root B: `HOME=$H XDG_CONFIG_HOME=$H/xdg ocm add /tmp/ocm-e2e6/fixtures/local-mp`
exit=0 (stdout ends "restart opencode to activate"; stderr carried the trust
prompt warnings and a stranded-install warning — full capture in
`/tmp/ocm-e2e6/work/b/s3-addB.{out,err}`).

`~/.cache/ocm/roots.json` after both:
```
{
  "roots": [
    "/tmp/ocm-e2e6/homes/b-3/.config/opencode",
    "/tmp/ocm-e2e6/homes/b-3/xdg/opencode"
  ]
}
```
Cache namespaces: `default-986f30/` (A) and `xdg-184290/` (B).

Hand-made link in root A pointing into root B's cache namespace:
```
ln -s $H/.cache/ocm/roots/xdg-184290/links/demo-marketplace/skills/demo-kit--code-review/SKILL.md \
      $H/.config/opencode/commands/demo-kit:cross.md
```
Root B snapshot before: `shasum` over all 50 files under `$H/xdg` and
`$H/.cache/ocm/roots/xdg-184290` (`/tmp/ocm-e2e6/work/b/s3-rootB-sha-before.txt`).

`HOME=$H ocm doctor --fix` (root A):
```
exit=1
doctor
  loader  core.js (current)
  loader  ocm-loader.js (current)
  loader  ui.js (current)
  cache   default-986f30 (/tmp/ocm-e2e6/homes/b-3/.cache/ocm/roots/default-986f30)
  error   /tmp/ocm-e2e6/homes/b-3/.config/opencode/commands/demo-kit:cross.md: symlink → /tmp/ocm-e2e6/homes/b-3/.cache/ocm/roots/xdg-184290/links/demo-marketplace/skills/demo-kit--code-review/SKILL.md ; no marketplace owns it and the target is not ocm's — remove it by hand, or re-add the marketplace
1 error, 1 warnings
```
(Wording as printed; the summary line reads "1 error, 1 warnings".)
stderr: empty.

On disk after: no `fixed` lines, both cross-root links still present, root A's
own three links untouched. Root B after:
`diff` of the before/after shasum lists — empty, `ROOT-B-IDENTICAL`
(checked twice: after `doctor` and after `doctor --fix`).

**Verdict: pass.** Doctor in root A reports the cross-root link, --fix removes
nothing, root B's tree and config are byte-identical.

Observations (not failures):
- A cross-root link named without a colon (`crossroot.md`) is not reported at
  all — doctor does not scan user-named files (same reason `mine.md` is never
  reported). Consistent with the ownership model.
- The message says "the target is not ocm's" while the target is inside ocm's
  cache (another root's namespace). Wording is imprecise; the recommended
  action (remove by hand) is the safe one either way.

---

## Step 4 — corrupt registry + doctor --fix: no finding promises a removal; nothing removed; registry byte-identical

Home `b-4`. `ocm add file:///tmp/ocm-e2e6/fixtures/root-mp` exit=0, three
command files on disk as in step 1. Registry then overwritten with
`printf 'this is not json {{{'` (shasum `f43a9cad2188e86b807e49486234fe3428d5b25a`).

`HOME=$H ocm doctor --fix`:
```
exit=1
doctor
  loader  core.js (current)
  loader  ocm-loader.js (current)
  loader  ui.js (current)
  cache   default-201a3d (/tmp/ocm-e2e6/homes/b-4/.cache/ocm/roots/default-201a3d)
  error   /tmp/ocm-e2e6/homes/b-4/.config/opencode/ocm/registry.json: not valid JSON — restore it from a backup, or remove it and re-add your marketplaces
  error   /tmp/ocm-e2e6/homes/b-4/.config/opencode/commands/root-kit:plain.md: cannot verify ownership — the registry is unreadable (see the error above)
    fix /tmp/ocm-e2e6/homes/b-4/.config/opencode/ocm/registry.json, then run ocm doctor --fix
  error   /tmp/ocm-e2e6/homes/b-4/.config/opencode/commands/plain-kit:quiet.md: cannot verify ownership — the registry is unreadable (see the error above)
    fix /tmp/ocm-e2e6/homes/b-4/.config/opencode/ocm/registry.json, then run ocm doctor --fix
  error   /tmp/ocm-e2e6/homes/b-4/.config/opencode/commands/root-kit:hello.md: cannot verify ownership — the registry is unreadable (see the error above)
    fix /tmp/ocm-e2e6/homes/b-4/.config/opencode/ocm/registry.json, then run ocm doctor --fix
4 errors, 0 warnings
```
stderr: empty.

On disk after: registry content still `this is not json {{{`, shasum unchanged
(`f43a9cad2188e86b807e49486234fe3428d5b25a`); all three command files still
present. No finding contains "removes it" or any removal promise.

**Verdict: pass.**

---

## Step 5 — collisions: install p@second --force; update first prints takeover line; remove second reports freed name

Home `b-5` first: a direct `ocm add` of a marketplace whose plugins collide
with an installed one is **refused** (exit=1), even with `--explicit` and even
after uninstalling the first's plugins:
```
plugin "plain-kit" is already provided by marketplace "fixtures-root-mp"
  plain-kit:quiet.md from marketplace "fixtures-root-mp" conflicts with plain-kit:quiet.md from marketplace "a-root-mp-tagged"
plugin "root-kit" is already provided by marketplace "fixtures-root-mp"
  root-kit:hello.md from marketplace "fixtures-root-mp" conflicts with root-kit:hello.md from marketplace "a-root-mp-tagged"
  root-kit:plain.md from marketplace "fixtures-root-mp" conflicts with root-kit:plain.md from marketplace "a-root-mp-tagged"
not adding "a-root-mp-tagged"; remove one, or ask its author to rename
```
This is the add-time guard (matches the error style in AGENTS.md), so the two
marketplaces were brought together the way it happens in the wild: both added
while disjoint, then the second's upstream introduces the colliding plugin and
`ocm update` delivers it. Fixtures built for this:
`/tmp/ocm-e2e6/fixtures/b-collideA` (plugin `shared-kit` 0.1.0) and
`/tmp/ocm-e2e6/fixtures/b-collideB` (plugin `other-kit`; a later commit adds a
rival `shared-kit` 0.2.0). Home `b-5b`.

Both adds exit=0 (marketplaces `fixtures-b-collidea`, `fixtures-b-collideb`).
After the rival commit upstream:

`HOME=$H ocm update fixtures-b-collideb`:
```
exit=0
updating fixtures-b-collideb...
  75e899e → 96c7ac9
  shared-kit   name owned by marketplace "fixtures-b-collidea" — kept disabled; ocm install shared-kit@fixtures-b-collideb --force to take over
```
stderr: empty.

`HOME=$H ocm install shared-kit@fixtures-b-collideb --force`:
```
exit=0
took over "shared-kit" from marketplace "fixtures-b-collidea"
restart opencode to activate
```
stderr: empty. On disk: `shared-kit:hello.md` now symlinks into
collideb's clone; registry shows collidea's shared-kit `enabled: false`,
collideb's `enabled: true` (jq output in the run log).

`HOME=$H ocm update fixtures-b-collidea` (the takeover line):
```
exit=0
updating fixtures-b-collidea...
  already up to date
  shared-kit: name taken over by marketplace "fixtures-b-collideb" — kept disabled; ocm install shared-kit@fixtures-b-collidea --force to take it back
```
stderr: empty. Registry after: collidea's shared-kit still `enabled: false`,
version 0.1.0; links still point at collideb.

`HOME=$H ocm remove fixtures-b-collideb`:
```
exit=0
removed marketplace "fixtures-b-collideb"
  other-kit: 1 commands removed
  shared-kit: 1 commands removed
  shared-kit@fixtures-b-collidea: the name is free again — ocm install shared-kit@fixtures-b-collidea to enable it
restart opencode to activate
```
stderr: empty. Registry after (jq): marketplaces = `["fixtures-b-collidea"]`
only; its shared-kit `enabled: false` — exactly what the line says ("to enable
it"). `commands/` is empty (correct: B's links removed, A's plugin disabled).

**Verdict: pass.** (Reached via update-introduced collision because the
add-time guard refuses the direct path — that guard itself behaves as
documented.)

---

## Step 6 — clone deleted: list --all marker and no sync age; info states cause once; --json unchanged in shape

Home `b-6`. `ocm add file:///tmp/ocm-e2e6/fixtures/root-mp` exit=0; `info
root-kit --json` and `list --all --json` captured before; clone deleted
(`rm -rf .../marketplaces/fixtures-root-mp`).

`HOME=$H ocm list --all`:
```
exit=0
fixtures-root-mp (auto, clone missing — ocm update re-clones)
  source: file:///tmp/ocm-e2e6/fixtures/root-mp
  revision: de29ae7
  plain-kit (0.1.0)
    commands: quiet.md
  root-kit (0.1.0)
    commands: hello.md, plain.md
```
stderr: empty. The clone-missing marker is present and there is no
"synced <age>" line (before deletion the same command printed
`synced just now`).

`HOME=$H ocm info root-kit`:
```
exit=0
root-kit @ fixtures-root-mp
  description  Plugin-root substitution fixture
  version      0.1.0
  enabled      yes
  installed    2026-09-23T19:52:43.134Z
  marketplace  file:///tmp/ocm-e2e6/fixtures/root-mp
  revision     de29ae7  (synced just now)
  trust        none
  marketplace clone missing (/tmp/ocm-e2e6/homes/b-6/.cache/ocm/roots/default-cac1b1/marketplaces/fixtures-root-mp) — ocm update re-clones
  components
    command root-kit:hello  → /tmp/ocm-e2e6/homes/b-6/.config/opencode/commands/root-kit:hello.md
    command root-kit:plain  (not linked)
```
stderr: empty. The cause is stated exactly once (one clone-missing line).

`HOME=$H ocm info root-kit --json`: exit=0, full output in
`/tmp/ocm-e2e6/work/b/s6-info-after.json`. Structural comparison against the
pre-deletion capture:
```
jq paths before/after: diff empty → SHAPE-IDENTICAL
jq -S . before/after:  diff empty → CONTENT-IDENTICAL
```

**Verdict: pass.**

---

## Step 7 — (46 §2) rendered command whose record is removed: reported as orphan, --fix removes it

Primary reading (home `b-7`): the plugin record that owns the rendered
command is jq-deleted while the marketplace entry stays. The rendered file
carries the marker (verified on disk in b-6):
```
<!-- ocm: rendered from plugins/root-kit/commands/hello.md @ de29ae739675b4c403f7d3841c30f4fcfe119e0d -->
```

Setup: `ocm add file:///tmp/ocm-e2e6/fixtures/root-mp` exit=0; then
`jq 'del(.marketplaces["fixtures-root-mp"].plugins["root-kit"])'` (registry
afterwards lists only `plain-kit`).

`HOME=$H ocm doctor`:
```
exit=1
doctor
  loader  core.js (current)
  loader  ocm-loader.js (current)
  loader  ui.js (current)
  cache   default-9b3544 (/tmp/ocm-e2e6/homes/b-7/.cache/ocm/roots/default-9b3544)
  error   /tmp/ocm-e2e6/homes/b-7/.config/opencode/commands/root-kit:plain.md: registry records are stale — run ocm update
  error   /tmp/ocm-e2e6/homes/b-7/.config/opencode/commands/root-kit:hello.md: no marketplace owns this file — ocm doctor --fix removes it
2 errors, 0 warnings
```
stderr: empty. Reported as an orphan: yes.

`HOME=$H ocm doctor --fix`:
```
exit=1
doctor
  loader  core.js (current)
  loader  ocm-loader.js (current)
  loader  ui.js (current)
  cache   default-9b3544 (/tmp/ocm-e2e6/homes/b-7/.cache/ocm/roots/default-9b3544)
  error   /tmp/ocm-e2e6/homes/b-7/.config/opencode/commands/root-kit:plain.md: registry records are stale — run ocm update
  fixed   /tmp/ocm-e2e6/homes/b-7/.config/opencode/commands/root-kit:hello.md: removed
  fixed   marketplace "fixtures-root-mp": re-materialized 1 component(s) (restart opencode to activate)
1 error, 0 warnings
```
stderr: empty.

On disk after --fix: `root-kit:hello.md` is **back** (644, 291B, same rendered
content and marker), while the registry still has no `root-kit` record
(`jq '.marketplaces["fixtures-root-mp"].plugins | keys'` → `["plain-kit"]`).
A second `doctor` reports the same orphan again and a second `doctor --fix`
reproduces the same remove-then-re-materialize cycle verbatim (captures:
`s7-doc2.out`, `s7-fix2.out`). Doctor never reaches exit 0 in this state.

**Verdict: fail** — see finding F-B1.

Secondary reading (home `b-7b`, for completeness): only the command's
component/hash entries removed from the plugin record
(`components.command = ["plain.md"]`), plugin record kept. `ocm doctor`
exit=0, **no findings at all** — the rendered `root-kit:hello.md` is not
reported as an orphan under this reading. Reported as an observation; the
primary reading above is the one scored.

---

## Findings

- **F-B1 (medium, step 7 / brief 46 §2):** `ocm doctor --fix` removes the
  orphaned rendered command and re-materializes it in the same run, forever.
  Test, expected, actual, impact below in the run summary.
- **F-B2 (low, step 1 observation):** with a local-path marketplace whose
  registry entry is gone, `doctor --fix` does not remove the orphaned
  symlinks; it tells the user to remove them by hand. Safe, but the brief's
  "--fix removes exactly those" holds only for git/file:// installs whose
  links point into ocm's cache.
