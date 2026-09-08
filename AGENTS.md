# ocm

A file-based plugin marketplace for opencode: skills, agents and commands
distributed as git repositories, installed once and available in every
project. Bun + TypeScript, no runtime dependencies.

## How work happens here

Implementation is driven by the specs in `docs/specs/`, one at a time, in the
order given by `docs/specs/README.md`. **The spec is the source of truth.** If
the code and the spec disagree, the code is wrong. If two specs disagree, stop
and say so — do not pick a side.

One command per spec:

```
/ocm:spec 01
```

That dispatches the whole cycle — tests, implementation, gate, review — and
loops the implementer on a failure up to three times. Use `/ocm:status` to see
where you are and `/ocm:probe` to ask the real opencode binary what it sees.

If you want to drive a step by hand, `/ocm:tests NN`, `/ocm:implement NN` and
`/ocm:check NN` each run one stage on their own.

Tests are written before the implementation, by a different agent, and the
implementer is not permitted to edit `test/`. That separation is the point: a
test the implementer can change is not a check.

**Write the smallest thing that passes.** The failure mode here is not bad
syntax, it is building far more than the spec asked for. Size budgets live in
the `ocm-code-style` skill and the evaluator enforces them.

## Two traps specific to this repo

**Never run bare `bun test`.** Directory traversal hangs indefinitely here;
`./scripts/check.sh` passes explicit file paths and is the command to use.

**Nothing expensive at module scope in a test file.** Module bodies run during
discovery, outside any timeout, with no output — a probe call there looks like
a hang.

## The gate

```
./scripts/check.sh
```

Typecheck, tests, and a probe that asks the real opencode binary what it sees.
Nothing is done until this exits 0. **It is red right now** — `ocm-loader.js`
cannot import its core, which is exactly what spec 01 fixes.

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

Four project skills carry the knowledge that is not in the code:

| Skill | Load it when |
|---|---|
| `ocm-code-style` | writing any code — carries the size budgets |
| `ocm-contract` | touching the loader, the materializer, or any config write |
| `ocm-architecture` | deciding which file a change belongs in |
| `ocm-invariants` | before calling any file-writing change done |
| `ocm-test-harness` | writing anything under `test/` |

Read the relevant one. Do not reconstruct these facts from memory — several of
them contradict opencode's own documentation, and the specs record which was
verified by probe.

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
