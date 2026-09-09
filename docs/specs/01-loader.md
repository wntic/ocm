# 01 — Loader & plugin-host correctness

Depends on: [00](./00-contract.md). **Build this first** — everything
automatic in ocm today is inert, and two of the three installed files log an
error on every opencode start.

## Goal

ocm's runtime pieces load cleanly under opencode's actual plugin contract, in
a layout that cannot be mistaken for a plugin, with no error lines in the log.

## The three defects

1. `ocm-loader.js` default-exports `{ id, setup }`. opencode requires
   `{ id, server }` for a server plugin, so the module is rejected and startup
   sync has never run.
2. `ocm-core.js` is a library, but it sits in `~/.config/opencode/plugins/`,
   which opencode globs as `{plugin,plugins}/*.{ts,js}`. Every start it is
   loaded as a plugin and rejected with `Plugin export is not a function`.
3. `ocm-ui.js` is a `tui`-only module and is *also* in that directory, so the
   server host rejects it with `must default export an object with server()`
   in addition to the TUI host loading it correctly from `tui.json`.

All three are verified by probe; see [00](./00-contract.md#plugin-module-contract).

## Layout

```
~/.config/opencode/
├── plugins/
│   └── ocm-loader.js            the ONLY ocm file in this directory
├── ocm/                         NEW — not scanned by any opencode glob
│   ├── core.js                  shared runtime core
│   ├── core.d.ts
│   ├── ui.js                    TUI plugin module
│   ├── …                        every other *.js / *.d.ts module in loader/
│   └── registry.json            moved from plugins/ocm-registry.json —
│                                not an installed file
└── tui.json                     managed: one entry, "./ocm/ui.js"
```

`~/.config/opencode/ocm/` is chosen because opencode only globs `command(s)`,
`agent(s)`, `mode(s)`, `skill(s)` and `plugin(s)` under a config directory —
an `ocm/` sibling is invisible to all of them. `ocm-loader.js` imports
`../ocm/core.js` by a path relative to its own module URL, so there is no PATH
or cwd dependency.

`ocm/` holds every runtime module from the repository's `loader/` directory
(see Installation set); `registry.json` is moved there by migration, never
installed.

`plugins/ocm-loader.js` keeps its name and location so that the file the user
already has is overwritten in place rather than orphaned.

## Loader module

```js
import { syncAll } from "../ocm/core.js"

export default {
  id: "ocm-loader",
  server: async () => {
    void syncAll({ reason: "startup" }).catch(() => {})
    return {}
  },
}
```

Decisions:

- **`server`, not `setup`.** Required by the contract.
- **Fire-and-forget.** `server()` is awaited sequentially before other
  plugins load ([00](./00-contract.md#load-order)), so awaiting a `git fetch`
  here would add its latency to every start. Nothing in the current session
  can consume the result anyway — there is no reload API — so the sync exists
  purely to make the *next* start current. Not awaiting is therefore free.
- **Never throws.** A rejected `server()` is logged as a plugin failure; ocm
  must never put a red line in a user's log because a marketplace was
  unreachable.
- **Returns `{}`.** No hooks are registered in this spec. [11](./11-cross-tool.md)
  adds a `shell.env` hook here for `OCM_PLUGIN_ROOT`.

### What the loader honestly cannot do

The superseded spec claimed commands and agents refresh in-session. They do
not. Every user-visible message about an install must say **"restart opencode
to activate"** — for all five component types, without exception. The TUI path
in [10](./10-tui.md) is the only place where a live-session effect is
possible, and only via `api.client`.

## TUI plugin registration

`ocm/ui.js` stays a `{ id, tui }` module and is registered as the single entry
`"./ocm/ui.js"` in `~/.config/opencode/tui.json`'s `plugin` array. Because it
now lives outside `plugins/`, the server host no longer sees it.

`tui.json` rules (same as every other config write — see
[12](./12-validate-doctor.md)):

- read, merge one array entry, atomic write (temp file in the same directory,
  rename over target)
- every other key preserved byte-identically
- unparseable file → warn on stderr, leave untouched, print the manual entry
  the user should add
- `ocm loader uninstall` removes exactly that entry and the `ocm/` directory

## Installation set

`src/loader.ts` installs exactly the repository's `loader/` directory and
manages the `tui.json` entry: `ocm-loader.js` installs to
`plugins/ocm-loader.js`, and every other `*.js` / `*.d.ts` file in `loader/`
installs to `ocm/<name>`. Nothing else ever lands in either directory. The
directory is the shipped set by definition — hard rule 1 already treats all
of `loader/*.js` as raw-loaded runtime — so a module can be added to the core
without another coordinated amendment here, and the set stays exact: a
partial install or a stray installed file still fails the pin. The `*.js` /
`*.d.ts` filter keeps editor junk (e.g. `.DS_Store`) out of both the
expectation and the install. It runs on `ocm init`, on the first `ocm add`,
and on every `ocm update` — the last so a stale core cannot silently no-op
forever.

> The installed set was originally pinned as an enumerated four-file list.
> [03](./03-materializer.md) grew `loader/core.js` past its size budget, and
> the pin was relaxed to this derived rule so the core could be split into
> modules.

Each installed file carries a trailing comment line
`// ocm-version: <package version> <sha256-8>` so [12](./12-validate-doctor.md)
can detect a stale installation without hashing the whole file.

## Migration from the current layout

On any ocm command, if `~/.config/opencode/plugins/ocm-core.js` or
`ocm-ui.js` exists:

1. move `plugins/ocm-registry.json` → `ocm/registry.json` (read old location
   as a fallback for one release)
2. delete `plugins/ocm-core.js`, `plugins/ocm-ui.js`, and any
   `plugins/ocm-core.d.ts`
3. rewrite the `tui.json` entry `./plugins/ocm-ui.js` → `./ocm/ui.js`
4. reinstall the installed set
5. print one line naming what moved

Idempotent, and safe to run when the old files are absent.

## Edge cases

| Case | Behaviour |
|---|---|
| `~/.config/opencode/ocm/` exists but is not a directory | error naming the path; no partial install |
| `tui.json` is valid JSON but `plugin` is not an array | warn, leave untouched, print manual instruction |
| user manually added `./plugins/ocm-ui.js` to a *project* `.opencode/tui.json` | not ours to touch; `doctor` reports it |
| `OPENCODE_PURE=1` | both loader and UI are skipped by opencode; ocm CLI is unaffected |
| loader import of `../ocm/core.js` fails (partial install) | opencode logs one plugin error; `doctor` detects and repairs |

## Consumed by

Every other spec. [02](./02-registry.md) reads the registry from its new path;
[08](./08-update.md) owns `syncAll`; [10](./10-tui.md) owns `ocm/ui.js`.

## Tests (`test/phase01-loader.mjs`)

1. Installed set is exactly the repository's `loader/` directory: every
   `*.js` / `*.d.ts` file in `loader/` exists at its target (`ocm-loader.js`
   in `plugins/`, the rest in `ocm/`); `plugins/` contains only
   `ocm-loader.js`, and `ocm/` contains only the remaining files.
2. `ocm-loader.js` default export has `id` and a `server` function and no
   `setup`; `ocm/ui.js` has `id` and `tui` and no `server`.
3. `ocm-loader.js` imports `../ocm/core.js` successfully from the installed
   location (node import smoke test).
4. `server()` resolves without awaiting the sync, and resolves even when
   `syncAll` rejects.
5. `tui.json` with pre-existing `theme` and `keybinds` keys keeps them
   byte-identically; the ocm entry is added once and only once.
6. Migration: a fixture home in the old layout ends in the new layout, with
   the registry contents preserved and the `tui.json` entry rewritten.
7. `opencodeProbe` reports zero plugin-load errors for ocm files (skipped when
   opencode is absent).
