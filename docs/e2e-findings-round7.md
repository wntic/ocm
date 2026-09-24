# e2e round 7 — the v0.9.0 surface (targeted)

Plan: `.work/briefs/T7`-series plan `T6-round7.md` (deleted once stable).
Build under test: main's `ocm` at merge commit `efcbafc` ("Merge pull
request #34 from wntic/work/36-display-and-tui"), package version 0.8.0
(brief 36 rides unreleased), run via `/tmp/ocm-e2e6/bin/ocm` with the HOME
guard; `ocm071` is the published 0.7.1 baseline. Homes: `/tmp/ocm-e2e6/
homes/r7-*`; verbatim stream captures under `/tmp/ocm-e2e6/r7/`.

Scope: **brief 36 only** (`.work/briefs/36-display-and-tui.md`) — §1
width, §2 one spelling, §3 matched annotations, §5 trust wording, §6
startup-sync voice (F222) — plus the v0.8.0 exit-code regression check.
The TUI (§4) is **out of scope**: a human checks it against brief 36's
manual checklist. The bar: **v0.9.0 ships when no high and no medium is
found.**

Harness notes. Pty runs used `script -q /dev/null zsh -c 'stty cols N
rows M 2>/dev/null; HOME=$H ocm …'`; `stty size` inside the pty confirmed
the geometry before every capture. `script` prepends a `^D\b\b` artifact
to the first line and emits CRLF endings — both are harness artifacts,
stripped for the line-length measurements below and visible in the raw
captures. Piped runs used both `| cat` and `>` redirect; the two are
byte-identical (`cmp`) for every verb, so "piped" covers both.

## Verdict table

| Step | Scenario | Verdict |
|---|---|---|
| 1 | width: `list --all`, `search`, `info` piped / pty 80 / pty 200 | pass — piped never wrapped; pty lines within width except info's whole-path continuations (F280, per brief 36 §1 rule 4); nothing cut off mid-name |
| 2 | one spelling across `list`, `search`, `info` | pass for list↔search (verbatim-identical component names); info differs for plugin/mcp components (F281, outside brief 36 §2's stated scope) |
| 3 | `matched:` annotation on a plugin-name + component-name query | pass |
| 4 | trust wording: `n/a` / `none` / `none` with dir deleted | pass |
| 5 | F222 startup sync voice: stored warning → list stderr → doctor warning, exit 0 → clean update clears | pass |
| 6 | v0.8.0 exit codes: partial install exit 1, clean install exit 0 | pass |

## Step detail

### 1 — Width (brief 36 §1), home `r7-1` (root-mp + many-mp, all plugins auto-installed)

Piped (`| cat`, byte-identical to redirect): one logical line per record
everywhere — `search` keeps the description on the head line
(`many-kit@many-mp  0.1.0  Plugin shipping 25 skills for timing`), `list
--all` keeps all 25 skills on one line, `info` keeps `type name → target`
on one line. Never wrapped. `--json` untouched by this step's checks.

Pty at 80 columns (content lengths, artifacts stripped):

- `ocm list --all`: max line 75. The 25-skill line wraps with a hanging
  indent two deeper than its own (label line at 4, continuations at 6),
  breaking only at the comma boundaries — all 25 names present, none cut
  mid-name.
- `ocm search skill`: max line 38. With a supplementary 178-char
  description (fixture `r7-longdesc-mp`, home `r7-1b`): head line
  `wordy-kit@r7-longdesc-mp  0.1.0`, description wrapped beneath at
  indent 2 with continuations at 4, max line exactly 80.
- `ocm info root-kit`: max line 78; `→ <target>` moved to an indented
  continuation line, type and name together.
- `ocm info many-kit`: the `→ <path>` continuation lines are 115
  characters — the path is a single unbreakable token longer than the
  budget, printed whole per brief 36 §1 rule 4. This is the only line
  class that exceeds 80; see F280. All 25 skills and the command are
  present, nothing elided.

Pty at 200 columns: `list --all` max 191, `search` max 184 (long
description), `info many-kit` max 140, `info root-kit` max 100 — all
within 200.

### 2 — One spelling (brief 36 §2), homes `r7-1`, `r7-4b`

`list` and `search` print verbatim-identical component names through the
shared renderer — commands and agents drop `.md`, skills keep their
relative path, plugin files keep `.js`, mcp names bare:

- list `    commands: hello, plain` / search `  commands: hello, plain`
- list `    commands: quiet` / search `  commands: quiet`
- list `    plugins: notify.js, other.js` / search `  plugins: notify.js, other.js · mcp: exec-mcp`
- list `    mcp: exec-mcp` (both homes)

`info` spells commands and skills with its documented per-component shape
(`command root-kit:hello`, `skill   many-kit:skill-01` — the invocation
name; bare name identical), but spells plugin and mcp components as their
opencode key names (`plugin  ocm--exec-kit--notify.js`, `mcp
ocm--exec-kit--exec-mcp`) where list/search say `notify.js` / `exec-mcp`.
Brief 36 §2 unified "both verbs" (list and search) and did not list
`info.ts` among its consumers; the plan asked for all three. F281, low.

### 3 — Matched annotations (brief 36 §3), home `r7-3` (fixture `r7-parse-mp`: plugin `parse` shipping `commands/parse.md`)

`ocm search parse` (piped, exit 0):

```
parse@r7-parse-mp  0.1.0  Plugin whose command shares the plugin name
  matched: commands/parse
```

Rank-0 plugin-name match **and** the component annotation — the F122
suppression is gone. `search parse --json` carries `"matched":
["commands/parse"]` with no shape change. Non-colliding queries keep
their current behaviour (`search root-kit` → component summary;
`search quiet` → `matched: commands/quiet`). In a pty at 80 the same
output wraps the description beneath the head line, `matched:` intact.

### 4 — Trust wording (brief 36 §5), homes `r7-1`, `r7-4`

- Marketplace with no executable components (`ocm info many-kit`,
  `info root-kit`, `info plain-kit`): `  trust        n/a — no executable
  components`. `ocm list` prints no trust word for such marketplaces at
  all — nothing left to misread as "untrusted".
- `exec-mp` added, trust declined (home `r7-4`): `  trust        none` —
  the real undecided state, unchanged.
- Marketplace directory then deleted: still `  trust        none`, plus
  the clone-missing line
  (`  marketplace clone missing (/private/tmp/ocm-e2e6/fixtures/r7-exec-mp) — restore the directory, or run ocm remove r7-exec-mp`).
  The tree is not read to make a claim about it.
- `info --json` keeps the raw enum: `"trust": "none"` in both the
  no-executable and the untrusted cases.

### 5 — Startup sync voice (brief 36 §6, F222), home `r7-5`

Setup: `nomanifest-mp` copied to `fixtures/r7-nomanifest-mp`; registry
pre-seeded 0.7.1-era (rounds 4–5 technique — `ocm071 add` refuses a
manifest-less marketplace outright, so no CLI path can produce the
state), then `ocm071 install ancient-kit@r7-nomanifest-mp` (exit 0,
"repaired 1 link") and `ocm071 update` (exit 0, "change tracking
initialized") — ancient-kit linked and its digest baselined
(`commands/old.md: d83658…`, matching round 5's record). Main's `ocm
list` then refreshed the loader:
`refreshed the auto-sync loader: 0.7.1 → 0.8.0 (restart opencode to activate)`.

The plugin's `commands/old.md` was edited, `lastSync` cleared (the
throttle), and `HOME=$H opencode debug config` run from `$H`. On disk
afterwards: registry `plugins` map empty, `commands/` empty, and

```
$ jq -r '.marketplaces["r7-nomanifest-mp"].lastSync.warnings[]' registry.json
plugin "ancient-kit": changed upstream and still has no plugin.json — uninstalled
  it predates the plugin.json requirement and kept working until it changed
  add plugins/ancient-kit/plugin.json ({ "description": "…" }) and run ocm update to reinstall it
```

`ocm list` (exit 0) prints it beneath the marketplace row on stderr,
prefixed `warning:` — stdout carries only the marketplace row. `ocm
doctor` (exit 0) reports it as a warning finding and the exit code is
not raised:

```
  warning marketplace "r7-nomanifest-mp": last sync warned: plugin "ancient-kit": changed upstream and still has no plugin.json — uninstalled
  it predates the plugin.json requirement and kept working until it changed
  add plugins/ancient-kit/plugin.json ({ "description": "…" }) and run ocm update to reinstall it
0 errors, 1 warning
```

After adding `plugin.json` (the warning's own remedy) and a clean
`ocm update r7-nomanifest-mp` (exit 0, `ancient-kit   installed (auto)`),
`lastSync.warnings` is `[]` and `ocm list` is silent again — the stored
warnings were replaced, not accumulated.

Observation, not a finding: in the dropping session itself,
`opencode debug config`'s snapshot still listed `ancient-kit:old` — the
async startup sync (`void core.syncAll(...)`) raced the config read, and
nothing reloads in-session. The on-disk state after the session is
correct (link gone, record gone); this is the documented async design,
and the warning is exactly the voice brief 36 §6 gives it.

### 6 — v0.8.0 exit-code regression (T5 c1), home `r7-6`

Hand-written `commands/root-kit:hello.md` standing, then
`ocm install root-kit` → **exit 1**:

```
--stdout--
installed root-kit@root-mp partially — 1 component withheld
restart opencode to activate
--stderr--
  warning: skipped /tmp/ocm-e2e6/homes/r7-6/.config/opencode/commands/root-kit:hello.md: not managed by ocm — re-run with --force to displace it
```

The hand-written file is byte-identical (`shasum -c` OK). With the file
removed, `ocm install root-kit` → **exit 0**
(`repaired 1 link for root-kit@root-mp` — the rendered command
re-materialized with its `ocm: rendered from` marker).

## Findings

### F280 — `ocm info`'s `→ <target>` continuation lines exceed the 80-column budget; the plan's width check and brief 36 §1 rule 4 disagree

- **Test:** step 1 — `ocm info <plugin>` in a pty at 80 columns (home
  `r7-1`, `info many-kit`).
- **Command:** `script -q /dev/null zsh -c 'stty cols 80 rows 24; HOME=$H ocm info many-kit'`.
- **Expected:** the plan's step 1: "in a pty no line exceeds the width".
- **Actual (verbatim, longest line, 115 chars):**
  ```
        → /tmp/ocm-e2e6/homes/r7-1/.cache/ocm/roots/default-49c783/links/many-mp/skills/many-kit--skill-01/SKILL.md
  ```
  Every over-width line is a `→ <absolute path>` continuation whose path
  is a single unbreakable token longer than the budget.
- **Impact:** none on users — brief 36 §1 rule 4 explicitly requires
  this ("a path … longer than the budget is printed whole on its own
  line, even if it exceeds the budget — a broken path is not
  copy-pasteable"). The code follows the brief; the plan's check
  over-stated it. Every wrappable line is within width; nothing is
  broken mid-token.
- **Severity:** low.

### F281 — `ocm info` spells plugin and mcp components as opencode key names where `list` and `search` spell them `notify.js` / `exec-mcp`

- **Test:** step 2 — the same component spelled identically in `list`,
  `search` and `info` (home `r7-4b`, exec-mp trusted).
- **Command:** `HOME=$H ocm list` / `ocm search exec-kit` / `ocm info exec-kit`.
- **Expected:** the plan's step 2: "The same component is spelled
  identically in `list`, `search` and `info`".
- **Actual (verbatim):**
  ```
  list:    plugins: notify.js, other.js
  search:  plugins: notify.js, other.js · mcp: exec-mcp
  info:    plugin  ocm--exec-kit--notify.js  → …/plugins/ocm--exec-kit--notify.js
           mcp     ocm--exec-kit--exec-mcp  → …/opencode.json (mcp)
  ```
  Commands and skills agree across all three verbs (bare names
  identical; info qualifies them with the `plugin:` prefix — its
  documented per-component shape). Plugin files and mcp servers do not.
- **Impact:** cosmetic — info's spelling is the actual on-disk file /
  config-key name, so it is not false, merely different. Brief 36 §2
  unified exactly two verbs ("become the single renderer both verbs
  call") and did not list `info.ts` among its consumers, so this is a
  plan-vs-brief scope difference, not a regression: list↔search, the
  F115 pair, are verbatim-identical.
- **Severity:** low.

## Bar

No high and no medium found. Two lows (F280, F281), both plan-vs-brief
wording differences rather than behaviour defects; neither blocks.

v0.9.0 bar: MET

---

## Resolution (owner, 2026-09-24)

- **F280** — by design: brief 36 §1 keeps a path whole rather than break
  it, and the plan's "no line exceeds the width" over-stated the rule.
- **F281** — low; backlog.
- Spot-checked on the round's homes: the F222 chain's stored warning is
  quoted verbatim, and the registry now holds `warnings: []` after the
  plan's final clean update — as specified.
- **Not covered by this round:** brief 36 §4, the `/ocm` details view at
  80×24 (F124). It needs the brief's manual checklist in a real terminal,
  and is the one open item before v1.0.0.

**v0.9.0 bar: MET.**
