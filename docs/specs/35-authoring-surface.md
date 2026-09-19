# 35 — Authoring surface: the reference plugin and the plugin root

Depends on: [11 — Cross-tool authoring](./11-cross-tool.md),
[03 — Materializer](./03-materializer.md),
[06 — Manifests](./06-manifests.md).

Release: **v0.5.1** for §1, §3, §4 (docs and template only);
**v0.7.0** for §2 (materializer change).
Branch: `hotfix/v0.5.1` for the first three; `spec/35-authoring-surface`
for §2.

Evidence: F67 (high), F84, F121, F95/F52
([round 3](../e2e-findings-round3.md)).

## Goal

Everything an author copies or reads before writing their first plugin
is wrong in one of three ways: the reference agent does not run, the
documented plugin-root variable is empty where the docs imply it works,
and the marketplace manifest example omits the field `validate` asks
for. None of it is deep — all of it is the first hour of every user's
experience.

## 1. The reference agent must run (F67, v0.5.1)

`template/plugins/demo-kit/agents/reviewer.md` ships `model: inherit`.
opencode splits `model` on `/` into provider and model, so this fails
at runtime with `Model not found: inherit/.` and opencode silently
substitutes a general agent. `ocm validate` passes the template clean,
so nothing anywhere warns.

`inherit` is a Claude Code-ism; opencode's equivalent is **omitting the
field**.

- The template drops the line.
- README's command-and-agent frontmatter section states the `model`
  value format (`provider/model`), that omitting it inherits the
  session's model, and that `inherit` and bare model names fail at
  runtime. The section's worked example is corrected likewise — it
  shipped `model: sonnet`, which fails the same way.

**A validate rule is deliberately not part of v0.5.1** (a patch release
carries no behaviour change). `validate` gains a `model`-format error in
v0.6.0 alongside the rest of the manifest gate ([29]) — until then the
README is the only guard, which is why §1 ships as documentation rather
than being deferred wholesale.

## 2. `${OCM_PLUGIN_ROOT}` is substituted, not exported (v0.7.0)

The loader exports `OCM_PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT` through
opencode's `shell.env` hook (`loader/ocm-loader.js:14`). That hook fires
when opencode spawns a shell for the model's **bash tool**. A command
template's `!` block is executed by opencode's own template engine,
which never calls it — so the documented form
`"${OCM_PLUGIN_ROOT}/plugins/<name>/scripts/x.sh"` is empty in exactly
the place spec 11 aimed it (F84, verified round 3 D1.2).

No hook can fix this; there is no plugin hook on the template path. A
second defect compounds it: the flat `OCM_PLUGIN_ROOT` exists only when
exactly one marketplace is added (`loader/registry.js:127-129`), because
a flat name cannot say which root it means.

**Decision: substitute at materialization time.** When a command or
agent body references `${OCM_PLUGIN_ROOT}` or `${CLAUDE_PLUGIN_ROOT}`,
ocm renders the file — writing the plugin's own marketplace root in
place of the variable — instead of symlinking it. This is the mechanism
[03](./03-materializer.md) already uses for `SKILL.md`, and at render
time ocm knows exactly which marketplace the file came from, which the
variable cannot.

Rules:

1. A body containing neither variable keeps its **symlink**. Local
   authoring stays live-edit for the common case; only the files that
   are broken today change shape.
2. A rendered file is regenerated on every materialization, so an
   upstream edit lands on the next sync exactly as a symlink would.
3. The `shell.env` hook stays: the variables remain correct for scripts
   the model runs through the bash tool, which is where they work today.
4. `ocm doctor` treats a rendered command/agent as ocm-owned by the same
   rule it uses for skill mirrors (content match, not link target).

### Edge cases

| Case | Behaviour |
|---|---|
| body references the variable in a `!` block *and* in prose | substituted in both — it is one text substitution |
| `OCM_PLUGIN_ROOT_<NAME>` (per-marketplace form) in a body | substituted too, when it names this plugin's marketplace; left alone otherwise |
| marketplace root contains a `$` or a space | substituted literally; the body is the author's to quote |
| user edits the rendered file in `~/.config/opencode/` | overwritten on the next materialization, like any ocm-owned file |
| a rendered file's plugin is uninstalled | removed by the ownership diff, as a symlink would be |

## 3. Manifest examples carry `$schema` (F121, v0.5.1)

`plugin.json`'s README example carries `$schema` (F48, v0.3.0); the
`marketplace.json` example does not, so an author copying it writes a
manifest that `validate` nudges on. The example gains the pinned
`schema/marketplace-v1.json` URL.

## 4. Config-safety scope is documented (F95/F52, v0.5.1)

[20](./20-doctor-config-safety.md) §5 refuses a mutation pre-flight when
a file it will write is read-only. Round 3 read that as a defect when
`ocm install` proceeded under a read-only `tui.json` — it is the rule
working: a command refuses over files it actually touches. **Wontfix**,
documented: README's config-safety section names which commands write
`tui.json` and which write `opencode.json`, so a refusal is predictable
rather than arbitrary.

## Tests

§1, §3, §4 are documentation and fixture content:

1. `cd template && ocm validate` → zero findings (existing invariant).
2. README grep-test (the phase-15 pattern): the `model` format sentence,
   the `shell.env` scoping paragraph, `$schema` in the marketplace
   example, and the per-command config-write table each appear.

§2 (`test/…`, v0.7.0):

3. A command body referencing `${OCM_PLUGIN_ROOT}` materializes as a
   **rendered file** whose content names the marketplace root; a body
   without it materializes as a **symlink**.
4. Two marketplaces added: each rendered body names its own root.
5. Upstream edit of a rendered command is picked up by the next
   materialization.
6. `ocm doctor` reports neither a rendered command nor its plugin as
   drift; uninstall removes it.
