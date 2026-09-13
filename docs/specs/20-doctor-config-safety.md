# 20 — Doctor & config-write safety

Depends on: [12 — Validate & doctor](./12-validate-doctor.md)
(amends it), [07 — Trust](./07-trust.md), [08 — Update engine](./08-update.md).

Release: **v0.4.0** (batch with [21](./21-displaced-originals.md),
[22](./22-tui-fixes.md)). Branch: `spec/20-doctor-config-safety`.

Evidence: F1, F8 (high), F26, F27, F28, F29, F30, F46, F52
([round 2](../e2e-findings-round2.md)); transcripts in
`docs/e2e-round2/a3.md`, `a6.md`.

## Goal

Doctor is the diagnostic surface of last resort, and today it fails
in every direction at once: it floods a fresh home with 23 errors,
its `--fix` deletes a link the user just trusted, it cannot see
several defect classes it is specified to see, and it diverges from
[12](./12-validate-doctor.md) on what `--fix` does. Separately, the
config-write layer silently defeats a read-only `opencode.json`. This
spec makes doctor's reports complete and its fixes safe, and makes
config writes respect the user's explicit freeze.

## 1. Never-initialized home is one line (F1)

`ocm doctor` on a home where `ocm init` never ran prints 3 loader
`(missing)` lines plus one error per core file — 23 errors, exit 1.

When `~/.config/opencode/ocm/` does not exist at all, doctor prints
exactly:

```
error: ocm is not installed here — run ocm init
```

exit 1, nothing else. The per-file diagnostics exist to explain a
*broken* install, not an absent one.

## 2. `--fix` must never remove something the user approved (F8)

The failure chain: loader sync pulls a new `plugin/other.js`
(trust-pending), `ocm trust` approves it and creates the link, then
`ocm doctor --fix` sees `ocm--exec-kit--other.js` as a stray ocm file
(no registry entry owns it) and **removes the link the user just
approved** — leaving `trust.components`, the per-plugin record and
`trustPending` disagreeing with each other and with disk.

Root cause: the loader's sync path materializes after pull without
refreshing the per-plugin component records (only the CLI
update/reconcile path does), and `ocm trust` creates links without
refreshing them either; `doctor-links` then correctly reports an
unowned link — the *records* are wrong, not the diagnosis.

**Changes:**

1. `loader/sync.js` refreshes per-plugin component records after
   every pull, exactly as the CLI update path does. The two paths
   converge on one reconciliation function rather than two half-copies.
2. `ocm trust` (and `--yes`, and update's re-prompt grant) refreshes
   the same records when it materializes.
3. Doctor's ownership guard gains a safety net independent of 1–2: a
   link matching a trust-approved component of a registered plugin is
   never classified as stray, even if the records lag. When records
   and trust state disagree, doctor reports the disagreement as an
   error (`registry records are stale — run ocm update`) instead of
   deleting anything.

Invariant added to the phase tests: **after sync + trust, `ocm doctor
--fix` removes nothing and exits 0.**

## 3. Doctor sees the defect classes it owns

- **Single-dash strays (F26):** a stray `plugins/ocm-*.js` (single
  dash — matches no ocm layout) is invisible today, while opencode
  loads it as a plugin on every start. Doctor reports it as a
  **warning**: `plugins/ocm-stray.js looks like an ocm file but
  matches no ocm layout — opencode loads it on every start; remove or
  rename it`. Never auto-removed by `--fix`: the file is not ocm's
  (ownership model, [12](./12-validate-doctor.md)) — the user decides.
- **Orphaned ocm links (F30):** after `loader uninstall` + `ocm init`,
  working `ocm--` links and skill mirrors exist with no registry
  backing; `ocm list` says "no marketplaces" and doctor is clean — no
  ocm command can see or remove them. Doctor reports each orphan:
  `ocm--demo-kit--tdd.md: no marketplace owns this link (orphaned by a
  loader uninstall?) — ocm doctor --fix removes it`. `--fix` removes
  them: the `ocm--` namespace is ocm's by the ownership model, so
  removal is within ownership. The `skills/` mirror and the
  `skills.paths` entry are cleaned alongside.
- **Local marketplace with a missing directory (F46):** the remedy
  line today says "ocm update re-clones", but update only skips local
  marketplaces — the error can never clear. The remedy becomes:
  `restore the directory, or run ocm remove <mp>`.
- **Recorded collisions (F32):** covered by [18](./18-collisions.md)
  §3 — listed here only so the doctor-coverage table stays complete.

## 4. `--fix` re-clones a missing marketplace (F27)

[12](./12-validate-doctor.md)'s findings table says doctor's fix for
a missing marketplace clone is "re-clone"; the implementation instead
removes the broken links (leaving the install *less* materialized
than before) and keeps the error, telling the user to run a second
command. The spec is right and the code is wrong — `--fix` re-clones
(via the same code path `ocm update` uses) and reports the outcome;
links are re-materialized, not removed. `--fix` on a *local*
marketplace with a missing directory still refuses (there is nothing
to clone) with the F46 remedy.

## 5. Config-write safety

- **Corrupt `opencode.json` (F28):** today ocm refuses to rewrite it
  (correct), prints the warning twice, then reports the add as a
  success with "1 skills" — while `skills.paths` was never written
  and nothing says so. [12](./12-validate-doctor.md) already requires
  printing the manual change; the fix: one warning (deduplicated),
  the exact JSON edit to make by hand (the `skills.paths` entry), and
  the mutation report stating `skills.paths NOT written — opencode.json
  is not valid JSON` instead of counting the skill as installed.
- **Read-only config (F29):** the atomic write (temp + rename)
  silently defeats a `chmod 444` — the file is rewritten with exit 0.
  The e2e plan already fixed the intent: "clean error, no partial
  state, original file intact" (`docs/e2e-test-plan.md:590`).
  **Change:** every mutation pre-flights writability of the files it
  will touch (`opencode.json`, `tui.json`); if any is read-only, the
  mutation is refused before doing anything:

  ```
  error: opencode.json is read-only — ocm will not bypass it
    chmod +w ~/.config/opencode/opencode.json, then re-run
  ```

  No partial state: the check happens before the first write of the
  run, so a refused uninstall leaves the registry and config
  byte-identical.
- **Re-serialization documented (F52, wontfix):** ocm rewrites user
  configs with 2-space indentation, preserving key order and content
  exactly. That is inherent to the atomic-write design and stays; the
  README's config-safety section states it plainly so a diff-averse
  user is not surprised.

## Edge cases

| Case | Behaviour |
|---|---|
| fresh home, `ocm doctor` | one line, exit 1 |
| fresh home, `ocm doctor --fix` | same one line — nothing to fix, no init performed implicitly |
| sync + trust then `doctor --fix` | removes nothing, exit 0 (the §2 invariant) |
| stray single-dash file + `--fix` | warning persists, file untouched |
| orphan links + `--fix` | orphans removed, `skills.paths` entry cleaned, exit 0 |
| missing git marketplace clone + `--fix` | re-cloned, links restored |
| missing local marketplace dir + `--fix` | refused with the restore-or-remove remedy |
| read-only `opencode.json` + any mutation | refused pre-flight, zero writes |
| corrupt config + add | single warning + manual edit printed; skill not counted as installed |

## Tests (`test/phase20-doctor-config-safety.mjs`)

1. Doctor on a fresh home: exactly one stderr line, exit 1.
2. The F8 chain (sync pulls trust-pending JS → trust → doctor):
   doctor clean; `--fix` removes nothing; records and disk agree.
3. Single-dash stray: warning reported; `--fix` leaves the file.
4. Orphan sweep: seeded orphans reported; `--fix` removes links,
   mirrors and the `skills.paths` entry; user's own files untouched.
5. Missing clone + `--fix`: re-cloned, install re-materialized, exit 0.
6. Missing local dir: remedy names restore-or-remove; `--fix` refuses.
7. Corrupt config + add: one warning, manual edit printed, report
   states the skill was not written; config byte-identical.
8. Read-only config + uninstall: refused, registry and config
   byte-identical, error names the chmod.
9. Config-safety and ownership invariants across all of the above.
