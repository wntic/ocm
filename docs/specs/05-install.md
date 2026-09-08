# 05 — Per-plugin install & uninstall

Depends on: [02](./02-registry.md), [03](./03-materializer.md). This is the
gap the current ocm README reads as all-or-nothing per marketplace.

## Goal

Add a marketplace offering ten plugins and install two.

```
ocm add <url|path> [--ref <ref>] [--explicit] [--name <n>]
ocm remove <marketplace>
ocm list [--all] [--json]
ocm install <plugin>[@<marketplace>] [--force]
ocm uninstall <plugin>[@<marketplace>]
ocm enable <plugin>[@<marketplace>]      # alias of install
ocm disable <plugin>[@<marketplace>]     # alias of uninstall
ocm scan <url|path|plugin[@marketplace]> # dry run
```

`enable`/`disable` are pure aliases, present because that is the wording users
arrive with from Claude Code's `/plugin` model. The registry distinguishes the
two states it actually needs (`enabled`, `installedAt`); the verbs are
vocabulary.

## Argument resolution

`resolvePlugin(arg)` is shared by every verb that takes a plugin:

1. `foo@mp` → marketplace `mp`, plugin `foo`. Missing either → error naming
   which, plus an `ocm list` hint.
2. bare `foo` → search every marketplace. Exactly one match proceeds. Zero
   matches → error suggesting `ocm add` / `ocm update`. Multiple matches →
   **cannot happen**: plugin names are globally unique
   ([04](./04-precedence.md)). If it happens anyway (a hand-edited registry),
   error listing candidates.
3. present in the registry but no longer discovered on disk → error naming
   `ocm update <marketplace>` as the fix. Rename migration is
   [08](./08-update.md).

## Marketplace modes

| Event | `auto` | `explicit` |
|---|---|---|
| `ocm add` | every discovered plugin enabled | none enabled; the add report lists them as *available* |
| new upstream plugin found during sync | enabled, unless its manifest says `defaultEnabled: false` | registered `enabled: false` |
| upstream plugin disappears | links removed, record dropped ([08](./08-update.md)) | same |

`ocm add --explicit` sets `mode: "explicit"`. A first `ocm uninstall` against
an `auto` marketplace does **not** flip the mode — a single uninstall should
not silently change how future upstream additions behave. `ocm mode <mp>
auto|explicit` changes it deliberately.

## Semantics

- **install** → `enabled: true`, `installedAt: now`, re-materialize that
  marketplace. Idempotent. Prints the components materialized, then the
  restart notice.
- **uninstall** → `enabled: false`, `installedAt: null`, re-materialize; the
  ownership diff removes exactly that plugin's components
  ([03](./03-materializer.md)). The record is kept, so `ocm list --all` shows
  it and re-installing is instant and offline.
- **--force** on install takes over an unowned target path, printing each
  displaced path. The displaced file is moved to
  `~/.cache/ocm/displaced/<timestamp>/<original path>` rather than deleted, so
  a mistake is recoverable, and the path is printed.
- A plugin containing executable components requires trust
  ([07](./07-trust.md)) before its `plugin/*.js` components materialize; its
  stuff installs regardless.

## `ocm add`

1. Parse the source. Accepted forms:
   - `https://github.com/user/repo`, `git@github.com:user/repo.git`, any git
     URL, `file://…`
   - `https://github.com/user/repo/tree/<ref>[/<subdir>]` — the GitHub browse
     URL, parsed into repo + ref + subdirectory
   - a local directory path (absolute, relative, or `~/`-prefixed)
2. Derive the marketplace name: `--name` if given, else `marketplace.json`'s
   `name` if valid, else `<owner>--<repo>` for a URL or the directory basename
   for a path, normalised to `^[a-z0-9]+(-[a-z0-9]+)*$`.
3. Refuse if that name is already added, naming `ocm update <name>`.
4. Clone (shallow, `--ref` honoured) into `~/.cache/ocm/marketplaces/<name>`,
   or record the local directory as `local: true` and never write to it.
5. Discover plugins. Zero plugins → remove the clone, error naming the
   expected layout.
6. **Check plugin-name collisions against the whole registry**
   ([04](./04-precedence.md)) before writing anything; on collision, discard
   the clone and exit non-zero.
7. Prompt for trust if executable components are present ([07](./07-trust.md)).
8. Register, materialize, install/refresh the loader ([01](./01-loader.md)),
   save, report.

`--ref` accepts a branch or tag. Subdirectory sources are recorded as a
`subdir` field on the marketplace entry; discovery roots there while git
operations run against the clone root.

## `ocm remove`

Complete teardown: remove every materialized component of every plugin, the
marketplace's `skills.paths` entry, its `~/.cache/ocm/links/<mp>` directory,
every `ocm--<plugin>--*` MCP key (dropping the `mcp` object if it becomes
empty), and the clone — but **never a `local: true` directory**. Then drop the
registry record and print a per-plugin summary.

## `ocm list`

Default: marketplaces, each with its enabled plugins, version/revision, and a
component summary. `--all` adds disabled plugins with a `(disabled)` marker,
shows the marketplace mode, and shows a failing `lastSync` in red.
`--json` emits the machine-readable form for the TUI and for scripting.

## `ocm scan`

Dry run, three shapes:

- a URL → clone to a temp directory, report what would be installed, discard
- a local path → report without touching anything
- `plugin[@marketplace]` for an already-added marketplace → report what
  installing that one plugin would materialize, including any collision it
  would hit

Scan never writes outside its temp directory and never modifies the registry.
It exits 0 even when it finds nothing installable, printing why.

## Error messages

Every failure names the thing and the next action:

```
error: no plugins found in https://github.com/u/r
  expected plugins/<name>/{commands,agents,skills}/ at the repository root
  run `ocm scan <url>` to see what was found

error: plugin "adw" is already provided by marketplace "wntic-adw"
  not adding "other-mp"; remove one, or ask its author to rename

error: marketplace "wntic-adw" is unreachable
  git: could not read from remote repository
  already-installed plugins keep working; retry with `ocm update wntic-adw`
```

## Consumed by

[10](./10-tui.md) calls the same functions from the dialog;
[08](./08-update.md) reuses the mode table for newly discovered plugins.

## Tests (`test/phase05-install.mjs`)

1. install / uninstall / enable / disable matrix on a two-plugin fixture;
   materialized set matches `enabled` after every operation.
2. Uninstall removes only that plugin's components.
3. `--explicit` add materializes nothing; a later install materializes one.
4. Bare-name resolution; `@marketplace` form; the three error paths.
5. `--force` displaces an unowned file into `~/.cache/ocm/displaced/` and
   prints the path; without `--force` the file is untouched.
6. `ocm remove` leaves zero `ocm--` traces in `opencode.json`, no links, no
   `skills.paths` entry, no registry record — and does not delete a `local`
   marketplace's directory.
7. `scan` of a URL leaves no temp directory and no registry change.
8. Idempotence: every verb run twice is a no-op the second time.
