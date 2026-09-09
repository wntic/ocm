# ocm specs

Implementation specs for `ocm` — a file-based plugin marketplace for opencode.
One spec per independently implementable, independently testable subtask.

These specs supersede the earlier 00–09 set, which rested on several facts
about opencode that turned out to be wrong (see
[00 — Verified opencode contract](./00-contract.md#corrections-to-the-previous-spec-set)).

## Reading order

| Spec | Status | Depends on |
|---|---|---|
| [00 — Verified opencode contract](./00-contract.md) | reference | — |
| [01 — Loader & plugin-host correctness](./01-loader.md) | not started | 00 |
| [02 — Registry v2](./02-registry.md) | not started | 00 |
| [03 — Materializer & namespacing](./03-materializer.md) | not started | 00, 02 |
| [04 — Precedence & loading order](./04-precedence.md) | decision record | 00, 03 |
| [05 — Per-plugin install/uninstall](./05-install.md) | not started | 02, 03 |
| [06 — Manifests & component types](./06-manifests.md) | not started | 02, 03 |
| [07 — Trust for code-executing components](./07-trust.md) | not started | 02, 06 |
| [08 — Update engine](./08-update.md) | not started | 02, 03, 06 |
| [09 — Search & info](./09-search.md) | not started | 06 |
| [10a — Shared mutation core](./10a-core-mutations.md) | not started | 01, 05–09 |
| [10b — TUI integration (`/ocm`)](./10b-tui-dialog.md) | not started | 10a |
| [11 — Cross-tool authoring format](./11-cross-tool.md) | not started | 03, 06 |
| [12 — Validate & doctor](./12-validate-doctor.md) | not started | 06, 07 |
| [13 — Packaging & migration](./13-packaging.md) | not started | all |

## Decisions locked before writing these specs

| Decision | Choice | Where it is argued |
|---|---|---|
| Tool name | CLI stays `ocm`; npm package is `@wntic/ocm` | [13](./13-packaging.md) |
| Install mechanism | symlink-first behind a materializer interface; copy mode is a non-goal | [03](./03-materializer.md) |
| Skill namespacing | rendered `SKILL.md` (`name:` rewritten to `<plugin>:<skill>`), siblings symlinked | [03](./03-materializer.md) |
| Scope | user-global only in v1; project scope is a documented non-goal | [04](./04-precedence.md) |
| Plugin name collisions | globally unique, first-come-wins, `plugin@marketplace` disambiguates | [04](./04-precedence.md) |
| Cross-tool | portable `SKILL.md` subset + per-target command/agent dirs; no neutral schema compiler | [11](./11-cross-tool.md) |
| Trust | per-marketplace at add, re-prompt when an update introduces new executable code | [07](./07-trust.md) |
| Auto-sync | throttled, 1h default, per-marketplace override | [08](./08-update.md) |

## Non-goals (all specs)

- Copy-mode installs and versioned copy caches.
- Project-local (`.opencode/`) install scope.
- External plugin sources (npm / archive / `git-subdir` entries inside a
  marketplace) — the marketplace repo is the distribution unit.
- Plugin-to-plugin dependencies.
- Org settings, allowlists, managed distribution.
- Writing anything into `~/.claude/` or `.claude/` on the user's machine.

## Conventions

- Runtime: Bun + TypeScript. CLI entry `bun ./bin/ocm.ts`.
- `tsc --noEmit` must be clean before a phase ships.
- Tests live in `test/*.mjs` and run under a fake `$HOME` (see
  [00 — Testing harness](./00-contract.md#testing-harness)).
- A phase ships only when its test file passes and typecheck is clean.

## Implementation order

Build in this order. The reasoning is dependency plus how much each unblocks.

| # | Spec | Why here |
|---|---|---|
| 1 | [01 — Loader](./01-loader.md) | Everything automatic in ocm is currently inert and two installed files error on every opencode start. Until the module shape and the file layout are right, nothing else can be observed working. Small, self-contained, immediately visible. |
| 2 | [02 — Registry v2](./02-registry.md) | One schema migration, done once, so 05–09 add behaviour rather than schema. Cheap, and blocking for almost everything. |
| 3 | [03 — Materializer](./03-materializer.md) | The engine every install path runs through, and where the skill-namespacing decision becomes real. Also fixes the skill-collision coin flip. |
| 4 | [04 — Precedence](./04-precedence.md) | Mostly a decision record, but 05 and 08 implement its rules, so it lands before them. A day of writing, not of code. |
| 5 | [05 — Per-plugin install](./05-install.md) | The headline gap. With 01–03 in place this is the first release that is meaningfully better than today's ocm. |
| 6 | [06 — Manifests & component types](./06-manifests.md) | Adds JS plugins and MCP servers, and the metadata 09 and 10 render. |
| 7 | [07 — Trust](./07-trust.md) | Must land in the same release as 06, never after: 06 is what makes unattended code execution possible. |
| 8 | [08 — Update engine](./08-update.md) | Pinning, change reporting, renames, per-marketplace throttling. Wants 06's manifests for `renames` and versions. |
| 9 | [09 — Search & info](./09-search.md) | Independently shippable, and 10 renders its output — cheaper to build once here than inline in the TUI. |
| 10 | [10a — Shared mutation core](./10a-core-mutations.md) + [10b — TUI](./10b-tui-dialog.md) | The visible payoff, and correct only once 05–07 exist to be driven from a dialog. Split in two: the plain-JS core surface the dialog and CLI share, then the dialog over it. |
| 11 | [11 — Cross-tool](./11-cross-tool.md) | Phase 1 is a directory convention, a `shell.env` hook and a lint — small, and nothing above depends on it. Deliberately after per-plugin install, as requested. |
| 12 | [12 — Validate & doctor](./12-validate-doctor.md) | Cross-cutting; wants every rule it lints to exist first. |
| 13 | [13 — Packaging & migration](./13-packaging.md) | The migration must cover every layout change from 01–03, so it is written last even though users hit it first. |

Parallelisable once 03 lands: 06+07 and 08 are independent of each other, and
09 is independent of both.

Two things are worth doing out of order if the schedule slips: the **migration
in 13** can be folded into 01 as it is written (it is mostly 01's own file
moves), and **04** can be written on day one since it is a decision record.
