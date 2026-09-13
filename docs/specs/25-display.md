# 25 — List, info & search display

Depends on: [09 — Search & info](./09-search.md), [07 — Trust](./07-trust.md),
[08 — Update engine](./08-update.md).

Release: **v0.5.0** (batch with [23](./23-truthful-reports.md),
[24](./24-validate-hardening.md), [26](./26-update-hygiene.md)).
Branch: `spec/25-display`.

Evidence: F15, F17, F20 (round-1 #6), F43, F44 (U2), F47, F60
([round 2](../e2e-findings-round2.md)); transcripts in
`docs/e2e-round2/a2.md`, `a3.md`, `a4.md`, `a5.md`.

## Goal

The display commands render the registry rather than the world: a
denied marketplace's executable components list as if installed, the
plugin-details view prints arrows to files that do not exist, a
pin held since yesterday is invisible in `ocm list`, and search
cannot find a plugin by its JS or MCP component names. Every item
here is rendering — the registry already holds the truth (verified:
`--json` output is correct); these commands just do not show it.

## 1. Blocked components are marked in `list` (F15)

After a trust denial, `ocm list` prints `plugins: notify.js` /
`mcp: everything` as if installed. The text renderer gains the marker
the data already carries (`trust.code: "denied"`):

```
demo-marketplace (auto)
  demo-kit (0.1.0)
    plugins: notify.js (blocked — ocm trust demo-marketplace)
    mcp: everything (blocked — ocm trust demo-marketplace)
```

One marker per line where the components are listed; `list --json`
is unchanged (already truthful).

## 2. Trust-pending is visible everywhere (F20, round-1 #6)

The loader records `trustPending` after a sync pulls new executable
components; no `src/` command reads it, so the component stays
disabled indefinitely unless the user happens to run `ocm update` and
read its output.

- `ocm list`: a trust-pending marketplace's line gains
  `(1 component awaiting trust)`.
- `list --all` and `ocm info`: the pending components, one line each,
  with the `ocm trust` hint.
- `ocm doctor`: one error per trust-pending marketplace
  (`executable components pulled but not trusted — run ocm trust <mp>`),
  exit-code-relevant. ([16](./16-trust-flow.md) §3 already stops the
  prompt itself from looping; this is the visibility half.)

## 3. `info` renders disk, not registry fiction (F17)

- For a disabled or blocked plugin, the components block today prints
  `command tdd.md → ~/.config/opencode/commands/ocm--demo-kit--tdd.md`
  for a file that does not exist. When the target is absent the line
  becomes `command tdd.md (not linked)`; the arrow form is printed
  only for links that exist.
- The trust line stops saying `trust granted` unconditionally: it
  compares the current code fingerprint and prints `trust granted`,
  `code changed since trust — run ocm trust <mp>`, or `trust denied`,
  matching the decision states of [07](./07-trust.md).

## 4. Install dates are real (F43)

Plugins that arrived via update's auto-install get
`installedAt = <marketplace addedAt>` — a backdated install date in
`ocm info`. The auto-install path records the actual materialization
time. Existing registries keep their stored values (no rewrite; the
fix is forward-looking).

## 5. Pins are visible in `list` (F44 / U2)

`ocm list` shows a held pin on the marketplace line:
`demo-marketplace (auto, pinned @ v1.0.0)`. (`info` already shows it
as `@ v1.0.0`; the TUI half is [22](./22-tui-fixes.md) §4.)

**Pin ref picker (enhancement, from U2):** `ocm pin <mp>` with no ref
argument lists the marketplace's remote heads and tags
(`git ls-remote --heads --tags`) and prompts interactively for one;
non-interactive with no ref errors, listing the available refs. The
explicit `ocm pin <mp> <ref>` form is unchanged.

## 6. Sync freshness is visible (F60)

- `list --all` shows the age: `synced 2h ago` / `never synced` /
  `sync failed 5m ago` per marketplace (relative time, no clock
  arithmetic by the user).
- A **failed** sync shows in plain `list` too — a one-line marker on
  the marketplace row (`! sync failed 5m ago`); plain list stays
  silent about mere age. (The red `last sync failed:` line in `--all`
  already works and stays.)

## 7. Search matches executable component names (F47)

`ocm search` matches command, agent and skill names today, but not
plugin JS file names (`notify`) or MCP server names (`everything`,
`hook`). Both become searchable component types, with the `matched:`
annotation extended to them (`matched: plugin notify.js`, `matched:
mcp everything`). Search behaviour is otherwise unchanged (ranking,
offline, markers).

## Edge cases

| Case | Behaviour |
|---|---|
| denied marketplace, `list --json` | unchanged (already truthful) |
| component linked but registry says blocked (post-[20](./20-doctor-config-safety.md) stale-records case) | doctor's disagreement error covers it; info renders disk truth |
| `installedAt` absent in an old registry | info omits the date line rather than printing a wrong one |
| pinned marketplace, remote ref deleted | pin still shown (user choice); update reports the fetch failure as today |
| `ocm pin` non-interactive, no ref | error listing available refs (no hang — [17](./17-add-integrity.md) §3 git flags apply) |
| search term matches a plugin name AND its MCP server | one result, both `matched:` annotations |

## Tests (`test/phase25-display.mjs`)

1. Denied marketplace: `list` shows `(blocked — ocm trust <mp>)` on
   the executable lines; `--json` byte-stable versus today.
2. Trust-pending (seeded via loader sync): marker in `list`, lines in
   `--all`/`info`, doctor error.
3. Disabled plugin `info`: `(not linked)` for absent targets; trust
   line states `denied`/`changed`/`granted` correctly per seeded
   fingerprint.
4. Auto-installed plugin via update: `installedAt` within the test
   run's window (not the marketplace's addedAt).
5. Pinned marketplace: `(pinned @ v1.0.0)` in `list`.
6. `ocm pin mp` interactive (pty): ref list offered, choice recorded;
   non-interactive: error with refs listed.
7. `list --all` age strings; failed sync marker in plain `list`.
8. `ocm search notify` / `search everything` / `search hook`: results
   with the extended `matched:` annotations.
