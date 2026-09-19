# Brief: reorganize the test suite

You are working in the `ocm` repository. This is a **mechanical
refactor of the test suite only**. No file under `src/`, `loader/` or
`bin/` may change. Read `AGENTS.md` first; its hard rules apply.

## Why

Two problems, both structural:

1. **The file naming is spec-numbered.** `test/phaseNN-<spec>.mjs` maps
   one file to one spec. The specs are being deleted once the code is
   stable, and the next spec (31) changes behaviour tested across eight
   different phase files, so the mapping is already breaking. It also
   fights the runner: bun only discovers `*.test.*` / `*.spec.*`, so
   `bun test test/phase02-registry.mjs` runs **nothing** — which is why
   `test/all.test.mjs` exists as an import shim and why
   `scripts/check.sh` passes explicit paths.
2. **The suite takes 469 seconds** (measured: 209 tests, 1216
   `expect()` calls, `bun test test/all.test.mjs`). Almost none of it is
   ocm: the CLI under test runs in 0.01 s. The cost is ~60 spawns of the
   real `opencode` binary, at ~5.9 s each when a plugin file is present
   (0.53 s when not).

## Task 1 — rename and merge (do this first, land it separately)

Merge the 26 `test/phaseNN-*.mjs` files into ~12 files named for the
behaviour they cover, each ending in `.test.mjs` so `bun test`
discovers them without a shim.

Proposed mapping — adjust if the content argues otherwise, but say so
in your report:

| New file | Absorbs |
|---|---|
| `registry.test.mjs` | phase02 |
| `loader.test.mjs` | phase01 |
| `materialize.test.mjs` | phase03, phase04 |
| `install.test.mjs` | phase05, phase18, phase21 |
| `manifests.test.mjs` | phase06, phase14, phase15, phase19 |
| `trust.test.mjs` | phase07, phase16 |
| `update.test.mjs` | phase08, phase26 |
| `search-info.test.mjs` | phase09, phase25 |
| `reports.test.mjs` | phase23 |
| `validate.test.mjs` | phase12 (validate half), phase24 |
| `doctor.test.mjs` | phase12 (doctor half), phase20 |
| `tui.test.mjs` | phase10a, phase10b, phase22 |
| `crosstool.test.mjs` | phase11 |
| `migrate.test.mjs` | phase13 |

Rules:

- **Move test bodies verbatim.** Do not rewrite an assertion, rename a
  variable, "improve" a helper, or delete a test you think is
  redundant. A reviewer must be able to read the diff as moves. If a
  test looks wrong, note it in your report and leave it alone.
- Merge duplicated local helpers within a new file (several phase files
  define their own `runOcm`/`gitInit`); if a helper is now used by
  three or more files, move it to `test/harness.mjs` — which has a
  **150-line, 8-export budget** (`ocm-test-harness` skill). If the
  budget blocks you, say so rather than silently exceeding it.
- Keep each test's name text unchanged, so a failure is still
  greppable against the old logs and the e2e findings.
- Delete `test/all.test.mjs` once nothing needs it.
- Update `scripts/check.sh` to stop passing explicit paths if `bun
  test` now discovers correctly — but keep the "never run bare `bun
  test`" protection in mind: verify discovery does not walk
  `node_modules` (both trees) and hang. If it does, keep the explicit
  list and say so.
- `test/ocm-pty.py` is used by pty-driven tests; leave it where it is.

**Acceptance for task 1: `209 pass, 0 fail, 1216 expect() calls`** —
exactly the counts above, no test lost, none added. Report the numbers.

## Task 2 — cut the probe cost (separate commit)

`test/harness.mjs` `opencodeProbe()` spawns the real `opencode` binary.
26 of 27 files call it, each costing at least two spawns: a canary
config with a deliberately broken plugin (always the slow path) plus
the subject, and more if the caller reads `.commands` / `.skills`.

Three changes, in this order — measure after each:

1. **Cache the canary result per process.** `opencodeOnPath` is already
   cached across calls; the canary spawn is not, and it is identical
   every time. One line; halves the cost immediately.
2. **Probe once for the suite, not once per file.** Build one home
   containing every component shape (command, agent, skill, JS plugin,
   MCP server) and assert opencode resolves all of it in a single
   dedicated test. Every other file asserts on disk — symlink targets,
   rendered `SKILL.md` content, `opencode.json` keys — which is what
   most of them already do around the probe call. Remove the
   now-redundant probe calls; do not remove the **assertions** they
   guard, only the spawn.
3. **Make any remaining in-test probe opt-in** behind `OCM_PROBE=1`,
   defaulting off. `scripts/check.sh` already runs
   `scripts/oc-probe.sh` as its own gate step, so the gate keeps full
   probe coverage; set `OCM_PROBE=1` in the check script's test step so
   nothing is lost there either.

**Acceptance for task 2:** same test and expect counts as task 1;
`bun test` under 30 s on a warm machine; `./scripts/check.sh` still
exits 0 with the probe step green. Report the before/after wall time.

## Task 3 — update what documents the layout (same commit as task 1)

Two project skills describe the old naming and become wrong the moment task 1
lands:

- `.opencode/skills/ocm-test-harness/SKILL.md` — states the
  `test/phaseNN-<name>.mjs` convention, the `all.test.mjs` shim and the
  explicit-path invocation. Update all three to the new layout, and **rename
  the skill directory to `ocm-testing`** (it is not only a harness any more).
  Update the reference to it in `AGENTS.md` and in
  `.opencode/agents/test-author.md`.
- `.opencode/skills/ocm-architecture/SKILL.md` — one line describes `test/` as
  "harness.mjs plus one phaseNN-*.mjs per spec".

Every test file also carries a header comment citing `docs/specs/NN-….md`.
Those briefs are no longer in the repository — they live untracked in
`.work/briefs/`. While you are moving each test body, change the citation to
name the behaviour instead of the path (`// trust: an update that changes a
trusted file blocks it`). Do not add new commentary beyond that.

Keep both within their existing budgets. Do not add new guidance while you are
in there; this is a naming update, not a rewrite.

## Hard rules for this work

- No change to `src/`, `loader/`, `bin/`, or any behaviour of ocm. If a
  test fails after a move, the move is wrong — do not "fix" it by
  editing the code under test.
- The four ownership invariants every test asserts (`ocm-invariants`
  skill) must still be asserted in the merged files. Count them before
  and after.
- Two commits, in order: the rename/merge, then the probe work. House
  commit style — imperative subject, prose body explaining why, no
  trailers.
- Do not touch `docs/specs/`. The spec-to-test mapping is being retired
  by this work; recording that is a separate change.

## Report back

1. The final file list and what each absorbed.
2. Test count, expect count, wall time — before and after each task.
3. Anything you left alone because it looked wrong (do not fix it).
4. Whether `bun test` discovery is safe without an explicit file list.
