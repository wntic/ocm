# ocm — file-based plugin marketplace for opencode

Distribute **skills, agents, commands, JS plugins and MCP servers** for
[opencode](https://opencode.ai) via plain git repositories. Installed once at
user-global scope — available in **every project**, even without `.opencode/`
or `.claude/` directories.

![ocm demo](https://raw.githubusercontent.com/wntic/ocm/main/docs/demo.gif)

## Install

```bash
npm install -g @wntic/ocm          # latest
npm install -g @wntic/ocm@1.0.1    # a specific version
```

Or with bun:

```bash
bun install -g @wntic/ocm          # for the `ocm` binary on PATH
bunx @wntic/ocm add <url>          # or run it without installing
```

The npm package is `@wntic/ocm`; the binary it installs is `ocm`. **Bun must
be on `PATH` whichever way ocm is installed** — the `ocm` binary is TypeScript
run by Bun (`bin/ocm.ts`, `"engines": { "bun": ">=1.0.0" }`). Also requires
git and [opencode](https://opencode.ai).

## Quickstart

A session against the public demo marketplace,
[github.com/wntic/ocm-demo](https://github.com/wntic/ocm-demo) — three small
plugins for git, review and docs work:

```bash
ocm add https://github.com/wntic/ocm-demo
ocm list
```

`ocm add` clones the marketplace and materializes its plugins (`git-kit`,
`review-kit`, `docs-kit`); `ocm list` shows what landed. **Restart opencode
to activate**, then open `/ocm` to browse and update plugins across
marketplaces, or use a command directly — `/git-kit:commit` writes a
Conventional Commits message for the staged changes.

```bash
ocm update                # pull + re-materialize
ocm remove ocm-demo       # full teardown
```

Changes apply on the next opencode start — there is no reload API.

## Commands

| Command | What it does |
|---|---|
| `ocm add <url\|path> [--ref <ref>] [--explicit] [--name <name>] [--trust\|--no-trust]` | add a marketplace (github url or local dir) |
| `ocm init` | install auto-sync loader |
| `ocm remove <name>` | remove a marketplace and its links |
| `ocm update [marketplace] [--quiet] [--json] [--trust\|--no-trust]` | pull latest changes (all or one marketplace) |
| `ocm pin <name> <ref>` | follow a branch or tag |
| `ocm pin <name> --clear` | back to the default branch |
| `ocm list [--all] [--json]` | list marketplaces and plugins |
| `ocm search <query> [--enabled-only] [--json]` | search cached plugin metadata |
| `ocm info <plugin>[@<marketplace>] [--json]` | show a plugin's cached record |
| `ocm install <plugin>[@<mp>] [--force]` | enable a plugin and materialize its components |
| `ocm uninstall <plugin>[@<mp>]` | disable a plugin and remove its links |
| `ocm enable <plugin>[@<mp>]` / `ocm disable <plugin>[@<mp>]` | aliases of install / uninstall |
| `ocm mode <name> <auto\|explicit>` | change when new upstream plugins install |
| `ocm trust <name> [--yes]` | approve a marketplace's executable components |
| `ocm untrust <name>` | revoke trust and remove executable components |
| `ocm scan <url\|path\|plugin>` | dry-run: show what would be installed |
| `ocm validate [path]` | lint a marketplace repo (default: current directory) |
| `ocm doctor [--fix]` | diagnose this installation; --fix applies safe fixes |
| `ocm loader uninstall` | remove auto-sync loader |
| `ocm --version` | print the version |

## Documentation

- [Write a marketplace](https://github.com/wntic/ocm/blob/main/docs/authoring.md) —
  the repository format, manifests and validation rules.
- [Reference](https://github.com/wntic/ocm/blob/main/docs/reference.md) —
  how it works, per-plugin installs, exit codes, precedence, config safety,
  trust, the loader, the TUI, migration.

## Requirements

- [opencode](https://opencode.ai)
- git
- [bun](https://bun.com) on `PATH` (to run the CLI)

## License

MIT
