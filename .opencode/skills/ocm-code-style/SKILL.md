---
name: ocm-code-style
description: How to write JavaScript and TypeScript in this repository — the size budgets that stop over-engineering, when an abstraction is allowed, and the conventions for errors, options and dependencies. Use before writing or reviewing any code in src/, loader/, bin/ or test/, and whenever a file is growing past its budget.
---

# Writing code in ocm

This repository is a small CLI with **zero runtime dependencies**. The most
common failure here is not a bug — it is building far more than the task
needed. A 650-line test harness and a 400-line test file for a seven-item test
list have already happened once. This skill exists to stop that.

## Size budgets

These catch **over-engineering while you write**, which is this repository's
most common failure. They are smells, not gates: crossing one means stop and
say why in your report, not split a file to satisfy a number. None of them
comes from a JavaScript or TypeScript standard — there isn't one; they come
from what went wrong here before.

| Thing | Budget | If you exceed it |
|---|---|---|
| a function | 40 lines | split it, or admit it is doing two jobs |
| a source file | 300 lines | ask whether it is two concerns — if it is one, say so and move on |
| one test | 50 lines | it is asserting two behaviours, or its fixture belongs in a helper |
| a test helper module | 175 lines | you are building a framework; stop |
| exported helpers in one module | 8 | most of them have one caller |

**Test files have no line budget.** Since the suite was reorganised by
behaviour, one file holds every test for an area — `manifests.test.mjs`
carries four briefs' worth — so its length says nothing about whether anyone
over-built. The budget that bites there is the per-test one: a test over ~50
lines is usually asserting two things and will fail for a third reason.

The two that catch real damage are the **function** budget and the **export**
count: a 90-line function is doing two jobs, and a ninth export is usually a
helper with one caller. A file that is long because it holds many small
functions of one concern is not a defect — `src/commands/doctor.ts` is an
orchestrator plus nine `check*` functions, and splitting it further would
produce a module named after nothing.

A budget is never a reason to churn code that already shipped. It applies to
what you are writing now.

Before writing a helper, count its call sites in the code you are about to
write. **One call site is not a helper, it is a detour.** Inline it.

## When an abstraction is allowed

Three real call sites, existing right now, in code that is already written. Not
two. Not "we will need it for spec 06". A parameter added for a future caller
is dead weight the next reader has to understand.

Three similar lines beat one clever helper. If two blocks differ by a single
value, pass the value; if they differ by two or more, leave them apart.

## Options objects

An options object with one field is a positional argument wearing a costume.
Add the object when a function genuinely has three or more independent knobs
*and more than one caller sets them differently*.

Never add an option whose only purpose is to make a function testable — that is
a sign the function is doing too much.

## Errors

Throw `Error` with a message naming the thing and the next action. No custom
error classes: this codebase has no `catch` that discriminates on error type,
so a class hierarchy is pure ceremony.

```js
throw new Error(`marketplace "${name}" not found (ocm list)`)
```

## The two runtimes

**`loader/*.js`** — plain JavaScript, `node:*` builtins only, no TypeScript
syntax, no Bun APIs, no imports from `src/`. opencode loads these raw.

**`src/*.ts`** — TypeScript, Bun APIs fine. It imports *from* `loader/core.js`
rather than reimplementing it.

Types in `src/` describe data that exists. Do not add a generic parameter, a
mapped type or a conditional type unless a concrete second case already uses
it. `unknown` plus a narrow check beats an elaborate type that encodes a
guess.

## Dependencies

None. Not for argument parsing, not for YAML, not for JSON Schema validation,
not for colours. If a task seems to need one, it needs twenty lines of plain
code instead, and the spec usually says so.

## Comments

Rare. A comment earns its place by explaining a non-obvious *why* — a
workaround, a verified constraint, a decision that looks wrong and is not.
Never restate what the line does. Never write a banner comment over a
three-line function.

## When you are unsure

Write the smallest thing that makes the test pass, and stop. The reviewer can
ask for more; nobody has ever asked for less and got it cheaply.
