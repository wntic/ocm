// Phase 11 — docs/specs/11-cross-tool.md: one test per numbered item, plus
// the four invariants (ownership in 1, idempotence in 2, config safety in 3,
// no plugin errors in 5). Two surfaces the spec requires do not exist yet,
// and these tests are the contract for them:
// - the installed loader's server() registers opencode's "shell.env" hook,
//   in opencode's documented shape: async (input, output) => {
//   output.env.VAR = value } (opencode.ai/docs/plugins, "Inject environment
//   variables")
// - loader/core.js exports lintCrossTool(marketplaceDir) returning string[]
//   warnings in the spec 12 finding format. Spec 11's Phasing table puts
//   "the frontmatter-subset lint" in phase 1 while its gate "ships with 12":
//   the `ocm validate` command is spec 12's deliverable, the lint function
//   it will render is this phase's.
import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, assertFileExists, opencodeProbe, withFakeHome } from "./harness.mjs"

const OCM_BIN = fileURLToPath(new URL("../bin/ocm.ts", import.meta.url))
const CORE_MODULE = fileURLToPath(new URL("../loader/core.js", import.meta.url))

function ocm(home, ...args) {
  const result = spawnSync(process.execPath, [OCM_BIN, ...args], {
    env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 120_000,
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

const phase = (name, body, timeout = 120_000) => test(name, () => withFakeHome(body), timeout)

function writeTree(dir, tree) {
  mkdirSync(dir, { recursive: true })
  for (const [name, value] of Object.entries(tree)) {
    if (typeof value === "string") writeFileSync(join(dir, name), value)
    else writeTree(join(dir, name), value)
  }
}

function git(dir, args) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: 120_000 })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${result.stderr}`)
}
function gitRepo(dir, tree) {
  writeTree(dir, tree)
  git(dir, ["init", "-b", "main"])
  git(dir, ["add", "-A"])
  git(dir, ["-c", "user.email=ocm@test", "-c", "user.name=ocm", "commit", "-m", "fixture"])
}

const cfg = (home) => join(home, ".config", "opencode")
const registryFile = (home) => join(cfg(home), "ocm", "registry.json")
const readRegistry = (home) => JSON.parse(readFileSync(registryFile(home), "utf8"))
const mpRoot = (home, name) => join(home, ".cache", "ocm", "marketplaces", name)

// realpath on both sides: macOS temp dirs sit behind /var -> /private/var
function assertResolves(dest, source) {
  if (!existsSync(dest) || !lstatSync(dest).isSymbolicLink()) throw new Error(`expected a symlink at ${dest}`)
  expect(realpathSync(dest)).toBe(realpathSync(source))
}
function isSamePath(a, b) {
  if (typeof a !== "string") return false
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

// The modules under test run in spawned children on the fake $HOME — loader
// modules compute their path constants at module load. The hook runner loads
// the INSTALLED loader, the surface opencode actually starts; sync is
// disabled so the child only answers the hook question.
const HOOK_RUNNER = `
const [loaderPath] = process.argv.slice(2)
const mod = await import(loaderPath)
const hooks = await mod.default.server()
const hook = hooks && hooks["shell.env"]
if (typeof hook !== "function") {
  throw new Error("the installed loader registers no shell.env hook (spec 11); server() returned hooks: " + JSON.stringify(Object.keys(hooks || {})))
}
const output = { env: {} }
await hook({}, output)
process.stdout.write(JSON.stringify(output.env))
`
function hookEnv(home) {
  const runner = join(home, "hook-runner.mjs")
  writeFileSync(runner, HOOK_RUNNER)
  const result = spawnSync(process.execPath, [runner, join(cfg(home), "plugins", "ocm-loader.js")], {
    env: { ...process.env, HOME: home, OCM_SYNC_DISABLE: "1" }, encoding: "utf8", timeout: 120_000,
  })
  if (result.status !== 0) throw new Error(`shell.env hook probe exited ${result.status}: ${result.stderr}`)
  return JSON.parse(result.stdout)
}

const LINT_RUNNER = `
const [modulePath, dir] = process.argv.slice(2)
const mod = await import(modulePath)
if (typeof mod.lintCrossTool !== "function") {
  throw new Error("loader/core.js does not export lintCrossTool(marketplaceDir) returning warning strings (spec 11 phase 1: the frontmatter-subset lint; spec 12 renders it as the validate command)")
}
const warnings = await mod.lintCrossTool(dir)
if (!Array.isArray(warnings)) {
  throw new Error("lintCrossTool must return an array of warning strings, got: " + typeof warnings)
}
process.stdout.write(JSON.stringify(warnings))
`
function runLint(home, dir) {
  const runner = join(home, "lint-runner.mjs")
  writeFileSync(runner, LINT_RUNNER)
  const result = spawnSync(process.execPath, [runner, CORE_MODULE, dir], {
    env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 120_000,
  })
  if (result.status !== 0) throw new Error(`lintCrossTool exited ${result.status}: ${result.stderr}`)
  return JSON.parse(result.stdout)
}

const COMMAND = "---\ndescription: commit helper\n---\n\nCommit body.\n"
const AGENT = "---\ndescription: code reviewer\n---\n\nReviewer body.\n"
const SKILL = (name, extra = "") =>
  `---\nname: ${name}\ndescription: ${name} guidance\n${extra}---\n\n# ${name}\n\nBody.\n`
// frontmatter of the real wntic/agentic-development-workflow python-style
// skill: name, description and Claude's when_to_use, which opencode tolerates
const ADW_PYTHON_STYLE = `---
name: python-style
description: Cross-cutting Python style for every layer — typing conventions, logging, and comments.
when_to_use: Deciding an annotation form, a collection type, how or where to log, or whether a comment is warranted.
---

# Python Style

Use ruff. Prefer X | None over Optional[X].
`
// mirrors plugins/run-report/commands/run-report.md of the real repo, with
// the script path in the form that resolves under ocm: CLAUDE_PLUGIN_ROOT is
// the marketplace root, so the plugins/<name>/ segment is written out
const RUN_REPORT_CMD = `---
description: "Report on how a run went — which agents ran, where the time went, and every blocker"
argument-hint: "[session|latest|all] [--include-main]"
---

# /run-report [session]

Run the analyzer:

python3 "\${CLAUDE_PLUGIN_ROOT}/plugins/run-report/scripts/run_report.py" --cwd "$PWD" --session latest

Read the generated SUMMARY.md and relay the roster, the blockers, and what the run produced.
`

phase("1. discovery ignores commands.claude/ and agents.claude/; commands/ and agents/ are still discovered", async (home) => {
  // ownership invariant: a hand-written command predates every ocm run
  writeTree(join(cfg(home), "commands"), { "mine.md": "# my own command\n" })
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { adw: {
    commands: { "commit.md": COMMAND },
    "commands.claude": { "claude-only.md": COMMAND },
    "commands.codex": { "codex-only.md": COMMAND },
    agents: { "reviewer.md": AGENT },
    "agents.claude": { "claude-only.md": AGENT },
  } } })
  expect(ocm(home, "add", mp).status).toBe(0)
  const components = readRegistry(home).marketplaces.mp.plugins.adw.components
  expect(components.command).toEqual(["commit.md"])
  expect(components.agent).toEqual(["reviewer.md"])
  assertResolves(join(cfg(home), "commands", "adw:commit.md"), join(mp, "plugins", "adw", "commands", "commit.md"))
  assertResolves(join(cfg(home), "agents", "adw:reviewer.md"), join(mp, "plugins", "adw", "agents", "reviewer.md"))
  assertAbsent(join(cfg(home), "commands", "adw:claude-only.md"))
  assertAbsent(join(cfg(home), "commands", "adw:codex-only.md"))
  assertAbsent(join(cfg(home), "agents", "adw:claude-only.md"))
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
})

phase("2. a plugin with only commands.claude/ and skills/ installs its skill and reports zero commands, without error", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { adw: {
    "commands.claude": { "commit.md": COMMAND },
    skills: { "python-style": { "SKILL.md": SKILL("python-style") } },
  } } })
  const added = ocm(home, "add", mp)
  expect(added.status).toBe(0)
  expect(added.stdout).toContain("adw (1 skills)") // the report counts no commands
  const components = readRegistry(home).marketplaces.mp.plugins.adw.components
  expect(components.command).toBeUndefined()
  expect(components.skill).toEqual(["python-style"])
  const skillMd = join(home, ".cache", "ocm", "links", "mp", "skills", "adw--python-style", "SKILL.md")
  expect(readFileSync(skillMd, "utf8")).toContain('name: "adw:python-style"')
  assertAbsent(join(cfg(home), "commands", "adw:commit.md"))
  // invariant: idempotence — installing again rewrites nothing
  const bytes = readFileSync(registryFile(home), "utf8")
  const mtime = statSync(skillMd).mtimeMs
  expect(ocm(home, "install", "adw").status).toBe(0)
  expect(readFileSync(registryFile(home), "utf8")).toBe(bytes)
  expect(statSync(skillMd).mtimeMs).toBe(mtime)
})

phase("3. the shell.env hook exports OCM_PLUGIN_ROOT and CLAUDE_PLUGIN_ROOT at the marketplace root, for every added marketplace", async (home) => {
  // config-safety invariant: user keys predate every ocm write
  const userConfig = {
    model: "claude-sonnet-4-6",
    permission: { edit: "allow" },
    skills: { paths: ["/users/me/my-skills"] },
    mcp: { "user-server": { type: "local", command: ["echo"] } },
  }
  writeTree(cfg(home), { "opencode.json": `${JSON.stringify(userConfig, null, 2)}\n` })
  const repoA = join(home, "repo-a")
  gitRepo(repoA, { plugins: { alpha: {
    commands: { "work.md": COMMAND },
    skills: { "python-style": { "SKILL.md": SKILL("python-style") } },
  } } })
  const repoB = join(home, "repo-b")
  gitRepo(repoB, { plugins: { beta: { commands: { "lint.md": COMMAND } } } })
  expect(ocm(home, "add", `file://${repoA}`, "--name", "mp-a").status).toBe(0)
  // one marketplace added: the spec body's flat pair, both at its root
  const rootA = mpRoot(home, "mp-a")
  let env = hookEnv(home)
  for (const key of ["OCM_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT"]) {
    if (!isSamePath(env[key], rootA)) {
      throw new Error(`expected ${key}=${rootA} from the shell.env hook, got: ${JSON.stringify(env[key])}`)
    }
  }
  expect(ocm(home, "add", `file://${repoB}`, "--name", "mp-b").status).toBe(0)
  // The spec body names one flat pair; the test item adds "for every added
  // marketplace", which a single flat pair cannot satisfy when two are
  // added. With two, the test requires every marketplace root to be exported
  // under both variable families — however the implementation names them.
  env = hookEnv(home)
  const rootB = mpRoot(home, "mp-b")
  for (const root of [rootA, rootB]) {
    for (const prefix of ["OCM_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT"]) {
      const values = Object.entries(env).filter(([key]) => key.startsWith(prefix)).map(([, value]) => value)
      if (!values.some((value) => isSamePath(value, root))) {
        throw new Error(`expected a ${prefix}* variable pointing at ${root} from the shell.env hook, got: ${JSON.stringify(env)}`)
      }
    }
  }
  const after = JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8"))
  expect(after.model).toBe(userConfig.model)
  expect(after.permission).toEqual(userConfig.permission)
  expect(after.mcp).toEqual(userConfig.mcp)
  expect(after.skills.paths).toContain("/users/me/my-skills")
})

phase("4. the cross-tool lint warns on non-subset skill frontmatter, naming the field, and on a ${CLAUDE_PLUGIN_ROOT} reference missing the plugins/<name>/ segment", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { adw: {
    skills: {
      style: { "SKILL.md": SKILL("style", "allowed-tools: Bash\n") },
      clean: { "SKILL.md": SKILL("clean") },
    },
    commands: {
      "bad.md": "---\ndescription: bad reference\n---\n\npython3 \"${CLAUDE_PLUGIN_ROOT}/scripts/run_report.py\"\n",
      "good.md": "---\ndescription: good reference\n---\n\npython3 \"${CLAUDE_PLUGIN_ROOT}/plugins/adw/scripts/run_report.py\"\n",
    },
  } } })
  const warnings = runLint(home, mp)
  const nonSubset = warnings.find((warning) => warning.includes("allowed-tools"))
  if (!nonSubset) throw new Error(`expected a warning naming the non-subset field "allowed-tools", got: ${JSON.stringify(warnings)}`)
  expect(nonSubset).toContain("SKILL.md")
  const badRoot = warnings.find((warning) => warning.includes("CLAUDE_PLUGIN_ROOT"))
  if (!badRoot) throw new Error(`expected a warning about a ${"${CLAUDE_PLUGIN_ROOT}"} reference without plugins/<name>/, got: ${JSON.stringify(warnings)}`)
  expect(badRoot).toContain("bad.md")
  // the portable forms — subset frontmatter, reference with the segment — warn about nothing
  expect(warnings.some((warning) => warning.includes("clean") || warning.includes("good.md"))).toBe(false)
})

phase("5. round-trip on a wntic/agentic-development-workflow fixture: adw skills install as adw:<skill> and run-report resolves its script path", async (home) => {
  const repo = join(home, "agentic-development-workflow")
  const catalog = `${JSON.stringify({ name: "wntic-adw", plugins: [
    { name: "adw", source: "./plugins/adw" },
    { name: "run-report", source: "./plugins/run-report" },
  ] }, null, 2)}\n`
  gitRepo(repo, {
    "marketplace.json": catalog,
    ".claude-plugin": { "marketplace.json": catalog }, // the Claude-side manifest; ocm must ignore it
    plugins: {
      adw: {
        skills: {
          "python-style": { "SKILL.md": ADW_PYTHON_STYLE },
          architecture: { "SKILL.md": SKILL("architecture", "when_to_use: Deciding how to layer a service.\n") },
        },
        commands: { "spec.md": "---\ndescription: Start a change from a delta spec\n---\n\nWrite the delta spec.\n" },
        agents: { "implementer.md": AGENT },
      },
      "run-report": {
        ".claude-plugin": { "plugin.json": `${JSON.stringify({ name: "run-report", description: "Render a run's transcripts into a readable report" }, null, 2)}\n` },
        commands: { "run-report.md": RUN_REPORT_CMD },
        scripts: { "run_report.py": "#!/usr/bin/env python3\nprint('run-report')\n" },
      },
    },
  })
  expect(ocm(home, "add", `file://${repo}`).status).toBe(0)
  const root = mpRoot(home, "wntic-adw") // the manifest name seeds it, as in the real repo
  if (!existsSync(root)) throw new Error(`expected the clone at ${root} (marketplace.json name "wntic-adw")`)
  const links = join(home, ".cache", "ocm", "links", "wntic-adw", "skills")
  expect(readFileSync(join(links, "adw--python-style", "SKILL.md"), "utf8")).toContain('name: "adw:python-style"')
  expect(readFileSync(join(links, "adw--architecture", "SKILL.md"), "utf8")).toContain('name: "adw:architecture"')
  assertResolves(join(cfg(home), "commands", "run-report:run-report.md"), join(root, "plugins", "run-report", "commands", "run-report.md"))
  // the command's script path resolves through the hook's CLAUDE_PLUGIN_ROOT
  const env = hookEnv(home)
  if (!isSamePath(env.CLAUDE_PLUGIN_ROOT, root)) {
    throw new Error(`expected CLAUDE_PLUGIN_ROOT=${root} from the shell.env hook, got: ${JSON.stringify(env.CLAUDE_PLUGIN_ROOT)}`)
  }
  const body = readFileSync(join(root, "plugins", "run-report", "commands", "run-report.md"), "utf8")
  const ref = body.match(/\$\{CLAUDE_PLUGIN_ROOT\}[^"\s]+/)
  if (!ref) throw new Error("expected a ${CLAUDE_PLUGIN_ROOT} reference in the run-report command body")
  assertFileExists(ref[0].replace("${CLAUDE_PLUGIN_ROOT}", env.CLAUDE_PLUGIN_ROOT))
  // invariant: no plugin-load errors, and opencode resolves the adw:<skill> names
  const probe = opencodeProbe(cfg(home), home)
  if (!probe.available) console.log("skipped: opencode is not on PATH")
  else {
    if (probe.unreliable) throw new Error("probe cannot trust itself: the canary broken plugin produced no error line")
    expect(probe.skills).toContain("adw:python-style")
    expect(probe.skills).toContain("adw:architecture")
    expect(probe.pluginErrors).toEqual([])
  }
}, 420_000) // opencode spawns with plugin files present: canary + skill + error scan
