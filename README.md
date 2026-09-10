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

Skills are named by their **frontmatter `name`**, not their folder. ocm
therefore renders each installed skill into its own mirror directory with the
name rewritten to `<plugin>:<skill>` — `adw:python-style`. opencode never
lists skills in the `/` autocomplete by design — skills are invoked by the
model through the `skill` tool, or browsed via the `/skills` picker.

### Breaking change: skill names

Earlier versions symlinked a plugin's whole `skills/` directory, so an
installed skill kept its own name (`python-style`). Skills now install under
their namespaced name (`adw:python-style`). If you referenced an installed
skill by name — in a project file or a prompt — update the reference. The
automatic migration (below) prints the old → new mapping when it relinks.

## Marketplace repository format

```
my-marketplace/
├── marketplace.json              # optional
└── plugins/
    ├── demo-kit/
    │   ├── plugin.json           # optional
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
`plugins/` with at least one component is an installable plugin, manifest or
not — manifests add metadata, they never hide a plugin.

`command`/`commands`, `agent`/`agents`, `skill`/`skills` and `plugin`/`plugins`
are all accepted (singular matches opencode's own globs); a name clash between
the singular and plural form of the same type is an error.

### Cross-tool authoring

Unsuffixed directories are opencode's. A `commands.claude/` sibling holds the
Claude Code form of the same command; ocm ignores it, Claude Code reads it
through its own manifest. `skills/` is shared unchanged between the tools —
keep skill frontmatter to the portable subset (`name`, `description`,
`license`, `compatibility`, `metadata`); `ocm validate` warns on anything
else. Command bodies that reference supporting scripts use
`"${OCM_PLUGIN_ROOT}/plugins/<name>/scripts/…"` — the loader exports
`OCM_PLUGIN_ROOT` (and `CLAUDE_PLUGIN_ROOT` as an alias) pointing at the
marketplace root.

### `marketplace.json`

```json
{
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
`./`-relative path inside the marketplace — `../` and absolute paths are
rejected; the marketplace repo is the distribution unit. `defaultEnabled:
false` keeps a plugin disabled in an `auto` marketplace.

### `plugin.json`

The same fields as a `plugins[]` entry, minus `source`, `defaultEnabled` and
`mcpServers` — a plugin directory is self-describing when vendored or read on
its own. Metadata precedence: marketplace entry > `plugin.json` > filesystem
inference (name from the directory, components from the scan).

### JS plugins and MCP servers

`plugin/*.{js,ts}` are opencode server plugins. They execute, so they
materialize only after trust is granted for their marketplace — until then
they are reported as `blocked (untrusted)`. Each must default-export
`{ id, server }` (see `template/plugins/demo-kit/plugin/notify.js`).

`mcp.json` uses exactly opencode's `mcp` entry shape:

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
ocm update [name|plugin@mp]                      # pull + re-materialize
ocm pin <name> <ref>                             # follow a branch or tag
ocm pin <name> --clear                           # back to the default branch
ocm remove my-marketplace                        # full teardown
ocm scan <url|path|plugin>                       # dry run
ocm validate [path]                              # lint a marketplace repo
ocm doctor [--fix]                               # diagnose this installation
ocm init                                         # reinstall the auto-sync loader
ocm loader uninstall                             # remove the auto-sync loader
```

A marketplace with ten plugins and two installs is the normal case. In `auto`
mode (the default) every discovered plugin is enabled on add and new upstream
plugins install as they appear; `--explicit` (or `ocm mode <mp> explicit`)
installs nothing until you name it. `uninstall` keeps the record, so
re-installing is instant and offline.

## Precedence

- **Project beats global.** ocm installs at user-global scope only; a
  project's own `.opencode/` always wins over anything ocm installed.
- **ocm never writes into `~/.claude`, `.claude`, `~/.agents` or `.agents`.**
  Those paths belong to other tools.
- **Hand-authored files beat marketplace-installed ones.** ocm never
  overwrites a file it does not own: a collision is reported and skipped;
  `ocm install --force` takes over and names the displaced path (the file
  moves to `~/.cache/ocm/displaced/`, it is never deleted).
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

## Trust

JS plugins and MCP servers execute. They materialize only after you approve
their marketplace (`ocm trust <name>`); until then they are reported as
`blocked (untrusted)` while the rest of the plugin installs normally.
`ocm untrust` revokes and removes them. A grant is fingerprinted per
component — an upstream change to an executable component re-blocks it until
re-approved.

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
   touches that marketplace's links.

A sync makes the *next* opencode start current. Remove the loader any time
with `ocm loader uninstall`.

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
