# 11 — Cross-tool authoring format

Depends on: [03](./03-materializer.md), [06](./06-manifests.md).

## Goal

Author a plugin once and have it usable from Claude Code and opencode, without
maintaining near-duplicate trees, and without foreclosing Codex later.

## What is actually portable — verified, not assumed

| Component | Portable? | Evidence |
|---|---|---|
| skill | **yes, with a frontmatter subset** | opencode documents `name`, `description` as required and `license`, `compatibility`, `metadata` as optional. `samber/cc-skills-golang` ships exactly that subset unchanged to Claude Code, Codex, Cursor and Gemini. Probe: a `SKILL.md` carrying Claude-only `allowed-tools`, a multi-line `arguments:` list and `disable-model-invocation` still loaded in opencode 1.18.20 |
| command | **no** | Claude Code folded commands into skills; opencode has its own `{command,commands}/**/*.md` convention with different frontmatter (`agent`, `model`, `subtask`, `template`) and does not read `.claude/commands/` at all |
| agent | **no** | field names and semantics diverge: Claude Code's `tools`, `model: inherit`, `skills:` vs opencode's `mode`, `permission`, `steps`, `variant`, with unknown keys silently routed into `options` |
| JS plugin | **opencode only** | Claude Code has no equivalent; its plugins compose hooks.json, commands and MCP servers, not arbitrary lifecycle JS |
| MCP server | **near-portable** | both tools consume an MCP server list, but in different config shapes and locations |

## The decision: passthrough skills, per-target commands and agents

No neutral schema, no compiler.

```
plugins/quality-review/
├── plugin.json
├── skills/                 shared — copied unchanged to every target
│   └── code-review/SKILL.md
├── commands/               opencode (the default, unsuffixed)
│   └── commit.md
├── commands.claude/        Claude Code
│   └── commit.md
├── agents/                 opencode
│   └── reviewer.md
├── agents.claude/          Claude Code
│   └── reviewer.md
├── plugin/                 opencode only, by definition
│   └── notify.js
└── scripts/                shared supporting files
    └── run_report.py
```

Rules:

- **Unsuffixed = opencode.** ocm reads `commands/` and `agents/` and ignores
  every `*.claude` / `*.codex` sibling. Claude Code, pointed at the same repo
  through its own marketplace manifest, reads the suffixed ones.
- **`skills/` is shared and never rewritten at the source level.** The one
  transform ocm applies is the `name:` namespacing at materialization time
  ([03](./03-materializer.md)), which happens in ocm's own link tree and never
  touches the author's file. Claude Code namespaces the same skill to the same
  `plugin:skill` string on its own, so the two tools agree without
  coordination.
- Skill frontmatter is **restricted to the portable subset** — `name`,
  `description`, `license`, `compatibility`, `metadata` — by convention, and
  [12](./12-validate-doctor.md) warns on anything else with the reason. This
  is a lint, not a hard rule, because opencode tolerates extras today; the
  lint exists so a plugin does not become a liability if that tolerance
  regresses.

### Why not a neutral schema with renderers

A `command.yaml` → per-tool renderer buys a single source for commands and
agents. It costs a build step in every marketplace repo, generated files that
must be committed (because ocm installs from a git checkout, not from a build)
or a build ocm must run at install time, and a schema that has to model the
union of two tools' semantics — including fields with no counterpart, like
opencode's `subtask` or Claude Code's `model: inherit`. The generated file
would need hand-tuning per tool anyway for anything non-trivial, which is the
duplication the schema was meant to remove.

`samber/cc-skills-golang` is the working counter-example: four tools, one
unchanged `skills/` tree, and the only per-tool artifacts are thin manifests.
That is the shape to copy.

Two directories of hand-written command files is a real cost, and it is paid
only by plugins that ship commands to both tools. Plugins that ship only
skills — the majority, and the portable case — pay nothing.

**The boundary is preserved.** If a neutral schema is wanted later, it slots
in as a generator that *emits* `commands/` and `commands.claude/` from a
source of its own, with no change to this layout, to the marketplace manifest,
or to ocm. Nothing here forecloses it.

## `${CLAUDE_PLUGIN_ROOT}`

The concrete blocker, not frontmatter. Your `run-report` command body runs
`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/run_report.py"`. opencode has no
plugin-root variable — its command templates substitute `$ARGUMENTS`, `$1`…,
`!` shell blocks and `@` file references, and its config-level substitution is
`{env:VAR}` / `{file:path}`, neither of which knows what a plugin is.

Resolution, in two parts:

1. **`OCM_PLUGIN_ROOT` is exported into the shell** by ocm's loader through
   opencode's `shell.env` hook, pointing at the marketplace root
   (`~/.cache/ocm/marketplaces/<mp>`). Command bodies use
   `"${OCM_PLUGIN_ROOT}/plugins/<plugin>/scripts/…"`.
   The hook cannot know *which* plugin invoked the shell, so the variable is
   the marketplace root and the plugin path is written out — explicit, and
   correct for every plugin.
2. **`CLAUDE_PLUGIN_ROOT` is also exported**, as an alias pointing at the same
   marketplace root, so a command file written for Claude Code runs unmodified
   under opencode when its script path is expressed relative to the plugin. It
   is an alias only; ocm does not emulate Claude Code's plugin-root semantics
   beyond a path.

`validate` warns when a command or agent body references `${CLAUDE_PLUGIN_ROOT}`
without the `plugins/<name>/` segment, since that is the form that will not
resolve.

## The Claude-side marketplace

A repo that serves both tools declares both manifests, samber-style:

```
my-marketplace/
├── marketplace.json                 ocm / opencode
├── .claude-plugin/
│   └── marketplace.json             Claude Code
└── plugins/<name>/
    ├── plugin.json                  ocm
    └── .claude-plugin/plugin.json   Claude Code
```

`ocm render claude` (phase two, not required for v1) generates and refreshes
the `.claude-plugin/` manifests from `marketplace.json` and each
`plugin.json`, because they carry the same fields under different names. It
writes only those two file kinds and never touches component files. This is
the only "renderer" in the design, and it renders *manifests*, not content —
exactly what the reference repo does by hand.

## Codex

Out of scope for v1 and deliberately unmodelled. The layout already
accommodates it (`commands.codex/`, `.codex-plugin/plugin.json`) whenever its
conventions are worth verifying. Nothing in v1 needs to change to add it.

## Phasing

| Phase | Contents | Gate |
|---|---|---|
| 1 | the directory convention, the unsuffixed-is-opencode rule, `OCM_PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT` via `shell.env`, the frontmatter-subset lint | ships with [12](./12-validate-doctor.md) |
| 2 | `ocm render claude` for the two manifest kinds | after v1 |
| 3 | Codex target | when its conventions are verified the way opencode's were in [00](./00-contract.md) |

## Tests (`test/phase11-crosstool.mjs`)

1. `commands.claude/` and `agents.claude/` are ignored by discovery;
   `commands/` and `agents/` are not.
2. A plugin with only `commands.claude/` and `skills/` installs its skill and
   reports zero commands, without error.
3. The `shell.env` hook exports `OCM_PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT`
   pointing at the marketplace root, for every added marketplace.
4. `validate` warns on non-subset skill frontmatter, naming the field, and on
   a `${CLAUDE_PLUGIN_ROOT}` reference missing the `plugins/<name>/` segment.
5. Round-trip against a real fixture built from `wntic/agentic-development-workflow`:
   its `plugins/adw` skills install into opencode under `adw:<skill>` names,
   and its `run-report` command resolves its script path.
