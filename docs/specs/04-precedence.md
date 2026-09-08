# 04 — Precedence & loading order

Depends on: [00](./00-contract.md), [03](./03-materializer.md). This is a
decision record: it resolves every collision axis for *stuff* — the shorthand
used throughout these specs for **skills, commands and agents collectively**
(JS plugins and MCP servers are not stuff; they are handled separately below).

Nothing here is left undefined. Where opencode itself is nondeterministic, ocm
makes the collision impossible instead of picking a winner.

## The table

| # | Axis | opencode's own behaviour (verified) | ocm's rule |
|---|---|---|---|
| 1 | project-local vs user-global | config directories are walked global → project; per-item the later merge wins, so **project overrides global**, field by field, without error (`config/config.ts:470-480`) | ocm installs at **user-global scope only** in v1. A project's own `.opencode/` always wins over anything ocm installed — deliberately, because a repo's local override should beat a machine-wide subscription |
| 2 | native vs Claude-compatible paths | both are scanned for skills; `~/.claude/skills` and `.claude/skills` feed the same flat name map as `~/.config/opencode/skill(s)` | ocm **never writes into `~/.claude/`, `.claude/`, `~/.agents/` or `.agents/`**. Those paths belong to a real Claude Code install; writing there would make an ocm uninstall able to delete another tool's data. ocm materializes only under `~/.config/opencode/` and `~/.cache/ocm/` |
| 3 | hand-authored vs marketplace-installed | last writer wins, silently | ocm **never overwrites what it does not own** ([03](./03-materializer.md#collision-with-things-ocm-does-not-own)). A collision is reported and the component is skipped; `--force` takes over and names the displaced path; there is no automatic rename |
| 4 | same plugin name in two marketplaces | n/a — opencode has no notion of a plugin | plugin names are **globally unique across all added marketplaces**, first-come-wins. `ocm add` of a marketplace whose plugin name is already taken fails with both sources named; nothing is materialized |
| 5 | two JS plugins on the same lifecycle event | server plugins load config-array entries first, then directory-discovered files in **filesystem order**; `setup` runs sequentially and hooks fire in registration order | ocm makes no ordering promise between marketplace-shipped JS plugins, and documents that. `ocm-loader.js` is explicitly *not* ordered first, because it cannot usefully be (see below) |
| 6 | one marketplace failing during a sync pass | n/a | failures are isolated per marketplace: a pull failure records `lastSync.ok = false` and skips that marketplace's materialize, leaving its previous links intact; every other marketplace still syncs ([08](./08-update.md)) |

## Axis 4 — why global uniqueness, not `marketplace/plugin:item`

The alternative is fully-qualified naming: `wntic-adw/adw:commit`. It makes
collisions impossible but pushes the marketplace name into every command the
user types, every agent reference, and every skill name — for a collision that
is rare and that the user can resolve once, at add time, by renaming or not
adding. Claude Code made the same call (`adw:python-style`, not
`wntic-adw/adw:python-style`) and it is the convention users already have.

So: the *item* namespace is `plugin:item`, and the *plugin* namespace is
global. `plugin@marketplace` remains the disambiguating form in the CLI and
TUI — it addresses a registry record, not a runtime name.

Retroactive collision — a marketplace already added, then a second added that
ships a plugin with the same name:

- `ocm add` refuses, exits non-zero, prints
  `plugin "adw" is already provided by marketplace "wntic-adw"; not adding
  "other-mp". Remove one, or ask its author to rename.`
- Nothing is cloned-and-left-behind: the temporary clone is discarded.
- A collision appearing *later*, when an already-added marketplace adds a
  plugin whose name a different marketplace already provides, is handled the
  same way at sync time: the new plugin is registered `enabled: false` with a
  `collision` note, never materialized, and reported by `update` and `doctor`.
  The incumbent is never displaced by an upstream change.

## Axis 5 — the ordering ocm cannot have, and does not need

It would be convenient for `ocm-loader.js` to run before other plugins so a
freshly synced component were visible to them in the same session. That is not
achievable and would not help:

- directory-discovered plugins load in filesystem order, so no filename
  convention (`00-ocm-loader.js`) reliably orders us first. Only a config
  `plugin` array entry orders reliably, and ocm has committed to not editing
  the user's `plugin` array.
- even if we ran first, nothing consumes the result: commands, agents, skills,
  MCP config and plugin files are all read once at startup and there is no
  reload API ([00](./00-contract.md#plugin-module-contract)). A sync that
  finishes at t+800ms cannot affect the process that started at t+0.

Hence the loader's sync is fire-and-forget and exists to make the *next* start
current. Every user-facing message says "restart opencode to activate". This
is a limitation to document loudly, not to engineer around.

Between two marketplace-shipped JS plugins, ocm guarantees only that each is
linked with a distinct `ocm--<plugin>--<file>.js` name. If two of them hook the
same event, both run; the order is opencode's, and is unspecified. Plugin
authors who need ordering must not rely on it — [12](./12-validate-doctor.md)
warns when two enabled plugins register a hook on the same event name if that
is statically detectable, and otherwise this is documented in the README.

## Axis 1 — why user-global only, for now

The stated goal is "installed once, available in every project". A
project-local scope adds a second registry, a scope flag on every verb,
scope-aware TUI, and a global-vs-project precedence rule, for a use case
(a repo declaring its own plugin set) that is better served later by a
committed manifest that materializes into a gitignored `.opencode/` — see
[13](./13-packaging.md#deferred). Recorded as a deliberate non-goal.

Note the asymmetry this creates and document it: because project config
overrides global, a project that defines its own `commit` command shadows
nothing of ocm's (ocm's is `adw:commit`), but a project that defines
`.opencode/skills/…` with `name: "adw:python-style"` *would* shadow an
ocm-installed skill. That is the user's own file winning, which is correct.

## MCP and JS plugins

Neither is stuff, and neither collides by name:

- MCP servers are namespaced `ocm--<plugin>--<server>` in the global
  `opencode.json` `mcp` object; cross-plugin collision is impossible.
- JS plugins are namespaced `ocm--<plugin>--<file>.js` on disk; two plugins
  shipping `notify.js` produce two distinct files.

A user's own MCP key or plugin file is never prefixed `ocm--`, so ocm never
touches it.

## Consumed by

[03](./03-materializer.md) implements the ownership rules; [05](./05-install.md)
implements the add-time collision check; [08](./08-update.md) implements
failure isolation and sync-time collision handling.

## Tests (`test/phase04-precedence.mjs`)

1. Adding a second marketplace that ships an already-provided plugin name
   fails, exits non-zero, names both marketplaces, and leaves no clone behind.
2. An upstream update introducing a colliding plugin name registers it
   disabled with a collision note and materializes nothing.
3. No ocm operation ever creates a path under `~/.claude`, `.claude`,
   `~/.agents` or `.agents` — asserted by walking a fake `$HOME` after a full
   add/install/update/remove cycle.
4. A project `.opencode/commands/adw:commit.md` in the probe fixture wins over
   the ocm-installed global one (documents axis 1 against the real binary).
5. One unreachable marketplace in a three-marketplace sync leaves the other
   two updated and its own links intact.
