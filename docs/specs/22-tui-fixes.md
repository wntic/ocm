# 22 — TUI fixes: routing, sizing, navigation, versions

Depends on: [10b — TUI integration](./10b-tui-dialog.md),
[08 — Update engine](./08-update.md).

Release: **v0.4.0** (batch with [20](./20-doctor-config-safety.md),
[21](./21-displaced-originals.md)). Branch: `spec/22-tui-fixes`.

Evidence: F4 (high), F61 (U1), F62, F63 (U2)
([round 2](../e2e-findings-round2.md)); user visual round, 2026-09-13.

## Goal

Four verified defects of the `/ocm` TUI, from the user's visual pass:

1. the empty-state "add one here" route is dead — after Enter on the
   alert, nothing appears (F4);
2. dialogs clip text and never scroll, regardless of terminal size —
   button help text truncates mid-sentence, a details view with many
   skills loses everything past the bottom fold (F61/U1);
3. no back navigation — the details view is a dead end; the only way
   out is re-running `/ocm` (F62);
4. versions and pins are displayed nowhere — a pinned marketplace
   does not show which ref the pin holds (F63/U2).

All rendering is `loader/ui-dialog.js` and the `loader/ui-*.js`
views; all plain JS with `node:*` builtins only (hard rule 1).

## 1. The empty state must offer its own way in (F4)

`loader/ui.js` chains the "No marketplaces added yet… Or add one
here." alert into `addMarketplaceFlow` — the intent exists, the chain
breaks somewhere between the alert's Enter handler and the flow (the
input source is likely consumed or dismissed by the alert itself).

Required behaviour: on a fresh install, `/ocm` shows the empty-state
alert; Enter opens the "Add marketplace" prompt (source URL/path,
then the normal add flow with its trust prompt). This is the only
route to a first install that does not require leaving opencode, and
it is currently unreachable. Fix the chain; the regression test is a
headless call of the same flow functions the dialog drives.

## 2. Dialogs size to the terminal and scroll their content (F61/U1)

Today the dialog window has a fixed small size independent of the
terminal; text clips and overflow is unreachable.

**Rules:**

1. A dialog's width is `min(content need, terminal width − 4)` with a
   floor of 40 columns; its height is `min(content need, terminal
   height − 2)`. Content need is computed from the wrapped lines —
   help and description text **wraps** at the dialog width instead of
   clipping (the uninstall button's help text is the canonical
   example: it must be fully readable at 80 columns).
2. When content exceeds the height, the body area **scrolls**: ↑/↓
   (and j/k) move a viewport over the content; a scrollbar or
   position indicator (`3/17`) shows there is more. The action row
   (buttons/help) is fixed and never scrolls away.
3. Resize: the dialog re-computes on terminal resize if the widget
   library exposes it; at minimum, dialogs opened after a resize use
   the new size. A dialog must never render outside the terminal.

The plugin-details view with a long component list is the acceptance
case: every skill reachable by scrolling at the default 80×24.

## 3. Back navigation (F62)

- **Escape** returns to the previous view, one level at a time,
  through the whole stack (details → plugin list → marketplace list →
  root), closing the dialog at the root.
- Lists keep their selection and scroll position when returning to
  them.
- The details view's action row gains a visible `← back` affordance
  alongside Escape (discoverability: the user must not have to guess
  the key).
- Escape in a text input clears the input first, then navigates back
  (standard two-step); Ctrl+C keeps its existing abort behaviour.

No view opened from `/ocm` may be a dead end.

## 4. Versions and pins visible (F63/U2)

- Marketplace row in the list shows the pin when one is held:
  `demo-marketplace (auto, pinned @ v1.0.0)`.
- The marketplace detail view shows `pinned @ v1.0.0` (or `not
  pinned`) and the current revision.
- The plugin detail view shows the plugin's version (from its
  manifest) next to the name, matching what `ocm info` prints.

CLI parity for the pin-in-list half is [25](./25-display.md) §5; the
registry already stores everything needed (`ref`, `revision`,
manifest versions) — this is rendering only.

## Testing

TUI rendering is visual; the spec splits verification accordingly:

- **Automated (`test/phase22-tui-fixes.mjs`):** the data-shape
  functions the views render from — detail lines include version and
  pin; the empty-state flow function exists and returns the add flow;
  the view-stack model returns the previous view on back; wrap
  computations (given width and text, the expected line count —
  pure functions, testable headlessly).
- **Manual checklist** (mirrors e2e plan Tests 37–41): the F4 route
  end to end; the long-skill-list details view at 80×24 and at
  200×50; help text fully readable; Escape walking back the full
  stack; pin visible on a pinned marketplace.

## Edge cases

| Case | Behaviour |
|---|---|
| terminal narrower than the floor (40 cols) | dialog uses the floor; body scrolls horizontally is **not** attempted — content wraps |
| details view with 1 item | no scroll indicator; back still available |
| Escape at root list | closes the dialog (existing behaviour) |
| add flow from the empty state, user Ctrl+C's the trust prompt | [16](./16-trust-flow.md) §1 handler applies; state summarized |
| pinned ref deleted upstream | pin shown as held (it is a user choice), update reports the failure as today |
