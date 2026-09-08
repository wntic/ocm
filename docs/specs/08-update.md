# 08 — Update engine

Depends on: [02](./02-registry.md), [03](./03-materializer.md),
[06](./06-manifests.md). Absorbs pinning, change reporting, renames and
removals, throttled auto-sync, and failure isolation.

## Goal

```
ocm update                       every marketplace
ocm update <marketplace>         one marketplace
ocm update <plugin>@<mp>         one plugin (pull its marketplace, re-materialize it alone)
ocm pin <marketplace> <ref>      follow a branch or tag
ocm pin <marketplace> --clear    back to the default branch
```

plus the loader's unattended startup sync.

## One pass over one marketplace

1. skip if `local: true` — nothing to pull; re-materialize only
2. `git fetch --depth 1 origin <ref or default>`; `git reset --hard` to
   `FETCH_HEAD` (falling back to `@{u}`), shallow-clone safe
3. record `before` and `after` revisions
4. discover plugins; apply renames; reconcile against the registry
5. re-check the trust fingerprint ([07](./07-trust.md))
6. materialize with the enabled set
7. write `revision`, `lastSync`, and the refreshed `components` / `manifest`

Every step is per-marketplace and wrapped: **a failure in one marketplace
records `lastSync.ok = false` with the error and moves to the next**, never
aborting the pass and never leaving a partially materialized state — the
materialize step is skipped entirely when the pull fails, so the previous
links stay valid and the user keeps working offline.

## Change reporting

`ocm update` reports what actually changed, computed from git rather than from
content hashes — git already knows, and it can say *which* files:

```
updating wntic-adw…
  35eda0f → 8c1f2ab
  quality-review   1.2.0 → 1.3.0
    + commands/review.md
    ~ skills/code-review/SKILL.md
    - agents/old-reviewer.md
  new-plugin       installed (auto)
  gone-plugin      removed (no longer in the marketplace)
  team-tools       plugin/notify.js changed — blocked pending `ocm trust team-tools`
  restart opencode to activate
```

The per-plugin file list comes from `git diff --name-status <before> <after>`
filtered to that plugin's `source` prefix. For a `local: true` marketplace
there is no revision pair, so the report degrades to the materializer's own
created/removed/skipped counts.

`--quiet` prints only marketplaces that changed. `--json` emits the structured
form for the TUI.

## Version sources

Per plugin, in order: manifest `version` (marketplace entry, then
`plugin.json`), else `null` — in which case the marketplace `revision` is the
implicit version and `ocm list` shows `@<short sha>`.

## Pinning

`ref` is stored per marketplace and passed to every fetch. Pinning is
**branch- and tag-following, not commit-freezing**: a pinned marketplace moves
to the ref's current tip. To freeze, an author cuts a tag and the user pins to
it; to freeze harder, they fork.

`ocm pin` validates the ref by fetching it *before* saving, so a typo fails
immediately rather than breaking the next unattended sync. A ref deleted
upstream fails the pull with the ref named; the marketplace stays at its
current revision and keeps working.

**Per-plugin pinning** is not offered. A marketplace is one git repository and
one working tree; pinning a single plugin to an older ref would require a
second checkout of the same repo, which is buildable (`git worktree add`) but
buys reproducibility for a case — two plugins from one marketplace wanted at
two different versions — that has not come up. Recorded as a non-goal with the
implementation route noted, so it stays cheap to add.

## Lockfile

Deferred, deliberately. The registry already records `ref` and `revision` per
marketplace, which is every input a reproducible install needs; a lockfile
would be a second copy of that data with its own staleness rules. When a team
wants reproducibility, the shape to build is `ocm export > ocm.lock` /
`ocm import ocm.lock` over the existing registry fields — a serialization of
state that already exists, not a new source of truth. Noted here so
[13](./13-packaging.md) can schedule it.

## Renames and removals

Source: `renames: { "old": "new" | null }` in `marketplace.json` (also honoured
from `plugin.json`; the marketplace manifest wins on conflict). Applied after
discovery and before materialization, on every pass:

1. **rename** — registry has `old`, discovery has `new` → migrate the record
   (`enabled`, `installedAt`, `version`), drop `old`, re-materialize (the
   ownership diff renames the links for free, since the desired set changed),
   report `renamed old → new`
2. **removal** (`old → null`) → drop the record, unlink its components, drop
   its MCP keys, report
3. **registry plugin absent from discovery and not in `renames`** → same as a
   removal, reported as `removed (no longer in the marketplace)`. This applies
   regardless of `enabled` — a plugin the user disabled but that has since
   vanished upstream is pruned like any other.
4. **chains** (`a→b`, later `b→c`) → iterate to a fixed point. A cycle
   (`a→b`, `b→a`) is reported as a warning and ignored.
5. a rename whose target collides with a plugin name from another marketplace
   → refused, reported ([04](./04-precedence.md)); the old record stays.

## Auto-sync

The loader's `syncAll({ reason: "startup" })`:

- throttled: skip entirely if `now - lastSync.at < interval`, where interval
  is `marketplace.syncIntervalMs ?? OCM_SYNC_INTERVAL_MS ?? 3_600_000`
- the throttle is **per marketplace**, not one global stamp — the current
  single `~/.cache/ocm/last-sync.json` means one marketplace's sync suppresses
  every other's. Replaced by `lastSync.at` in the registry.
- never prompts, never materializes new or changed executable components
  ([07](./07-trust.md))
- never throws
- writes nothing when nothing changed, so a quiet start does not churn the
  registry file

Default 1h. `syncIntervalMs: 0` on a marketplace means every start;
`OCM_SYNC_DISABLE=1` turns startup sync off entirely.

Be honest in every message: a sync makes the *next* opencode start current.
Nothing appears in the running session ([04](./04-precedence.md#axis-5)).

## Edge cases

| Case | Behaviour |
|---|---|
| clone directory missing (cache cleared) | re-clone from `url` at `ref`, report it; a `local` marketplace whose directory is gone is reported and skipped, never re-created |
| shallow clone cannot reach `<ref>` | fetch that ref explicitly; if it still fails, report with the ref named |
| dirty working tree in the clone (user edited the cache) | `reset --hard` discards it; warn once naming the path, since the cache is not an editing surface |
| network down | every marketplace fails, every install keeps working, exit non-zero with one summary line |
| `before`/`after` identical | "already up to date"; still re-materialize, cheaply, so a hand-deleted link is repaired |

## Tests (`test/phase08-update.mjs`)

1. Two-commit fixture: revision transition, per-plugin version change, and the
   `+ ~ -` file list are all reported.
2. One unreachable marketplace of three: the other two update, its links
   survive, `lastSync.ok` is false, exit is non-zero.
3. `--ref` add and `pin` / `pin --clear`; pinning to a nonexistent ref fails
   without saving; a deleted upstream ref leaves the revision unchanged.
4. Rename migrates state and renames links; removal drops record, links and
   MCP keys; a plugin absent from discovery is pruned; a chain converges; a
   cycle warns.
5. Per-marketplace throttle: marketplace A syncing does not suppress B.
6. `syncAll` writes nothing when nothing changed.
7. A cleared cache directory is re-cloned; a missing local directory is not.
