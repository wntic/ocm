# ocm — file-based plugin marketplace for opencode

Distribute **skills, agents and commands** for [opencode](https://opencode.ai) via plain git repositories.
Installed once — available in **every project**, even without `.opencode/` or `.claude/` directories.

## How it works

```
github.com/you/my-marketplace     ← single source of truth (markdown files)
        │
   ocm add (clone to ~/.cache/ocm/marketplaces/)
        │
        ├── commands → ~/.config/opencode/commands/<plugin>:<command>.md
        ├── agents   → ~/.config/opencode/agents/<plugin>:<agent>.md
        ├── skills   → skills.paths entry in global opencode.json
        │              (~/.cache/ocm/links/<marketplace>/skills/)
        ├── js plugins → ~/.config/opencode/plugins/ocm--<plugin>--<file>
        └── mcp       → ocm--<plugin>--<server> keys in global opencode.json
        │
   ocm-loader (global plugin)     ← syncs at most once an hour on opencode start
```

No file copying into projects. Update the repo — every project picks it up on next start.

## Naming

Commands and agents are namespaced by plugin to avoid collisions between
marketplaces: a command file `plugins/adw/commands/commit.md` becomes `/adw:commit`
in the opencode TUI, an agent `plugins/adw/agents/reviewer.md` becomes `adw:reviewer`.

Skills keep their own names (opencode requires the skill name to match its folder
name). Note that opencode never lists skills in the `/` autocomplete by design —
skills are invoked by the model through the `skill` tool, or browsed via the
`/skills` picker.

## Install

```bash
bun install -g .   # or run via npx tsx ./bin/ocm.ts
```

## Usage

```bash
ocm add https://github.com/user/my-marketplace
ocm add ~/plugins/my-marketplace  # local marketplace for development
ocm list                          # show installed marketplaces and plugins
ocm update                        # pull all marketplaces now
ocm remove my-marketplace         # clean uninstall
ocm scan <url|path>               # dry-run
ocm init                          # reinstall the auto-sync loader
ocm loader uninstall              # remove auto-sync loader
```

Runs with [bun](https://bun.com) (`bun ./bin/ocm.ts ...`) or via `npx tsx ./bin/ocm.ts`.

## Marketplace repository format

```
my-marketplace/
├── marketplace.json              # optional
└── plugins/
    └── demo-kit/
        ├── plugin.json           # optional
        ├── commands/
        │   └── tdd.md            # → /demo-kit:tdd
        ├── agents/
        │   └── reviewer.md       # → demo-kit:reviewer
        ├── skills/
        │   └── code-review/
        │       └── SKILL.md      # skill "demo-kit:code-review"
        ├── plugin/
        │   └── notify.js         # opencode server plugin (trust-gated)
        ├── mcp.json              # mcp servers (trust-gated)
        └── scripts/, templates/  # supporting files, never materialized
```

A marketplace is any git repo with `plugins/<name>/`. Every directory under
`plugins/` with at least one component is an installable plugin, manifest or
not — manifests add metadata, they never hide a plugin.

`command`/`commands`, `agent`/`agents`, `skill`/`skills` and `plugin`/`plugins`
are all accepted (singular matches opencode's own globs); a name clash between
the singular and plural form of the same type is an error.

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

### JS/TS plugins and MCP servers

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
The user's own `mcp` keys are preserved. Both are read once at startup:
restart opencode to activate.

## Loader (auto-sync)

`ocm add` installs `~/.config/opencode/plugins/ocm-loader.js` and
`ocm-core.js` (opencode auto-loads `*.js` files from that directory — your
`opencode.json` is not modified, except for a `skills.paths` entry).

On every opencode start the loader:

1. runs `git fetch` + `git reset` (shallow-clone safe) for all added git
   marketplaces — in the background, adds ~1s to startup;
2. refreshes the symlinks, so newly added or removed plugins are picked up;
3. if anything changed, triggers a config reload, so **commands and agents
   from the update are available in the current session**.

Skills are cached for the process lifetime by opencode and pick up changes on
the next launch.

By default the sync runs on every start. To throttle it (e.g. to once an
hour), set `OCM_SYNC_INTERVAL_MS=3600000`.

Remove the loader any time with `ocm loader uninstall`.

## TUI integration (`/ocm`)

`ocm init` also installs a TUI plugin (`~/.config/opencode/plugins/ocm-ui.js`)
and registers it in `~/.config/opencode/tui.json` — the only entry ocm owns in
that file; theme, keybinds and other user settings are preserved.

Restart opencode after installing, then type `/ocm` in the prompt:

```
ocm
  Browse plugins    All plugins across marketplaces
  Update all        Pull every marketplace now
  Marketplaces      List and update marketplaces
```

- **Browse plugins** — searchable list of every installed plugin
  (`plugin@marketplace`), with per-plugin details (commands, agents, skills).
- **Update all** — pulls every marketplace and refreshes links in place.
- **Marketplaces** — per-marketplace update.

The dialog is a thin view over the same `ocm-core.js` the CLI uses — no CLI
spawning, no duplicated logic. Install/uninstall toggles and marketplace
add/remove from inside the TUI are planned (see `docs/specs/09-tui-command.md`).

`OPENCODE_PURE=1` disables the TUI plugin along with all other external
plugins. Remove it with `ocm loader uninstall`.

## Requirements

- [opencode](https://opencode.ai)
- git
- [bun](https://bun.com) (to run the CLI)

## License

MIT
