# 18 — Collision correctness & scan truthfulness

Depends on: [04 — Precedence](./04-precedence.md),
[05 — Per-plugin install](./05-install.md),
[08 — Update engine](./08-update.md), [12 — Validate & doctor](./12-validate-doctor.md).

Release: **v0.3.0** (batch with [16](./16-trust-flow.md),
[17](./17-add-integrity.md), [19](./19-mandatory-manifests.md)).
Branch: `spec/18-collisions`.

Evidence: F10 (high, round-1 #1), F14, F25, F32 (round-1 #4), F38,
F39, F56 ([round 2](../e2e-findings-round2.md)); transcripts in
`docs/e2e-round2/a1.md`, `a3.md`, `a5.md`.

## Goal

Plugin-name collisions are globally unique and first-come-wins
([04](./04-precedence.md)) — the ownership model is right, but every
human surface around it lies: install reports success while
materializing nothing, the warning names neither marketplace, update
silently undoes the user's explicit choice, doctor and validate do not
see recorded collisions at all, and `ocm scan` reports a collision for
every path that does not exist yet. This spec makes each surface
state the truth and gives the user a real takeover path.

## 1. `ocm install` refuses collisions; `--force` takes over (F10)

Today `ocm install review-tools@collide` when `big` already provides
`review-tools` prints a degenerate warning (`review-tools:review.md
conflicts with review-tools:review.md` — same name twice, no
marketplace, no path) and then `installed review-tools@collide`, exit
0, nothing materialized. The next `ocm update collide` silently flips
the plugin back to disabled. Three defects in one flow: the message,
the success claim, and the silent reversal of an explicit user choice.

**Changes:**

1. `ocm install <plugin>@<mp>` where another marketplace owns the
   name: **refuse**, exit 1, naming both marketplaces and the
   conflicting component paths, in the house error style:

   ```
   error: plugin "review-tools" is already provided by marketplace "big"
     review-tools:review.md conflicts with review-tools:review.md
     install with --force to take the name over, or ask the author to rename
   ```

2. `--force` performs a real takeover: the incumbent's plugin is
   disabled and its links removed (displaced originals handled by
   [21](./21-displaced-originals.md)), the new marketplace's plugin is
   installed, and the report states the takeover:
   `took over "review-tools" from marketplace "big"`.

3. **Update never silently flips an explicit choice.** The incumbent
   check in `loader/marketplace.js` that disables a re-registered
   plugin must not override an `enabled` state the user set through
   install. A collision encountered during update is reported, not
   acted on:
   `review-tools: name owned by marketplace "big" — kept disabled; ocm install review-tools@collide --force to take over`.

4. The collision warning text (wherever a collision is reported)
   always names: the plugin, both marketplaces, and the conflicting
   paths on both sides.

## 2. Add-time refusal lists every colliding plugin (F56)

Adding a marketplace whose plugins collide with an incumbent's
currently names only the first colliding plugin; an author who renames
just that one hits the same wall again. The refusal lists **all**
colliding plugins, each with its component paths, capped at a
reasonable number (10) with `… and N more`.

## 3. Doctor reports recorded collisions (F32, round-1 #4)

[04](./04-precedence.md) axis 4 says a retroactive collision is
"reported by update and doctor". With `collision: "big"` recorded,
doctor today prints only loader version lines and exits 0.

Doctor gains one finding per collision record:

```
error: plugin "review-tools" from marketplace "collide" is disabled —
  the name is owned by marketplace "big"
  install with ocm install review-tools@collide --force, or remove one marketplace
```

No `--fix` action: the remedy is a user decision, not a mechanical
repair.

## 4. `ocm scan` tells the truth about the destination (F14)

`ocm scan <plugin>@<mp>` today prints
`(collision: install would refuse without --force)` for **every**
component of a not-yet-installed plugin — the most common case
(scanning before installing) is labelled a collision. Root cause:
`src/commands/plugins.ts` treats a `readlinkSync` throw as
"occupied", conflating "nothing there" with "foreign file".

**Changes:**

1. Destination states are distinct:
   - nothing at the destination → `would create`
   - ocm-owned symlink to this plugin → `already linked`
   - ocm-owned symlink to another plugin → collision, named
   - anything else (foreign file) → collision, named
2. Executable components (plugin JS, MCP) are annotated
   `(trust-gated)` (F39) — "would create" must not imply "would run";
   they materialize only after trust.

## 5. Scan on an empty directory explains the layout (F38)

`ocm scan` in a directory with no plugins prints today only
`no plugins found in <dir>`. It gains the expected layout (one line)
and a pointer: `see ocm validate and the README's marketplace format`.

## 6. Validate detects manifest-level collisions (F25)

`ocm validate` currently misses two defect classes (2 of the 20 rows
in the e2e plan, `docs/e2e-round2/a5.md`):

1. **Duplicate `plugins[]` entries** in `marketplace.json` with the
   same name — silently clobbers the registry record at add time.
   Becomes an error: `<file>: plugin "<name>" listed twice — the
   second entry is ignored today`.
2. **Cross-plugin component collisions** — two plugins in one
   marketplace shipping the same command/agent basename (e.g. both
   have `command/commit.md`). Becomes an error naming both plugins
   and the shared target.

Both are authoring errors that first-come-wins would otherwise
resolve silently at the user's expense; they belong to the author.

## Edge cases

| Case | Behaviour |
|---|---|
| `install x@mp` collision, no `--force` | refusal, exit 1, nothing materialized |
| `install x@mp --force` twice (idempotence) | second run: `already installed` — no re-takeover, no warnings |
| takeover, then `ocm remove` of the incumbent | no change to the taken-over plugin; no leftover collision record |
| collision record exists, plugin uninstalled by user | doctor still reports the record with the remove suggestion |
| scan of an installed plugin | `already linked` for every component, no collision noise |
| scan of a plugin whose dest holds a hand-written file | collision, the foreign file named, `--force` displacement implied |
| duplicate `plugins[]` + cross-plugin collision in one manifest | both errors reported in one validate run (non-fail-fast, as today) |

## Consumed by

`src/commands/plugins.ts` (install, scan), `loader/marketplace.js`
(incumbent logic), `src/commands/doctor-*.ts`, `src/manifest-lint.ts`,
`src/commands/validate.ts`. The TUI's install flow consumes the same
core refusal for free.

## Tests (`test/phase18-collisions.mjs`)

1. Install a colliding plugin: refusal text names both marketplaces
   and paths; exit 1; incumbent untouched (byte-compare registry).
2. Same with `--force`: takeover materialized, incumbent's links
   gone, report states the takeover; re-run is a clean no-op.
3. Update after an explicit install does not flip `enabled` to false;
   the collision is reported as a line, not an action.
4. Add a marketplace with two colliding plugins: refusal lists both.
5. Doctor with a recorded collision: the finding prints, exit
   non-zero, `--fix` changes nothing.
6. Scan of an uninstalled plugin: every component `would create`
   (executable ones `(trust-gated)`), zero `collision:` lines; a real
   install then succeeds without `--force`.
7. Scan in an empty dir: layout hint present.
8. Validate on a fixture with duplicate `plugins[]` and a cross-plugin
   basename clash: both errors, names and paths in the text.
