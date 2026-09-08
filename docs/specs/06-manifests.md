# 06 — Manifests & component types

Depends on: [02](./02-registry.md), [03](./03-materializer.md).

## Goal

Author-declared metadata, and the two component types opencode supports that
ocm does not yet ship: **JS/TS opencode plugins** and **MCP servers**.

## Marketplace repository layout

```
my-marketplace/
├── marketplace.json                    optional
└── plugins/
    └── quality-review/
        ├── plugin.json                 optional
        ├── commands/commit.md          → /quality-review:commit
        ├── agents/reviewer.md          → quality-review:reviewer
        ├── skills/code-review/SKILL.md → skill "quality-review:code-review"
        ├── plugin/notify.js            → opencode server plugin (trust-gated)
        ├── mcp.json                    → mcp servers
        └── scripts/, templates/, …     supporting files, never materialized
```

`plugin/` is singular, matching opencode's own `{plugin,plugins}` glob;
`plugins/` inside a plugin directory is also accepted. Both `command`/`commands`,
`agent`/`agents`, `skill`/`skills` are accepted for the same reason. A name
clash between the singular and plural form of the same type is an error.

A directory under `plugins/` with at least one component is a plugin, manifest
or not. **Manifests add metadata; they never hide a plugin.** This keeps
zero-config marketplaces working.

## `marketplace.json`

```json
{
  "$schema": "https://raw.githubusercontent.com/wntic/ocm/main/schema/marketplace-v1.json",
  "name": "wntic-adw",
  "description": "Team plugin catalog",
  "owner": { "name": "…", "email": "…", "url": "…" },
  "homepage": "https://…",
  "renames": { "old-plugin": "new-plugin", "dead-plugin": null },
  "plugins": [
    {
      "name": "quality-review",
      "source": "./plugins/quality-review",
      "description": "…",
      "version": "1.2.0",
      "author": { "name": "…" },
      "category": "review",
      "tags": ["review", "quality"],
      "keywords": ["pr", "lint"],
      "homepage": "…", "repository": "…", "license": "MIT",
      "defaultEnabled": true,
      "mcpServers": "./mcp.json"
    }
  ]
}
```

Rules:

- Only a plugin entry's `name` and `source` are required; everything is
  optional at the top level too.
- `source` is a `./`-relative path inside the marketplace. `../` and absolute
  paths are rejected. External sources (npm, archive, another repo) are a
  non-goal — the marketplace repo *is* the distribution unit.
- An entry whose `source` does not resolve is a warning at add/update and an
  error at `validate`, never a failure of the whole operation.
- The manifest `name` is display metadata. It seeds the marketplace name at
  `ocm add` time and never renames an already-added marketplace — the registry
  key is the identity users have typed into scripts.
- `renames` is consumed by [08](./08-update.md).

## `plugins/<name>/plugin.json`

The same fields as a marketplace `plugins[]` entry, minus `source`,
`defaultEnabled` and `mcpServers`. It exists so a plugin directory is
self-describing when it is vendored or read on its own.

**Metadata precedence:** marketplace entry > `plugin.json` > filesystem
inference (name from directory, components from the scan). The merged result
populates the registry's cached `manifest`.

A `plugin.json` whose `name` disagrees with its directory name is an error at
`validate` and a warning at install; the directory name always wins, because
that is what the materializer namespaces from.

## JS/TS opencode plugins

Source: `plugins/<p>/plugin/*.{js,ts}`.
Target: `link` → `~/.config/opencode/plugins/ocm--<p>--<file>`.

- The `ocm--` prefix puts the file inside ocm's ownership model and cannot
  collide with a user's own plugin file or with another plugin's.
- These files execute. They materialize **only** after trust is granted for
  their marketplace ([07](./07-trust.md)); until then they are discovered,
  recorded in the registry, and reported as `blocked (untrusted)`.
- Each must satisfy opencode's module contract — default-export
  `{ id, server }` (or a legacy bare function). `validate`
  ([12](./12-validate-doctor.md)) checks the shape statically, because a bad
  module produces a red line in the user's log on every start
  ([00](./00-contract.md)).
- Load order relative to other plugins is unspecified
  ([04](./04-precedence.md)).
- Requires a restart, like everything else.

Shipping a TUI plugin (`{ id, tui }`) from a marketplace is **not supported in
v1**: it would require editing the user's `tui.json` `plugin` array on behalf
of third-party code, which is a materially larger trust decision than dropping
a file into a directory opencode already scans. Recorded as a non-goal;
`validate` rejects a `tui` module under `plugin/` with that explanation.

## MCP servers

Source: `plugins/<p>/mcp.json` (or the path in the entry's `mcpServers`),
containing exactly opencode's `mcp` entry shape:

```json
{
  "context7": { "type": "local", "command": ["npx", "-y", "@upstash/context7-mcp"], "enabled": true },
  "linear":   { "type": "remote", "url": "https://mcp.linear.app/sse", "enabled": true }
}
```

Materialization, for enabled and trusted plugins only:

1. desired keys are `ocm--<plugin>--<server>`
2. read the global `opencode.json`; remove every `ocm--<plugin>--*` key not
   desired; add or overwrite the desired ones
3. preserve every other key; write atomically
4. create the `mcp` object only if missing; drop it if it becomes empty

An MCP server is executable code by the same argument as a JS plugin — a local
server is a command line ocm caused to run — so **MCP components are
trust-gated too**.

MCP config is read once at startup: restart notice applies.

## Registry effects

`components` gains `plugin` and `mcp` arrays; `manifest` caches
`description`, `category`, `tags`, `version`, `defaultEnabled`.

## Deliverables

- `schema/marketplace-v1.json` and `schema/plugin-v1.json` — JSON Schema for
  editor validation, mirrored by a hand-rolled validator in
  [12](./12-validate-doctor.md) (no new runtime dependency).
- `template/` extended to one plugin with one component of every type.
- README section rewritten around this layout.

## Tests (`test/phase06-manifests.mjs`)

1. Metadata reaches the registry cache; precedence verified with conflicting
   values in both manifests.
2. An unlisted plugin directory is still discovered; a bad `source` warns and
   does not fail.
3. JS plugin links as `ocm--<p>--<file>.js` when trusted; is reported
   `blocked` and not linked when untrusted; is removed on uninstall.
4. MCP keys are written namespaced; a disabled plugin's keys are removed; the
   user's own `mcp` keys are untouched; the `mcp` object is dropped when only
   ocm keys remain.
5. Config-safety invariant exercised across an MCP write.
6. `defaultEnabled: false` stays disabled in an `auto` marketplace.
7. Singular and plural component directories both discovered; a name clash
   between them errors.
8. A `tui`-shaped module under `plugin/` is rejected with the documented
   message.
