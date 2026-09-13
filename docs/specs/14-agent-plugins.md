# 14 — Agent Plugins interop

Depends on: [06 — Manifests & component types](./06-manifests.md),
[11 — Cross-tool authoring format](./11-cross-tool.md),
[12 — Validate & doctor](./12-validate-doctor.md).

Partially landed: the `mcp.json` dual-format reader described in §4 is
implemented and tested. Everything else in this spec is not started.

## Goal

A plugin in an ocm marketplace installs into **Codex** and **Cursor** without a
second copy of anything, and ocm installs plugins authored to the Agent Plugins
standard by anyone else.

This is not a bet on a young standard. Codex will not read a plugin without it:
the root `plugin.json` carrying the `agent-plugins.org` schema is its primary
manifest, and `.codex-plugin/plugin.json` is only a compatibility fallback.
Adopting costs two lines in a file we already write.

## What was verified, and where

Checked 2026-09-13 against primary sources, not summaries.

| Fact | Source |
|---|---|
| Agent Plugins 1.0.0 is **Published** (2026-08-06); 1.1.0 is a **Working Draft** | `agentplugins/agent-plugins-spec` `spec/1.0.0.md`, `spec/1.1.0.md` |
| Exactly two portable component types: skills and MCP servers | spec §7 |
| `plugin.json` schema is **closed**: `$schema`, `name`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`, `extensions`. Unknown top-level fields MUST be reported and ignored, not rejected | spec §5.2 |
| `$schema` and `name` are the only required fields | spec §5.3 |
| Name charset `a-z 0-9 - .`, 1–64 chars, alphanumeric at both ends | spec §5.5 |
| Skills discovered from `skills/`, immediate children only — **no recursive descent** | spec §7.1 |
| `mcp.json` requires `$schema` + `mcpServers`; transports are `stdio`, `streamable-http`, `sse` | `schemas/1.0.0/mcp.schema.json` |
| Client-specific files belong in a top-level reverse-domain directory; the spec assigns them **no portable semantics** | spec §8 |
| Codex: root `plugin.json` is "the portable entry point"; `.codex-plugin/plugin.json` is "a compatibility fallback" | developers.openai.com/plugins/build/plugins |
| Codex catalogs: `.agents/plugins/marketplace.json`, `.claude-plugin/marketplace.json` (legacy), `~/.agents/plugins/marketplace.json`. **`.codex-plugin/marketplace.json` is not supported** | same |
| Cursor accepts either an Agent Plugins root `plugin.json` or `.cursor-plugin/plugin.json`; the latter is required for rules, agents, commands and hooks | cursor.com/docs/reference/plugins |
| Claude Code implements none of it; its layout is its own | code.claude.com/docs — no mention |
| opencode implements none of it | anomalyco/opencode issue #41561, open |

## 1. Decision: conform at the manifest, do not restructure

ocm's existing layout stays exactly as it is. Specifically, **`commands/`,
`agents/` and `plugin/` do not move into a `dev.wntic.ocm/` extension
directory**, even though §8 offers that as the blessed home for client-specific
files.

Reasoning: the spec assigns extension directories no discovery, validation or
loading semantics — they are a naming reservation, nothing more. Moving
component directories there would break ocm's own discovery, break spec 11's
`commands.claude/` convention, and be read by no client that does not already
read them where they are. The cost is real and the benefit is zero.

What conformance buys is the *manifest*: a `plugin.json` Codex and Cursor
accept, and an `mcp.json` all three read. That is the whole of it.

## 2. `plugin.json`

A plugin's manifest becomes Agent Plugins conformant. Two additions and one
relocation:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "adw",
  "version": "2.0.0",
  "description": "…",
  "author": { "name": "…", "url": "…" },
  "homepage": "…",
  "repository": "…",
  "license": "MIT",
  "keywords": ["spec-driven-development", "tdd"],
  "extensions": {
    "dev.wntic.ocm": { "category": "workflow", "tags": ["python"] }
  }
}
```

- **`$schema` is required** and pinned to `1.0.0`, the published version. Never
  `1.1.0` while it is a Working Draft, and never a floating identifier — §5.2
  forbids clients from fetching a schema at load time, so the string is a
  version selector, not a URL to resolve.
- **`name` is required** and must agree with the plugin directory name, which
  ocm already enforces (spec 06).
- **`category` and `tags` move under `extensions["dev.wntic.ocm"]`.** They are
  not in the closed schema, so at the top level a conformant client reports them
  as unknown on every load — harmless but noisy.

`dev.wntic.ocm` is the extension namespace. §8 says a client SHOULD base it on
a domain it controls and keep it stable; this one is stable and unambiguous,
and changing it later silently drops metadata, so it is fixed here.

**Backward compatibility.** ocm keeps reading top-level `category`/`tags` for
marketplaces that predate this spec. Precedence: `extensions["dev.wntic.ocm"]`
wins over the top-level form when both are present. `ocm validate` warns on the
top-level form, naming the move; it is never an error.

Marketplace-entry metadata (spec 06) is unchanged — `marketplace.json` is ocm's
own file and no other client reads it.

## 3. Plugin names

AP permits `.` in a name; ocm's `PLUGIN_NAME_RE` does not. ocm's rule is the
stricter one and it stays: names become command and agent namespaces on disk
(`<plugin>:<item>.md`), and a dot there is a new failure surface for no gain.
Every ocm-valid name is AP-valid, so nothing we publish is rejected. `validate`
reports an AP-valid-but-ocm-invalid name with that explanation, rather than a
bare regex failure.

## 4. `mcp.json` — dual format (landed)

One `mcp.json` per plugin, read in either shape. If the parsed object has an
`mcpServers` key it is Agent Plugins; otherwise it is opencode-native.

| Agent Plugins | opencode |
|---|---|
| `{type:"stdio", command:"npx", args:[…], env}` | `{type:"local", command:["npx", …args], enabled:true, environment:env}` |
| `{type:"streamable-http"｜"sse", url, headers}` | `{type:"remote", url, headers, enabled:true}` |
| `cwd` | dropped — opencode has no equivalent |

Three call sites parse it and all three must agree, which is the part that bit
during implementation: discovery (component names), `syncMcp` (the keys
written), and **the trust fingerprint**. A fingerprint computed over the
untranslated file approves `$schema` and `mcpServers` as if they were servers,
so nothing materializes and nothing explains why. One shared reader,
`readMcpServers(file)`, is the only correct shape.

This also means ocm installs any Agent Plugins repo's MCP servers, which is a
larger win than making our own repos conformant.

## 5. One repository, four catalogs

Each client reads a different path, so all four coexist:

```
.claude-plugin/marketplace.json    Claude Code   (Codex reads as legacy)
.cursor-plugin/marketplace.json    Cursor
.agents/plugins/marketplace.json   Codex
marketplace.json                   ocm
```

They are **not** required to list the same plugins, and should not. A plugin
shipping opencode lifecycle JS appears in ocm's catalog and is omitted from the
others, so a Codex user is never offered something that cannot run.

`.codex-plugin/marketplace.json` does not exist — Codex's plugin manifest
directory is not a catalog location. Shipping one would be dead weight.

## 6. Claude Code's manifest, for the record

Not part of Agent Plugins, but the same repo carries it and the redirect rules
are easy to get wrong:

- `commands` **replaces** the default `commands/` — a directory string works.
- `agents` **replaces** the default and requires an **array of explicit `.md`
  paths**. A directory string fails with `agents: Invalid input`.
- `skills` **adds to** the default `skills/`, which is what lets one shared
  `skills/` serve every client.

## 7. `validate` additions

New findings, all in `src/manifest-lint.ts`:

| Level | Finding |
|---|---|
| error | `plugin.json` has `$schema` with an unrecognised value |
| warning | `plugin.json` has no `$schema` — not installable by Codex |
| warning | top-level `category`/`tags` — move under `extensions["dev.wntic.ocm"]` |
| warning | `extensions` present but not an object (§8.1: report and ignore) |
| warning | a skill nested deeper than an immediate child of `skills/` — ocm materializes it, Codex and Cursor will not see it |
| warning | `.codex-plugin/marketplace.json` present — not a catalog location |

None are errors except the first, because a non-conformant plugin still works
perfectly well in opencode. This spec makes plugins *portable*, it does not
make portability mandatory.

## 8. Non-goals

- **Restructuring into extension directories.** §1.
- **An Agent Plugins marketplace format.** The standard has none; it is a
  package format with no distribution layer. ocm's `marketplace.json` and the
  three per-tool catalogs remain the distribution story.
- **Hooks, commands, agents, rules.** Outside the standard. Spec 11's per-tool
  directories remain the answer and always will.
- **Generating the other tools' manifests.** `ocm render claude` stays deferred
  (spec 11, phase 2).
- **Tracking 1.1.0** until it leaves Working Draft.

## 9. Edge cases

| Case | Behaviour |
|---|---|
| `plugin.json` declares an unknown `$schema` | error at validate; discovery still reads the file, since ocm is not a conformant AP client and refusing would break installs |
| both `extensions["dev.wntic.ocm"].tags` and top-level `tags` | extensions wins; validate warns |
| `mcp.json` has `mcpServers` but it is not an object | treated as opencode-native, so a server literally named `mcpServers` is possible; documented, not defended against |
| AP `stdio` entry with no `command` | skipped with a warning — AP requires it, so the file is malformed |
| a repo with only `.claude-plugin/marketplace.json` | ocm still discovers `plugins/<n>/`; the manifest is optional (spec 06) |

## 10. Consumed by

[12](./12-validate-doctor.md) gains the findings in §7. The template gains a
conformant `plugin.json`. Nothing else changes: discovery, materialization,
trust and update are untouched beyond the shared MCP reader.

## Tests (`test/phase14-agent-plugins.mjs`)

1. A plugin with an AP-conformant `plugin.json` installs, and `category`/`tags`
   read from `extensions["dev.wntic.ocm"]` reach the registry cache.
2. Top-level `category`/`tags` still work; with both present, extensions wins
   and validate warns.
3. An AP `mcp.json` materializes the same opencode keys as the native shape —
   stdio with `args`, `streamable-http`, and `sse` each translated. *(landed,
   phase 06 tests 9–10)*
4. The trust fingerprint covers translated server names, not wrapper keys: a
   changed `command` invalidates trust; reordering `mcp.json` keys does not.
   *(partly landed)*
5. Every validate finding in §7, one fixture each, asserting the exact line.
6. An ocm-invalid but AP-valid name (`acme.tools`) is reported with the
   namespacing explanation, not a bare regex error.
7. A skill nested two levels under `skills/` installs in opencode and warns
   that other clients will not see it.
8. Round trip: the `template/` marketplace passes `ocm validate` **and**
   `claude plugin validate` with no findings, skipped when the `claude` CLI is
   absent.
