# 02 — Registry v2

Depends on: [00](./00-contract.md). Foundation for 05–09; designed once so
later phases add behaviour, not schema.

## Goal

One schema carrying everything the later specs need — per-plugin enablement,
marketplace mode, pinning, revisions, trust, sync throttling, cached metadata
— while v1 registries keep working and unknown fields survive round-trips.

## Location

`~/.config/opencode/ocm/registry.json`, moved from
`~/.config/opencode/plugins/ocm-registry.json` by [01](./01-loader.md). The
old path is read as a fallback for one release and never written.

Why not `~/.cache/ocm/`: the registry is user intent, not a cache. A user
clearing `~/.cache` should lose clones and links (both reconstructible) and
keep their list of marketplaces and choices.

## Schema

```json
{
  "version": 2,
  "marketplaces": {
    "<marketplace>": {
      "url": "https://github.com/user/repo",
      "dir": "/Users/x/.cache/ocm/marketplaces/user--repo",
      "local": false,
      "addedAt": "2026-09-08T10:00:00.000Z",
      "mode": "auto",
      "ref": null,
      "revision": "35eda0f…",
      "syncIntervalMs": null,
      "trust": {
        "code": "granted",
        "grantedAt": "2026-09-08T10:00:00.000Z",
        "fingerprint": "sha256:…"
      },
      "lastSync": { "at": "…", "ok": true, "error": null },
      "plugins": {
        "<plugin>": {
          "source": "plugins/quality-review",
          "components": {
            "command": ["commit.md"],
            "agent": ["reviewer.md"],
            "skill": ["code-review"],
            "plugin": ["notify.js"],
            "mcp": ["context7"]
          },
          "enabled": true,
          "installedAt": "…",
          "version": "1.2.0",
          "manifest": { "description": "…", "category": "…", "tags": [] }
        }
      }
    }
  }
}
```

## Field semantics

| Field | Meaning |
|---|---|
| `dir` | absolute path of the working tree ocm reads components from. For a git marketplace this is the clone under `~/.cache/ocm/marketplaces/`; for a local marketplace it is the user's own directory, which ocm never writes to. |
| `local` | true when `dir` is the user's directory rather than an ocm-managed clone. Replaces the current `dir.startsWith(MARKETPLACES_DIR)` string test, which is a latent bug for anyone whose marketplace lives under `~/.cache`. |
| `mode` | `auto` — every discovered plugin is enabled, and new upstream plugins auto-enable. `explicit` — only plugins the user installed are enabled. |
| `ref` | branch or tag the marketplace follows; `null` = the clone's default branch. See [08](./08-update.md). |
| `revision` | last successfully synced commit SHA. Written by every successful pull, CLI and loader alike. |
| `syncIntervalMs` | per-marketplace throttle override; `null` = use the global default (1h). |
| `trust.code` | `"none"` (no executable component has ever been seen), `"granted"`, or `"denied"`. `fingerprint` is a hash over the set of executable component paths and contents at grant time. See [07](./07-trust.md). |
| `lastSync` | outcome of the most recent sync attempt, so `list` and `doctor` can show a marketplace that has been failing quietly. |
| `plugins.<n>.source` | path **relative to the marketplace root**, not absolute. An absolute path (as stored today) breaks the moment the cache directory moves; relative also makes registries diffable across machines. |
| `plugins.<n>.enabled` | whether the materializer links this plugin. |
| `plugins.<n>.installedAt` | when the user chose it; `null` when never chosen or uninstalled. Distinguishes "never picked" from "picked then disabled". |
| `plugins.<n>.version` | from a manifest ([06](./06-manifests.md)) if declared, else `null` — the marketplace `revision` is the implicit version. |
| `plugins.<n>.manifest` | cached metadata subset so `list` / `info` / `search` need no marketplace directory access. |

## Migration

`normalizeRegistry(raw)` in `src/registry.ts`, mirrored read-only in
`ocm/core.js`:

- `version: 1` → fill defaults: `mode: "auto"`, `ref: null`, `revision: null`,
  `syncIntervalMs: null`, `trust: { code: "none" }`, `lastSync: null`,
  `local` derived from the old `dir` prefix test, per plugin `enabled: true`,
  `installedAt: <addedAt>`, `version: null`, `manifest: {}`, `source`
  rewritten from absolute to marketplace-relative.
- `version: 2` → passed through; **unknown marketplace-level and plugin-level
  fields are preserved verbatim** on save, so a newer ocm on another machine
  writing a field this one doesn't know cannot lose it.
- anything else → empty registry.

Migration is **read-only**: reading a v1 file must not rewrite it. The v2 file
is written on the next mutating command, and the report names the upgrade.

The old top-level `path` field (a duplicate of `url`) is dropped.

## Writes

Every write is atomic: serialise, write `registry.json.tmp` in the same
directory, `rename()` over the target. Keys are emitted in a stable order so a
no-op save produces a byte-identical file (idempotence invariant).

## Degradation

A stale `ocm/core.js` reading a v2 registry ignores fields it does not know
and links everything — the v1 observable behaviour. Acceptable, and
[12](./12-validate-doctor.md) detects the stale core by version comment.

## Consumed by

[03](./03-materializer.md) reads `enabled` and `components`;
[05](./05-install.md) mutates `enabled` / `installedAt`;
[07](./07-trust.md) owns `trust`; [08](./08-update.md) owns `ref`,
`revision`, `syncIntervalMs`, `lastSync`; [09](./09-search.md) reads
`manifest`.

## Tests (`test/phase02-registry.mjs`)

1. A v1 registry on disk reads back in v2 shape with defaults filled.
2. Migration does not touch the file until an explicit save.
3. v2 round-trips byte-stably through load → save with no changes.
4. Unknown marketplace-level and plugin-level fields survive load → save.
5. Absolute `source` values in a v1 registry are rewritten relative, and
   resolve back to the same absolute path.
6. `local` is derived correctly for a marketplace whose directory happens to
   sit under `~/.cache` but is not ocm-managed.
7. Atomicity: a write into a read-only directory leaves the previous file
   intact and reports an actionable error.
