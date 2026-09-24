# Reference

How an ocm installation behaves: what materializes where, when changes
become visible, exit codes, precedence, config safety, trust, the loader,
the TUI, and migration. For writing a marketplace, see
[authoring.md](authoring.md).

## How it works

```
github.com/you/my-marketplace     single source of truth (markdown + manifests)
        │
   ocm add (clone to ~/.cache/ocm/marketplaces/<name>)
        │
        ├── commands   → ~/.config/opencode/commands/<plugin>:<command>.md
        ├── agents     → ~/.config/opencode/agents/<plugin>:<agent>.md
        ├── skills     → ~/.cache/ocm/links/<mp>/skills/<plugin>--<skill>/SKILL.md
        │                (rendered: name rewritten to <plugin>:<skill>)
        │                + one skills.paths entry in global opencode.json
        ├── js plugins → ~/.config/opencode/plugins/ocm--<plugin>--<file>.js
        └── mcp        → ocm--<plugin>--<server> keys in global opencode.json
        │
   ocm-loader.js (global plugin)  syncs on opencode start, throttled
                                  per marketplace
```

No file copying into projects. Update the repo — every project picks it up on
the next opencode start.

## Changes apply on the next opencode start

opencode reads commands, agents, skills, plugins and MCP config **once at
startup**. There is no reload API: nothing ocm does — install, uninstall,
update — can make a change visible in a session that is already running.
Every ocm operation that materializes something ends with:

```
restart opencode to activate
```

The loader's startup sync exists to make the *next* start current, not the
current one. This is a verified property of opencode, not a choice — see
[opencode-contract.md](opencode-contract.md) for what was checked
against which opencode version.

## Per-plugin install

```bash
ocm add https://github.com/user/my-marketplace   # clone + register
ocm add ~/plugins/my-marketplace                 # local dir, never written to
ocm add <url> --explicit                         # register nothing until asked
ocm install commit-tools                         # enable one plugin
ocm install commit-tools@my-marketplace          # … disambiguated
ocm uninstall commit-tools                       # disable, keep the record
ocm mode my-marketplace explicit                 # change how new plugins land
ocm list [--all] [--json]                        # what is installed
ocm search <query>                               # search cached metadata
ocm info <plugin>[@<marketplace>]                # one plugin's record
ocm update [marketplace]                         # pull + re-materialize
ocm pin <name> <ref>                             # follow a branch or tag
ocm pin <name> --clear                           # back to the default branch
ocm remove my-marketplace                        # full teardown
ocm scan <url|path|plugin>                       # dry run
ocm validate [path]                              # lint a marketplace repo
ocm doctor [--fix]                               # diagnose this installation
ocm init                                         # reinstall the auto-sync loader
ocm loader uninstall                             # remove the auto-sync loader
```

`ocm add` expands a leading `~` itself, so `ocm add "~/plugins/my-marketplace"`
works whether or not the shell expands it; relative paths are resolved to an
absolute real path before anything is written.

A marketplace with ten plugins and two installs is the normal case. In `auto`
mode (the default) every discovered plugin is enabled on add and new upstream
plugins install as they appear; `--explicit` (or `ocm mode <mp> explicit`)
installs nothing until you name it. `uninstall` keeps the record, so
re-installing is instant and offline.

## Exit codes

`0` success, `1` failure — and three distinctions that matter to scripts:

- `ocm install` / `ocm add` exit 1 when a component was withheld by a file
  ocm does not own — a partial install; `--force` takes it over. A
  trust-blocked component is not partial (exit 0): the rest of the plugin
  installed, the executable waits for `ocm trust`.
- `ocm update` keeps exit 0 for a standing skip — a component still
  withheld by a file ocm does not own is a warning, not a partial install.
- `ocm doctor` exits 1 on any error finding; warnings alone exit 0.

## Precedence

- **Project beats global.** ocm installs at user-global scope only; a
  project's own `.opencode/` always wins over anything ocm installed.
- **ocm never writes into `~/.claude`, `.claude`, `~/.agents` or `.agents`.**
  Those paths belong to other tools.
- **Hand-authored files beat marketplace-installed ones.** ocm never
  overwrites a file it does not own: a collision is reported and skipped;
  `ocm install --force` takes over and names the displaced path (the file
  moves to `~/.cache/ocm/roots/<slug>/displaced/`, it is never deleted;
  `ocm doctor` prints the exact directory).
- **Plugin names are globally unique across marketplaces.** Adding a
  marketplace that ships an already-provided name fails with both sources
  named; an upstream collision registers the newcomer disabled — the
  incumbent is never displaced.
- **No ordering promise between JS plugins.** opencode loads
  directory-discovered plugins in filesystem order; two plugins hooking the
  same event both run, in unspecified order.
- **A failing marketplace is isolated.** A failed pull records
  `lastSync.ok = false` and leaves that marketplace's links intact; every
  other marketplace still syncs.

## Config safety

- **Atomic writes, ocm's keys only.** Every ocm write to `opencode.json`,
  `tui.json` and the registry is atomic (temp file + rename) and touches
  only keys ocm owns: `ocm--*` prefixes, ocm's own `skills.paths` entries,
  and the single `tui.json` plugin entry. Your own keys survive
  byte-identically outside those.
- **Re-serialization is real and stays.** When ocm does write one of these
  files, it re-serializes it with 2-space indentation, preserving key order
  and content exactly. A diff-averse user sees a whitespace-only diff the
  first time ocm touches their config; this is inherent to the atomic-write
  design and will not change.
- **A config that does not parse is never rewritten.** ocm warns and prints
  the exact manual edit instead.
- **A read-only config is never bypassed.** The mutation is refused before
  any write — `chmod +w` the file, then re-run. A command refuses only over
  the files it would actually touch: `ocm add`, `ocm update`, `ocm init` and
  `doctor --fix` write `tui.json`; every mutation that materializes or
  removes a skill or an MCP server writes `opencode.json`. So a read-only
  `tui.json` stops an `add` and lets an `install` through — by design.
- **One writer at a time.** Every mutating command takes an exclusive lock
  at `~/.config/opencode/ocm/registry.lock` and holds it for the whole
  command; a second ocm waits up to 10 s, then refuses naming the holder's
  pid. The loader's startup sync never waits — it skips entirely and stays
  due for the next start. A lock whose holder is gone, older than 10
  minutes, or unreadable is broken with a warning.
- **The cache is namespaced per config root.** Clones, skill link trees and
  displaced originals live under `~/.cache/ocm/roots/<slug>/`, one namespace
  per config root (`ocm doctor` prints the slug), so two config roots
  referencing the same marketplace never interact — at the cost of one clone
  per root per marketplace. `roots.json` and the sync stamp stay global.

## Platform

- **The config root follows opencode exactly.** ocm resolves the opencode
  config root as `$XDG_CONFIG_HOME/opencode` when `XDG_CONFIG_HOME` is set
  and non-empty, else `~/.config/opencode`; a relative value is joined, not
  resolved, and `ocm doctor` warns about it. `~/.cache/ocm` always follows
  `$HOME` and never moves. `OPENCODE_CONFIG_DIR` is ignored — opencode
  appends to the config with it, it does not relocate the global config. If
  the variable changes between shells, ocm reports the stranded install (an
  error from `ocm doctor`, a stderr notice from mutating commands) and never
  migrates it; recovery is re-adding the marketplaces or unsetting the
  variable.
- **Names must not differ only in case.** Plugin directory names, and the
  component files within a plugin — commands, agents, skills, plugin JS
  files — must not contain names that differ only in case. They are refused
  at `ocm add`, reported by `ocm validate`, and skipped or stopped at
  update. This holds on every platform, not just case-insensitive
  filesystems, because plugin names are lowercased. MCP server keys are
  exempt — they are JSON keys, with no filesystem behind them.

## Trust

JS plugins and MCP servers execute. They materialize only after you approve
their marketplace (`ocm trust <name>`); until then they are reported as
`blocked (untrusted)` while the rest of the plugin installs normally.
`ocm untrust` revokes and removes them. A grant is fingerprinted per
component — an upstream change to an executable component re-blocks it until
re-approved.

The prompt offers three answers:

- **`y`** — grant. The listed components are linked and run from the next
  opencode start.
- **`N`** — deny. A decline at first sight (add time) denies the whole
  marketplace: every executable component stays blocked. A decline of a
  changed-code re-prompt denies only the new or changed components — what the
  existing grant still covers keeps running — and the same change never
  prompts again.
- **`skip`** — decide nothing this run. The components stay blocked, and the
  question returns only when something new arrives.

`ocm trust <name> --yes` grants without reading stdin, exactly as an
interactive `y` — the scriptable path. Without a TTY and without `--yes`,
`ocm trust` prints the question, then
`stdin is not interactive — re-run with --yes to grant`, and exits 1.

## Loader (auto-sync)

`ocm add` installs `~/.config/opencode/plugins/ocm-loader.js` — the only ocm
file in that directory — plus the runtime core and the TUI plugin under
`~/.config/opencode/ocm/`. Your `opencode.json` gains nothing but a
`skills.paths` entry; `tui.json` gains the single `./ocm/ui.js` plugin entry.

On every opencode start the loader:

1. pulls each git marketplace (shallow-clone safe), throttled to once an hour
   per marketplace by default — `syncIntervalMs` per marketplace or
   `OCM_SYNC_INTERVAL_MS` globally; `OCM_SYNC_DISABLE=1` turns sync off;
2. re-materializes links, so newly added or removed upstream plugins are
   picked up;
3. records `lastSync` per marketplace — a failed pull is recorded and never
   touches that marketplace's links. A sync's warnings are stored with it
   and shown by `ocm list` (stderr) and `ocm doctor` (as warnings) until
   the next sync replaces them.

The startup sync is fire-and-forget: it serves long-lived sessions, where the
fetch finishes in the background long before it matters. A short-lived
invocation — `opencode run`, `opencode debug config` — may exit before the
sync completes, leaving `lastSync` untouched. `ocm update` is the
deterministic path when a sync must have happened.

A sync makes the *next* opencode start current. Remove the loader any time
with `ocm loader uninstall` — it takes the TUI plugin and its `tui.json`
entry with it, deleting `tui.json` itself only when ocm created it and
nothing else remains.

## TUI integration (`/ocm`)

`ocm init` also installs a TUI plugin under `~/.config/opencode/ocm/` and
registers it in `~/.config/opencode/tui.json` — the only entry ocm owns in
that file; theme, keybinds and other user settings are preserved. Restart
opencode, then type `/ocm` in the prompt: browse plugins across marketplaces,
update all of them, or update one marketplace. `OPENCODE_PURE=1` disables the
TUI plugin along with all other external plugins.

## Migration

Any `ocm` command — including `ocm doctor` — automatically migrates an
installation from the earlier layouts: loader files move from `plugins/` to
`ocm/`, the registry upgrades to v2 with marketplace-relative sources, the
global sync stamp folds into per-marketplace `lastSync`, skills relink under
namespaced names (the one breaking change — see
[Naming](authoring.md#breaking-change-skill-names)), and legacy `ocm--<mp>`
containers are removed. The migration is idempotent, prints one line per
thing moved, and never touches files ocm does not own.
