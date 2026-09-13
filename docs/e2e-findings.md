# E2E findings — 2026-09-10

Bugs found by four end-to-end passes over the shipped specs 01–13, run
against isolated fake `$HOME`s with the real opencode binary (1.18.30).
Baseline gate was green at the time (typecheck clean, 102 tests pass,
probe clean).

A second round of findings from real usage of the installed product
(`npm i -g @wntic/ocm`, marketplace `wntic/ocm-test-marketplace`) is in
the "User findings" section at the bottom.

Everything else verified correct, including: the full install lifecycle,
ownership invariants (hand-written user files survive every operation),
trust withholding and re-prompting, rename-following updates, pinning,
loader throttling, first-come-wins collisions at add and sync time,
doctor's diagnosis of six planted corruptions with `--fix` preserving
foreign files, migration from the v1 layout (idempotent), and real
opencode resolving all installed commands, agents and skills with zero
plugin load errors.

## 1. False success on colliding install (high)

`ocm install <plugin>@<mp>` on a plugin whose name is already provided
by another marketplace reports success, materializes nothing, and the
next `ocm update` silently flips the plugin back to disabled.

```
ocm install alpha-tools@mp-two
# exit 0, prints "installed alpha-tools@mp-two (1 command)"
# warning: alpha-tools:commit.md conflicts with alpha-tools:commit.md
# nothing materialized; registry: enabled:true + collision:"mp-one"

ocm update mp-two
# "already up to date", enabled silently true -> false
```

Three defects in one flow: the success message states a false fact; the
warning is degenerate (same name twice, names neither marketplace nor
path — violates the house error style); the user's explicit choice is
undone by the next update with no output. Root cause is
`loader/marketplace.js:42` (`if (incumbent) enabled = false` on
re-register) versus the install path setting `enabled: true`; the
materializer's ownership guard correctly refuses the conflicting link,
but the CLI still reports success.

## 2. `ocm trust <name>` cannot grant non-interactively (medium)

Non-TTY invocation prints the prompt but exits 0 with trust unchanged:

```
HOME=<fake> ocm trust team-tools </dev/null
# prints "trust this marketplace to run code? [y/N/skip]"
# exit 0; trust stays code:"none"; nothing materializes
```

`src/commands/trust.ts:47` returns "skipped" when stdin is not a TTY.
The only non-interactive grant is `ocm add --trust` at add time — a
script cannot trust an already-added marketplace, and the printed
question implies an answer was read. Needs a `--trust`/`--yes` flag or
equivalent.

## 3. Skill-only install omits the restart notice (medium)

Installing a plugin whose only component is a skill does not print
"restart opencode to activate".

`loader/materialize.js:144` — `removed += mirror(sourceDir, …)`
accumulates only `mirror`'s removal count; the rendered `SKILL.md` and
sibling links created inside `mirror` (`loader/links.js:176-192`) are
never counted in `created`. Since `src/commands/plugins.ts:28` gates the
notice on `reportRestart(result.report.created)`, a skill-only install
reports `created: 0`. Violates spec 03 ("Every caller that created
anything appends the same line"). The uninstall direction is unaffected.

```
ocm add <fixture> --explicit   # fixture with a skill-only plugin
ocm install review-tools
# actual:   installed review-tools@e2e-tools (1 skill)  — no notice
# expected: … + "restart opencode to activate"
```

## 4. `ocm doctor` does not report plugin-name collisions (low)

Spec 04 axis 4 says a retroactive collision is "reported by `update`
and `doctor`". With `collision: "mp-one"` recorded in the registry,
`ocm doctor` prints only loader version lines and exits 0.

## 5. Update report lies in explicit mode (low)

`src/commands/update-report.ts:84` hardcodes the note `installed
(auto)` for any fresh plugin regardless of `entry.mode`. In an
`explicit` marketplace a new upstream plugin is reported `installed
(auto)` while it is registered `enabled: false` and nothing is
materialized.

```
ocm mode mp-two explicit
# commit a new plugin upstream
ocm update mp-two
# report: "gamma-tools   installed (auto)" — but it was not installed
```

## 6. Cosmetic

- The MCP blocked warning lacks the next-action hint. Plugin warnings
  end with ``— run `ocm trust team-tools` to approve``; MCP warnings
  are just `blocked (untrusted): exec-tools:mcp/db not installed`.
- `trustPending` is recorded by the loader and consumed by the TUI
  (`loader/ui-plugins.js:13`), but no `src/` command reads it —
  `ocm list` shows no indicator. Spec 07: "the next `ocm` invocation
  and the TUI report it".
- In `ocm update`, the trust diff/prompt block (stderr) appears before
  the `updating <name>...` header (stdout) — interleaving makes the
  report read out of order.
- `ocm update` / `add` / `doctor --fix` print "installed auto-sync
  loader" even when the loader files were already current (files are
  not rewritten; only the message is unconditional).
- `ocm search <nomatch>` shows the "sync is stale or failed; run ocm
  update" hint for a freshly added local marketplace that has never
  synced (`lastSync: null` counts as stale) — mildly misleading for
  local marketplaces.

## Observations (not bugs)

- Rendered skill `name` doubles the prefix if the source frontmatter
  already carries it (`alpha-tools:alpha-tools:greeting`). A `validate`
  lint could catch this.
- The collision note is reported only on the update where it appears; a
  later no-change update says only "already up to date". Arguable
  against spec 04's "reported by update".
- A plugin with executable code installed while untrusted is not
  refused — it installs with the executable components blocked and
  reported. This matches spec 07's denied-state semantics.

## User findings — real-usage round

Found while dogfooding the installed product against the test
marketplace. Not yet triaged against the specs; severities are the
user's, not verified.

### U1. TUI dialog too small, no scrolling (UX, medium)

The `/ocm` dialogs are cramped: text is clipped in places, and a long
component list in a plugin's detail view overflows the bottom of the
window with no way to see the rest. Needs a larger default size and
scrolling for overflowing content (`loader/ui-dialog.js`,
`loader/ui-plugins.js`).

### U2. Pin state invisible (UX, medium)

After `ocm pin <name> <ref>`, the pin is displayed nowhere — `ocm list`
and `ocm info` do not show which ref a marketplace is pinned to, so it
is impossible to tell what is being followed. The registry stores it
(`entry.ref`). Should surface in `list`, `info` and the TUI's
marketplace view. Related idea worth thinking through: when pinning,
offer the available branch/tag names so the user does not have to know
the ref in advance.

### U4. Should manifests be required? (design question, open)

The user wants richer UI metadata ("showing what a plugin is and where
it comes from is useful") and asks why `marketplace.json` /
`plugin.json` are optional, and whether they could be made mandatory
with a minimal field set.

Current design (spec 06): zero-config — a directory under `plugins/`
with components is a plugin, manifest or not; "manifests add metadata;
they never hide a plugin". Name comes from the directory, components
from the scan, origin (marketplace URL, revision) from the registry —
so `list`/`info`/TUI already show identity and origin without any
manifest. Only the author-written `description` is missing when there
is no manifest, which mostly hurts `ocm search`.

Cost of making manifests mandatory: breaks the existing zero-config
marketplace (`adw` lives without one), raises the onboarding floor
("learn the manifest format before your first plugin"), and a minimal
required set (`name`) duplicates the filesystem. Claude Code does
require them — that is the reference the product is measured against.

Options recorded for a later decision:

- **(a)** Keep optional, but warn in `ocm validate` and the TUI when a
  plugin has no `plugin.json` — "description unknown; search and the
  UI will show only names". Cheap, breaks nothing, closes most of the
  gap.
- **(b)** Require `plugin.json` with at least `description` as a hard
  error at `ocm add` / `validate` — Claude Code parity, but breaking
  for existing marketplaces; needs a spec 06 amendment and a migration
  story.
- **(c)** Leave as is.

Not decided. Revisit with U1/U2 (TUI improvements) since the TUI is
where the missing metadata is most visible.

### U3. Stale component list and stale skills after update (reclassified: UX, low)

Reported as: after deleting a skill upstream and running an update, the
plugin's description still listed the skill, and the skill stayed
usable — the user's custom `/reload` command was needed to make it go
away.

**Triage (2026-09-10):** not a data bug. Verified in isolation that
both a full `ocm update` and a plugin-scoped `ocm update <plugin>@<mp>`
correctly unregister the deleted skill, remove its mirror, and clean
`skills.paths`. The user updated through the `/ocm` TUI flow and the
skill remained visible **inside the running opencode session** — which
is the opencode contract, not an ocm bug: there is no in-session
reload, and a loaded skill stays in the session until restart. The
user's `/reload` (a hand-written TUI plugin that disposes and
re-initializes the instance) masked this by providing the restart
in-session.

What may still be worth fixing:
1. Verify the update output prints "restart opencode to activate" when
   a removal happened, not only on creation — the removal notice is
   known to print, but the TUI update flow (`loader/ui-marketplaces.js`
   `updateFlow`) may not surface it.
2. Consider mentioning in the docs/README that deletions, like
   installs, apply on the next start — the expectation gap is real.
