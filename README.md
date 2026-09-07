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
        └── skills   → skills.paths entry in global opencode.json
                       (~/.cache/ocm/links/<marketplace>/skills/)
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
├── marketplace.json              # optional: { "name", "description" }
└── plugins/
    └── my-plugin/
        ├── agents/
        │   └── reviewer.md       # opencode agent frontmatter
        ├── commands/
        │   └── tdd.md            # opencode command frontmatter
        └── skills/
            └── code-review/
                └── SKILL.md      # agent skill
```

A marketplace is any git repo with `plugins/<name>/{agents,commands,skills}/`.
Every directory under `plugins/` with at least one component becomes an installable plugin.

## Loader (auto-sync)

`ocm add` installs `~/.config/opencode/plugins/ocm-loader.js` and
`ocm-core.js` (opencode auto-loads `*.js` files from that directory — your
`opencode.json` is not modified, except for a `skills.paths` entry).

On every opencode start the loader:

1. runs `git fetch` + `git reset` (shallow-clone safe) for all added git
   marketplaces — at most once per hour;
2. refreshes the symlinks, so newly added or removed plugins are picked up;
3. if anything changed, triggers a config reload, so **commands and agents
   from the update are available in the current session**.

Skills are cached for the process lifetime by opencode and pick up changes on
the next launch.

The sync interval defaults to one hour and can be tuned or disabled with the
`OCM_SYNC_INTERVAL_MS` environment variable (`0` syncs on every start).

Remove the loader any time with `ocm loader uninstall`.

## Requirements

- [opencode](https://opencode.ai)
- git
- [bun](https://bun.com) (to run the CLI)

## License

MIT
