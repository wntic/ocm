---
name: code-review
description: Structured checklist for reviewing pull requests
license: MIT
compatibility: opencode
---

## What I do

Guide a structured code review using this checklist:

1. Tests — are new behaviors covered?
2. Errors — are failures handled explicitly?
3. Contracts — do types and APIs match usage?
4. Performance — any obvious N+1 or unbounded work?
5. Docs — are public interfaces documented?

## When to use me

Use when reviewing a PR, a diff, or freshly written code.
Produce findings as `file:line — severity — suggestion`.
