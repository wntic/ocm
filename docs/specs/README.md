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
| [01 — Loader & plugin-host correctness](./01-loader.md) | shipped | 00 |
| [02 — Registry v2](./02-registry.md) | shipped | 00 |
| [03 — Materializer & namespacing](./03-materializer.md) | shipped | 00, 02 |
| [04 — Precedence & loading order](./04-precedence.md) | decision record | 00, 03 |
| [05 — Per-plugin install/uninstall](./05-install.md) | shipped | 02, 03 |
| [06 — Manifests & component types](./06-manifests.md) | shipped | 02, 03 |
| [07 — Trust for code-executing components](./07-trust.md) | shipped | 02, 06 |
| [08 — Update engine](./08-update.md) | shipped | 02, 03, 06 |
| [09 — Search & info](./09-search.md) | shipped | 06 |
| [10a — Shared mutation core](./10a-core-mutations.md) | shipped | 01, 05–09 |
| [10b — TUI integration (`/ocm`)](./10b-tui-dialog.md) | shipped | 10a |
| [11 — Cross-tool authoring format](./11-cross-tool.md) | shipped | 03, 06 |
| [12 — Validate & doctor](./12-validate-doctor.md) | shipped | 06, 07 |
| [13 — Packaging & migration](./13-packaging.md) | shipped | all |
| [14 — Agent Plugins interop](./14-agent-plugins.md) | shipped | 06, 11, 12 |
| [15 — Manifest location & path resolution](./15-manifest-location.md) | shipped | 06, 12 |
| [16 — Trust flow completion](./16-trust-flow.md) | shipped | 07, 10a |
| [17 — Add-path integrity](./17-add-integrity.md) | shipped | 02, 03, 08 |
| [18 — Collision correctness & scan](./18-collisions.md) | shipped | 04, 05, 08, 12 |
| [19 — Mandatory plugin manifests](./19-mandatory-manifests.md) | shipped | 06, 12, 15 |
| [20 — Doctor & config-write safety](./20-doctor-config-safety.md) | shipped | 07, 08, 12 |
| [21 — Displaced originals](./21-displaced-originals.md) | shipped | 03, 05, 10a |
| [22 — TUI fixes](./22-tui-fixes.md) | shipped | 10b, 08 |
| [23 — Truthful CLI reports](./23-truthful-reports.md) | shipped | 05, 08, 10a |
| [24 — Validate hardening](./24-validate-hardening.md) | shipped | 06, 12, 15, 19 |
| [25 — List, info & search display](./25-display.md) | shipped | 07, 08, 09 |
| [26 — Update engine hygiene](./26-update-hygiene.md) | shipped | 08 |

Specs 16–26 are the triage of two e2e rounds
([round 1](../e2e-findings.md),
[round 2](../e2e-findings-round2.md) — the triage table at its bottom
maps every finding to its spec). Each spec's header names its release
and its branch.

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

Continuing after 13 (the e2e triage specs — severity first, then polish):

| # | Spec | Why here |
|---|---|---|
| 14 | [16 — Trust flow](./16-trust-flow.md) | The security-adjacent UX: Ctrl+C half-installs, non-interactive trust is impossible, declines are unrecorded. Every trust interaction must state a true fact before anything else is built on it. |
| 15 | [17 — Add-path integrity](./17-add-integrity.md) | The front door installs dead symlinks on relative paths and half-registers on bad names — pre-flight validation and absolute resolution unblock everything downstream. |
| 16 | [18 — Collisions](./18-collisions.md) | The ownership model is right; every human surface around it lies. Fix the surfaces while the model is fresh. |
| 17 | [19 — Mandatory manifests](./19-mandatory-manifests.md) | Breaking for authors, cheap only while there are no public users — the later it lands, the more expensive it gets. |
| 18 | [20 — Doctor & config safety](./20-doctor-config-safety.md) | Doctor is the surface of last resort; it must stop deleting approved links and see the classes it owns. |
| 19 | [21 — Displaced originals](./21-displaced-originals.md) | Small, self-contained; makes the ownership invariant practically true, not just technically. |
| 20 | [22 — TUI fixes](./22-tui-fixes.md) | Visual batch: routing, sizing, navigation, versions. Independent of 20–21; order within v0.4.0 is free. |
| 21 | [23 — Truthful reports](./23-truthful-reports.md) + [24](./24-validate-hardening.md)–[26](./26-update-hygiene.md) | Pure polish on a correct core — deliberately last. |

Parallelisable: 16, 17, 18, 19 are independent of each other; 20, 21, 22
likewise; 23–26 likewise. Within a batch, any order.

## Releases & versioning

npm package `@wntic/ocm`; semver; currently 0.x.

| Version | Contents | Status |
|---|---|---|
| v0.1.0 | specs 01–13 | published 2026-09-10 |
| v0.2.0 | specs 14–15 (implemented on `main`, unpushed) | published 2026-09-13 |
| v0.3.0 | specs 16–19 | published 2026-09-14 |
| v0.4.0 | specs 20–22 | published 2026-09-15 |
| v0.5.0 | specs 23–26 | code complete; npm publish pending |
| v0.4.0 | specs 20–22 | planned |
| v0.5.0 | specs 23–26 | planned |

Rules:

- **Every spec names its target release in its header.** A spec that
  changes shipped behaviour does not land without its release;
  docs-only changes may ride any release.
- While 0.x: one **minor** per milestone batch; **patch** only for
  hotfixes of an already-published version.
- Breaking changes (schema, CLI contract, author requirements) are
  allowed only in a minor while 0.x, must be listed in the spec's
  **Breaking** note, and are justified by the absence of public
  users. After 1.0 they require a deprecation window.
- `npm publish` runs only from `main`, only on a commit tagged
  `vX.Y.Z`. The tag is the release record; the version in
  `package.json` never lies about what is published.

## Branches

- **One branch per spec**: `spec/<NN>-<slug>` matching the spec's own
  header — `spec/16-trust-flow`, `spec/17-add-integrity`, …. One spec
  per branch, one branch per spec; the PR description names the spec.
- PR into `main`; imperative subject, prose body explaining why (the
  house commit style).
- `develop` is **retired** — delete it after v0.2.0 ships. Per-spec
  branches plus tagged releases replace it.
- Hotfixes: `hotfix/vX.Y.Z` cut from the release tag, patch bump, PR
  into `main`.
- Release commit: `Release v0.3.0` — version bump and spec-status
  flips only, no behaviour changes in the release commit itself.
