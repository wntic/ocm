# 15 — Manifest location & path resolution

Depends on: [06 — Manifests & component types](./06-manifests.md),
[12 — Validate & doctor](./12-validate-doctor.md). Independent of
[14](./14-agent-plugins.md); either may ship first.

## Goal

Two corrections to where a marketplace repository keeps its metadata and how
paths inside it resolve. Both are cheap now and expensive later: ocm has one
marketplace in existence, which is being scrapped, and no public users.

## 1. `marketplace.json` moves to `.opencode-plugin/`

```
.opencode-plugin/marketplace.json    NEW — ocm's catalog
.claude-plugin/marketplace.json      Claude Code (Codex reads as legacy)
.cursor-plugin/marketplace.json      Cursor
.agents/plugins/marketplace.json     Codex
plugins/<name>/                      UNCHANGED — shared by every client
```

### Why move it

A bare `marketplace.json` at the repository root was defensible when ocm was
the only reader: the manifest is optional (spec 06 — a marketplace is any repo
with `plugins/<name>/`), and a root file is visible and zero-config.

It stopped being defensible once the repo carries four catalogs. `marketplace.json`
is a generic name with no owner marked on it, sitting beside three files that
all announce whose they are. It only works if the repository exists solely to
be an ocm marketplace, and it leaves ocm nowhere to put a second repo-level
file if one is ever needed.

### Why `.opencode-plugin/` and not the alternatives

| Candidate | Rejected because |
|---|---|
| `.ocm/` | scopes the convention to *this tool* rather than to the platform. A second opencode plugin manager could share `.opencode-plugin/`; it could not share `.ocm/`. |
| `.opencode/` | **actively harmful.** opencode scans `.opencode/` as project config, globbing `{command,commands}`, `{agent,agents}`, `{skill,skills}` and `{plugin,plugins}` inside it ([00](./00-contract.md)). A marketplace repo with an `.opencode/` directory would inject its own contents into any session opened inside that repo. |
| `.agents/plugins/` | already Codex's. Two clients writing one file invites a schema fight. |
| root, unchanged | the status quo this section exists to fix. |

`.opencode-plugin/` parallels `.claude-plugin/` and `.cursor-plugin/`, is not
scanned by opencode, and reads as "the opencode plugin platform's directory"
rather than "ocm's directory".

### What does not move

**`plugins/<name>/` stays at the repository root.** Every other catalog points
into it — Claude Code's `"source": "./plugins/adw"`, Codex's
`{"source": "local", "path": "./plugins/adw"}`, Cursor's `"source": "plugins/adw"`.
Moving it would mean rewriting three foreign manifests to gain nothing.

Per-plugin `plugin.json` also stays at the plugin root, where Agent Plugins
requires it ([14](./14-agent-plugins.md)).

## 2. Lookup order and migration

One resolver, `marketplaceManifestFile(marketplaceDir)`, exported from
`loader/manifest.js`. It replaces the five sites that currently join
`"marketplace.json"` by hand: `loader/manifest.js` (×2), `loader/source.js`,
`src/discovery.ts`, `src/manifest-lint.ts`.

Order:

1. `.opencode-plugin/marketplace.json` — used if present
2. `marketplace.json` at the root — used if the first is absent
3. neither — no manifest, which stays legal (spec 06)

Both present is not an error: the new path wins, and `validate` reports a
warning naming the file being ignored. Silently preferring one while the author
edits the other is the failure mode worth spending a warning on.

There is no deprecation deadline. The root path is read indefinitely — it costs
one `existsSync` and breaking third-party marketplaces to save it would be a
poor trade. `validate` warns so new marketplaces land in the right place.

## 3. `mcpServers` resolves against the plugin, not the marketplace

`marketplace.json`'s per-plugin `mcpServers` field currently resolves against
the **marketplace root** (`loader/manifest.js`, `join(marketplaceDir, rel)`),
while spec 06 reads as plugin-relative. The implementation is wrong.

**Decision: plugin-relative.** `"./mcp.opencode.json"` means the file inside
that plugin's directory.

Reasoning:

- **Containment.** Marketplace-relative lets one plugin's entry name a file
  inside a *different* plugin, or anywhere else in the repo. Agent Plugins
  §4.1 is explicit that plugin-relative paths must resolve within the plugin
  root, and that containment is worth keeping whether or not the standard is
  adopted.
- **A plugin is the unit that moves.** It gets installed, copied and vendored
  on its own; a path that only resolves in the context of its marketplace is a
  path that breaks the moment the plugin is used any other way.
- **`source` is the exception that proves it.** `source` is marketplace-relative
  because it says *where the plugin is*; `mcpServers` says *what is inside it*.
  Different kinds of path, different bases — documented in the README rather
  than left for a reader to infer.

### Migration

The field is used by nothing: not `template/`, not any marketplace on disk. So
the change is free, and the transition is a courtesy rather than a necessity:

- resolve plugin-relative first
- if that does not exist **and** the marketplace-relative interpretation does,
  use it and warn that the path is deprecated, naming both candidates
- if neither resolves, the existing "not a JSON object" warning applies

### Is the field still needed at all?

After [14](./14-agent-plugins.md), one `mcp.json` per plugin serves opencode,
Codex and Cursor, which was the override's main use. What remains is a plugin
that keeps its MCP config under a different filename — thin, but real, and
removing a field from a published schema is a larger breaking change than
correcting its base. It stays, with the base fixed.

## 4. Edge cases

| Case | Behaviour |
|---|---|
| both manifest locations present | new path wins; warning names the ignored file |
| `.opencode-plugin/` exists but holds no `marketplace.json` | fall through to the root path; no error |
| `.opencode-plugin/marketplace.json` is not valid JSON | existing malformed-manifest handling; **do not** silently fall back to the root file — a broken manifest must be reported, not routed around |
| `mcpServers` path escapes the plugin with `../` | rejected, as today (`relativePath` already refuses `../`) |
| `mcpServers` resolves plugin-relative *and* marketplace-relative to different existing files | plugin-relative wins; warning names the other |
| a marketplace with `.opencode/` at its root | not ocm's business to police, but `validate` warns: opening that repo in opencode injects its contents as project config |

## 5. Consumed by

[12](./12-validate-doctor.md) gains three warnings (both manifests present,
deprecated `mcpServers` base, `.opencode/` in a marketplace repo). `template/`
moves its manifest. README's "Marketplace repository format" section and the
layout diagram change. Nothing else: discovery, materialization, trust and
update never touch the manifest path directly once the resolver exists.

## Tests (`test/phase15-manifest-location.mjs`)

1. A marketplace with only `.opencode-plugin/marketplace.json` is added,
   discovered and listed exactly as a root-manifest one is — metadata, renames
   and plugin entries all reach the registry.
2. A marketplace with only the root manifest still works, unchanged.
3. Both present: the `.opencode-plugin/` one wins, and `validate` warns naming
   the ignored file.
4. `.opencode-plugin/marketplace.json` that is malformed reports the error and
   does **not** fall back to a valid root manifest.
5. `mcpServers: "./mcp.custom.json"` resolves inside the plugin directory and
   its servers materialize.
6. The same value resolving only marketplace-relative still works and warns
   once, naming both candidates.
7. `mcpServers: "../other-plugin/mcp.json"` is refused.
8. `template/` passes `ocm validate` with zero findings after the move.
9. Config-safety and idempotence invariants across an add/update cycle for a
   `.opencode-plugin/` marketplace.
