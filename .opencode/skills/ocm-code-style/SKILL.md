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

These are limits, not targets. Crossing one is a signal to stop and reconsider,
not a rule to route around.

| Thing | Budget | If you exceed it |
|---|---|---|
| a function | 40 lines | split it, or admit it is doing two jobs |
| a source file | 200 lines | it is probably two modules |
| a test file | 250 lines | the spec asked for fewer tests than you wrote |
| a test helper module | 150 lines | you are building a framework; stop |
| exported helpers in one module | 8 | most of them have one caller |

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
