---
name: ocm-test-harness
description: How to write a phase test for ocm — the fake-HOME harness, the fixture builders, what every phase test must assert, and why path constants force a cache-busting re-import. Use when writing or fixing anything under test/, or when a test fails in a way that looks like it is reading the real home directory.
---

# Writing an ocm phase test

Tests are plain `.mjs` under `test/`, run by `bun test`. One file per spec:
`test/phaseNN-<name>.mjs`, matching the spec's own Tests section — the spec is
the test plan, so implement its numbered list, in order, one test per item.

## The fake home

Every test runs against a throwaway `$HOME`. Nothing ever touches the real
`~/.config/opencode`.

```js
import { withFakeHome, fixtureMarketplace, gitRepo } from "./harness.mjs"

await withFakeHome(async (home, ocm) => {
  const mp = await fixtureMarketplace(`${home}/src/mp`, {
    plugins: {
      adw: { commands: ["commit.md"], skills: { "python-style": {} } },
    },
  })
  await ocm.add(mp)
  // assertions
})
```

`ocm` is the re-imported module set bound to this fake home.

**Why a re-import.** `src/paths.ts` and `loader/core.js` compute their path
constants at module load from `homedir()`. Changing `process.env.HOME` after
import does nothing. `withFakeHome` therefore imports with a cache-busting
query string per test:

```js
const core = await import(`../loader/core.js?t=${Date.now()}-${counter++}`)
```

If a test appears to read your real home, this is why: something imported the
module at file scope instead of inside `withFakeHome`.

## Fixtures

`fixtureMarketplace(dir, spec)` writes a marketplace tree from a compact
object — plugins, their components, manifests, renames, MCP files, JS plugins.
Prefer it over hand-written `mkdir`/`writeFile` chains: a test that fails
should fail on behaviour, not on a typo'd fixture.

`gitRepo(dir, commits)` runs `git init` and applies scripted commits, for
anything testing pull, revision, rename or pin.

## What every phase test asserts

Beyond the spec's own list, all four invariants (see the `ocm-invariants`
skill):

```js
assertConfigUnchangedOutsideOwned(before, after)
assertIdempotent(() => ocm.install("adw"))
assertUnownedUntouched(`${home}/.config/opencode/commands`)
await assertNoPluginErrors()
```

`assertNoPluginErrors` shells out to the real `opencode` binary and is skipped
when it is not on PATH, so the suite still runs in CI.

## Rules

- **One behaviour per test.** A test named for two things will fail for a
  third reason and teach you nothing.
- **Assert the observable thing**, not the implementation. Assert that the
  symlink exists and where it points, not that a private helper was called.
- **No network.** Marketplaces under test are local `gitRepo` fixtures. A test
  that needs github is not a unit test.
- **No sleeps.** If something is async, await it.
- **Failure messages name the path.** `expected link at ${dest} -> ${source}`
  beats `expected true`.

## Running

```
bun test                          everything
bun test test/phase03-*.mjs       one phase
./scripts/check.sh                typecheck + tests + probe, the real gate
```

A phase ships only when `./scripts/check.sh` exits 0.
