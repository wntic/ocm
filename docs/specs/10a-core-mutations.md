# 10a — Shared mutation core (plain JS)

Depends on: [01](./01-loader.md) (module placement), [05](./05-install.md)
(mutations), [06](./06-manifests.md) (metadata), [07](./07-trust.md),
[08](./08-update.md), [09](./09-search.md). Split out of the former spec 10
so that the core surface and the dialog over it ship — and review —
separately; [10b](./10b-tui-dialog.md) builds the dialog.

## Why this exists

`ocm/ui.js` must be a thin view over `ocm/core.js` — the same module the CLI
and the loader use. No CLI spawning, no PATH dependency, no duplicated
logic: every mutation the dialog performs has to be a core function the CLI
also calls, so the two surfaces cannot drift. This spec builds that surface.
It changes no user-visible behaviour — the CLI keeps doing exactly what
specs 05–09 defined, through the same functions.

## Requirements

- Every mutation moves into `loader/*.js` siblings, plain JavaScript with
  `node:*` builtins only (hard rule, [00](./00-contract.md)):
  - marketplace add — source parsing (git URL, GitHub tree URL, local path),
    clone placement, discovery, the [04](./04-precedence.md) collision
    check, registration, and the facts a trust prompt needs
    - marketplace remove — full teardown: links, `skills.paths` entry,
    `ocm--<plugin>--*` MCP keys, the clone (never a `local` directory), the
    registry record
  - install / uninstall — `setEnabled` + `materialize` + registry save
    ([05](./05-install.md))
  - trust grant / deny / revoke and pin ([07](./07-trust.md),
    [08](./08-update.md))
  - search ranking ([09](./09-search.md))
  - the syncAll summary ([08](./08-update.md)) — updated / unchanged /
    failed with per-marketplace errors, not swallowed
- `loader/core.js` re-exports them; `core.d.ts` is updated so `src/` stays
  typecheck-clean.
- `src/*.ts` delegates to the core functions instead of carrying its own
  copies. Behaviour is unchanged: the phase 01–09 tests pass unmodified.
- Registry writes go through one atomic save with canonical key ordering: a
  no-op save is byte-identical, and unknown fields survive round-trips.
- Interactive surfaces stay out of the core: core functions take options and
  return the facts (e.g. the component list a trust prompt must show); the
  CLI prompts and the dialog's `DialogConfirm` render them. The core never
  prints and never reads stdin.

## Tests (`test/phase10a-core-mutations.mjs`)

1. install / uninstall through the core flip `enabled` / `installedAt` and
   materialize / remove exactly that plugin's links.
2. Marketplace add through the core registers and materializes, and refuses
   a plugin-name collision without writing anything.
3. Remove through the core leaves zero `ocm--` traces, no links, no
   `skills.paths` entry, no registry record — and a `local` marketplace's
   directory survives.
4. Trust grant / deny / revoke and pin through the core update the registry
   and re-materialize accordingly.
5. Search through the core returns the [09](./09-search.md) ranking.
6. The registry save is atomic and idempotent: saving an unchanged registry
   is byte-identical; user-added keys survive.
7. Delegation, not a rewrite: the phase 01–09 tests pass unmodified.
