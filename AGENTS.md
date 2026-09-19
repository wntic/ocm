# ocm

A file-based plugin marketplace for opencode: skills, agents and commands
distributed as git repositories, installed once and available in every
project. Bun + TypeScript, no runtime dependencies.

## How work happens here

Work is driven by **briefs** — one brief per independently shippable change.
A brief is the source of truth while it exists: if the code and the brief
disagree, the code is wrong; if two briefs disagree, stop and say so rather
than picking a side. Briefs are scaffolding, not history — they are deleted
once the code they describe is stable, so nothing durable may depend on a
brief's path or number. What must outlive them lives in `AGENTS.md`, in the
skills, and in the tests.

One command runs a brief:

```
/ocm:build <path-to-brief>
```

That dispatches the `lead` agent, which does not write code. It decomposes
the brief into independently testable subtasks and dispatches one `subtask`
agent per subtask, in order. Each `subtask` runs its own loop: `test-author`
writes failing tests, `implementer` makes them pass, `verifier` produces
mechanical evidence — gate output, diff scope, invariants — and the loop
repeats on a failure up to three times. The lead runs `./scripts/check.sh`
itself at the end, because subtask gates are scoped and only the full run
proves they compose.

The split is deliberate. The lead holds the brief, the subtask list and one
verdict each — never file contents — so its context stays clean across a long
brief. Everything that writes a file is a subagent whose permissions stop it
writing anywhere else.

Tests are written before the implementation, by a different agent, and the
implementer is **not permitted to edit `test/`**. That separation is the
point: a test the implementer can change is not a check.

**Write the smallest thing that passes.** The failure mode here is not bad
syntax, it is building far more than the brief asked for. Size budgets live in
the `ocm-code-style` skill and the verifier reports against them.

`/ocm:gate` runs the gate alone. `/ocm:probe` asks the real opencode binary
what it sees. `/ocm:commit` verifies the gate, then stages and commits — never
pushes, amends or resets.

### Who verifies what

Everything inside opencode runs on GLM. Its verification is **mechanical**:
the gate is green, the diff is in scope, the invariants hold. That proves the
code runs; it does not prove it is right.

**Judgement is a Claude Code review**, run by the human after a brief lands —
does this match what was asked, is it the smallest thing, did it invent scope.
Write every report for that reviewer: someone who has read the brief and none
of the diffs.

## Two traps specific to this repo

**Never run bare `bun test`.** Directory traversal has hung indefinitely here;
`./scripts/check.sh` passes explicit file paths and is the command to use.

**Nothing expensive at module scope in a test file.** Module bodies run during
discovery, outside any timeout, with no output — a probe call there looks like
a hang.

## The gate

```
./scripts/check.sh
```

Typecheck, tests, and a probe that asks the real opencode binary what it sees.
Nothing is done until this exits 0.

`./scripts/oc-probe.sh` runs the probe alone. It verifies its own error
detection with a canary before reporting, so a clean result means something.

## Hard rules

1. **`loader/*.js` is plain JavaScript with `node:*` builtins only.** No
   TypeScript syntax, no dependencies, no Bun APIs, no imports from `src/`.
   These files are loaded raw by opencode; there is no build step.
2. **A plugin module exports `{ id, server }`, never `{ id, setup }`.** The
   wrong shape is silently rejected. See the `ocm-contract` skill.
3. **Nothing reloads in-session.** There is no reload API. Every message about
   an install says "restart opencode to activate".
4. **Never touch a file ocm does not own.** Ownership is provable —
   see the `ocm-invariants` skill. A user's hand-written command must survive
   every operation including `ocm remove`.
5. **Never write under `~/.claude`, `.claude`, `~/.agents` or `.agents`.**
   Those belong to other tools.
6. **No new runtime dependencies.** devDependencies only.
7. **Do not invent scope.** If no spec asked for it, it does not get built.

## Skills

Five project skills carry the knowledge that is not in the code:

| Skill | Load it when |
|---|---|
| `ocm-code-style` | writing any code — carries the size budgets |
| `ocm-contract` | touching the loader, the materializer, or any config write |
| `ocm-architecture` | deciding which file a change belongs in |
| `ocm-invariants` | before calling any file-writing change done |
| `ocm-test-harness` | writing anything under `test/` |

Commit messages: imperative subject, prose body explaining *why*, no trailers
of any kind. `git log` is the reference.

Read the relevant one. Do not reconstruct these facts from memory — several of
them contradict opencode's own documentation, and the `ocm-contract` skill
records which was verified by probe and against which opencode version.

## Style

Match the code around you. Comments are rare and explain a non-obvious *why*,
never restate the code. Error messages name the thing and the next action:

```
error: plugin "adw" is already provided by marketplace "wntic-adw"
  not adding "other-mp"; remove one, or ask its author to rename
```

Warnings to stderr, data to stdout. Multi-item operations report per item and
never abort the whole run on one item's failure.

## Toolchain note

`scripts/check.sh` resolves bun even when it is not on `PATH` — bun's
installer writes its export to `.zshrc`, which non-interactive shells do not
source, so a tool call from an agent may not see it. Run the scripts rather
than `bun test` directly and this never bites you.
