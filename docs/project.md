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
| v0.6.1 | brief 38 §0 — the TUI freeze at zero columns, and a stale loader after upgrade | published 2026-09-20 |
| v0.7.0 | briefs 30, 31, 38, 39, 40, 41 — outcome-derived reports, per-root cache, renames in the loader, local changed-set, plugin-root substitution, small correctness | published 2026-09-22 |
| v0.7.1 | briefs 42, 43 — a read-only command writes nothing; the cache migration is resumable and moves only what it owns | published 2026-09-23 |
| v0.8.0 | briefs 32, 33, 44, 45, 46 — error classification, doctor ownership, the materializer split, outcome-derived headlines | in progress |
| v0.9.0 | brief 36 — display & TUI, and a voice for the loader's startup sync | planned |
| v1.0.0 | no new scope — the first release to meet the bar below after v0.9.0 | planned |

Rules:

- **Every brief names its target release in its header.** A brief that
  changes shipped behaviour does not land without its release; docs-only
  changes may ride any release.
- While 0.x: one **minor** per milestone batch; **patch** only for
  hotfixes of an already-published version.
- Breaking changes (schema, CLI contract, author requirements) are
  allowed only in a minor while 0.x and must be listed in the brief's
  **Breaking** note. **The "no public users" justification has expired**:
  npm recorded 126 downloads of v0.6.1 and 152 of v0.6.0 in one week
  (2026-09-22). Earlier breaking changes — brief 19's mandatory
  `plugin.json` above all — were argued as cheap on that basis, and it was
  true when they were argued. From here a breaking change needs a
  migration story that works without the user reading a release note.
  After 1.0 they require a deprecation window.
- `npm publish` runs only from `main`, only on a commit tagged
  `vX.Y.Z`. The tag is the release record; the version in
  `package.json` never lies about what is published.

## Scope freeze (2026-09-23)

Rounds 3–5 found 62, 13 and 24 findings, and round 5's high and medium
findings all sat in code new in that release: every fix to an older
finding held. The old surface has converged; new defects now come from new
code. So the finish line is set by scope, not by a clean round:

- **The scope is frozen** at briefs 45 and 46 (v0.8.0) and 36 (v0.9.0).
  A new brief is written only for a **high** finding.
- **Round 6, before v0.8.0, is the last broad e2e round.** After it, a
  round covers only the surface its release changed.
- **The release bar:** a release ships when its round finds no high and no
  medium. Low findings go to a backlog and do not generate briefs.
- **v1.0.0** is the first release after v0.9.0 that meets the bar. It adds
  nothing.

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

## Accepted risks

Known, understood, and deliberately not fixed.

| Risk | Why it is accepted |
|---|---|
| **Lock-steal race** (brief 37, closed 2026-09-23). Two processes that both judge the same registry lock stale can both break it and both hold it, and the later write clobbers the earlier. | It needs two ocm processes to reach the stale-lock path within one interleaving window — reproducible by construction (round 5 built it deliberately as the setup for A7-24) but never observed in use. Its visible residue, links orphaned by the lost write (F233), is now reported and repaired by `ocm doctor` (brief 33). Closing the window properly means a compare-and-swap on the lock file, and the scope is frozen. |

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
