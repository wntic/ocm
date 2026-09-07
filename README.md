# ocm — file-based plugin marketplace for opencode

Distribute **skills, agents and commands** for [opencode](https://opencode.ai) via plain git repositories.
Installed once — available in **every project**, even without `.opencode/` or `.claude/` directories.

## How it works

```
github.com/you/my-marketplace     ← single source of truth (markdown files)
        │
   ocm add (clone to ~/.cache/ocm/marketplaces/)
        │
        ├── agents   → symlink ~/.config/opencode/agents/ocm--<marketplace>
        ├── commands → symlink ~/.config/opencode/commands/ocm--<marketplace>
        └── skills   → skills.paths entry in global opencode.json
        │
   ocm-loader (global plugin)     ← git pull at most once an hour on opencode start
```

No file copying into projects. Update the repo — every project picks it up on next start.

## Install

```bash
bun install -g .   # or run via bun ./bin/ocm.ts
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

`ocm add` installs `~/.config/opencode/plugins/ocm-loader.js` (opencode auto-loads
files from that directory — your `opencode.json` is not modified, except for a
`skills.paths` entry). On every opencode start the loader runs `git pull` for all
added git marketplaces — at most once per hour — in the background.
Remove it any time with `ocm loader uninstall`.

## Requirements

- [opencode](https://opencode.ai)
- git
- [bun](https://bun.com) (to run the CLI)

## License

MIT
