---
description: Ask the real opencode binary what it currently sees, and explain it
---

Here is what opencode actually resolves from a scratch config directory:

!`./scripts/oc-probe.sh 2>&1`

Explain what this shows: which commands, agents and skills opencode found,
whether any plugin failed to load, and whether that matches what the current
state of the repository should produce.

If anything is wrong, name the file responsible and the rule from the
`ocm-contract` skill that it violates. Do not change any files — this is a
read-only diagnosis.
