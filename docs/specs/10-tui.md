# 10 — TUI integration (`/ocm`)

Depends on: [01](./01-loader.md) (module placement), [05](./05-install.md)
(mutations), [06](./06-manifests.md) (metadata). Delivers what the current
README lists as planned: install, uninstall, enable, disable, add and remove
from inside the dialog.

## Feasibility, re-verified

Against `@opencode-ai/plugin` 1.18.15's `dist/tui.d.ts` and opencode 1.18.20:

- TUI plugins load **only** from a `tui.json` `plugin` array; path specs
  resolve relative to the declaring file
  (`packages/opencode/src/config/tui.ts:88-96`). Global merges first, project
  last.
- The module shape is `{ id, tui(api, options, meta) }` — `id` is mandatory
  for a path plugin. It must **not** also export `server`, and it must not sit
  in `plugins/`, or the server host rejects it every start
  ([01](./01-loader.md)).
- `api.ui` provides `DialogSelect` (with built-in filtering, `category`, and
  `description` per option), `DialogAlert`, `DialogConfirm`, `DialogPrompt`,
  the `dialog` stack, and `toast`.
- `api.keymap.registerLayer({ commands, bindings })` registers a command with
  `slash: { name: "ocm" }`, which is what puts `/ocm` in autocomplete.
- `api.lifecycle.onDispose` for cleanup, `api.kv` / `api.state` for persisted
  dialog state.
- **New relative to the old spec:** `api.client` is the full `OpencodeClient`
  against the running server, and `api.plugins` exposes
  `list / activate / deactivate / add / install`.

## Architecture

`ocm/ui.js` is a **thin view over `ocm/core.js`** — the same module the CLI
and the loader use, imported relative to its own module URL. No CLI spawning,
no PATH dependency, no duplicated logic. Every mutation the dialog performs is
a core function that the CLI also calls, so the two surfaces cannot drift.

The plugin is plain JS with no JSX and no dependencies, because it is copied
into the user's config directory and loaded raw.

## Flows

### `/ocm` — main menu

```
Browse plugins        24 plugins across 3 marketplaces
Search                Find a plugin by name, tag or command
Marketplaces          Add, update, remove
Update all            Pull every marketplace now
```

Empty registry → `DialogAlert` explaining `ocm add`, with the Marketplaces →
Add flow offered as the in-TUI route.

### Browse

`DialogSelect` over every registry plugin: title `plugin@marketplace`,
description from the cached manifest, `category` set to the marketplace name
so the built-in filter groups sensibly, suffixed `(disabled)` or `(blocked)`.
Selecting one opens:

```
Install / Uninstall     toggle; label reflects current state
Details                 the `ocm info` record
Trust marketplace       only when components are blocked
Update marketplace      pull just this one
Back
```

Install and uninstall call the core `setEnabled` + `materialize`
([05](./05-install.md)), then show a toast and return to the browse list with
the state refreshed in place. Every mutation is confirmed with `DialogConfirm`
first; uninstall of a plugin with executable components says so in the
confirmation.

### Search

`DialogPrompt` for a query, then the [09](./09-search.md) ranking rendered as
a `DialogSelect` — the same list shape as Browse, so selection reuses the
per-plugin menu.

### Marketplaces

List → per-marketplace `Update`, `Remove` (confirmed, showing what will be
removed), `Trust` / `Untrust`, `Pin`, `Back`. `Add` takes a URL or path via
`DialogPrompt`, then runs the core add — including the collision check
([04](./04-precedence.md)) and the trust prompt rendered as a
`DialogConfirm` carrying the same component list the CLI prints.

### Update all

`syncAll({ force: true })` sequentially, a busy dialog while it runs, then a
`DialogAlert` summarising updated / unchanged / failed, with per-marketplace
errors listed rather than swallowed.

## The restart problem

Nothing reloads in-session ([00](./00-contract.md)). So every mutation ends
with an explicit notice — "restart opencode to activate" — and the dialog must
not imply otherwise.

One improvement is available and worth attempting, in this order:

1. probe `api.client` for an endpoint that re-reads config or re-lists
   commands/agents/skills; if one exists, call it after a mutation and soften
   the notice to only cover plugins and MCP.
2. `api.plugins.activate(id)` can bring a *newly added* server plugin up
   without a restart; if it does, use it for the JS-plugin component type
   after trust is granted.
3. If neither works, ship the honest notice and open an upstream issue for a
   config-reload endpoint, linked from the README.

This is a stretch goal. The dialog must be correct and useful without it.

## Ownership of `tui.json`

Exactly one entry, `"./ocm/ui.js"`, in the `plugin` array. Everything else in
the file — theme, keybinds, the user's own plugins — survives byte-identically.
Same atomic read-merge-write rules as every other config write
([12](./12-validate-doctor.md)). `OPENCODE_PURE=1` disables it along with all
external plugins; document that as the escape hatch.

## Tests (`test/phase10-tui.mjs`)

The TUI cannot run headless, so test what can be:

1. `ocm/ui.js` default export is `{ id, tui }`, `tui` is async, and there is
   no `server` export.
2. It imports `./core.js` successfully from the installed location.
3. `tui.json` management: the entry is added to a file with pre-existing keys
   without touching them, added exactly once, and removed cleanly.
4. A recorded fake `api` drives the flows end to end — main menu → browse →
   confirm → install — asserting the core mutation ran and the toast fired.
   The fake implements `DialogSelect`, `DialogConfirm`, `DialogPrompt`,
   `toast`, `dialog` and `keymap.registerLayer` as promise-resolving stubs.
5. The same fake covers the failure paths: unreachable marketplace on update,
   collision on add, blocked components on install.
6. Every mutation path ends by emitting the restart notice.
