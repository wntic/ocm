# 19 — Mandatory plugin manifests

Depends on: [06 — Manifests & component types](./06-manifests.md)
(amends it), [12 — Validate & doctor](./12-validate-doctor.md),
[15 — Manifest location](./15-manifest-location.md).

Release: **v0.3.0** (batch with [16](./16-trust-flow.md),
[17](./17-add-integrity.md), [18](./18-collisions.md)).
Branch: `spec/19-mandatory-manifests`.

**Breaking** — for marketplace authors. Deliberate and cheap now:
ocm has one marketplace in existence (being scrapped) and no public
users; after 1.0 this change would need a deprecation window.

Evidence: U4 (design question, decided 2026-09-13: option b —
required), F48 ([round 2](../e2e-findings-round2.md)).

## Goal

`plugin.json` becomes required: every `plugins/<name>/` must carry
one, with a non-empty `description`. Today a plugin is "any directory
under `plugins/` with components" ([06](./06-manifests.md)) and the
manifest only adds metadata — which means `ocm search` and the TUI
show bare names for anything whose author never wrote one, and the
user asked why the richer UI metadata they see in Claude Code is
missing. Claude Code requires the manifest; that is the reference the
product is measured against.

## What changes in the contract

[06](./06-manifests.md) said: "manifests add metadata; they never
hide a plugin". Amended: **a plugin without `plugin.json` is not a
plugin.** It is refused at every boundary — add, update, validate —
with an error that says exactly that. The marketplace-level manifest
(`.opencode-plugin/marketplace.json`, [15](./15-manifest-location.md))
remains optional: a directory of self-describing plugins is still a
valid zero-config marketplace.

### Required fields

| Field | Rule |
|---|---|
| `description` | required, non-empty string, ≤ 200 chars |
| `name` | optional; if present, must equal the directory name |
| `$schema` | recommended; `validate` keeps its existing info-level nudge |
| everything else | unchanged from [06](./06-manifests.md) |

Only `description` is new as a hard requirement — the minimum that
makes search and the TUI non-blind. Not requiring `name` keeps the
directory as the single source of the name (a required field that
must duplicate the filesystem is noise).

## Enforcement points

1. **`ocm add`** refuses the marketplace. The error lists every
   manifest-less plugin (name + missing file), capped at 10 with
   `… and N more`, and points at the fix:

   ```
   error: marketplace "demo" is not installable — 2 plugins have no plugin.json
     plugins/alpha-kit/plugin.json — missing
     plugins/beta-kit/plugin.json — missing
     each needs at least { "description": "…" }; see ocm validate and the README
   ```

   Refusal happens before any write (registry, links, config) — the
   atomicity rule of [17](./17-add-integrity.md) §2 applies.

2. **`ocm validate`** reports one error per missing manifest and
   prints a copy-pasteable stub for the first one:

   ```
   plugins/alpha-kit: plugin.json is required
     minimal content: { "$schema": "…", "description": "one line about the plugin" }
   ```

3. **`ocm update`** refuses *new* manifest-less plugins coming from
   upstream (that plugin is reported and not installed; the rest of
   the update proceeds — the existing failure-isolation model).

4. **Already-installed plugins without manifests keep working.** An
   update never disables a plugin that was legitimately installed
   before this spec; `ocm doctor` reports it once as
   `legacy: "<plugin>" has no plugin.json — add one before its next
   update` (a warning, exit-code-neutral). This is the migration
   story: nothing bricks, the boundary moves, existing state is
   grandfathered until the plugin next changes.

## Template and docs

- `template/`: every plugin gains a `plugin.json` with `$schema` and a
  real `description`; the template must pass `ocm validate` with zero
  findings.
- README: the manifest section moves from "optional metadata" to
  "required"; **every** README example of a plugin includes
  `plugin.json` with `$schema` (F48 — today every README-only author
  gets a validate nudge on first run because `$schema` appears in no
  example).
- The schema files (`schema/plugin-v1.json`) gain `description` as
  required.

## Edge cases

| Case | Behaviour |
|---|---|
| `plugin.json` present, `description` empty string | error: `description` must be non-empty |
| `plugin.json` present, `name` ≠ directory name | error naming both (unchanged from 06) |
| `plugin.json` malformed JSON | existing malformed-manifest error; **never** silently treated as missing |
| marketplace with 0 plugins | still valid (empty marketplace is legal); nothing to require |
| dir under `plugins/` with neither components nor manifest | ignored as today (not a plugin) |
| grandfathered plugin changes upstream without gaining a manifest | now refused by update rule 3 — the grandfather ends when the plugin changes |
| `ocm add` of a marketplace whose only defect is missing manifests | refused whole; after authoring the manifests, the same add succeeds |

## Why not warn-only (the rejected alternative)

A validate warning (round-2 U4 option a) closes most of the search
gap at zero breakage — recorded as the fallback if this spec proves
too aggressive in practice. It was not chosen because the manifest is
also the natural carrier for future author-facing fields, and
"optional forever" means every consumer of `description` forever
carries a missing-data branch. One breaking change now, while there
are no public users, is cheaper than a deprecation window later.

## Tests (`test/phase19-mandatory-manifests.mjs`)

1. Add a marketplace with one manifest-less plugin: refusal lists the
   plugin and file; exit 1; zero writes (byte-compare home).
2. Same marketplace with manifests added: add succeeds; `ocm search`
   finds the plugin by its description.
3. Validate: error per missing manifest, stub printed, exit 1.
4. `description: ""` and `name` mismatch: distinct errors.
5. Update pulling a new manifest-less plugin: that plugin refused and
   reported, siblings updated.
6. Grandfathered install (registry pre-seeded without manifest):
   update keeps it enabled; doctor reports the legacy warning once.
7. `template/` passes `ocm validate` with zero findings.
8. Migration invariant: a pre-spec home keeps working end to end
   (list, update, opencode resolution) with zero errors.
