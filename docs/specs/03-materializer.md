# 03 — Materializer & namespacing

Depends on: [00](./00-contract.md), [02](./02-registry.md).

## Goal

One engine that turns "these plugins are enabled" into files opencode
discovers, namespaced per plugin, owning exactly what it created and nothing
else, and reversing itself exactly.

## Why an interface, not just a symlinker

Three of the five component types can be pure symlinks. Skills cannot, because
opencode names a skill from its frontmatter
([00](./00-contract.md#namespacing-consequences)) and a symlink cannot rewrite
a file's contents. Rather than special-casing skills inside a symlink
function, the engine is expressed as a **materializer** with three primitives:

```
link(source, dest)                      symlink; dest is owned iff it resolves into a managed dir
render(source, dest, transform)         write a generated file; dest is owned iff it carries our marker
mirror(sourceDir, destDir, plan)        a real directory whose entries are link() or render()
```

Copy mode, if it is ever wanted, is a fourth primitive behind the same
interface. It is a non-goal today
([README](./README.md#non-goals-all-specs)).

## Targets

| Component | Source in the marketplace | Materialized as | Resulting opencode name |
|---|---|---|---|
| command | `plugins/<p>/commands/<f>.md` | `link` → `~/.config/opencode/commands/<p>:<f>.md` | `/<p>:<f>` |
| agent | `plugins/<p>/agents/<f>.md` | `link` → `~/.config/opencode/agents/<p>:<f>.md` | `<p>:<f>` |
| skill | `plugins/<p>/skills/<s>/` | `mirror` → `~/.cache/ocm/links/<mp>/skills/<p>--<s>/` | `<p>:<s>` |
| js plugin | `plugins/<p>/plugin/<f>.js` | `link` → `~/.config/opencode/plugins/ocm--<p>--<f>.js` | n/a — [06](./06-manifests.md), [07](./07-trust.md) |
| mcp | `plugins/<p>/mcp.json` | keys `ocm--<p>--<server>` in global `opencode.json` | n/a — [06](./06-manifests.md) |

Commands and agents get their namespace free, from the link's filename.

## Skills

A skill materializes as a **real directory** whose `SKILL.md` is generated and
whose every other entry is a symlink into the source:

```
~/.cache/ocm/links/<mp>/skills/adw--python-style/
├── SKILL.md          rendered: `name:` rewritten, everything else byte-identical
├── references/  ->   …/plugins/adw/skills/python-style/references     (symlink)
└── examples.md  ->   …/plugins/adw/skills/python-style/examples.md    (symlink)
```

The single transform is the frontmatter `name` value:
`name: python-style` → `name: "adw:python-style"`. Nothing else in the file is
touched — not the body, not other frontmatter keys, not line endings. The
rendered file ends with the marker comment
`<!-- ocm: rendered from <relative source path> @ <revision> -->`, which is how
`render` recognises its own output as owned.

Consequences, all intended:

- The author writes `name: python-style`. Claude Code namespaces it to
  `adw:python-style` on its own; ocm produces the identical name for opencode.
  One source, same name in both tools, no double prefix.
- Skill names cannot collide across plugins by construction, which matters
  because opencode resolves duplicate skill names by an unordered concurrent
  load ([00](./00-contract.md)) — a collision is a coin flip, not an error.
- The directory name (`<p>--<s>`, not `<p>:<s>`) is cosmetic since opencode
  ignores it; `--` avoids a colon in a path that users will see in `ocm info`.
- A skill body change upstream needs a re-render, which every sync performs
  anyway. `render` is a no-op when the would-be output equals the file on
  disk, so this costs one read per skill per sync.

If a source `SKILL.md` has no `name` in its frontmatter, or no frontmatter at
all, it is not a skill: skip it with a warning. [12](./12-validate-doctor.md)
makes that an error at author time.

`skills.paths` in the global `opencode.json` gains one entry per marketplace,
`~/.cache/ocm/links/<mp>/skills`, added when that marketplace first
materializes a skill and removed when it materializes none.

## Ownership and garbage collection

The current model — "a link is ours iff its target resolves inside a
marketplace directory we manage" — is kept and extended:

| Materialization | Owned iff |
|---|---|
| `link` | it is a symlink and its target resolves inside a managed marketplace directory |
| `render` | it is a regular file whose content carries the `ocm: rendered from` marker |
| `mirror` | the directory contains an owned `SKILL.md` |
| mcp key | the key starts with `ocm--` |

Every refresh computes the desired set, enumerates the owned set in each
target directory, and removes owned entries not in the desired set. Nothing
without an ownership proof is ever touched — this is what keeps a
hand-authored `~/.config/opencode/commands/commit.md` safe.

`refreshLinks` is renamed `materialize(marketplace, dir, { enabled })`, where
`enabled` is a `Set<string>` of plugin names or `null` for "all discovered"
(v1 behaviour, kept so a stale core degrades sanely).

## Collision with things ocm does not own

Three cases, distinguished before writing anything:

| Situation | Behaviour |
|---|---|
| target does not exist | materialize |
| target exists and is owned by this same plugin | overwrite / no-op |
| target exists and is owned by a **different** ocm plugin | refuse this one component, report `<a>:<x> conflicts with <b>:<x>`, continue with the rest |
| target exists and is **not** owned by ocm | refuse, report `skipped <dest>: not managed by ocm`, continue |
| target is a broken symlink | remove and materialize (a dangling link is never user data) |

A refusal is never fatal to the whole operation and never silently
overwrites. `ocm install --force` (see [05](./05-install.md)) is the only way
to take over an unowned target, and it prints the path it displaced. There is
no automatic rename: a rename would change the name the user has to type,
which is worse than a clear failure.

Because commands and agents are namespaced by plugin and skills by frontmatter
rewrite, an unowned-target collision in practice means the user hand-wrote a
file literally named `adw:commit.md`, or two marketplaces ship a plugin with
the same name — which [04](./04-precedence.md) prevents at add time.

## Report shape

`materialize` returns
`{ counts: {command, agent, skill, plugin, mcp}, created, removed, skipped, warnings }`.
Callers render it; the engine prints nothing. Every caller that created
anything appends the same line:

> restart opencode to activate

because nothing reloads in-session ([00](./00-contract.md)).

## Edge cases

| Case | Behaviour |
|---|---|
| marketplace directory disappeared (cache cleared, local dir deleted) | do not GC that marketplace's links — a missing source is transient; report it, leave links dangling, `doctor` offers cleanup |
| symlink creation fails (permissions, cross-device) | warn per file, continue, non-zero exit at the end |
| a skill directory contains a nested skill (`skills/a/b/SKILL.md`) | opencode's `**/SKILL.md` would find it; mirror it as its own entry `<p>--a-b` and namespace it `<p>:<b>` |
| plugin name is not `^[a-z0-9]+(-[a-z0-9]+)*$` | not materialized; error at add and at `validate` |
| the same component file appears in both `commands/` and `command/` | both are opencode-valid; discover `command` and `commands`, error on a name clash between them |

## Consumed by

[05](./05-install.md) drives it with an `enabled` set; [08](./08-update.md)
calls it after every pull and diffs its report; [10](./10-tui.md) calls the
same function.

## Tests (`test/phase03-materializer.mjs`)

1. Commands and agents link with `<plugin>:` names; targets resolve to the
   source files.
2. A skill renders with `name: "<plugin>:<skill>"` and a body byte-identical
   to the source below the frontmatter; sibling files and directories are
   symlinks.
3. Re-running is a no-op: no rewrite of an unchanged `SKILL.md` (mtime
   unchanged), no link churn.
4. Disabling a plugin removes exactly its components; a sibling plugin's are
   untouched.
5. A hand-written unowned file at a target path is never modified; the
   operation reports it and continues.
6. A broken symlink at a target path is replaced.
7. `skills.paths` gains one entry when the first skill appears and loses it
   when the last one goes; other `opencode.json` keys are byte-identical.
8. A `SKILL.md` with no `name` is skipped with a warning, not a crash.
9. `opencodeProbe` sees the expected command, agent and skill names.
