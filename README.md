# ocm — file-based plugin marketplace for opencode

Distribute **skills, agents, commands, JS plugins and MCP servers** for
[opencode](https://opencode.ai) via plain git repositories. Installed once at
user-global scope — available in **every project**, even without `.opencode/`
or `.claude/` directories.

## Install

```bash
bunx @wntic/ocm add https://github.com/you/my-marketplace
# or, for the `ocm` binary on PATH:
bun install -g @wntic/ocm
ocm add https://github.com/you/my-marketplace
```

The npm package is `@wntic/ocm`; the binary it installs is `ocm`. Requires
[opencode](https://opencode.ai), git and [bun](https://bun.com).

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
[docs/opencode-contract.md](docs/opencode-contract.md) for what was checked
against which opencode version.

## Naming

Commands and agents are namespaced by plugin:
`plugins/adw/commands/commit.md` becomes `/adw:commit` in the opencode TUI,
`plugins/adw/agents/reviewer.md` becomes `adw:reviewer`.

Plugin directory names become those namespaces, so they must be kebab-case
(`^[a-z0-9]+(-[a-z0-9]+)*$`) and at most 64 characters. One marketplace
shipping the same command or agent name from two plugins is a validate
error — first-come-wins would silently shadow one at the user's expense.

Skills are named by their **frontmatter `name`**, not their folder. ocm
therefore renders each installed skill into its own mirror directory with the
name rewritten to `<plugin>:<skill>` — `adw:python-style`. Two skills whose
namespaced names collide (both produce `adw:style`) are a validate error.
opencode never lists skills in the `/` autocomplete by design — skills are
invoked by the model through the `skill` tool, or browsed via the `/skills`
picker.

### Breaking change: skill names

Earlier versions symlinked a plugin's whole `skills/` directory, so an
installed skill kept its own name (`python-style`). Skills now install under
their namespaced name (`adw:python-style`). If you referenced an installed
skill by name — in a project file or a prompt — update the reference. The
automatic migration (below) prints the old → new mapping when it relinks.

## Marketplace repository format

```
my-marketplace/
├── .opencode-plugin/
│   └── marketplace.json      # optional
└── plugins/
    ├── demo-kit/
    │   ├── plugin.json           # required
    │   ├── commands/
    │   │   └── tdd.md            # → /demo-kit:tdd
    │   ├── commands.claude/      # Claude Code sibling, ignored by ocm
    │   │   └── tdd.md
    │   ├── agents/
    │   │   └── reviewer.md       # → demo-kit:reviewer
    │   ├── skills/
    │   │   └── code-review/
    │   │       └── SKILL.md      # skill "demo-kit:code-review"
    │   ├── plugin/
    │   │   └── notify.js         # opencode server plugin (trust-gated)
    │   ├── mcp.json              # mcp servers (trust-gated)
    │   └── scripts/, templates/  # supporting files, never materialized
    └── release-kit/
        └── …                     # a second plugin, same rules
```

A working example with two plugins ships in [template/](template/). A
marketplace is any git repo with `plugins/<name>/`. Every directory under
`plugins/` with at least one component is a plugin — plugin.json is required
in every one of them, with a non-empty `description`; a plugin without it
is refused by `ocm add`, `ocm update` and `ocm validate` (already-installed
plugins keep working; `ocm doctor` tells you which need a manifest). A
directory whose only content is a `plugin.json` is not a plugin and nothing
installs from it, but `ocm validate` reports it — either the manifest is
wrong or the components are missing — and `ocm add` names it when refusing
the tree.

`command`/`commands`, `agent`/`agents`, `skill`/`skills` and `plugin`/`plugins`
are all accepted (singular matches opencode's own globs); a name clash between
the singular and plural form of the same type is an error. `ocm validate`
also warns on likely typos — `skill/` beside `skills/`, a `plugin.ts` at the
plugin root, `SKILLS.md`.

### Cross-tool authoring

Unsuffixed directories are opencode's. A `commands.claude/` sibling holds the
Claude Code form of the same command; ocm ignores it, Claude Code reads it
through its own manifest. `skills/` is shared unchanged between the tools —
keep skill frontmatter to the portable subset (`name`, `description`,
`license`, `compatibility`, `metadata`); `ocm validate` warns on anything
else. A SKILL.md whose frontmatter has no `name` or no `description` is an
error — the description is what the model reads to decide whether to load
the skill, and it must be 1-1024 characters. Command bodies that reference
supporting scripts use
`"${OCM_PLUGIN_ROOT}/plugins/<name>/scripts/…"` — the loader exports
`OCM_PLUGIN_ROOT` (and `CLAUDE_PLUGIN_ROOT` as an alias) pointing at the
marketplace root.

**Where those variables are set.** The loader exports them through
opencode's `shell.env` hook, which fires when opencode spawns a shell for
the model's bash tool. They are therefore available to a script the model
runs, and **not** inside a command template's `!` block — opencode's
template engine does not call the hook. With more than one marketplace
added, only the per-marketplace forms (`OCM_PLUGIN_ROOT_<MARKETPLACE>`,
the name upper-cased with `-` as `_`) are set: a flat name cannot say which
root it means. A command that must reference a script path inside a `!`
block should instruct the model to run the script instead.

### Command and agent frontmatter

Every file in `commands/` or `agents/` is a YAML frontmatter block plus a
body — the body is the template opencode runs, and an empty body is a
validate error: opencode requires the template. description is required
(opencode rejects a command without it); the other recognized fields are
`agent`, `mode`, `tools`, `model`, `extension`, `allowed-tools` and
`$schema`. `model` takes opencode's `provider/model` form
(`anthropic/claude-sonnet-4-5`); **omit it to inherit the session's model**.
A bare model name, or Claude Code's `model: inherit`, is parsed as a
provider and fails at runtime with `Model not found: inherit/.` — the agent
silently falls back to a general one. A file with no frontmatter at all is a warning. A frontmatter
value containing an unquoted `": "` is an error — strict YAML rejects it
even where opencode's lenient parser would rescue it; quote the value. A
body using `!` shell substitution draws a warning, because `ocm info`
surfaces the plugin as shell-executing.

A complete command file:

```markdown
---
description: commit helper
model: anthropic/claude-sonnet-4-5
allowed-tools:
  - Read
  - Bash
---

Run the tests, then commit with a conventional-commit message.
```

### `marketplace.json`

The manifest lives at `.opencode-plugin/marketplace.json`. A root
`marketplace.json` still works — `ocm validate` warns — but new marketplaces
should use the new location.

```json
{
  "$schema": "https://raw.githubusercontent.com/wntic/ocm/main/schema/marketplace-v1.json",
  "name": "my-marketplace",
  "description": "Team plugin catalog",
  "owner": { "name": "…", "email": "…", "url": "…" },
  "homepage": "https://…",
  "renames": { "old-plugin": "new-plugin", "dead-plugin": null },
  "plugins": [
    {
      "name": "demo-kit",
      "source": "./plugins/demo-kit",
      "description": "…",
      "version": "1.2.0",
      "defaultEnabled": true,
      "mcpServers": "./mcp.json"
    }
  ]
}
```

Only a plugin entry's `name` and `source` are required. `source` is a
./-relative path inside the marketplace — it says where the plugin is; a
source that does not resolve, or escapes the marketplace with `../`, is a
validate error, and so is a plugin listed twice in `plugins[]` (the first
entry silently wins otherwise). `mcpServers` is ./-relative, resolving
inside the plugin directory — it says what is in the plugin. `../` and
absolute paths are rejected; the marketplace repo is the distribution
unit. `defaultEnabled:
false` keeps a plugin disabled in an `auto` marketplace.

### `plugin.json`

Required in every plugin directory; one that exists but does not parse is a
validate error — fix it or remove it; ocm requires this file to be readable.
`description` is required — a non-empty string of at most 200 characters; it
is what `ocm search` and the TUI show.
`name` is optional and, when present, must equal the directory name.
`$schema` is recommended — pin it to the Agent Plugins schema so other tools
can read the manifest too. Otherwise the same fields as a `plugins[]` entry,
minus `source`, `defaultEnabled` and `mcpServers` — a plugin directory is
self-describing when vendored or read on its own. When the version disagrees
between the two manifests, validate warns. Metadata precedence:
marketplace entry > `plugin.json` > filesystem inference (name from the
directory, components from the scan).

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "description": "One command, agent, skill, plugin and mcp server — the demo kit"
}
```

### Category and tags

`category` (a string) and `tags` (an array of strings) ride under
`extensions["dev.wntic.ocm"]` in plugin.json:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "description": "One command, agent, skill, plugin and mcp server — the demo kit",
  "extensions": {
    "dev.wntic.ocm": { "category": "testing", "tags": ["tdd", "review"] }
  }
}
```

They surface in `ocm search` matching, `ocm info` and the TUI grouping. The
values are free-form strings — there is no closed set, and validate does not
check them in the `extensions` form. A top-level `category` or `tags` is
legacy: validate warns and the `extensions` form wins.

### JS plugins and MCP servers

`plugin/*.{js,ts}` are opencode server plugins. They execute, so they
materialize only after trust is granted for their marketplace — until then
they are reported as `blocked (untrusted)`. Each must default-export
`{ id, server }` (see `template/plugins/demo-kit/plugin/notify.js`).

`mcp.json` uses exactly opencode's `mcp` entry shape: `"type": "local"`
with a `command` array of strings, or `"type": "remote"` with a `url`. An
omitted `enabled` is normalised to `true` at the write; an entry
missing "type" — or the pre-1.18 `command`/`args` form — is a validate
error, and ocm blocks it at install with a warning rather than writing
it, because opencode refuses to start over it:

```json
{
  "time": { "type": "local", "command": ["date"], "enabled": true }
}
```

Both are namespaced under ocm's ownership prefix: JS plugins link as
`~/.config/opencode/plugins/ocm--<plugin>--<file>`, MCP servers as
`ocm--<plugin>--<server>` keys in the global `opencode.json`. MCP components
are trust-gated too — a local server is a command line ocm caused to run.
The user's own `mcp` keys are preserved.

Every rule `ocm validate` enforces is stated in this section: validate
enforces the documented contract, nothing else. A disagreement between the
README and a validate finding is a bug in one of the two.

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
namespaced names (the one breaking change, above), and legacy `ocm--<mp>`
containers are removed. The migration is idempotent, prints one line per
thing moved, and never touches files ocm does not own.

## Requirements

- [opencode](https://opencode.ai)
- git
- [bun](https://bun.com) (to run the CLI)

## License

MIT
