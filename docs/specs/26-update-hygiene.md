# 26 — Update engine hygiene

Depends on: [08 — Update engine](./08-update.md).

Release: **v0.5.0** (batch with [23](./23-truthful-reports.md),
[24](./24-validate-hardening.md), [25](./25-display.md)).
Branch: `spec/26-update-hygiene`.

Evidence: F22, F40 ([round 2](../e2e-findings-round2.md)); F41
(considered, rejected). Transcripts in `docs/e2e-round2/a4.md`,
`a6.md`, `a7.md`.

## Goal

Two real defects in the update engine's cache handling and one
documented non-defect. The untracked-file warning loop makes ocm
print a false claim ("discarded") on every update forever; the
fire-and-forget startup sync silently never completes in short-lived
opencode runs and nobody documented it.

## 1. The cache warning must be true (F22)

An untracked file in the cache clone triggers, on **every** update:

```
warning: <clone> has local changes; discarded (the cache is not an editing surface)
```

— while the file survives every time, because the remedy is
`git reset --hard`, which does not touch untracked files. The warning
only stops when the user deletes the file by hand. Two defects: the
check and the remedy disagree, and "discarded" is false.

**Changes:**

1. The dirty check and the remedy align: a dirty clone is cleaned
   with `git reset --hard` **and** `git clean -fd` (untracked files
   and directories included) — after which "discarded" is true and
   the next run is silent.
2. The warning prints once per cleaning (i.e. only when something was
   actually dirty), naming what was discarded when it is cheap to do
   so (`discarded 2 local changes and 1 untracked file`); a clean
   clone prints nothing.
3. The cache stays a non-editing surface — this spec makes the
   statement true, it does not soften it.

## 2. Fire-and-forget sync is documented (F40)

`loader/ocm-loader.js` runs `void core.syncAll(...)` at startup:
background sync by design, correct for the long-lived TUI, silently
incomplete for one-shot runs — `opencode debug config` (~0.5s) exits
before the fetch (~1–3s) finishes, `lastSync` stays null, and a user
probing "did sync happen?" gets a misleading no.

**Change:** documentation only. The README's auto-sync section gains
a paragraph: background sync serves long-lived sessions; a short-lived
`opencode run`/`debug` invocation may exit before it completes;
`ocm update` is the deterministic path. No code change — making the
loader await would tax every startup for a probe use case, and
detecting "short-lived" is not a thing a process can do about itself.

## 3. Rejected: skip the no-op registry write (F41)

A no-op update rewrites the registry with a new `lastSync.at` (mtime
churn for watchers). **Wontfix:** `lastSync.at` is real state — it is
the throttle's clock and the freshness display of
[25](./25-display.md) §6 — and one write per *manual* update is the
correct record of "the user asked, we checked, nothing changed".
Watchers that treat any mtime change as content change are misusing
mtime. Recorded here so the decision is findable.

## Tests (`test/phase26-update-hygiene.mjs`)

1. Untracked file in the cache clone: first update warns once and the
   file is gone afterwards; second update is silent (no warning
   line).
2. Tracked local modification: reset + clean, same once-only warning.
3. Clean clone: update output contains no `local changes` line.
4. Registry write on no-op update still happens (asserting the
   rejected F41 stays rejected — `lastSync.at` advances).
5. README contains the background-sync paragraph (grep-test, the
   phase-15 pattern).
