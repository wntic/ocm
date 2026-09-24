# Authoring a marketplace

How to structure a marketplace repository: the layout, the manifests, and
what each component kind must contain. A worked example lives at
[github.com/wntic/ocm-demo](https://github.com/wntic/ocm-demo) — a small
marketplace with three plugins; clone it and adapt it.

## Marketplace repository format

```
my-marketplace/
├── .opencode-plugin/
│   └── marketplace.json      # optional
└── plugins/
    ├── demo-kit/
    │   ├── plugin.json           # required
    │   ├── commands/
    │   │   └── tdd.md            # → /demo-kit:tdd
    │   ├── commands.claude/      # Claude Code sibling, ignored by ocm
    │   │   └── tdd.md
    │   ├── agents/
    │   │   └── reviewer.md       # → demo-kit:reviewer
    │   ├── skills/
    │   │   └── code-review/
    │   │       └── SKILL.md      # skill "demo-kit:code-review"
    │   ├── plugin/
    │   │   └── notify.js         # opencode server plugin (trust-gated)
    │   ├── mcp.json              # mcp servers (trust-gated)
    │   └── scripts/, templates/  # supporting files, never materialized
    └── release-kit/
        └── …                     # a second plugin, same rules
```

A working example with two plugins ships in [template/](../template/). A
marketplace is any git repo with `plugins/<name>/`. Every directory under
`plugins/` with at least one component is a plugin — plugin.json is required
in every one of them, with a non-empty `description`; a plugin without it
is refused by `ocm add`, `ocm update` and `ocm validate` (already-installed
plugins keep working; `ocm doctor` tells you which need a manifest). A
directory whose only content is a `plugin.json` is not a plugin and nothing
installs from it, but `ocm validate` reports it — either the manifest is
wrong or the components are missing — and `ocm add` names it when refusing
the tree.

`command`/`commands`, `agent`/`agents`, `skill`/`skills` and `plugin`/`plugins`
are all accepted (singular matches opencode's own globs); a name clash between
the singular and plural form of the same type is an error. `ocm validate`
also warns on likely typos — `skill/` beside `skills/`, a `plugin.ts` at the
plugin root, `SKILLS.md`.

### Cross-tool authoring

Unsuffixed directories are opencode's. A `commands.claude/` sibling holds the
Claude Code form of the same command; ocm ignores it, Claude Code reads it
through its own manifest. `skills/` is shared unchanged between the tools —
keep skill frontmatter to the portable subset (`name`, `description`,
`license`, `compatibility`, `metadata`); `ocm validate` warns on anything
else. A SKILL.md whose frontmatter has no `name` or no `description` is an
error — the description is what the model reads to decide whether to load
the skill, and it must be 1-1024 characters. Command bodies that reference
supporting scripts use
`"${OCM_PLUGIN_ROOT}/plugins/<name>/scripts/…"` — the loader exports
`OCM_PLUGIN_ROOT` (and `CLAUDE_PLUGIN_ROOT` as an alias) pointing at the
marketplace root.

**Where those variables are set.** The loader exports them through
opencode's `shell.env` hook, which fires when opencode spawns a shell for
the model's bash tool. They are therefore available to a script the model
runs, and **not** inside a command template's `!` block — opencode's
template engine does not call the hook. With more than one marketplace
added, only the per-marketplace forms (`OCM_PLUGIN_ROOT_<MARKETPLACE>`,
the name upper-cased with `-` as `_`) are set: a flat name cannot say which
root it means. A command that must reference a script path inside a `!`
block should instruct the model to run the script instead.

### Command and agent frontmatter

Every file in `commands/` or `agents/` is a YAML frontmatter block plus a
body — the body is the template opencode runs, and an empty body is a
validate error: opencode requires the template. description is required
(opencode rejects a command without it); the other recognized fields are
`agent`, `mode`, `tools`, `model`, `extension`, `allowed-tools` and
`$schema`. `model` takes opencode's `provider/model` form
(`anthropic/claude-sonnet-4-5`); **omit it to inherit the session's model**.
A bare model name, or Claude Code's `model: inherit`, is parsed as a
provider and fails at runtime with `Model not found: inherit/.` — the agent
silently falls back to a general one. A file with no frontmatter at all is a warning. A frontmatter
value containing an unquoted `": "` is an error — strict YAML rejects it
even where opencode's lenient parser would rescue it; quote the value. A
body using `!` shell substitution draws a warning, because `ocm info`
surfaces the plugin as shell-executing.

A complete command file:

```markdown
---
description: commit helper
model: anthropic/claude-sonnet-4-5
allowed-tools:
  - Read
  - Bash
---

Run the tests, then commit with a conventional-commit message.
```

### `marketplace.json`

The manifest lives at `.opencode-plugin/marketplace.json`. A root
`marketplace.json` still works — `ocm validate` warns — but new marketplaces
should use the new location.

```json
{
  "$schema": "https://raw.githubusercontent.com/wntic/ocm/main/schema/marketplace-v1.json",
  "name": "my-marketplace",
  "description": "Team plugin catalog",
  "owner": { "name": "…", "email": "…", "url": "…" },
  "homepage": "https://…",
  "renames": { "old-plugin": "new-plugin", "dead-plugin": null },
  "plugins": [
    {
      "name": "demo-kit",
      "source": "./plugins/demo-kit",
      "description": "…",
      "version": "1.2.0",
      "defaultEnabled": true,
      "mcpServers": "./mcp.json"
    }
  ]
}
```

Only a plugin entry's `name` and `source` are required. `source` is a
./-relative path inside the marketplace — it says where the plugin is; a
source that does not resolve, or escapes the marketplace with `../`, is a
validate error, and so is a plugin listed twice in `plugins[]` (the first
entry silently wins otherwise). `mcpServers` is ./-relative, resolving
inside the plugin directory — it says what is in the plugin. `../` and
absolute paths are rejected; the marketplace repo is the distribution
unit. `defaultEnabled:
false` keeps a plugin disabled in an `auto` marketplace.

### `plugin.json`

Required in every plugin directory; one that exists but does not parse is a
validate error — fix it or remove it; ocm requires this file to be readable.
`description` is required — a non-empty string of at most 200 characters; it
is what `ocm search` and the TUI show.
`name` is optional and, when present, must equal the directory name.
`$schema` is recommended — pin it to the Agent Plugins schema so other tools
can read the manifest too. Otherwise the same fields as a `plugins[]` entry,
minus `source`, `defaultEnabled` and `mcpServers` — a plugin directory is
self-describing when vendored or read on its own. When the version disagrees
between the two manifests, validate warns. Metadata precedence:
marketplace entry > `plugin.json` > filesystem inference (name from the
directory, components from the scan).

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "description": "One command, agent, skill, plugin and mcp server — the demo kit"
}
```

### Category and tags

`category` (a string) and `tags` (an array of strings) ride under
`extensions["dev.wntic.ocm"]` in plugin.json:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "description": "One command, agent, skill, plugin and mcp server — the demo kit",
  "extensions": {
    "dev.wntic.ocm": { "category": "testing", "tags": ["tdd", "review"] }
  }
}
```

They surface in `ocm search` matching, `ocm info` and the TUI grouping. The
values are free-form strings — there is no closed set, and validate does not
check them in the `extensions` form. A top-level `category` or `tags` is
legacy: validate warns and the `extensions` form wins.

### JS plugins and MCP servers

`plugin/*.{js,ts}` are opencode server plugins. They execute, so they
materialize only after trust is granted for their marketplace — until then
they are reported as `blocked (untrusted)`. Each must default-export
`{ id, server }` (see `template/plugins/demo-kit/plugin/notify.js`).

`mcp.json` uses exactly opencode's `mcp` entry shape: `"type": "local"`
with a `command` array of strings, or `"type": "remote"` with a `url`. An
omitted `enabled` is normalised to `true` at the write; an entry
missing "type" — or the pre-1.18 `command`/`args` form — is a validate
error, and ocm blocks it at install with a warning rather than writing
it, because opencode refuses to start over it:

```json
{
  "time": { "type": "local", "command": ["date"], "enabled": true }
}
```

Both are namespaced under ocm's ownership prefix: JS plugins link as
`~/.config/opencode/plugins/ocm--<plugin>--<file>`, MCP servers as
`ocm--<plugin>--<server>` keys in the global `opencode.json`. MCP components
are trust-gated too — a local server is a command line ocm caused to run.
The user's own `mcp` keys are preserved.

Every rule `ocm validate` enforces is stated in this section: validate
enforces the documented contract, nothing else. A disagreement between
this document and a validate finding is a bug in one of the two.

## Naming

Commands and agents are namespaced by plugin:
`plugins/adw/commands/commit.md` becomes `/adw:commit` in the opencode TUI,
`plugins/adw/agents/reviewer.md` becomes `adw:reviewer`.

Plugin directory names become those namespaces, so they must be kebab-case
(`^[a-z0-9]+(-[a-z0-9]+)*$`) and at most 64 characters. One marketplace
shipping the same command or agent name from two plugins is a validate
error — first-come-wins would silently shadow one at the user's expense.

Skills are named by their **frontmatter `name`**, not their folder. ocm
therefore renders each installed skill into its own mirror directory with the
name rewritten to `<plugin>:<skill>` — `adw:python-style`. Two skills whose
namespaced names collide (both produce `adw:style`) are a validate error.
opencode never lists skills in the `/` autocomplete by design — skills are
invoked by the model through the `skill` tool, or browsed via the `/skills`
picker.

### Breaking change: skill names

Earlier versions symlinked a plugin's whole `skills/` directory, so an
installed skill kept its own name (`python-style`). Skills now install under
their namespaced name (`adw:python-style`). If you referenced an installed
skill by name — in a project file or a prompt — update the reference. The
automatic migration (see [Migration](reference.md#migration)) prints the
old → new mapping when it relinks.
