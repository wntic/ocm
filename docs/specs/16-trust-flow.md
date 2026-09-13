# 16 — Trust flow completion

Depends on: [07 — Trust](./07-trust.md),
[10a — Shared mutation core](./10a-core-mutations.md).

Release: **v0.3.0** (batch with [17](./17-add-integrity.md),
[18](./18-collisions.md), [19](./19-mandatory-manifests.md)).
Branch: `spec/16-trust-flow`.

Evidence: F5 (high), F13, F19, F57, F58, F59
([round 2](../e2e-findings-round2.md)); round-1 #2 and part of #6.
Verbatim transcripts in `docs/e2e-round2/a1.md`, `a3.md`, `a4.md`.

## Goal

The trust flow is safe but dishonest at its edges: an interrupt lies by
silence, a non-TTY call lies by exit code, an undecided or declined
marketplace makes every later command re-print the full risk block, and
the two blind-grant paths never show what is being granted. This spec
makes every trust interaction state a true fact and record a real
decision. It does not change the security model of
[07](./07-trust.md): untrusted executable code still never runs.

## 1. Ctrl+C during a prompt must not produce a silent half-install (F5)

Today `ocm add` registers and materializes, then prompts, then installs
the loader files, then prints the summary — in that order
(`src/commands/marketplace.ts`). SIGINT at the prompt therefore leaves
a fully installed marketplace with no auto-sync loader, no `/ocm` TUI,
no summary, and exit 0.

**Changes:**

1. `installLoader()` runs **before** the trust prompt in every flow
   that calls both (add; update after a re-prompt). The loader files do
   not depend on the trust decision, so nothing is lost by installing
   them first, and an interrupt can no longer skip them.
2. For the duration of any interactive prompt, the CLI holds a one-shot
   SIGINT handler. On interrupt: print one block stating exactly what
   stands on disk and what was not done, then exit **130** (SIGINT
   convention), never 0:

   ```
   ^C
   interrupted — marketplace "demo-marketplace" is added and materialized
     trust: undecided (executable components are blocked)
     run `ocm trust demo-marketplace` to decide, or `ocm remove demo-marketplace` to undo
   ```

3. The handler is removed when the prompt completes normally. A second
   Ctrl+C (outside a prompt, during a long clone) keeps the default
   kill behaviour — we do not try to make git interruptible.

An interrupted mutation must leave consistent state (registry, links
and config agree) and say what that state is. Both halves are required;
the current failure is as much the silence as the ordering.

## 2. `ocm trust` must be able to grant non-interactively (F18, round-1 #2)

- New flag: `ocm trust <marketplace> --yes` — grants exactly as an
  interactive `y`, without reading stdin.
- Non-TTY without `--yes`: print the question, then
  `stdin is not interactive — re-run with --yes to grant`, and exit
  **1**. Today it exits 0 having granted nothing, which is a lie by
  exit code; scripts cannot detect it.
- `--yes` on an already-granted marketplace is a no-op reported as
  `already trusted` (exit 0).

This matches the existing non-interactive grant at add time
(`ocm add --trust`); after this spec every trust decision has a
scriptable path.

## 3. A decline must be recorded; an undecided state must not nag (F13)

Two loops exist today:

- With `trust.code: "none"`, **every** update — including
  `already up to date` — prints the full risk block and the prompt,
  because the prompt fires on the undecided state rather than on
  anything new to decide. Non-interactively the answer is silently
  "skipped", nothing is recorded, and the block returns next run.
- Declining a re-prompt for **changed** code leaves the old grant in
  place, so every later update re-prints "shipped code that changed
  since you trusted it" forever.

**Changes:**

1. The full trust block and prompt print only when there are undecided
   executable components to show — the set [07](./07-trust.md) calls
   trust-pending (new components, or components whose fingerprint
   changed since the grant). An update that changes nothing prints at
   most one reminder line:
   `trust pending for "mech" (2 executable components blocked) — run ocm trust mech`.
2. Declining a re-prompt records a **per-component** decision: the
   components the prompt was about (new or changed) are denied and
   never prompt again; components the existing grant still covers keep
   running. The registry already carries per-component trust records
   (`trust.components`), so this is a write, not a schema change.
3. Answering `y` to a re-prompt refreshes the grant to the current
   fingerprints, as today.

The `skip` answer stays what it is — decide nothing now — but it is
only offered interactively, and the next prompt appears only when
something new arrives (rule 1), so skip can no longer produce a loop.

## 4. The remaining honesty gaps

- **MCP blocked warnings carry the next action** (F19): the warning in
  `loader/mcp.js` gets the same suffix the JS-plugin warning in
  `loader/materialize.js` already has —
  `blocked (untrusted): exec-kit:mcp/everything not installed — run ocm trust exec-kit to approve`.
  This closes the last site of the known-#6 family for good.
- **A declined re-prompt states the functional cost** (F57): when a
  decline blocks a component that was running before, the report says
  so explicitly — `notify.js was running under the previous grant and
  is now blocked`. A decline that blocks nothing new says nothing
  extra.
- **`ocm add --trust` shows what it is granting** (F58): before
  granting, print the same component listing the interactive prompt
  shows (type, plugin, path, command line). A blind grant is a
  security decision made without seeing the question.
- **`skip` is documented** (F59): README's trust section documents all
  three answers — `y` grant, `N` deny, `skip` decide nothing this run —
  and what each means for blocked components.

## Edge cases

| Case | Behaviour |
|---|---|
| Ctrl+C arrives between registry write and prompt (add) | loader already installed (rule 1.1); summary block prints; exit 130 |
| Ctrl+C during update's re-prompt | same handler; states what the update already applied |
| `ocm trust mp --yes` on a marketplace with no executable components | no-op, `nothing to trust`, exit 0 |
| non-TTY update with undecided trust, nothing new | the one-line reminder (rule 3.1), no prompt, no hang |
| decline of a first-sight prompt (add) | as today: `denied`, executable components blocked, recorded |
| decline of a changed-code re-prompt | only the changed components denied; unchanged ones keep running; never re-prompts for the same change |

## Consumed by

`src/commands/trust.ts`, `src/commands/marketplace.ts`,
`src/commands/update.ts`, `loader/mcp.js`, README (trust section).
The TUI prompt paths (`loader/ui-trust.js`) consume rules 3–4 for free
once the core records per-component decisions.

## Tests (`test/phase16-trust-flow.mjs`)

1. Add with a trust prompt; send SIGINT to the child at the prompt:
   exit code 130, `ocm-loader.js` present, summary block on stderr
   naming the state, registry and links consistent (`ocm doctor`
   clean).
2. `ocm trust mp --yes < /dev/null` grants: registry fingerprint
   updated, executable components linked, exit 0.
3. `ocm trust mp < /dev/null` (no flag, non-TTY): exit 1, message
   names `--yes`, trust unchanged.
4. Update with undecided trust and no upstream change: exactly one
   reminder line, no risk block, no prompt.
5. Decline a changed-code re-prompt: the changed component is blocked
   and unlinked, an unchanged sibling keeps running, and a second
   update prints neither the block nor the prompt.
6. Declining states the functional cost when a previously-running
   component is blocked (and stays silent when not).
7. `ocm add --trust` prints the component listing before the grant.
8. MCP blocked warning ends with the `ocm trust` hint.
9. Ownership invariants across 1–5: no writes outside ocm's keys and
   links; config-safety asserts.
