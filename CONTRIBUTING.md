# Contributing to ocm

## Reporting bugs

Open an issue with the `ocm doctor` output, your OS, and the exact command
that misbehaved. `ocm --version` and `ocm doctor --fix` are worth trying
first.

## Development setup

```bash
git clone https://github.com/wntic/ocm.git
cd ocm
bun install
./scripts/check.sh   # typecheck, tests, and a probe against real opencode
```

Never run bare `bun test` here — directory traversal has hung indefinitely in
this repo. `./scripts/check.sh` passes explicit file paths and is the command
that must pass before anything is done.

## Making a change

- Read `AGENTS.md` first — it documents this repo's brief-driven workflow and
  the hard rules (`loader/*.js` is plain JS with no build step, plugin modules
  export `{ id, server }`, nothing under `~/.claude` or `.claude` gets
  touched, no new runtime dependencies).
- Match the code style already in the file you're editing. Comments are rare
  and explain a non-obvious *why*, not what the code does.
- Tests live under `test/`; `./scripts/check.sh` is the gate a PR needs to
  pass.

## Good first issues

Small, self-contained gaps that don't require deep context on the codebase:

- Some commands (`ocm doctor`, `ocm scan`, `ocm trust`) don't yet support
  `--json`, unlike `ocm list`/`ocm search`/`ocm info`/`ocm update`.
- Windows is untested (ocm links components as symlinks, which Windows
  restricts) — a report of what actually breaks there would help scope real
  support.
- Shell completions (bash/zsh/fish) for the `ocm` CLI don't exist yet.

Check open issues labeled
[`good first issue`](https://github.com/wntic/ocm/labels/good%20first%20issue)
for ones already scoped by a maintainer before starting work, so effort isn't
duplicated.

## Pull requests

- Keep the diff scoped to one change.
- Commit messages: imperative subject, prose body explaining *why*, no
  trailers.
- CI runs `./scripts/check.sh` on macOS and Linux; make sure it's green
  locally first.
