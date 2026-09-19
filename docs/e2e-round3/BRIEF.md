# Round-3 e2e execution brief (for test agents)

You are executing part of `docs/e2e-test-plan-round3.md` against the real
`ocm` binary and the real `opencode` binary. You are a tester: **report,
never fix**. Read this brief fully before running anything.

## Hard rules

1. **Never run `bun test`** — directory traversal hangs this repo. Never
   `npm install -g` / `bun install -g` — the global `ocm` is already a
   symlink to this repo's HEAD (v0.5.0) and must stay that way.
2. **Never run `ocm` or `opencode` with the real HOME.** Always
   `HOME=$H ocm …` / `HOME=$H opencode …` with your own scratch home.
3. **Run `opencode` from a neutral cwd** (e.g. `cd $H && HOME=$H opencode …`),
   never from inside the ocm repo — the repo's own `.opencode/` project
   config would pollute the results.
4. **Write nothing into the repo** except your transcript file
   `docs/e2e-round3/<your-id>.md`. Do not touch `src/`, `loader/`, `test/`,
   `bin/`, `template/`, or any spec.
5. **Shared fixtures are read-only.** If a step needs an upstream change,
   copy first, then mutate the copy:
   `cp -R /tmp/ocm-e2e3/repos/exec-src /tmp/ocm-e2e3/repos/<id>-exec-src`
   and add via `file:///tmp/ocm-e2e3/repos/<id>-exec-src`. Same for local
   fixtures (`cp -R` to your own path before editing). Never commit to the
   shared `*-src` repos.
6. `expect` is at `/usr/bin/expect`, `script` at `/usr/bin/script`, `jq`
   available. `git` 2.50, `bun` 1.4.2, opencode 1.18.31, ocm 0.5.0.

## Environment

- Scratch area: `/tmp/ocm-e2e3`. Homes:
  `H=/tmp/ocm-e2e3/home-<id>-NN`; make a fresh one whenever the plan says
  "fresh home" / "newhome". **Use your own capture files** under
  `/tmp/ocm-e2e3/logs/<id>/` — the shared `out.txt`/`err.txt` names race
  between concurrent agents.
- Registry: `$H/.config/opencode/ocm/registry.json`. Cache:
  `$H/.cache/ocm/` (clones under `marketplaces/`, skill mirrors under
  `links/<mp>/skills/<plugin>--<skill>`, displaced originals under
  `displaced/` + `displaced-records.json`). opencode config:
  `$H/.config/opencode/` (`opencode.json`, `tui.json`, `commands/`,
  `agents/`, `plugins/`, `ocm/`). opencode log:
  `$H/.local/share/opencode/log/opencode.log`.
- Commands/agents link as `<plugin>:<name>.md` in
  `$H/.config/opencode/{commands,agents}/`. MCP servers appear as
  `ocm--<mp>--<plugin>` keys in `opencode.json`'s `mcp`. Plugin JS links
  land in `$H/.config/opencode/plugins/` as `ocm--…`.
- `opencode debug config` (HOME set, neutral cwd) exposes `.command`
  (keys `plugin:name`), `.agent`, `.skills.paths`, `.plugin`, `.mcp`.

## Fixtures (pre-built)

| id | where | name | contents |
|---|---|---|---|
| MP-A | `file:///tmp/ocm-e2e3/repos/alpha-src` | `ocm-e2e3-alpha` | code-free; `greet-kit` (command `greet`, agent `greeter`, skill `greeting`), `tip-kit` (skill `tips`); tag `v1.0.0` |
| MP-B | `file:///tmp/ocm-e2e3/repos/exec-src` | `ocm-e2e3-exec` | plugin `notify`: `plugin/notify.js` + `mcp.json` (server `everything`); tag `v1.0.0` |
| MP-D | `file:///tmp/ocm-e2e3/repos/big-src` | `ocm-e2e3-big` | 10 code-free plugins `big-01`…`big-10`, rich `extensions.dev.wntic.ocm` manifests, distinct categories/tags; tag `v1.0.0` |
| MP-F | `file:///tmp/ocm-e2e3/repos/collide-src` | `ocm-e2e3-collide` | ships `big-03` + `big-07` (names collide with MP-D), code-free |
| MP-C | `/tmp/ocm-e2e3/fixtures/local-mp` (local dir) | `demo-marketplace` (its marketplace.json) | copy of repo `template/`: `demo-kit` (command `tdd`, agent `reviewer`, skill `code-review`, `plugin/notify.js`, `mcp.json`), `release-kit` |
| MP-G | `/tmp/ocm-e2e3/fixtures/nomanifest-mp` (local) | `nomanifest-mp` | plugins `nm-one`, `nm-two`, **no** `plugin.json` |
| MP-H | `/tmp/ocm-e2e3/fixtures/legacy-mp` (local) | `legacy-mp` | plugin `legacy-tool` (command `old`), **no** `plugin.json` |
| MP-E | `/tmp/ocm-e2e3/fixtures/broken/<case>` (local) | per case | validate defect matrix: `dup-plugins`, `basename-clash`, `containment`, `bad-plugin-json`, `bad-marketplace-json`, `empty-desc`, `name-mismatch` |
| — | `/tmp/ocm-e2e3/fixtures/local mp` (local) | `space-mp` | one plugin, path contains a space |
| — | `/tmp/ocm-e2e3/fixtures/unicode-mp` (local) | `unicode-mp` | unicode descriptions/skill bodies |

"Upstream change" for a git marketplace = edit + commit in (your copy of)
the source repo, then `ocm update`. For a local marketplace = edit the
(local copy of the) directory, then `ocm update`.

## Capture discipline

Use for **every** exit-code and stream assertion:

```bash
OCM_T=/tmp/ocm-e2e3
run() { echo "\$ $*"; "$@" >$OCM_T/logs/out.txt 2>$OCM_T/logs/err.txt; echo "exit=$?";
        echo "--stdout--"; cat $OCM_T/logs/out.txt; echo "--stderr--"; cat $OCM_T/logs/err.txt; }
run env HOME=$H ocm list --all
```

TTY-only behaviour (prompts, Ctrl+C/SIGINT, colour, combined stream):

```bash
expect -c 'set timeout 30
spawn env HOME=/tmp/... ocm add file:///tmp/ocm-e2e3/repos/exec-src
expect "trust this marketplace"
send "y\r"
expect eof'
# SIGINT instead of answering:  send "\x03"
# combined-stream tty capture:  script -q /tmp/ocm-e2e3/logs/tty.txt env HOME=$H ocm add …
```

Non-interactive prompts default to N (safe). To run updates
non-interactively: `HOME=$H ocm update </dev/null`.

The loader's startup sync runs when opencode starts. NOTE: `opencode debug
config` does NOT trigger it (it does not load server plugins); to force a
sync, start a headless TUI session under expect (spawn, wait ~5–10 s, send
Ctrl+C) or run `opencode run` briefly, with `OCM_SYNC_INTERVAL_MS=0`.

## Judging

After every step ask (from the plan): did it tell me what happened · did
it do what I expected · if it failed, do I know what to do next.

Additionally, throughout — **formatting / information-exposure lens**: flag
anywhere the user sees what they shouldn't: stack traces, debug JSON,
raw node errors, internal jargon, success lines on stderr, warnings on
stdout, colour on non-tty output, unreadable line wrapping. Exit codes:
0 only on success; 1 on refusal/error; 130 on SIGINT.

Be skeptical: verify on disk (registry JSON, symlinks, `opencode debug
config`), not just CLI output. Quote verbatim.

End every suite with the plan's cross-cutting invariants block:

```bash
# 1. never writes outside its own namespaces
ls -la $H/.claude $H/.agents 2>&1 | grep -v "No such file" && echo "VIOLATION"
# 2. only ocm-loader.js in plugins/ (plus ocm-- links)
ls $H/.config/opencode/plugins
# 3. no broken symlinks anywhere ocm owns
find $H/.config/opencode/{commands,agents,plugins} -type l ! -exec test -e {} \; -print
# 4. configs parse
for f in opencode.json tui.json; do jq . $H/.config/opencode/$f >/dev/null || echo "BAD $f"; done
# 5. doctor agrees
HOME=$H ocm doctor; echo "doctor exit=$?"
```

(User-key survival: compare `opencode.json` user keys you seeded against
what remains.)

## Deliverables

1. **Transcript** — append to `docs/e2e-round3/<your-id>.md` as you go:
   every command, both streams, exit code, and what you concluded.
2. **Final message** — return to the orchestrator:
   - per-step verdicts (`step → pass/fail/partial`, one line each);
   - every defect as:

     ```
     ## <id> — <one-line title> (area: CLI|TUI|loader|docs, severity: high|med|low)
     Test:     <plan step id>
     Command:  <exact command>
     Expected: <plan text / spec section>
     Actual:   <verbatim output, both streams, exit code>
     Impact:   <what a real user concludes>
     ```

   - if your suites verify round-2 findings (Part A): a closure verdict
     per finding id — **closed / still open / new defect**;
   - anything you could not test without a live human at a terminal
     (TUI, autocomplete pickers) — list it explicitly as "needs user".
