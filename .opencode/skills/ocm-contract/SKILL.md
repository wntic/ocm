---
name: ocm-contract
description: The verified facts about how opencode loads plugins, commands, agents and skills, and the six mistakes that look correct but break at runtime. Use ONLY when writing or reviewing code in loader/, src/loader.ts, src/install.ts, the materializer, or anything that writes opencode.json or tui.json — that is, whenever the change depends on what opencode actually does at startup.
---

# The opencode contract

Verified against opencode **1.18.20** and source `anomalyco/opencode@d6855b6`.
Full detail with citations: `docs/specs/00-contract.md`. Never contradict this
file from memory or from opencode's own documentation — where the docs and a
probe disagree, the probe is right.

## Six things that look correct and are wrong

1. **A plugin module is `{ id, server }`, never `{ id, setup }`.**
   `setup` is silently rejected: the plugin never runs and opencode logs
   `must default export an object with server()`. This is the bug that made
   ocm's auto-sync inert for its whole life.

2. **There is no reload API.** `PluginInput` is exactly
   `{ client, project, worktree, directory, experimental_workspace, serverUrl, $ }`.
   No `command.reload()`, no `agent.reload()`. Nothing a server plugin does
   can make a new command, agent or skill visible in the running session.
   Every message about an install must say **"restart opencode to activate"**.

3. **A skill's name comes from its frontmatter, not its folder.** Renaming a
   skill directory changes nothing. Namespacing a skill therefore requires
   rewriting the `name:` line — which is why skills are rendered, not
   symlinked. `:` is legal in a skill name (`adw:python-style` works).

4. **Only `ocm-loader.js` may live in `~/.config/opencode/plugins/`.**
   opencode globs `{plugin,plugins}/*.{ts,js}` there and tries to load every
   match as a server plugin. A library module (`core.js`) or a TUI module
   (`ui.js`) placed there produces an error line on every single start. They
   belong in `~/.config/opencode/ocm/`, which no opencode glob touches.

5. **Plugin load order is filesystem order.** Not alphabetical, not creation
   order. A filename prefix like `00-` buys nothing. Only an entry in a
   config `plugin` array orders reliably, and ocm does not write there.

6. **opencode refuses to start on an invalid config.** Unknown top-level keys
   in `opencode.json` are rejected. A command `.md` whose frontmatter fails
   schema decoding throws. Anything this project writes into a config file
   must validate against <https://opencode.ai/config.json>.

## Where opencode looks

| Item | Glob, under each config directory | Name derived from |
|---|---|---|
| command | `{command,commands}/**/*.md` | file path minus prefix and `.md` |
| agent | `{agent,agents}/**/*.md`, `{mode,modes}/*.md` | same |
| skill | `{skill,skills}/**/SKILL.md`, plus `**/SKILL.md` under every `skills.paths` entry | **frontmatter `name`** |
| server plugin | `{plugin,plugins}/*.{ts,js}` | n/a |
| tui plugin | the `plugin` array in `tui.json` only — no directory discovery | n/a |

Config directories, lowest precedence first: `~/.config/opencode`, then each
`.opencode` walking up from cwd to the worktree root, then `~/.opencode`, then
`$OPENCODE_CONFIG_DIR`. Later wins. **All globs follow symlinks** — this is
what makes link-based install legal.

Skills are additionally read from `~/.claude/skills`, `~/.agents/skills` and
`.claude` / `.agents` directories walking up. **ocm never writes to any of
those paths.**

## Valid frontmatter

Command: `description`, `agent`, `model`, `variant`, `subtask`. The body is
the template and is required. `$ARGUMENTS`, `$1`…, `!` shell blocks and `@`
file references are substituted.

Agent: `model`, `variant`, `temperature`, `top_p`, `prompt`, `disable`,
`description`, `mode` (`primary` | `subagent` | `all`), `hidden`, `options`,
`color`, `steps`, `permission`. Unknown keys are silently routed into
`options` — a typo does not error, it disappears.

Skill: `name` and `description` required; `license`, `compatibility`,
`metadata` optional. Everything else is non-portable.

## How to check a claim

Do not guess and do not trust memory. Run the probe:

```
./scripts/oc-probe.sh
```

It builds a scratch config directory, runs opencode against it, and prints the
resolved commands, agents, skills and any plugin-load errors. If a change is
supposed to make opencode see something, the probe is the proof.
