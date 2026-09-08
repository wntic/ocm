# 12 — Validate & doctor

Depends on: [06](./06-manifests.md), [07](./07-trust.md). Two commands
sharing one finding format: `validate` is for the marketplace author,
`doctor` is for the marketplace consumer.

## `ocm validate [path]`

Lint a marketplace repo before pushing. Reports every finding (not fail-fast),
exit 1 if any error, 0 otherwise. Default path is the cwd.

```
validate /path/to/marketplace
  error   plugins/foo/skills/bar/SKILL.md: frontmatter has no "name"
  error   plugins/bar/plugin.json: invalid JSON at position 12
  error   plugins/a/commands/x.md and plugins/b/commands/x.md: both produce "a:x"
  warning plugins/baz: version disagrees — marketplace.json 1.0.0, plugin.json 1.1.0
  warning plugins/adw/skills/style/SKILL.md: non-portable frontmatter "allowed-tools"
  2 errors, 2 warnings
```

### Errors

- `marketplace.json` / `plugin.json`: invalid JSON, or violating
  `schema/*-v1.json`
- plugin directory name or manifest `name` failing
  `^[a-z0-9]+(-[a-z0-9]+)*$`, longer than 64 characters, or a manifest `name`
  disagreeing with its directory
- `SKILL.md` with no frontmatter, no `name`, or no `description`; a
  `description` outside 1–1024 characters (it is what the model uses to decide
  whether to load the skill, so an empty one makes the skill invisible)
- two skills in the marketplace resolving to the same namespaced name
- two plugins producing the same materialized command or agent name
- a command or agent `.md` file with an empty body — opencode requires the
  template
- a manifest `plugins[]` entry whose `source` does not resolve, or escapes the
  marketplace with `../`
- a `plugin/*.js` file that does not default-export `{ id, server }` or a bare
  function — this one is worth an error rather than a warning, because the
  failure mode in the field is a red line in the user's log on every opencode
  start ([00](./00-contract.md))
- a `plugin/*.js` exporting `{ id, tui }` — not supported
  ([06](./06-manifests.md))
- `mcp.json` that is not an object of opencode MCP entries, or an entry
  missing `type`

### Warnings

- non-portable skill frontmatter — any key outside `name`, `description`,
  `license`, `compatibility`, `metadata` ([11](./11-cross-tool.md)), naming
  the key and the tool it belongs to
- `${CLAUDE_PLUGIN_ROOT}` without a `plugins/<name>/` segment
- `version` disagreeing between the two manifests
- a `.md` file in `commands/` or `agents/` with no frontmatter at all
- likely typos inside a plugin directory: `skill/` alongside `skills/`,
  `plugin.ts` at the plugin root, `SKILLS.md`, `Skill.md`
- a marketplace `name` that collides with a marketplace already added on this
  machine (informational — it only affects this user)
- a command template containing `!` shell substitution, listed so the author
  knows the plugin will be surfaced as shell-executing in `ocm info`
  ([07](./07-trust.md))

Implementation: `src/commands/validate.ts`, reusing core discovery and
manifest loading plus a hand-rolled validator implementing the same rules as
the published schema. No new runtime dependency; the `schema/*.json` files
exist for editors. Frontmatter parsing uses the same tolerant approach as
discovery — and deliberately **does not** use opencode's sanitizer fallback,
so `validate` catches YAML that only survives by luck.

`--fix` is a non-goal.

## `ocm doctor [--fix]`

Read-mostly diagnosis of an installation.

| Check | Fix |
|---|---|
| `git` on PATH | message only |
| loader installed at `~/.config/opencode/plugins/ocm-loader.js` | `ocm init` |
| **no ocm file other than `ocm-loader.js` in `plugins/`** | remove the strays ([01](./01-loader.md)) |
| installed loader/core/ui version comment matches this ocm | `ocm update` — a stale core silently no-ops |
| registry version is current | `ocm update` |
| every marketplace directory exists and, if not `local`, is a git repo | re-clone |
| any marketplace with `lastSync.ok === false` | report the error and the age |
| broken symlinks in `commands/`, `agents/`, `plugins/` | remove (confirmed) |
| orphaned `skills.paths` entries whose target is gone | remove (confirmed) |
| `ocm--*` MCP keys whose owning plugin is no longer in the registry | remove (confirmed) |
| materialized components that no longer match the registry | re-materialize |
| any path created under `~/.claude`, `.claude`, `~/.agents`, `.agents` | report loudly — this should be impossible ([04](./04-precedence.md)) |
| `opencode` on PATH: run the probe and report plugin-load errors attributable to ocm | report; suggest `ocm update` |

Exit 0 when healthy, 1 otherwise. `--fix` applies every safe fix without
asking; destructive fixes (removing a file ocm does not own) are never
applied, only reported.

## Config-write hygiene (cross-cutting, enforced everywhere)

Stated once here and asserted in every phase's tests:

- every write to `opencode.json`, `tui.json` or the registry is atomic —
  temp file in the same directory, `rename()` over the target
- only keys ocm owns are touched: `ocm--*` prefixes, ocm's own
  `skills.paths` entries, and the single `tui.json` plugin entry
- a pre-existing config with arbitrary user keys survives byte-identically
  outside those
- a config file that does not parse is never rewritten; ocm warns and prints
  the change the user should make by hand
- ocm never writes to the user's `plugin` array in `opencode.json`

## Tests (`test/phase12-validate-doctor.mjs`)

1. One fixture per error class and per warning class, asserting the exact
   finding line and the exit code; a clean marketplace exits 0 with only the
   header.
2. `validate` rejects YAML that opencode's sanitizer would have rescued.
3. `doctor` detects a stale core by version comment, a stray ocm file in
   `plugins/`, a broken symlink, an orphaned `skills.paths` entry, and an
   orphaned MCP key; `--fix` repairs exactly those.
4. `doctor` reports a marketplace whose last sync failed, with the error.
5. Atomicity: an injected write failure leaves the original `opencode.json`
   byte-identical.
6. A full add → install → update → remove cycle creates nothing under
   `~/.claude` or `~/.agents`.
