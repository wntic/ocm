# 24 — Validate hardening & authoring docs

Depends on: [12 — Validate & doctor](./12-validate-doctor.md),
[06 — Manifests](./06-manifests.md) (as amended by
[19](./19-mandatory-manifests.md)), [15 — Manifest location](./15-manifest-location.md).

Release: **v0.5.0** (batch with [23](./23-truthful-reports.md),
[25](./25-display.md), [26](./26-update-hygiene.md)).
Branch: `spec/24-validate-hardening`.

Evidence: F24, F49, F50, F51 ([round 2](../e2e-findings-round2.md));
transcript in `docs/e2e-round2/a5.md`, `a6.md`. (F48, the `$schema`
README gap, is fixed by [19](./19-mandatory-manifests.md); F25, the
two missed collision rules, by [18](./18-collisions.md) §6.)

## Goal

`ocm validate` is the authoring surface: it catches 18 of the e2e
plan's 20 defect rows with exact, actionable lines — and then falls
silent on the three cases where silence is the worst answer: run
outside a marketplace (exit 0, "all good" for the wrong directory), a
path rule violated with the wrong reason named, and a malformed
manifest described as "ignored". Plus the README's authoring contract
is missing two rules that validate enforces.

## 1. Validate refuses to run nowhere (F24)

`cd /tmp && ocm validate` today prints the header and exits 0 with
zero findings — a false "all good" for a directory that is not a
marketplace at all.

**Rule:** when the working directory has neither a marketplace
manifest (any location per [15](./15-manifest-location.md)) nor a
`plugins/` directory, validate errors:

```
error: not an ocm marketplace directory (no plugins/ and no manifest found)
  run ocm validate at the marketplace repository root
```

exit 1. An *empty but shaped* marketplace (a `plugins/` dir) stays
valid — zero plugins is a legal state ([19](./19-mandatory-manifests.md)
edge table).

## 2. Error messages name the rule that was broken (F50, F51)

- `mcpServers: "../other/mcp.json"` is refused today with
  `is not a JSON object` — the refusal is correct, the reason is
  wrong (the file exists; the *containment rule* rejected it). The
  message becomes:
  `mcpServers "../other/mcp.json" must resolve inside the plugin
  directory` (`loader/manifest.js`).
- A malformed preferred manifest is reported today as `ignored` with
  no next action. Post-[19](./19-mandatory-manifests.md) a manifest
  is not optional furniture; the message becomes
  `<file>: not valid JSON — fix it or remove it; ocm requires this
  file to be readable` for `plugin.json`, and the existing
  skip-with-warning shape stays for `marketplace.json` (still
  optional), with `…; the entries below were not applied` appended so
  "ignored" is never read as "fine".

House style throughout: name the thing, name the next action.

## 3. README documents what validate enforces (F49)

The README's authoring section gains two subsections that today exist
only in the command template and in validate's rules:

1. **Command frontmatter requirements** — which fields are required
   (`description`), which are recognized (`extension`,
   `allowed-tools`, `model`, `$schema`…), and what validate says when
   they are missing or malformed. One worked example.
2. **The `extensions` category and tags** — the recognized values,
   what they surface in (search, TUI grouping), and the constraint
   validate places on unknown values.

Rule of thumb recorded in the README: every validate rule must be
stated in the README, or it is a bug in one of the two — validate
enforces the documented contract, nothing else.

## Edge cases

| Case | Behaviour |
|---|---|
| run in a plugin subdirectory of a marketplace | today's behaviour (validates the marketplace) keeps a pointer line: `validating <root>` |
| marketplace with `plugins/` but zero plugins | valid, zero findings |
| both `mcpServers` interpretations exist (plugin- and marketplace-relative) | [15](./15-manifest-location.md) §3 rules; the deprecation warning unchanged |
| malformed `marketplace.json` | skip with the amended warning; exit 1 (as today — findings are errors) |
| malformed `plugin.json` | error naming fix-or-remove (post-19 requirement) |

## Tests (`test/phase24-validate-hardening.mjs`)

1. Validate in `/tmp`-like dir: the error, exit 1, nothing else.
2. Validate in a plugin subdir: pointer line, normal findings.
3. `mcpServers: "../x"` → the containment message (no "not a JSON
   object" anywhere in the output).
4. Malformed `plugin.json` → fix-or-remove error; malformed
   `marketplace.json` → warning with "entries below were not applied".
5. Empty `plugins/` dir → zero findings, exit 0.
6. README grep-test (mirroring the phase-15 pattern): every validate
   error string that names a rule appears in the README — the
   documented-contract invariant, mechanical.
