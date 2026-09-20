# Project record

The durable half of what used to live in `docs/specs/README.md`. The briefs
themselves are working material: they are written in `.work/briefs/`, are not
tracked, and are deleted once the code they describe is stable. Everything
here outlives them.

The verified opencode behaviour the code depends on is in
[opencode-contract.md](./opencode-contract.md); the end-to-end rounds that
produced the current work queue are in `e2e-findings*.md`, whose triage tables
name briefs by number.

## Releases & versioning

npm package `@wntic/ocm`; semver; currently 0.x.

| Version | Contents | Status |
|---|---|---|
| v0.1.0 | specs 01–13 | published 2026-09-10 |
| v0.2.0 | specs 14–15 (implemented on `main`, unpushed) | published 2026-09-13 |
| v0.3.0 | specs 16–19 | published 2026-09-14 |
| v0.4.0 | specs 20–22 | published 2026-09-15 |
| v0.5.0 | specs 23–26 | published 2026-09-15 |
| v0.5.1 | brief 35 §1, §3, §4 (docs and template only) | published 2026-09-19 |
| v0.6.0 | briefs 27, 28, 29, 34 — write safety, platform, manifest gate, MCP shape | published 2026-09-20 |

Rules:

- **Every brief names its target release in its header.** A brief that
  changes shipped behaviour does not land without its release; docs-only
  changes may ride any release.
- While 0.x: one **minor** per milestone batch; **patch** only for
  hotfixes of an already-published version.
- Breaking changes (schema, CLI contract, author requirements) are
  allowed only in a minor while 0.x, must be listed in the brief's
  **Breaking** note, and are justified by the absence of public
  users. After 1.0 they require a deprecation window.
- `npm publish` runs only from `main`, only on a commit tagged
  `vX.Y.Z`. The tag is the release record; the version in
  `package.json` never lies about what is published.

## Branches

- **One branch per brief**: `work/<slug>` — one brief per branch, one
  branch per brief; the PR description names the brief and what it changed,
  since the brief itself is not in the repository.
- PR into `main`; imperative subject, prose body explaining why (the
  house commit style, `AGENTS.md`).
- Hotfixes: `hotfix/vX.Y.Z` cut from the release tag, patch bump, PR
  into `main`.
- Release commit: `Release v0.5.1` — version bump only, no behaviour
  changes in the release commit itself.

## Locked decisions

Argued when they were made; changing one is a decision, not an edit.

| Decision | Choice | Where it is argued |
|---|---|---|
| Tool name | CLI stays `ocm`; npm package is `@wntic/ocm` | 13 |
| Install mechanism | symlink-first behind a materializer interface; copy mode is a non-goal | 03 |
| Skill namespacing | rendered `SKILL.md` (`name:` rewritten to `<plugin>:<skill>`), siblings symlinked | 03 |
| Scope | user-global only in v1; project scope is a documented non-goal | 04 |
| Plugin name collisions | globally unique, first-come-wins, `plugin@marketplace` disambiguates | 04 |
| Cross-tool | portable `SKILL.md` subset + per-target command/agent dirs; no neutral schema compiler | 11 |
| Trust | per-marketplace at add, re-prompt when an update introduces new executable code | 07 |
| Auto-sync | throttled, 1h default, per-marketplace override | 08 |

## Non-goals

- Copy-mode installs and versioned copy caches.
- Project-local (`.opencode/`) install scope.
- External plugin sources (npm / archive / `git-subdir` entries inside a
  marketplace) — the marketplace repo is the distribution unit.
- Plugin-to-plugin dependencies.
- Org settings, allowlists, managed distribution.
- Writing anything into `~/.claude/` or `.claude/` on the user's machine.

## Conventions

- Runtime: Bun + TypeScript. CLI entry `bun ./bin/ocm.ts`.
- `tsc --noEmit` must be clean before anything ships.
- Tests live in `test/` and run under a fake `$HOME` (see the `ocm-testing`
  skill and [opencode-contract.md](./opencode-contract.md#testing-harness)).
- Nothing ships until `./scripts/check.sh` exits 0.
