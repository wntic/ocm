# 07 — Trust for code-executing components

Depends on: [02](./02-registry.md), [06](./06-manifests.md).

## Goal

A marketplace can ship JS that opencode loads and runs, and MCP servers that
spawn commands. Neither may ever execute because a `git pull` happened.

## Threat model

The realistic risk is not a malicious marketplace the user chose to add — that
is a trust decision they made knowingly. It is **an update**: a marketplace
added a year ago for its skills quietly gaining a `plugin/notify.js`, which
then runs with the user's shell on the next opencode start. The `git pull` is
automatic and unattended, so nothing between the author's commit and code
execution involves the user unless ocm puts something there.

This is the postinstall-script problem, and the answer is the same: consent at
first sight, re-consent when the surface changes.

## Model

Trust is **per marketplace**, recorded in the registry as
`trust: { code, grantedAt, fingerprint }`.

- `code: "none"` — this marketplace has never shipped an executable
  component. Silent; nothing to consent to.
- `code: "granted"` — the user approved, at the fingerprint recorded.
- `code: "denied"` — the user declined. Stuff still installs; executable
  components stay blocked and are reported as such.

Per-marketplace rather than per-plugin because trust is really trust in the
*author and the repository*, which is the granularity at which the user can
actually reason. Per-plugin prompting would train the user to say yes.

## Fingerprint

```
sha256 over, for every executable component of every discovered plugin,
sorted by path:  "<relative path>\n<sha256 of file contents>\n"
```

Executable components are `plugins/<p>/plugin/*.{js,ts}` and every server
entry in a plugin's `mcp.json`. For MCP the "contents" hashed are the
canonicalised JSON of that server entry, so changing a server's `command`
invalidates trust while reordering keys does not.

The fingerprint deliberately covers **content, not just presence**: a
marketplace whose `notify.js` changes from a sound player to a credential
uploader must re-prompt.

## Prompts

At `ocm add`, when executable components exist:

```
marketplace "team-tools" ships code that opencode will execute:

  plugin  team-tools/notify        plugin/notify.js
  mcp     team-tools/db-tools      local server: npx -y @acme/db-mcp

this code runs with your shell's permissions on every opencode start.
review it at ~/.cache/ocm/marketplaces/team-tools

trust this marketplace to run code? [y/N/skip]
```

- `y` → `granted`, fingerprint recorded, everything materializes
- `N` (default) → `denied`; stuff installs, executable components blocked
- `skip` → leave `code: "none"` for now, re-prompt next time

At `ocm update`, when the fingerprint changes on a `granted` marketplace, the
report shows what changed (added, removed, modified paths) and prompts again.
Until the user answers, the **previously trusted files stay materialized at
their previous content** — an update never swaps executable content
unattended:

- new executable component → not linked until approved
- changed executable component → the link points at the marketplace working
  tree, which the pull has already advanced, so the *only* safe move is to
  unlink it and report it blocked pending approval. This is the one place
  where an update can reduce functionality; it is the correct trade and the
  report says so explicitly.

## Non-interactive contexts

`ocm` is run from scripts and the loader syncs unattended. Rules:

| Context | Behaviour |
|---|---|
| no TTY (`!process.stdin.isTTY`) | never prompt; treat as `skip`; print what would have been asked and exit 0 |
| `--trust` / `--no-trust` flags | answer without prompting; `--trust` is what CI and dotfile bootstraps use |
| the loader's startup sync | never prompts, never materializes a new or changed executable component; records `trustPending` on the marketplace so the next `ocm` invocation and the TUI report it |
| `ocm trust <marketplace>` / `ocm untrust <marketplace>` | change the decision later; `untrust` unlinks executable components immediately |

## What trust is not

It is not a sandbox. A trusted plugin runs with full user permissions; ocm
cannot and does not constrain it. The prompt says so. Users who want a
constraint have opencode's own `permission` config and `OPENCODE_PURE=1`.

Trust also does not extend to *stuff*: a marketplace's skills, commands and
agents install without a prompt. They are prompts, not programs — they can
persuade a model to run a command, which is a real risk, but it is the same
risk as any instruction the user reads and pastes, and gating it would make
ocm unusable. [12](./12-validate-doctor.md) surfaces stuff that contains
shell-executing constructs (`!` command substitution in an opencode command
template) at `validate` time so authors are aware, and `ocm info` shows it.

## Consumed by

[03](./03-materializer.md) skips untrusted executable components;
[05](./05-install.md) prompts at add; [08](./08-update.md) prompts on
fingerprint change and records `trustPending`; [10](./10-tui.md) surfaces
blocked components and offers the trust dialog.

## Tests (`test/phase07-trust.mjs`)

1. A marketplace with no executable component never prompts and records
   `code: "none"`.
2. `--trust` materializes the JS plugin and the MCP keys; `--no-trust`
   materializes the stuff and neither of those, and reports both as blocked.
3. Fingerprint changes when `notify.js` contents change, when a new plugin
   file appears, and when an MCP `command` array changes; does not change when
   `mcp.json` keys are reordered or a comment-only stuff file changes.
4. An update that changes a trusted file unlinks it, reports it blocked, and
   leaves stuff installed.
5. Non-TTY never prompts and exits 0.
6. The loader's sync never materializes a newly appeared executable component
   and sets `trustPending`.
7. `ocm untrust` removes executable components and leaves stuff in place.
