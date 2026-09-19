---
name: ocm-testing
description: How to write a test for ocm — the fake-HOME harness, the fixture builders, what every test must assert, and why path constants force a cache-busting re-import. Use when writing or fixing anything under test/, or when a test fails in a way that looks like it is reading the real home directory.
---

# Writing an ocm test

Tests are `*.test.mjs` under `test/`, run by `bun test`, one file per
behaviour area (`trust.test.mjs`, `update.test.mjs`) — never one per change
or per brief. A brief's Tests list is the test plan: implement its numbered
list, in order, one test per item, in the existing file that covers the
behaviour.

## The fake home

Every test runs against a throwaway `$HOME`. Nothing ever touches the real
`~/.config/opencode`.

```js
import { withFakeHome } from "./harness.mjs"

await withFakeHome(async (home, ocm) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { adw: { commands: { "commit.md": COMMAND } } } })
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

Each test file carries its own local fixture helpers — `writeTree(dir, tree)`
for marketplace trees, a `gitRepo(dir, tree)` wrapper for anything testing
pull, revision, rename or pin. Prefer them over hand-written
`mkdir`/`writeFile` chains: a test that fails should fail on behaviour, not
on a typo'd fixture. Duplicate helpers merge within a file when phases are
absorbed; they stay out of `harness.mjs` unless three or more files call
them (and the budget below allows it).

## What every test asserts

Beyond the spec's own list, all four invariants (see the `ocm-invariants`
skill), asserted inline:

```js
// config safety — the user's keys survive, byte-for-byte where nothing changed
expect(readFileSync(configFile(home), "utf8")).toBe(configBytes)
// ownership — a user's hand-written file at a target path is never modified
expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
// idempotence — a second run writes nothing
expect(readFileSync(registryFile(home), "utf8")).toBe(registryBytes)
// no plugin-load errors — ask the real binary (opt-in: OCM_PROBE=1)
const probe = opencodeProbe(cfg(home), home)
if (probe.available && !probe.unreliable) expect(probe.pluginErrors).toEqual([])
```

`opencodeProbe` shells out to the real `opencode` binary and reports
`available: false` unless `OCM_PROBE=1` is set, so a plain `bun test` never
spawns opencode; `scripts/check.sh` sets the variable and
`scripts/oc-probe.sh` scans plugin errors as its own gate step. The suite
keeps exactly one resolution probe — the every-component-shape test at the
end of `materialize.test.mjs`.

## The harness stays small

Budget: **150 lines, 8 exports**. It exists to remove repetition from the
tests, not to be a testing framework. Add a helper when a test in front of you
calls it — never for a test you have not written yet. If it is over budget,
the fix is deleting helpers with one call site, not splitting the file.

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
./scripts/check.sh                    the gate — typecheck, tests, probe
bun test test/materialize.test.mjs    one area, explicit path
```

**Never run bare `bun test` or `bun test test/` in this repo.** Directory
traversal walks both `node_modules` trees and hangs indefinitely; an explicit
file path runs in milliseconds. `scripts/check.sh` builds the file list for
you, which is why it is the command to use.

The `*.test.mjs` naming means `bun test` discovers the files by name — but
discovery still has to walk the tree to find them, so the explicit-path rule
above stands.

A change ships only when `./scripts/check.sh` exits 0.

## Nothing expensive at module scope

Test files are *imported* before any test runs, so anything at module scope
runs during discovery, outside any timeout, with no output. A probe helper
called while registering tests — rather than inside a test body — spawns
opencode during import and appears to the caller as an indefinite hang.

Do the expensive thing inside the test callback, or memoise it behind a lazy
getter the callback calls. A `test.skip` decision that needs a probe should
register the test unconditionally and skip from inside it.
