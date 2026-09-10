# 00 — Verified opencode contract

Reference spec. Everything every other spec is allowed to assume about
opencode, with how it was checked. No implementation work of its own beyond
the test harness.

Verified against **opencode 1.18.20** (installed via homebrew) and the source
at `github.com/anomalyco/opencode` @ `d6855b6` (2026-09-08). Two
implementations live in that repo simultaneously: `packages/opencode/src` is
the shipping v1 path, `packages/core/src` is an in-flight v2 rewrite. **The
facts below are from the v1 path unless marked**, because that is what 1.18.20
executes. Where v2 already differs, it is called out — treat those as change
risk, not as current behaviour.

Two verification methods are used below:

- **source** — read in the cloned repo at the cited path.
- **probe** — observed on the installed binary by pointing
  `OPENCODE_CONFIG_DIR` at a scratch config directory and running
  `opencode debug skill` / `opencode debug config --print-logs`. Probes are
  reproducible; keep them as the regression check when opencode upgrades.

## Discovery paths and naming

| Item | Where opencode looks | Name comes from | Verified |
|---|---|---|---|
| command | `{command,commands}/**/*.md` under each config directory | relative file path minus the `command(s)/` prefix and `.md` | source `packages/opencode/src/config/command.ts:15`; probe |
| agent | `{agent,agents}/**/*.md`, plus `{mode,modes}/*.md` (those become `mode: primary`) | same rule | source `packages/opencode/src/config/agent.ts:13,36` |
| skill | `{skill,skills}/**/SKILL.md` under each config directory; `**/SKILL.md` under every `skills.paths` entry | **frontmatter `name`** — the directory name is ignored | source `packages/opencode/src/skill/index.ts:23,172-220`; probe |
| js plugin | `{plugin,plugins}/*.{ts,js}` under each config directory | n/a | source `packages/opencode/src/config/plugin.ts:23`; probe |
| tui plugin | only the `plugin` array in `tui.json` — **no directory discovery** | n/a | source `packages/opencode/src/config/tui.ts:176-210` |

Config directories, in the order opencode walks them
(`packages/opencode/src/config/paths.ts`, `ConfigPaths.directories`):

1. `~/.config/opencode` (global)
2. every `.opencode` directory found walking up from cwd to the worktree root
3. `~/.opencode`
4. `$OPENCODE_CONFIG_DIR`, if set

All globs run with `symlink: true` / `follow: true` and `dot: true`. **Symlinked
files and symlinked directories are followed** — this is what makes ocm's
link-based install legal, and it is verified by probe (skills resolved through
`~/.cache/ocm/links/<mp>/skills/<plugin>` are discovered normally).

Skills are additionally scanned from `~/.claude/skills/**/SKILL.md`,
`~/.agents/skills/**/SKILL.md`, and any `.claude` / `.agents` directory found
walking up from cwd. Gated by `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1` and
`OPENCODE_DISABLE_EXTERNAL_SKILLS=1` (source
`packages/opencode/src/skill/index.ts:186-200`). **ocm never writes into
those paths** — see [04](specs/04-precedence.md).

### Namespacing consequences

Because commands and agents are named from their *path*, a symlink named
differently from its target renames the item at zero cost:
`~/.config/opencode/commands/adw:commit.md → …/plugins/adw/commands/commit.md`
registers as `/adw:commit`. Verified by probe (a file literally named
`probe:cmd.md` appeared in the resolved config as command `probe:cmd`).

Nested directories are an equally valid namespace: `commands/adw/commit.md`
registers as `adw/commit`. ocm keeps the flat `plugin:item` form for
continuity with the existing install base and with Claude Code's convention.

Because skills are named from *frontmatter*, renaming the directory does
nothing. Probe: a skill in folder `folder-name/` declaring
`name: myplugin-different-name` registered under the frontmatter name. The
skill name accepts `:`, `/` and `.` — probe registered `adw:python-style`,
`adw/python-style` and `adw.python-style` all three. So exact Claude Code
parity (`adw:python-style`) is achievable, but only by rewriting the
frontmatter. See [03](specs/03-materializer.md).

opencode's own built-in `customize-opencode` skill claims a skill's `name`
"matches the folder name". That claim is false in 1.18.20 —
`SkillNameMismatchError` is declared at `skill/index.ts:67` and never thrown.
Do not design around the doc; design around the probe.

## Plugin module contract

A path plugin's default export must be an object with **`server(input)`** (a
server plugin) or **`tui(api, options, meta)`** (a TUI plugin), never both, and
a path plugin must export `id`
(`packages/opencode/src/plugin/shared.ts:272-320`,
`resolvePluginId`). A module that default-exports a bare function, or exports
functions under any named export, is also accepted as a legacy server plugin
(`plugin/index.ts:99-125`).

Probe results on 1.18.20:

| Module shape | Result |
|---|---|
| `export default { id, server: async (input) => ({}) }` | runs |
| `export const Anything = async (input) => ({})` | runs (legacy path) |
| `export default { id, setup: async (ctx) => ({}) }` | **does not run**; logs `must default export an object with server()` |
| a library module with no function exports, sitting in `plugins/` | **error every start**; logs `Plugin export is not a function` |

`PluginInput` is exactly
`{ client, project, worktree, directory, experimental_workspace, serverUrl, $ }`
(probe printed the key list; matches `@opencode-ai/plugin` `dist/index.d.ts:36`).
**There is no `command.reload()` or `agent.reload()`.** Nothing a server plugin
does can make a newly linked command, agent or skill visible in the session
that is already running.

### Load order

Server plugin specs are accumulated in this order
(`packages/opencode/src/config/config.ts:344-362,470-480`):

1. `plugin` arrays from config files — global first, then project
2. then, per config directory in the order above, every file matched by
   `{plugin,plugins}/*.{ts,js}`

Directory matches come from `glob`, which does **not** sort. Probe on a real
machine returned `ocm-ui, rtk, ocm-core, rainbow-spinner, env-guard, sound,
ocm-loader` — neither alphabetical nor creation order. `setup` is then applied
sequentially in list order and hooks fire in registration order
(`plugin/index.ts:219-232`), so ordering *between* two directory-discovered
plugins is unspecified in practice. **A plugin that must run before others has
to be declared in the config `plugin` array, not dropped in the directory.**

`OPENCODE_PURE=1` skips all external plugins, server and TUI alike.

## Config write hazards

- Config is loaded once at startup and never hot-reloaded.
- Unknown top-level keys in `opencode.json` are rejected outright
  (`ConfigInvalidError`), and opencode refuses to start on an invalid config.
  Anything ocm writes into `opencode.json` must validate against
  <https://opencode.ai/config.json>.
- `skills` is the object form `{ paths: [...], urls: [...] }` in the v1 schema
  ocm targets — verified live, since the user's existing `skills.paths` entry
  loads. The v2 rewrite changes `skills` to a flat `string[]`
  (`packages/core/src/config.ts:88`) and migrates v1 documents on read
  (`ConfigMigrateV1`). ocm writes the v1 object form and must keep a
  migration-detection test.
- Frontmatter is parsed by `gray-matter` with a permissive retry that converts
  unquoted-colon values into block scalars
  (`packages/core/src/config/markdown.ts:20-35`). Probe: a command carrying
  `argument-hint`, `allowed-tools: Bash(git status:*)` and a deliberately
  mis-indented YAML list all loaded without error, and a skill carrying
  `allowed-tools`, a multi-line `arguments:` list and `disable-model-invocation`
  registered normally. A fatal `ConfigFrontmatterError` path does exist
  (`packages/opencode/src/cli/error.ts:92`), so treat graceful degradation as
  observed-not-guaranteed: [12](specs/12-validate-doctor.md) lints for it rather
  than relying on it.

## TUI plugin API

`tui.json` (`~/.config/opencode/tui.json`, `.opencode/tui.json`) carries a
`plugin` array of npm specs or path specs; path specs resolve relative to the
declaring file (`packages/opencode/src/config/tui.ts:88-96`). Global merges
first, project last.

`TuiPluginApi` (`@opencode-ai/plugin/dist/tui.d.ts:459-505`) provides, among
others:

- `ui.DialogSelect` / `DialogAlert` / `DialogConfirm` / `DialogPrompt`,
  `ui.dialog` (a stack), `ui.toast`
- `keymap.registerLayer({ commands, bindings })` — a command with
  `slash: { name: "ocm" }` appears in `/` autocomplete
- `client` — the full `OpencodeClient` SDK against the running server
- `plugins.list() / activate() / deactivate() / add() / install()`
- `kv`, `state`, `lifecycle.onDispose`, `event`

The `plugins.*` surface and `client` are new information relative to the old
spec set and are what make in-dialog mutation viable
([10b](specs/10b-tui-dialog.md)).

## Corrections to the previous spec set

The superseded specs asserted the following, all of which are false:

1. *"Commands/agents are reloadable in-session via `ctx.command.reload()`."*
   No such API exists; nothing reloads in-session.
2. *"`loader/ocm-core.js` is the single implementation, used by both the CLI
   and the startup loader."* The loader has never executed — `{id, setup}` is
   not a recognised module shape — and `ocm-core.js` itself errors on every
   start because it sits in an auto-loaded plugin directory.
3. *"opencode requires the skill name to match its folder name."* It does not;
   the folder name is ignored.
4. *"The global `~/.config/opencode/plugins/` auto-discovery does not feed the
   TUI host."* Correct — but the converse matters more and was missed: it
   **does** feed the server host, so `ocm-ui.js` (a `tui`-only module) throws
   there on every start.
5. *"Discovery/link order is deterministic."* Directory plugin order is
   filesystem order.

## Testing harness

Shared across every spec. `test/harness.mjs` provides:

- `withFakeHome(fn)` — runs `fn` with `$HOME` pointed at a fresh temp dir.
  Path constants are read at module load, so the harness re-imports the core
  with a cache-busting query string per test.
- `fixtureMarketplace(dir, spec)` — writes a marketplace tree from a compact
  object (plugins, components, manifests, renames, mcp, js plugins).
- `gitRepo(dir, commits)` — `git init` plus scripted commits, for
  pull/revision/rename/pin tests.
- `opencodeProbe(configDir)` — optional, skipped when `opencode` is not on
  PATH: runs `opencode debug config --print-logs` and
  `opencode debug skill` against a scratch `OPENCODE_CONFIG_DIR` and returns
  the resolved command/agent/skill names plus any plugin-load errors. This is
  the contract test for everything in this document; it is what catches an
  opencode upgrade breaking us.
- Assertions for link existence and target, registry content, `opencode.json`
  content, and stdout lines.

Invariants every phase's tests must include:

1. **Config safety.** An `opencode.json` with arbitrary user keys survives
   every ocm write byte-identically outside the keys ocm owns.
2. **Idempotence.** Any ocm operation run twice is a no-op the second time —
   no spurious "created" counts, no registry churn.
3. **Ownership.** Files and symlinks in target directories that ocm does not
   own are never modified or removed.
4. **No plugin-load errors.** `opencodeProbe` reports zero
   `failed to load plugin` lines attributable to ocm-installed files.
