# 09 — Search & info

Depends on: [06](./06-manifests.md) (cached manifest metadata). Independently
shippable; nothing else depends on it.

## Goal

The difference between a list of directories and a marketplace.

```
ocm search <query> [--enabled-only] [--json]
ocm info <plugin>[@<marketplace>] [--json]
```

Both read the registry's cached `manifest` — **no marketplace directory access
and no network** — so search works offline and stays fast with many
marketplaces added.

## `search`

Matched case-insensitively as a substring against: plugin name, description,
category, tags, keywords, marketplace name, and component names (command,
agent and skill names, which is how a user finds `commit` without knowing it
lives in `adw`).

Ranking, first rule that matches wins:

1. name exact
2. name prefix
3. name substring
4. tag or category exact
5. description substring
6. component name substring

Ties break alphabetically by `plugin@marketplace`, so output is stable.

```
$ ocm search review
quality-review@team-tools  1.2.0  review   Code review skills and agents
  commands: commit, review · agents: reviewer · skills: code-review
adw@wntic-adw  1.3.0  workflow   Spec-driven agentic development  (disabled)
  matched: agents/test-review
```

Disabled plugins are included with a `(disabled)` marker; `--enabled-only`
drops them. A plugin blocked for trust reasons is marked `(blocked)`. No
matches exits 1 with `no matches for "<query>"` and a hint to
`ocm update` if any marketplace's `lastSync` is stale or failed — a common
cause of a plugin appearing to not exist.

## `info`

```
$ ocm info quality-review
quality-review @ team-tools
  description   Code review skills and agents          (plugin.json)
  version       1.2.0                                  (marketplace.json)
  category      review
  tags          review, quality
  homepage      https://…
  license       MIT
  enabled       yes
  installed     2026-09-07T22:48:00Z
  marketplace   https://github.com/team/tools  @ main
  revision      35eda0f  (synced 2h ago)
  trust         granted
  components
    command  commit, review    → ~/.config/opencode/commands/quality-review:*
    agent    reviewer          → ~/.config/opencode/agents/quality-review:*
    skill    code-review       → skill "quality-review:code-review"
    plugin   notify.js         → ~/.config/opencode/plugins/ocm--quality-review--notify.js
```

- Field origin (`marketplace.json` / `plugin.json` / inferred) is annotated
  only when the sources disagree or the value was inferred — it is debugging
  information, not decoration.
- Works for disabled and for blocked plugins.
- The `components` block shows the *resulting opencode names*, not just source
  filenames, because "what do I type to use this" is the question `info`
  exists to answer.
- `--json` emits the full record including the source paths.

## Consumed by

[10](./10-tui.md) renders the same data in the browse and details dialogs, via
the `--json` shapes.

## Tests (`test/phase09-search.mjs`)

1. Ranking: exact beats prefix beats substring beats tag beats description
   beats component name.
2. A component-name match surfaces a plugin whose own name does not match, and
   the output says which component matched.
3. Disabled and blocked markers; `--enabled-only` filters.
4. Empty result exits 1, and mentions a stale marketplace when one exists.
5. `info` shows resulting opencode names, origin annotations only on
   disagreement, and works for a disabled plugin.
6. Both commands run with the marketplace directory deleted (registry cache
   only).
