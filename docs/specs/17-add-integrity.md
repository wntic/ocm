# 17 — Add-path integrity

Depends on: [02 — Registry v2](./02-registry.md),
[03 — Materializer](./03-materializer.md), [08 — Update engine](./08-update.md).

Release: **v0.3.0** (batch with [16](./16-trust-flow.md),
[18](./18-collisions.md), [19](./19-mandatory-manifests.md)).
Branch: `spec/17-add-integrity`.

Evidence: F7 (high), F23, F31, F45, F54, F55
([round 2](../e2e-findings-round2.md)); transcripts in
`docs/e2e-round2/a5.md`, `a7.md`.

## Goal

`ocm add` is the front door, and it currently fails silently on bad
input: a relative path installs dead symlinks with exit 0, an
over-long name crashes with a raw `ENAMETOOLONG` leaving a
half-registered marketplace, a private repo hangs forever at git's
username prompt, and a fresh add records no provenance (`revision:
null`), which makes search claim the sync "is stale or failed". This
spec makes the add path validate before it writes, resolve before it
links, and fail fast on unreachable sources.

## 1. Relative paths resolve to absolute at add time (F7)

`ocm add ocm-e2e/local-mp` from `$HOME` today stores the relative
string in the registry and builds every symlink target from it: the
install reports success, `opencode debug config` sees 0 commands, and
`ocm update` from another cwd says "directory missing … skipping".

**Changes:**

1. `loader/source.js expandPath` (and every entry into it) resolves
   the given path to an **absolute** real path before use:
   `resolve()` against the current working directory, `realpath()`
   where the target exists.
2. The registry stores the absolute path; symlink targets are built
   from it. A relative argument and its absolute spelling produce
   byte-identical registries.
3. A path that does not exist is refused **before any write** with the
   existing not-found error — never turned into a dead install.

`ocm add .` becomes valid (resolves to the cwd). Symlinked marketplace
directories are stored post-`realpath`, so moving the link does not
orphan the install.

## 2. Name and length limits, checked before any write (F54)

A 200-character plugin name passes discovery (`PLUGIN_NAME_RE` has no
length bound), reaches symlink creation, throws `ENAMETOOLONG` from
the filesystem, and leaves a registered marketplace whose plugin
"installed" nothing.

**Changes:**

1. Limits, enforced in the core's add and update registration paths
   before the registry is written:
   - marketplace name ≤ 64 chars (already regex-bound to
     `[a-z0-9]+(-[a-z0-9]+)*`)
   - plugin name ≤ 64 chars (same regex)
   - component file names ≤ 200 bytes each (command, agent, plugin JS,
     skill, MCP server key)
2. Violations are a single ocm-style error naming the offender, the
   limit, and the next action — never a raw syscall message:

   ```
   error: plugin "alpha-kit".command "<name>.md" exceeds 200 bytes (215)
     rename the file in the marketplace, then re-run ocm add
   ```

3. Atomicity rule: validation of **all** names happens before **any**
   write. A marketplace with one bad component is refused whole —
   no registry entry, no links, no config edits, exit 1.

## 3. Git never prompts; unreachable sources fail fast (F31)

A private repo over https in a tty hangs indefinitely at git's own
`Username for 'https://github.com':` prompt — no timeout, no ocm
context. Non-tty already fails cleanly, so this is purely the tty
case.

**Changes:** every git spawn in ocm (clone, fetch, ls-remote —
`loader/source.js` and `src/`) runs with:

- `GIT_TERMINAL_PROMPT=0`
- `GIT_SSH_COMMAND` set to `ssh -o BatchMode=yes` **only when the
  environment does not already provide one** (a user's custom
  `GIT_SSH_COMMAND` wins).

Failure surfaces as a normal ocm error:
`error: cannot access <url> — the repository is private, unreachable, or the URL is wrong`. For a
marketplace already in the registry, update reports the same failure
per-marketplace and continues (existing failure isolation, unchanged).

## 4. Add records provenance (F23, F45)

After a successful clone — including `ocm add --ref <ref>` — the
registry records the marketplace's `revision` (cloned HEAD) and
`lastSync: { at, ok: true }`. Today both stay `null` until the first
`ocm update`, which is why a no-match search on a freshly added
marketplace suggests "a marketplace sync is stale or failed; run ocm
update" (and then update says "already up to date").

The search hint's staleness predicate additionally stops firing for
**local** marketplaces (`lastSync` is permanently null for them and
always will be — they have nothing to sync). A local marketplace may
still produce the hint when its directory is missing.

## 5. Input shaping (F55)

- A leading `~/…` is expanded by ocm itself, even when quoted by the
  shell (`"~/ocm-e2e/local-mp"`). Today only the unquoted form works,
  because the shell does the expansion.
- Arguments are trimmed of surrounding whitespace.
- A bare `owner/repo` argument (no scheme, no path on disk) keeps the
  path-does-not-exist refusal but gains a hint:
  `looks like a repository shorthand — use git@github.com:owner/repo.git or https://github.com/owner/repo`.

## Edge cases

| Case | Behaviour |
|---|---|
| relative path, add and update from different cwds | both work; registry holds the absolute path |
| `ocm add .` | valid; marketplace named from the directory |
| symlinked marketplace dir | stored post-`realpath` |
| marketplace with one over-long component name | refused whole, zero writes, exit 1 |
| same via `ocm update` (upstream adds a bad name) | that plugin is skipped with the named-limit warning; rest of the update proceeds |
| private repo, tty | fails in <2s with the ocm error; no clone dir left behind |
| user has `GIT_SSH_COMMAND` set | respected, not overridden |
| `ocm add --ref v1.0.0` | `revision` and `lastSync` recorded at add |
| local marketplace, search no-match | no stale-sync hint while the directory exists |

## Consumed by

`loader/source.js`, `loader/core.js` (add/registration),
`src/commands/search.ts` (hint predicate), README (trust of `~`
quoting is no longer needed, but document that ocm expands `~`).

## Tests (`test/phase17-add-integrity.mjs`)

1. Add with a relative path from `$HOME`; links resolve; `opencode
   debug config` (or symlink target asserts) sees the components;
   `ocm update` from `/tmp` succeeds.
2. Same marketplace added by relative and absolute spellings produces
   identical registry bytes.
3. Nonexistent path: refused, no registry file created.
4. Fixture with a 200-char plugin name: single error naming the limit,
   exit 1, registry/links/config untouched (byte-compare before and
   after).
5. Private repo over https with a tty (expect-spawned): process exits
   non-zero within 2s with the ocm error.
6. `add --ref`: `revision` non-null, `lastSync.ok` true immediately.
7. Search no-match on a local marketplace: no stale hint.
8. `ocm add '"~/…"'` (quoted tilde) works; `wntic/some-repo` prints
   the URL hint.
