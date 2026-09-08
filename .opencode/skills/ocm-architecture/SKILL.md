---
name: ocm-architecture
description: Where code goes in the ocm repository, the CLI-versus-core split, the runtime constraint that makes core.js different from every other file, and the house conventions for errors and output. Use when adding or moving any source file, deciding which module something belongs in, or writing user-facing CLI output.
---

# ocm architecture

## The split that matters

```
bin/ocm.ts             entry: parse argv, call main, print the error, exit 1
src/                   the CLI — TypeScript, Bun APIs allowed
  index.ts               command dispatch and help text
  commands/*.ts          one file per verb group
  install.ts             registry + opencode.json read/write
  registry.ts            registry normalization and migration
  discovery.ts           typed facade over core discovery
  paths.ts               every path constant, no exceptions
  git.ts                 synchronous git for the CLI
loader/                installed into the user's opencode config
  ocm-loader.js          the server plugin  -> ~/.config/opencode/plugins/
  core.js                shared runtime core -> ~/.config/opencode/ocm/
  core.d.ts              types for core.js
  ui.js                  the TUI plugin     -> ~/.config/opencode/ocm/
schema/                JSON Schema for marketplace.json and plugin.json
template/              a working example marketplace
test/                  harness.mjs plus one phaseNN-*.mjs per spec
scripts/               dev tooling: check.sh, oc-probe.sh
docs/specs/            the specs being implemented
docs/plans/            per-spec task breakdowns (generated, gitignored)
```

## The rule that is easy to forget

**`loader/*.js` runs inside opencode's runtime, not ours.** Therefore, in
those files only:

- plain JavaScript, no TypeScript syntax — opencode imports them raw, there is
  no build step
- `node:*` builtins only. No dependencies, no Bun APIs (`Bun.$`, `Bun.file`),
  no imports from `src/`
- every export must be safe to call from three callers: the CLI, the startup
  loader, and the TUI plugin
- types live in `core.d.ts` and are hand-maintained alongside

`src/` is the opposite: TypeScript, Bun APIs fine, and it imports *from*
`loader/core.js` rather than duplicating it. If logic is needed by both the
CLI and the running opencode process, it belongs in `core.js` and the CLI gets
a thin typed facade.

## Conventions

**Paths.** Every filesystem path is a constant in `src/paths.ts` (CLI side) or
at the top of `core.js` (runtime side). No path is assembled inline. Path
constants are read at module load, which is why tests re-import with a
cache-busting query string under a fake `$HOME`.

**Errors.** Throw `Error` with a message that names the thing and the next
action. `bin/ocm.ts` prints it and exits 1. The shape:

```
error: plugin "adw" is already provided by marketplace "wntic-adw"
  not adding "other-mp"; remove one, or ask its author to rename
```

First line states the fact, indented lines say what to do. No stack traces to
the user.

**Output.** Warnings to stderr, data to stdout. Multi-item operations report
per item and never abort the whole run on one failure. Every operation that
materialized something ends with `restart opencode to activate`.

**Config writes.** Read, merge, write to a temp file in the same directory,
`rename()` over the target. Never rewrite a config file that failed to parse —
warn and print the change the user should make by hand.

**No new runtime dependencies.** The package has devDependencies only, and it
stays that way. If a JSON Schema needs validating, hand-roll it.

## Commands

```
bun ./bin/ocm.ts <args>     run the CLI
./scripts/check.sh          the gate: typecheck, tests, probe
./scripts/oc-probe.sh       ask the real opencode what it sees
bun test                    tests only
bunx tsc --noEmit           typecheck only
```
