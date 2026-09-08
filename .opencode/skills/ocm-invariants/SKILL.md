---
name: ocm-invariants
description: The four properties every ocm change must preserve — config safety, idempotence, ownership, and no plugin-load errors — plus the ownership model that decides which files ocm is allowed to touch. Use before finishing any change that writes files, creates symlinks, or edits opencode.json, tui.json or the registry, and when reviewing such a change.
---

# ocm invariants

These four hold after every change. A change that cannot demonstrate all four
is not done, regardless of whether its own tests pass.

## 1. Config safety

An `opencode.json`, `tui.json` or registry containing arbitrary user keys
survives every ocm write **byte-identically outside the keys ocm owns**.

The user's config is not ocm's file. It holds their provider credentials,
their model choice, their permissions. A formatting change is a diff in their
dotfiles repo; a dropped key is an outage.

Owned keys, exhaustively:

- keys prefixed `ocm--` (MCP servers)
- ocm's own entries in `skills.paths`
- the single `tui.json` plugin array entry `./ocm/ui.js`
- the whole of `~/.config/opencode/ocm/registry.json`

Nothing else. ocm never writes to the `plugin` array in `opencode.json`.

## 2. Idempotence

Running any operation twice changes nothing the second time. No re-created
symlinks, no rewritten files with new mtimes, no registry churn, no "created
5 links" on a run that created nothing.

This is what makes the startup sync safe to run on every launch and what makes
`--fix` safe to run repeatedly.

## 3. Ownership

ocm modifies or removes a file only when it can prove it created it:

| Kind | Owned iff |
|---|---|
| symlink | it is a symlink and its target resolves inside a managed marketplace directory |
| rendered file | it is a regular file carrying the `ocm: rendered from` marker |
| skill directory | it contains an owned `SKILL.md` |
| MCP key | the key starts with `ocm--` |

A path with no ownership proof is **never** touched — not overwritten, not
deleted, not moved. It is reported and skipped. The one exception is
`--force`, which moves the displaced file to `~/.cache/ocm/displaced/` and
prints the path.

A hand-written `~/.config/opencode/commands/commit.md` must survive every ocm
operation including `ocm remove`.

## 4. No plugin-load errors

After any change, `./scripts/oc-probe.sh` reports zero
`failed to load plugin` lines attributable to ocm files. A user should never
see a red line caused by this tool.

## How to demonstrate them

Every phase test file asserts all four. The harness gives you:

```js
assertConfigUnchangedOutsideOwned(before, after)
assertIdempotent(() => operation())
assertUnownedUntouched(dir)
await assertNoPluginErrors()          // skipped when opencode is absent
```

If a change makes one of these impossible to assert, the change is wrong, not
the invariant.
