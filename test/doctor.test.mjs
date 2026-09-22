// Doctor: diagnosing an installation for its consumer.

import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, assertFileExists, rootCacheDir, withFakeHome, withFakeOpencode } from "./harness.mjs"

// Helpers shared verbatim by the absorbed files below.

const OCM_BIN = fileURLToPath(new URL("../bin/ocm.ts", import.meta.url))

function ocm(home, ...args) {
  const result = spawnSync(process.execPath, [OCM_BIN, ...args], {
    env: withFakeOpencode({ ...process.env, HOME: home }), encoding: "utf8", timeout: 120_000,
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

function gitRepo(dir, tree) {
  writeTree(dir, tree)
  for (const args of [["init", "-b", "main"], ["add", "-A"], ["-c", "user.email=ocm@test", "-c", "user.name=ocm", "commit", "-m", "fixture"]]) {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" })
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${result.stderr}`)
  }
}

const cfg = (home) => join(home, ".config", "opencode")

const registryFile = (home) => join(cfg(home), "ocm", "registry.json")

const COMMAND = "---\ndescription: commit helper\n---\n\nCommit body.\n"

const SKILL = (name, extra = "") => `---\nname: ${name}\ndescription: ${name} guidance\n${extra}---\n\n# ${name}\n\nBody.\n`

const JS_PLUGIN = 'export default { id: "adw-notify", server: async () => ({}) }\n'

const USER_PLUGIN = 'export default { id: "mine", server: async () => ({}) }\n'

const MCP = { db: { type: "local", command: ["npx", "-y", "@acme/db-mcp"], enabled: true } }

const json = (value) => `${JSON.stringify(value, null, 2)}\n`

const manifest = (plugins) => json({ name: "mp", plugins })

const LONG = "a".repeat(65)

const CORE_MODULE = fileURLToPath(new URL("../loader/core.js", import.meta.url))

function git(dir, args) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: 120_000 })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${r.stderr}`)
}

const commitAll = (dir, msg) => { git(dir, ["add", "-A"]); git(dir, ["-c", "user.email=ocm@test", "-c", "user.name=ocm", "commit", "-m", msg]) }

const configFile = (home) => join(cfg(home), "opencode.json")

const readRegistry = (home) => JSON.parse(readFileSync(registryFile(home), "utf8"))

const cloneDir = (home, name = "mp") => join(rootCacheDir(home), "marketplaces", name)

const pluginLink = (home, plugin, file) => join(cfg(home), "plugins", `ocm--${plugin}--${file}`)

const JS_PLUGIN_OTHER = 'export default { id: "phase20-other", server: async () => ({}) }\n'

const PLUGIN_JSON = json({ description: "demo plugin" }) // spec 19: installable plugins carry a manifest

// phase12-validate-doctor.mjs (doctor half) — absorbed from test/phase12-validate-doctor.mjs
{
// realpath on both sides: macOS temp dirs sit behind /var -> /private/var
function assertResolves(dest, source) {
  if (!existsSync(dest) || !lstatSync(dest).isSymbolicLink()) throw new Error(`expected a symlink at ${dest}`)
  expect(realpathSync(dest)).toBe(realpathSync(source))
}

// a finding line in the spec 12 format: "  error   plugins/foo/...: message"
function finding(output, severity, ...needles) {
  const line = output.split("\n").find((l) => new RegExp(`^\\s*${severity}\\b`).test(l) && needles.every((n) => l.includes(n)))
  if (!line) throw new Error(`expected a ${severity} finding containing ${JSON.stringify(needles)}:\n${output}`)
}

// spec 19: every valid plugin carries a plugin.json with a description; the
// ERROR_CASES below stay manifest-less on purpose — phase 19 owns that error
const PLUGIN_JSON = json({ description: "demo plugin" })

// the clean fixture must produce zero findings, so its manifest also pins the
// $schema the warning asks for
const CLEAN_PLUGIN_JSON = json({ description: "demo plugin", $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" })

// one fixture per error class in the spec's list: [label, tree, needles]
const ERROR_CASES = [
  ["plugin-json", { plugins: { bad: { "plugin.json": "{ not json\n", commands: { "work.md": COMMAND } } } }, ["plugin.json", "invalid JSON at position"]],
  ["marketplace-json", { "marketplace.json": "{ not json\n", plugins: { tool: { commands: { "work.md": COMMAND } } } }, ["marketplace.json", "invalid JSON"]],
  ["plugin-schema", { plugins: { bad: { "plugin.json": json({ tags: "nope" }), commands: { "work.md": COMMAND } } } }, ["plugin.json", "tags"]],
  ["marketplace-schema", { "marketplace.json": json({ plugins: "nope" }), plugins: { tool: { commands: { "work.md": COMMAND } } } }, ["marketplace.json", "plugins"]],
  ["dir-name", { plugins: { bad_name: { commands: { "work.md": COMMAND } } } }, ["bad_name"]],
  ["dir-length", { plugins: { [LONG]: { commands: { "work.md": COMMAND } } } }, [LONG]],
  ["name-mismatch", { plugins: { mismatch: { "plugin.json": json({ name: "other" }), commands: { "work.md": COMMAND } } } }, ["mismatch", "other"]],
  ["skill-no-frontmatter", { plugins: { nofm: { skills: { one: { "SKILL.md": "# No frontmatter\n\nBody.\n" } } } } }, ["nofm", "SKILL.md"]],
  ["skill-no-name", { plugins: { noname: { skills: { one: { "SKILL.md": "---\ndescription: guidance\n---\n\nBody.\n" } } } } }, ["SKILL.md", 'frontmatter has no "name"']],
  ["skill-no-description", { plugins: { nodesc: { skills: { one: { "SKILL.md": "---\nname: one\n---\n\nBody.\n" } } } } }, ["SKILL.md", "description"]],
  ["skill-long-description", { plugins: { longdesc: { skills: { one: { "SKILL.md": `---\nname: one\ndescription: ${"d".repeat(1025)}\n---\n\nBody.\n` } } } } }, ["SKILL.md", "description"]],
  ["skill-collision", { plugins: { dup: { skills: { one: { "SKILL.md": SKILL("same") }, two: { "SKILL.md": SKILL("same") } } } } }, ["one", "two", "same"]],
  ["command-collision", { plugins: { clash: { commands: { "x.md": COMMAND }, command: { "x.md": COMMAND } } } }, ["clash", "x.md"]],
  ["empty-body", { plugins: { empty: { commands: { "empty.md": "---\ndescription: nothing follows\n---\n" } } } }, ["empty.md"]],
  ["wrong-export", { plugins: { badexp: { plugin: { "setup.js": 'export default { id: "x", setup: async () => ({}) }\n' }, commands: { "work.md": COMMAND } } } }, ["setup.js"]],
  ["tui-export", { plugins: { tuiexp: { plugin: { "ui.js": 'export default { id: "x", tui: async () => ({}) }\n' }, commands: { "work.md": COMMAND } } } }, ["ui.js", "tui"]],
  ["mcp-not-object", { plugins: { badmcp: { "mcp.json": "[]\n", commands: { "work.md": COMMAND } } } }, ["mcp.json"]],
  ["mcp-missing-type", { plugins: { notype: { "mcp.json": json({ db: { command: ["echo"] } }), commands: { "work.md": COMMAND } } } }, ["mcp.json", "db"]],
  ["source-unresolved", { "marketplace.json": manifest([{ name: "ghost", source: "./plugins/ghost" }]), plugins: { tool: { commands: { "work.md": COMMAND } } } }, ["ghost"]],
  ["source-escapes", { "marketplace.json": manifest([{ name: "outside", source: "../outside" }]), plugins: { tool: { commands: { "work.md": COMMAND } } } }, ["../outside"]],
]

// one fixture per warning class: { label, tree, warnings, absent? }
const WARNING_CASES = [
  { label: "non-portable-frontmatter", tree: { plugins: { adw: { "plugin.json": PLUGIN_JSON, skills: { style: { "SKILL.md": SKILL("style", "allowed-tools: Bash\n") } } } } }, warnings: [["SKILL.md", 'non-portable frontmatter "allowed-tools"']] },
  { label: "plugin-root-ref", tree: { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: {
    "bad.md": '---\ndescription: bad reference\n---\n\npython3 "${CLAUDE_PLUGIN_ROOT}/scripts/run_report.py"\n',
    "good.md": '---\ndescription: good reference\n---\n\npython3 "${CLAUDE_PLUGIN_ROOT}/plugins/adw/scripts/run_report.py"\n',
  } } } }, warnings: [["bad.md", "CLAUDE_PLUGIN_ROOT"]], absent: [["good.md"]] },
  { label: "version-disagrees", tree: { "marketplace.json": manifest([{ name: "baz", source: "./plugins/baz", version: "1.0.0" }]), plugins: { baz: { "plugin.json": json({ version: "1.1.0", description: "demo plugin" }), commands: { "work.md": COMMAND } } } }, warnings: [["version disagrees", "1.0.0", "1.1.0"]] },
  { label: "command-no-frontmatter", tree: { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "plain.md": "# Just markdown\n" } } } }, warnings: [["plain.md"]] },
  { label: "typo-dirs", tree: { plugins: { typodirs: { "plugin.json": PLUGIN_JSON, skills: { one: { "SKILL.md": SKILL("one") } }, skill: { two: { "SKILL.md": SKILL("two") } } } } }, warnings: [["typodirs", "skill"]] },
  { label: "typo-files", tree: { plugins: { typos: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND }, "plugin.ts": "// typo\n", "SKILLS.md": "# typo\n", "Skill.md": "# typo\n" } } }, warnings: [["plugin.ts"], ["SKILLS.md"], ["Skill.md"]] },
  { label: "shell-substitution", tree: { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "shell.md": "---\ndescription: shell out\n---\n\nRun `!git status --porcelain` first.\n" } } } }, warnings: [["shell.md"]] },
]

phase("3. doctor detects a stale core by version comment, a stray ocm file in plugins/, a broken symlink, an orphaned skills.paths entry and an orphaned MCP key; --fix repairs exactly those", async (home) => {
  // config safety + ownership: the user's keys and file predate every ocm write
  const userConfig = { model: "claude-sonnet-4-6", mcp: { "user-server": { type: "local", command: ["echo"] } } }
  writeTree(cfg(home), { "opencode.json": `${JSON.stringify(userConfig, null, 2)}\n`, plugins: { "my-own.js": USER_PLUGIN } })
  expect(ocm(home, "init").status).toBe(0)
  const coreFile = join(cfg(home), "ocm", "core.js")
  const fresh = readFileSync(coreFile, "utf8")
  writeFileSync(coreFile, fresh.replace(/^\/\/ ocm-version:.*$/m, "// ocm-version: 0.0.0 stale")) // a stale core silently no-ops
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { adw: {
    "plugin.json": PLUGIN_JSON,
    commands: { "commit.md": COMMAND },
    skills: { style: { "SKILL.md": SKILL("style") } },
    plugin: { "notify.js": JS_PLUGIN },
    "mcp.json": json(MCP),
  } } })
  expect(ocm(home, "add", mp, "--trust").status).toBe(0)
  // a stray ocm file no registry entry owns, and a broken symlink in commands/
  writeFileSync(join(cfg(home), "plugins", "ocm--adw--gone.js"), '// left behind\nthrow new Error("stale")\n')
  symlinkSync(join(mp, "plugins", "adw", "commands", "stale.md"), join(cfg(home), "commands", "adw:stale.md"))
  // an orphaned ocm skills.paths entry, a user entry whose target is also gone, an orphaned MCP key
  const configPath = join(cfg(home), "opencode.json")
  const config = JSON.parse(readFileSync(configPath, "utf8"))
  const goneOcm = join(rootCacheDir(home), "links", "gone", "skills")
  const goneUser = join(home, "gone-user-skills")
  config.skills ??= { paths: [] }
  config.skills.paths.push(goneOcm, goneUser)
  config.mcp["ocm--ghost--db"] = { type: "local", command: ["echo"] }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

  const diagnosed = ocm(home, "doctor")
  const report = `${diagnosed.stdout}\n${diagnosed.stderr}`
  if (diagnosed.status !== 1) throw new Error(`ocm doctor exited ${diagnosed.status}, expected 1:\n${report}`)
  for (const needle of ["core.js", "ocm--adw--gone.js", "adw:stale.md", goneOcm, "ocm--ghost--db"]) {
    if (!report.includes(needle)) throw new Error(`ocm doctor report lacks "${needle}":\n${report}`)
  }

  const fixed = ocm(home, "doctor", "--fix")
  const fixReport = `${fixed.stdout}\n${fixed.stderr}`
  if (fixed.status !== 0) throw new Error(`ocm doctor --fix exited ${fixed.status}:\n${fixReport}`)
  expect(readFileSync(coreFile, "utf8")).toBe(fresh)
  assertAbsent(join(cfg(home), "plugins", "ocm--adw--gone.js"))
  assertFileExists(join(cfg(home), "plugins", "my-own.js")) // ownership: the user's file is never a stray
  assertFileExists(join(cfg(home), "plugins", "ocm-loader.js"))
  assertAbsent(join(cfg(home), "commands", "adw:stale.md"))
  assertResolves(join(cfg(home), "commands", "adw:commit.md"), join(mp, "plugins", "adw", "commands", "commit.md"))
  const after = JSON.parse(readFileSync(configPath, "utf8"))
  expect(after.skills.paths).not.toContain(goneOcm)
  expect(after.skills.paths).toContain(goneUser) // ownership: the user's orphaned entry stays
  expect(after.skills.paths).toHaveLength(config.skills.paths.length - 1) // exactly the orphan removed
  expect(after.mcp["ocm--ghost--db"]).toBeUndefined()
  expect(after.mcp["ocm--adw--db"]).toBeDefined() // the owned key survives the fix
  expect(after.mcp["user-server"]).toEqual(userConfig.mcp["user-server"])
  expect(after.model).toBe(userConfig.model)
  assertResolves(join(cfg(home), "plugins", "ocm--adw--notify.js"), join(mp, "plugins", "adw", "plugin", "notify.js"))
  expect(lstatSync(join(rootCacheDir(home), "links", "mp", "skills", "adw--style")).isDirectory()).toBe(true)

  // idempotence: a second --fix writes nothing
  const before = [coreFile, configPath, registryFile(home)].map((p) => readFileSync(p, "utf8"))
  const again = ocm(home, "doctor", "--fix")
  if (again.status !== 0) throw new Error(`second ocm doctor --fix exited ${again.status}:\n${again.stdout}\n${again.stderr}`)
  expect([coreFile, configPath, registryFile(home)].map((p) => readFileSync(p, "utf8"))).toEqual(before)

  // no plugin-load errors attributable to ocm files
}, 900_000)

phase("4. doctor reports a marketplace whose last sync failed, with the error", async (home) => {
  expect(ocm(home, "init").status).toBe(0)
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { tool: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } } } })
  expect(ocm(home, "add", `file://${remote}`, "--name", "mp").status).toBe(0)
  rmSync(remote, { recursive: true, force: true })
  expect(ocm(home, "update", "mp").status).not.toBe(0)
  const lastSync = JSON.parse(readFileSync(registryFile(home), "utf8")).marketplaces.mp.lastSync
  if (!lastSync || lastSync.ok !== false || !lastSync.error) {
    throw new Error(`expected lastSync.ok === false with an error for mp in ${registryFile(home)}, got ${JSON.stringify(lastSync)}`)
  }
  const result = ocm(home, "doctor")
  const output = `${result.stdout}\n${result.stderr}`
  if (result.status !== 1) throw new Error(`ocm doctor exited ${result.status}, expected 1:\n${output}`)
  expect(output).toContain("mp")
  const firstLine = lastSync.error.split("\n").map((l) => l.trim()).find(Boolean)
  if (!firstLine || !output.includes(firstLine)) {
    throw new Error(`ocm doctor report lacks the last-sync error "${firstLine}" for mp:\n${output}`)
  }
}, 420_000)

phase("5. an injected write failure leaves the original opencode.json byte-identical; an unparseable config is never rewritten", async (home) => {
  expect(ocm(home, "init").status).toBe(0)
  const configPath = join(cfg(home), "opencode.json")
  // a config that does not parse is warned about and never rewritten
  const garbage = "{ this is not json\n"
  writeFileSync(configPath, garbage)
  const warned = ocm(home, "doctor", "--fix")
  const warnOut = `${warned.stdout}\n${warned.stderr}`
  if (!warnOut.includes("opencode.json")) throw new Error(`expected the report to name opencode.json:\n${warnOut}`)
  expect(readFileSync(configPath, "utf8")).toBe(garbage)
  // a read-only config directory makes the atomic write fail mid-fix
  const userConfig = { model: "claude-sonnet-4-6", mcp: {
    "user-server": { type: "local", command: ["echo"] },
    "ocm--ghost--db": { type: "local", command: ["echo"] }, // orphaned: no marketplace owns it
  } }
  writeFileSync(configPath, `${JSON.stringify(userConfig, null, 2)}\n`)
  const bytes = readFileSync(configPath, "utf8")
  chmodSync(cfg(home), 0o555)
  try {
    const blocked = ocm(home, "doctor", "--fix")
    const blockOut = `${blocked.stdout}\n${blocked.stderr}`
    if (blocked.status === 0) throw new Error(`expected ocm doctor --fix to exit non-zero when the config write fails:\n${blockOut}`)
    if (!blockOut.includes("opencode.json")) throw new Error(`expected the failure report to name opencode.json:\n${blockOut}`)
    expect(readFileSync(configPath, "utf8")).toBe(bytes)
    expect(JSON.parse(readFileSync(configPath, "utf8")).mcp["ocm--ghost--db"]).toBeDefined()
  } finally {
    chmodSync(cfg(home), 0o755)
  }
}, 600_000)

phase("6. a full add → install → update → remove cycle creates nothing under ~/.claude or ~/.agents", async (home) => {
  const userConfig = { model: "claude-sonnet-4-6", permission: { edit: "allow" }, skills: { paths: ["/users/me/my-skills"] } }
  writeTree(cfg(home), { "opencode.json": `${JSON.stringify(userConfig, null, 2)}\n`, commands: { "mine.md": "# my own command\n" } })
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND }, skills: { style: { "SKILL.md": SKILL("style") } } } } })
  expect(ocm(home, "add", `file://${remote}`, "--name", "mp", "--explicit").status).toBe(0)
  expect(ocm(home, "install", "adw").status).toBe(0)
  assertResolves(join(cfg(home), "commands", "adw:commit.md"), join(cloneDir(home), "plugins", "adw", "commands", "commit.md"))
  expect(ocm(home, "update", "mp").status).toBe(0)
  expect(ocm(home, "remove", "mp").status).toBe(0)
  assertAbsent(join(cfg(home), "commands", "adw:commit.md"))
  // ownership: the user's command survives every operation including remove
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
  // config safety: ocm's entries are gone; the user's config is exactly itself
  expect(JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8"))).toEqual(userConfig)
  const forbidden = []
  const stack = [home]
  while (stack.length) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.name === ".claude" || entry.name === ".agents") forbidden.push(path)
      if (entry.isDirectory()) stack.push(path)
    }
  }
  if (forbidden.length) throw new Error(`expected nothing under ~/.claude or ~/.agents, found: ${forbidden.join(", ")}`)
})
}

// doctor config safety: an unparseable config is never rewritten; the orphan sweep stays scoped — absorbed from test/phase20-doctor-config-safety.mjs
{
function ocm(home, args, timeout = 120_000, options = {}) {
  const r = spawnSync(process.execPath, [OCM_BIN, ...args], {
    env: withFakeOpencode({ ...process.env, HOME: home, ...options.env }, options), encoding: "utf8", timeout,
  })
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` }
}

const gitRepo = (dir, tree) => { writeTree(dir, tree); git(dir, ["init", "-b", "main"]); commitAll(dir, "fixture") }

// the loader's startup sync, run the way ocm-loader.js runs it: a child
// process on the fake $HOME (phase 07)
function loaderSync(home) {
  const runner = join(home, "sync-runner.mjs")
  writeFileSync(runner, "const mod = await import(process.argv[2]); await mod.syncAll({ force: true })\n")
  const r = spawnSync(process.execPath, [runner, CORE_MODULE], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 120_000 })
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

const LOADER_PATHS_MODULE = fileURLToPath(new URL("../loader/paths.js", import.meta.url))
const SRC_PATHS_MODULE = fileURLToPath(new URL("../src/paths.ts", import.meta.url))

// both paths modules compute their constants at import time, so the variable
// must sit in the child env before the import — same child-spawn reason as
// loaderSync above. src/paths.ts is TypeScript: the child runs under bun.
function pathConstants(home, env) {
  const runner = join(home, "paths-runner.mjs")
  writeFileSync(runner, "const l = await import(process.argv[2]); const s = await import(process.argv[3]); console.log(JSON.stringify({ OPENCODE_DIR: l.OPENCODE_DIR, CACHE_DIR: l.CACHE_DIR, LINKS_DIR: l.LINKS_DIR, OPENCODE_GLOBAL_DIR: s.OPENCODE_GLOBAL_DIR, OCM_CACHE_DIR: s.OCM_CACHE_DIR, OCM_LINKS_DIR: s.OCM_LINKS_DIR }))\n")
  const r = spawnSync(process.execPath, [runner, LOADER_PATHS_MODULE, SRC_PATHS_MODULE], { env: { ...process.env, HOME: home, ...env }, encoding: "utf8", timeout: 120_000 })
  if (r.status !== 0) throw new Error(`the paths runner exited ${r.status}: ${r.stderr}`)
  return JSON.parse(r.stdout)
}

// realpath on both sides: macOS temp dirs sit behind /var -> /private/var
function assertResolves(dest, source) {
  if (!existsSync(dest) || !lstatSync(dest).isSymbolicLink()) throw new Error(`expected a symlink at ${dest}`)
  expect(realpathSync(dest)).toBe(realpathSync(source))
}

const SKILL = "---\nname: style\ndescription: style guidance\n---\n\n# Style\n\nBody.\n"

const JS_PLUGIN = 'export default { id: "phase20-notify", server: async () => ({}) }\n'

const MCP = json({ db: { type: "local", command: ["npx", "-y", "@acme/db-mcp"], enabled: true } })

phase("1. doctor on a never-initialized home is exactly one stderr line and exit 1; --fix is the same and inits nothing", async (home) => {
  for (const args of [["doctor"], ["doctor", "--fix"]]) {
    const result = ocm(home, args)
    if (result.status !== 1) throw new Error(`ocm ${args.join(" ")} exited ${result.status}, expected 1:\n${result.output}`)
    if (result.stdout !== "") throw new Error(`ocm ${args.join(" ")} printed stdout on a never-initialized home:\n${result.stdout}`)
    expect(result.stderr).toBe("error: ocm is not installed here — run ocm init\n")
  }
  assertAbsent(join(cfg(home), "ocm")) // nothing to fix means nothing to init
  assertAbsent(join(cfg(home), "plugins", "ocm-loader.js"))
})

phase("2. the F8 chain: sync pulls a trust-pending JS plugin, trust approves it, doctor is clean and --fix removes nothing", async (home) => {
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { "exec-kit": {
    "plugin.json": PLUGIN_JSON,
    commands: { "work.md": COMMAND },
    plugin: { "notify.js": JS_PLUGIN },
  } } })
  expect(ocm(home, ["add", `file://${remote}`, "--name", "mp", "--trust"]).status).toBe(0)
  writeFileSync(join(remote, "plugins", "exec-kit", "plugin", "other.js"), JS_PLUGIN_OTHER)
  commitAll(remote, "ship a new executable component")
  const synced = loaderSync(home)
  if (synced.status !== 0) throw new Error(`the loader sync exited ${synced.status}: ${synced.stderr}`)
  assertAbsent(pluginLink(home, "exec-kit", "other.js")) // never materialized unattended
  expect(readRegistry(home).marketplaces.mp.trustPending).toBe(true)
  expect(ocm(home, ["trust", "mp", "--yes"]).status).toBe(0)
  const other = join(cloneDir(home), "plugins", "exec-kit", "plugin", "other.js")
  assertResolves(pluginLink(home, "exec-kit", "other.js"), other) // the link the user just approved
  const diagnosed = ocm(home, ["doctor"], 300_000)
  if (diagnosed.status !== 0) throw new Error(`ocm doctor exited ${diagnosed.status} after sync + trust:\n${diagnosed.output}`)
  // this flow never writes opencode.json (no skills, no mcp.json): snapshot
  // only what exists, and pin the existence set so a spurious --fix creation
  // still fails
  const tracked = [configFile(home), registryFile(home)]
  const existing = () => tracked.filter((p) => existsSync(p))
  const beforeFiles = existing()
  const before = beforeFiles.map((p) => readFileSync(p, "utf8"))
  const fixed = ocm(home, ["doctor", "--fix"], 300_000)
  if (fixed.status !== 0) throw new Error(`ocm doctor --fix exited ${fixed.status}:\n${fixed.output}`)
  assertResolves(pluginLink(home, "exec-kit", "other.js"), other) // --fix removed nothing the user approved
  assertResolves(pluginLink(home, "exec-kit", "notify.js"), join(cloneDir(home), "plugins", "exec-kit", "plugin", "notify.js"))
  expect(existing()).toEqual(beforeFiles)
  expect(existing().map((p) => readFileSync(p, "utf8"))).toEqual(before)
  // records and disk agree: the per-plugin record, the trust record and the link
  const entry = readRegistry(home).marketplaces.mp
  expect(entry.plugins["exec-kit"].components.plugin).toContain("other.js")
  expect(entry.trust.components["plugins/exec-kit/plugin/other.js"]).toMatch(/^[0-9a-f]{64}$/)
  expect(entry.trustPending).toBeUndefined()
}, 600_000)

phase("3. a single-dash plugins/ocm-stray.js is a doctor warning naming the risk; --fix leaves the file untouched", async (home) => {
  expect(ocm(home, ["init"]).status).toBe(0)
  const stray = join(cfg(home), "plugins", "ocm-stray.js")
  writeFileSync(stray, USER_PLUGIN)
  const diagnosed = ocm(home, ["doctor"], 300_000)
  const line = diagnosed.output.split("\n").find((l) => l.includes("ocm-stray.js"))
  if (!line) throw new Error(`expected a finding naming ${stray}:\n${diagnosed.output}`)
  for (const needle of ["warning", "matches no ocm layout", "opencode loads it on every start", "remove or rename"]) {
    if (!line.includes(needle)) throw new Error(`the stray finding lacks "${needle}":\n${line}`)
  }
  const fixed = ocm(home, ["doctor", "--fix"], 300_000)
  const persisted = fixed.output.split("\n").find((l) => l.includes("ocm-stray.js") && l.includes("matches no ocm layout"))
  if (!persisted) throw new Error(`the stray warning must persist through --fix:\n${fixed.output}`)
  expect(readFileSync(stray, "utf8")).toBe(USER_PLUGIN) // not ocm's to remove: the user decides
}, 600_000)

phase("4. orphan sweep: an unowned ocm-- link and skill mirror are each reported; --fix removes them and the skills.paths entry, and the user's own files survive", async (home) => {
  expect(ocm(home, ["init"]).status).toBe(0)
  // seeded orphans: a working ocm-- link and a rendered skill mirror, no registry backing
  const ghostCommand = join(rootCacheDir(home), "marketplaces", "ghost", "plugins", "demo-kit", "commands", "tdd.md")
  writeTree(join(rootCacheDir(home), "marketplaces", "ghost", "plugins", "demo-kit", "commands"), { "tdd.md": COMMAND })
  const orphanLink = join(cfg(home), "plugins", "ocm--demo-kit--tdd.md")
  symlinkSync(ghostCommand, orphanLink)
  const ghostSkills = join(rootCacheDir(home), "links", "ghost", "skills")
  writeTree(join(ghostSkills, "demo-kit--tdd"), { "SKILL.md": "---\nname: \"demo-kit:tdd\"\ndescription: orphaned mirror\n---\n\nBody.\n" })
  const userSkills = join(home, "my-skills")
  writeTree(userSkills, { "SKILL.md": SKILL }) // a real user entry: not ocm's to judge or touch
  writeTree(cfg(home), { "opencode.json": json({ model: "claude-sonnet-4-6", skills: { paths: [userSkills, ghostSkills] } }), plugins: { "my-own.js": USER_PLUGIN } })
  const diagnosed = ocm(home, ["doctor"], 300_000)
  if (diagnosed.status !== 1) throw new Error(`ocm doctor exited ${diagnosed.status}, expected 1:\n${diagnosed.output}`)
  const findings = diagnosed.output.split("\n").filter((l) => l.includes("no marketplace owns this link"))
  const linkFinding = findings.find((l) => l.includes("ocm--demo-kit--tdd.md"))
  if (!linkFinding) throw new Error(`expected an orphan finding naming ${orphanLink}:\n${diagnosed.output}`)
  for (const needle of ["orphaned by a loader uninstall?", "ocm doctor --fix removes it"]) {
    if (!linkFinding.includes(needle)) throw new Error(`the orphan finding lacks "${needle}":\n${linkFinding}`)
  }
  const mirrorFinding = findings.find((l) => l.includes(ghostSkills) || (l.includes("demo-kit--tdd") && l !== linkFinding))
  if (!mirrorFinding) throw new Error(`expected an orphan finding naming the skill mirror under ${ghostSkills}:\n${diagnosed.output}`)
  const fixed = ocm(home, ["doctor", "--fix"], 300_000)
  if (fixed.status !== 0) throw new Error(`ocm doctor --fix exited ${fixed.status}:\n${fixed.output}`)
  assertAbsent(orphanLink)
  assertAbsent(join(ghostSkills, "demo-kit--tdd"))
  expect(JSON.parse(readFileSync(configFile(home), "utf8")).skills.paths).toEqual([userSkills]) // ocm's entry cleaned, the user's stays
  expect(readFileSync(join(cfg(home), "plugins", "my-own.js"), "utf8")).toBe(USER_PLUGIN) // ownership
}, 600_000)

phase("5. a missing git marketplace clone is re-cloned by doctor --fix and the install re-materialized, exit 0", async (home) => {
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
  expect(ocm(home, ["add", `file://${remote}`, "--name", "mp"]).status).toBe(0)
  const clone = cloneDir(home)
  rmSync(clone, { recursive: true, force: true })
  const fixed = ocm(home, ["doctor", "--fix"], 300_000)
  if (fixed.status !== 0) throw new Error(`ocm doctor --fix exited ${fixed.status} on a missing clone:\n${fixed.output}`)
  expect(fixed.output).toMatch(/re-clone/i) // the outcome is reported
  expect(existsSync(join(clone, ".git"))).toBe(true) // the same code path ocm update uses
  assertResolves(join(cfg(home), "commands", "adw:commit.md"), join(clone, "plugins", "adw", "commands", "commit.md"))
}, 420_000)

phase("6. a missing local marketplace directory gets the restore-or-remove remedy, and --fix refuses", async (home) => {
  const mp = join(home, "local-mp")
  writeTree(mp, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
  expect(ocm(home, ["add", mp]).status).toBe(0)
  rmSync(mp, { recursive: true, force: true })
  const remedy = "restore the directory, or run ocm remove local-mp"
  const diagnosed = ocm(home, ["doctor"], 300_000)
  if (diagnosed.status !== 1) throw new Error(`ocm doctor exited ${diagnosed.status}, expected 1:\n${diagnosed.output}`)
  if (!diagnosed.output.includes(remedy)) throw new Error(`the remedy for a local marketplace must be restore-or-remove:\n${diagnosed.output}`)
  const fixed = ocm(home, ["doctor", "--fix"], 300_000)
  if (fixed.status === 0) throw new Error(`ocm doctor --fix must refuse a local marketplace with a missing directory:\n${fixed.output}`)
  if (!fixed.output.includes(remedy)) throw new Error(`the remedy must survive --fix:\n${fixed.output}`)
  assertAbsent(mp) // there is nothing to clone: the directory is never re-created
}, 600_000)

phase("7. a corrupt opencode.json during add: one warning, the manual skills.paths edit printed, the skill not counted as installed, config byte-identical", async (home) => {
  const garbage = "{ this is not json\n"
  writeTree(cfg(home), { "opencode.json": garbage })
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { adw: {
    "plugin.json": PLUGIN_JSON,
    commands: { "commit.md": COMMAND },
    skills: { style: { "SKILL.md": SKILL } },
    "mcp.json": MCP, // a second config writer: the warning must still appear once
  } } })
  const result = ocm(home, ["add", mp])
  if (result.status !== 0) throw new Error(`ocm add exited ${result.status}:\n${result.output}`)
  const warnings = result.output.split("\n").filter((l) => /warning/i.test(l) && /opencode\.json|not valid JSON/.test(l))
  if (warnings.length !== 1) throw new Error(`expected exactly one warning about the corrupt config, got ${warnings.length}:\n${result.output}`)
  expect(result.output).toContain("skills.paths NOT written — opencode.json is not valid JSON")
  expect(result.output).toContain(join(rootCacheDir(home), "links", "mp", "skills")) // the exact edit to make by hand
  expect(result.output).not.toMatch(/\b1 skills\b/) // the skill is not counted as installed
  expect(readFileSync(configFile(home), "utf8")).toBe(garbage) // a config that does not parse is never rewritten
})

phase("8. a read-only opencode.json refuses a mutation pre-flight: zero writes, and the error names the chmod", async (home) => {
  writeTree(cfg(home), { "opencode.json": json({ model: "claude-sonnet-4-6", mcp: { "user-server": { type: "local", command: ["echo"] } } }) })
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND }, skills: { style: { "SKILL.md": SKILL } } } } })
  expect(ocm(home, ["add", mp]).status).toBe(0)
  const configBytes = readFileSync(configFile(home), "utf8")
  const registryBytes = readFileSync(registryFile(home), "utf8")
  chmodSync(configFile(home), 0o444)
  try {
    const refused = ocm(home, ["uninstall", "adw@mp"])
    if (refused.status === 0) throw new Error(`ocm uninstall must refuse when opencode.json is read-only:\n${refused.output}`)
    for (const needle of ["opencode.json is read-only", "chmod +w"]) {
      if (!refused.output.includes(needle)) throw new Error(`the refusal lacks "${needle}":\n${refused.output}`)
    }
    expect(readFileSync(configFile(home), "utf8")).toBe(configBytes) // the check precedes the first write
    expect(readFileSync(registryFile(home), "utf8")).toBe(registryBytes)
  } finally {
    chmodSync(configFile(home), 0o644)
  }
})

phase("9. config safety and ownership across the doctor flows: user keys and files survive, --fix is idempotent, nothing under ~/.claude or ~/.agents, probe clean", async (home) => {
  const userConfig = { model: "claude-sonnet-4-6", permission: { edit: "allow" }, skills: { paths: [join(home, "my-skills")] }, mcp: { "user-server": { type: "local", command: ["echo"] } } }
  writeTree(join(home, "my-skills"), { "SKILL.md": SKILL })
  writeTree(cfg(home), {
    "opencode.json": json(userConfig), "tui.json": json({ plugin: ["my-own-tui-plugin"] }),
    commands: { "mine.md": "# my own command\n" }, plugins: { "my-own.js": USER_PLUGIN },
  })
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND }, skills: { style: { "SKILL.md": SKILL } } } } })
  expect(ocm(home, ["add", mp]).status).toBe(0)
  const diagnosed = ocm(home, ["doctor"], 300_000)
  if (diagnosed.status !== 0) throw new Error(`ocm doctor exited ${diagnosed.status} on a healthy install:\n${diagnosed.output}`)
  const before = [configFile(home), registryFile(home)].map((p) => readFileSync(p, "utf8"))
  const fixed = ocm(home, ["doctor", "--fix"], 300_000)
  if (fixed.status !== 0) throw new Error(`ocm doctor --fix exited ${fixed.status} on a healthy install:\n${fixed.output}`)
  expect([configFile(home), registryFile(home)].map((p) => readFileSync(p, "utf8"))).toEqual(before) // idempotence: a clean --fix writes nothing
  expect(ocm(home, ["uninstall", "adw@mp"]).status).toBe(0)
  expect(JSON.parse(readFileSync(configFile(home), "utf8"))).toEqual(userConfig) // outside ocm's keys, exactly the user's
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
  expect(readFileSync(join(cfg(home), "plugins", "my-own.js"), "utf8")).toBe(USER_PLUGIN)
  expect(JSON.parse(readFileSync(join(cfg(home), "tui.json"), "utf8")).plugin).toContain("my-own-tui-plugin")
  expect(readdirSync(cfg(home)).filter((name) => name.endsWith(".tmp"))).toEqual([]) // atomic writes leave no temp files
  const forbidden = []
  const stack = [home]
  while (stack.length) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".claude" || entry.name === ".agents") forbidden.push(join(dir, entry.name))
      if (entry.isDirectory()) stack.push(join(dir, entry.name))
    }
  }
  if (forbidden.length) throw new Error(`expected nothing under ~/.claude or ~/.agents, found: ${forbidden.join(", ")}`)
}, 900_000)

// the probe's error path: the fake opencode reports one ocm-attributable
// plugin-load error on demand (OCM_FAKE_PLUGIN_ERROR), so doctor's handling
// of probe output is covered without a real opencode start
phase("10. doctor reports a plugin-load error the probe attributes to ocm, with the update remedy, exit 1", async (home) => {
  expect(ocm(home, ["init"]).status).toBe(0)
  const diagnosed = ocm(home, ["doctor"], 120_000, { env: { OCM_FAKE_PLUGIN_ERROR: "1" } })
  if (diagnosed.status !== 1) throw new Error(`ocm doctor exited ${diagnosed.status} with a plugin-load error to report:\n${diagnosed.output}`)
  for (const needle of ["ocm--demo--broken.js", "(ocm update)", "1 error, 0 warnings"]) {
    if (!diagnosed.output.includes(needle)) throw new Error(`the plugin-error finding lacks "${needle}":\n${diagnosed.output}`)
  }
}, 300_000)

// brief 28 §1, test 1: the config root follows XDG_CONFIG_HOME
phase("11. a set XDG_CONFIG_HOME relocates the install: init and add write only under $XDG/opencode, never $HOME/.config, and both paths modules join the variable — a relative value stays relative", async (home) => {
  const xdg = join(home, "xdg")
  const env = { XDG_CONFIG_HOME: xdg }
  const root = join(xdg, "opencode")
  const init = ocm(home, ["init"], 120_000, { env })
  if (init.status !== 0) throw new Error(`ocm init exited ${init.status} with XDG_CONFIG_HOME=${xdg}:\n${init.output}`)
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
  const add = ocm(home, ["add", mp], 120_000, { env })
  if (add.status !== 0) throw new Error(`ocm add exited ${add.status} with XDG_CONFIG_HOME=${xdg}:\n${add.output}`)
  assertFileExists(join(root, "ocm", "registry.json"))
  assertFileExists(join(root, "plugins", "ocm-loader.js"))
  assertResolves(join(root, "commands", "adw:commit.md"), join(mp, "plugins", "adw", "commands", "commit.md"))
  assertAbsent(join(home, ".config")) // the default root is not created at all
  // the constants, not just the files: both modules resolve the root from the
  // variable, and the cache stays anchored to $HOME
  const set = pathConstants(home, env)
  expect(set.OPENCODE_DIR).toBe(root)
  expect(set.OPENCODE_GLOBAL_DIR).toBe(root)
  expect(set.CACHE_DIR).toBe(join(home, ".cache", "ocm"))
  expect(set.OCM_CACHE_DIR).toBe(join(home, ".cache", "ocm"))
  // brief 38: the link tree lives under the per-root cache namespace, and
  // both modules agree on it
  expect(set.LINKS_DIR).toBe(join(rootCacheDir(home, xdg), "links"))
  expect(set.OCM_LINKS_DIR).toBe(join(rootCacheDir(home, xdg), "links"))
  // join, not resolve: a relative value produces a relative constant, the
  // same rule opencode follows — never run ocm itself with one
  const relative = pathConstants(home, { XDG_CONFIG_HOME: "rel-dir" })
  expect(relative.OPENCODE_DIR).toBe(join("rel-dir", "opencode"))
  expect(relative.OPENCODE_GLOBAL_DIR).toBe(join("rel-dir", "opencode"))
  // invariants: nothing under ~/.claude or ~/.agents anywhere in the home
  const forbidden = []
  const stack = [home]
  while (stack.length) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".claude" || entry.name === ".agents") forbidden.push(join(dir, entry.name))
      if (entry.isDirectory()) stack.push(join(dir, entry.name))
    }
  }
  if (forbidden.length) throw new Error(`expected nothing under ~/.claude or ~/.agents, found: ${forbidden.join(", ")}`)
}, 420_000)

// brief 28 §1, test 2: empty string falls back — the || semantics a
// `!== undefined` check would get wrong
phase("12. an empty-string XDG_CONFIG_HOME falls back to $HOME/.config/opencode in both paths modules and on disk", async (home) => {
  const env = { XDG_CONFIG_HOME: "" }
  const constants = pathConstants(home, env)
  expect(constants.OPENCODE_DIR).toBe(join(home, ".config", "opencode"))
  expect(constants.OPENCODE_GLOBAL_DIR).toBe(join(home, ".config", "opencode"))
  // brief 38: the fallback root still gets its own cache namespace
  expect(constants.LINKS_DIR).toBe(join(rootCacheDir(home), "links"))
  expect(constants.OCM_LINKS_DIR).toBe(join(rootCacheDir(home), "links"))
  const init = ocm(home, ["init"], 120_000, { env })
  if (init.status !== 0) throw new Error(`ocm init exited ${init.status} with an empty XDG_CONFIG_HOME:\n${init.output}`)
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
  const add = ocm(home, ["add", mp], 120_000, { env })
  if (add.status !== 0) throw new Error(`ocm add exited ${add.status} with an empty XDG_CONFIG_HOME:\n${add.output}`)
  assertFileExists(join(home, ".config", "opencode", "ocm", "registry.json"))
  assertAbsent(join(home, "xdg"))
}, 420_000)

// brief 28 §2: an install stranded in the other config root is reported,
// never migrated — doctor names both roots, mutations warn once and proceed

const ROOTS_FILE = (home) => join(home, ".cache", "ocm", "roots.json")

// one local marketplace fixture; the marketplace name is the basename
function localMp(home, name = "mp") {
  const dir = join(home, name)
  writeTree(dir, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
  return dir
}

// the stranded finding's content lines, asserted without the severity prefix
// so the same assertions hold in the early-exit and the findings renderings.
// The remedy adapts per direction, like the parenthetical: with the variable
// set, unsetting it reaches the stranded install; with it unset, setting it
// to the stranded config home does — the recorded root is the opencode dir,
// so the config home is its parent
function expectStranded(output, strandedRoot, activeRoot, xdgSet) {
  const remedy = xdgSet
    ? "unset XDG_CONFIG_HOME to use the existing install, or re-add those marketplaces here"
    : `set XDG_CONFIG_HOME to ${dirname(strandedRoot)} to use the existing install, or re-add those marketplaces here`
  for (const needle of [
    "an ocm install is stranded in another config root",
    `installed at: ${strandedRoot} (1 marketplace)`,
    `this shell:   ${activeRoot} (XDG_CONFIG_HOME is ${xdgSet ? "set" : "not set"})`,
    "opencode reads the second; nothing in the first is visible to it",
    remedy,
  ]) {
    if (!output.includes(needle)) throw new Error(`the stranded finding lacks "${needle}":\n${output}`)
  }
  if (output.includes("ocm is not installed here")) {
    throw new Error(`the not-installed line must not appear while an install is stranded:\n${output}`)
  }
}

// the breadcrumb names every root a registry write went to; the cache does
// not move, which is what makes the stranded check symmetric
function expectBreadcrumb(home, root) {
  const file = ROOTS_FILE(home)
  const recorded = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null
  if (!recorded?.roots?.includes(root)) {
    throw new Error(`expected the breadcrumb at ${file} to record ${root} after a registry write, got ${JSON.stringify(recorded)}`)
  }
}

phase("13. an install in the default root is reported as stranded when XDG_CONFIG_HOME moves the active root: both roots and the count named, the breadcrumb recorded, nothing moved", async (home) => {
  expect(ocm(home, ["init"]).status).toBe(0)
  expect(ocm(home, ["add", localMp(home)]).status).toBe(0)
  const registryBytes = readFileSync(registryFile(home), "utf8")
  const xdg = join(home, "xdg")
  const diagnosed = ocm(home, ["doctor"], 300_000, { env: { XDG_CONFIG_HOME: xdg } })
  if (diagnosed.status !== 1) throw new Error(`ocm doctor exited ${diagnosed.status}, expected 1 with a stranded install:\n${diagnosed.output}`)
  expectStranded(diagnosed.output, cfg(home), join(xdg, "opencode"), true)
  expectBreadcrumb(home, cfg(home))
  expect(readFileSync(registryFile(home), "utf8")).toBe(registryBytes) // nothing is migrated
  const forbidden = []
  const stack = [home]
  while (stack.length) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".claude" || entry.name === ".agents") forbidden.push(join(dir, entry.name))
      if (entry.isDirectory()) stack.push(join(dir, entry.name))
    }
  }
  if (forbidden.length) throw new Error(`expected nothing under ~/.claude or ~/.agents, found: ${forbidden.join(", ")}`)
}, 420_000)

phase("13b. an install made before the breadcrumb existed is still reported: no roots.json, XDG_CONFIG_HOME set (review finding)", async (home) => {
  // the upgrade path: everything installed by v0.5.0 left no breadcrumb, so a
  // user who already had XDG_CONFIG_HOME set would otherwise see their whole
  // install vanish with no explanation — the default root is checked directly
  expect(ocm(home, ["init"]).status).toBe(0)
  expect(ocm(home, ["add", localMp(home)]).status).toBe(0)
  rmSync(ROOTS_FILE(home), { force: true })
  const xdg = join(home, "xdg")
  const diagnosed = ocm(home, ["doctor"], 300_000, { env: { XDG_CONFIG_HOME: xdg } })
  if (diagnosed.status !== 1) throw new Error(`ocm doctor exited ${diagnosed.status}, expected 1 with a pre-breadcrumb install stranded:\n${diagnosed.output}`)
  expectStranded(diagnosed.output, cfg(home), join(xdg, "opencode"), true)
}, 300_000)

phase("14. the reverse direction via the breadcrumb: an install made with XDG_CONFIG_HOME set is reported as stranded once the variable is gone", async (home) => {
  const xdg = join(home, "xdg")
  const env = { XDG_CONFIG_HOME: xdg }
  expect(ocm(home, ["init"], 120_000, { env }).status).toBe(0)
  expect(ocm(home, ["add", localMp(home)], 120_000, { env }).status).toBe(0)
  const diagnosed = ocm(home, ["doctor"], 300_000) // no variable: the default root is active and empty
  if (diagnosed.status !== 1) throw new Error(`ocm doctor exited ${diagnosed.status}, expected 1 with a stranded install:\n${diagnosed.output}`)
  expectStranded(diagnosed.output, join(xdg, "opencode"), cfg(home), false)
}, 420_000)

phase("15. a relative XDG_CONFIG_HOME draws the doctor warning naming the cwd dependence and the absolute-path remedy", async (home) => {
  const diagnosed = ocm(home, ["doctor"], 300_000, { env: { XDG_CONFIG_HOME: "rel-dir" } })
  for (const needle of ["XDG_CONFIG_HOME is relative", "different directory", "set it to an absolute path"]) {
    if (!diagnosed.output.includes(needle)) throw new Error(`the relative-XDG warning lacks "${needle}":\n${diagnosed.output}`)
  }
  assertAbsent(join(home, ".config")) // doctor without --fix writes nothing
  assertAbsent(join(process.cwd(), "rel-dir")) // the relative root is joined, never created
}, 300_000)

phase("16. no other root with a marketplace keeps the old sentence: after ocm remove leaves an empty registry, doctor says 'not installed'", async (home) => {
  expect(ocm(home, ["init"]).status).toBe(0)
  expect(ocm(home, ["add", localMp(home)]).status).toBe(0)
  expect(ocm(home, ["remove", "mp"]).status).toBe(0)
  expect(Object.keys(readRegistry(home).marketplaces)).toEqual([]) // the registry file survives the remove, empty
  expectBreadcrumb(home, cfg(home)) // the root is known — it just holds nothing
  const diagnosed = ocm(home, ["doctor"], 300_000, { env: { XDG_CONFIG_HOME: join(home, "xdg") } })
  if (diagnosed.status !== 1) throw new Error(`ocm doctor exited ${diagnosed.status}, expected 1:\n${diagnosed.output}`)
  expect(diagnosed.stderr).toBe("error: ocm is not installed here — run ocm init\n")
  expect(diagnosed.stdout).toBe("")
  if (diagnosed.output.includes("stranded")) throw new Error(`an other root with zero marketplaces must not be reported as stranded:\n${diagnosed.output}`)
}, 600_000)

phase("17. both roots hold a registry: doctor reports the non-active root as stranded in both directions and writes nothing", async (home) => {
  expect(ocm(home, ["init"]).status).toBe(0)
  expect(ocm(home, ["add", localMp(home, "mp-one")]).status).toBe(0)
  const xdg = join(home, "xdg")
  const env = { XDG_CONFIG_HOME: xdg }
  expect(ocm(home, ["init"], 120_000, { env }).status).toBe(0)
  expect(ocm(home, ["add", localMp(home, "mp-two")], 120_000, { env }).status).toBe(0)
  const registries = [registryFile(home), join(xdg, "opencode", "ocm", "registry.json")]
  const before = registries.map((p) => readFileSync(p, "utf8"))
  const withVariable = ocm(home, ["doctor"], 300_000, { env })
  if (withVariable.status !== 1) throw new Error(`ocm doctor exited ${withVariable.status}, expected 1 with the default root stranded:\n${withVariable.output}`)
  expectStranded(withVariable.output, cfg(home), join(xdg, "opencode"), true)
  const withoutVariable = ocm(home, ["doctor"], 300_000)
  if (withoutVariable.status !== 1) throw new Error(`ocm doctor exited ${withoutVariable.status}, expected 1 with the xdg root stranded:\n${withoutVariable.output}`)
  expectStranded(withoutVariable.output, join(xdg, "opencode"), cfg(home), false)
  expect(registries.map((p) => readFileSync(p, "utf8"))).toEqual(before) // no automatic reconciliation
}, 900_000)

// brief 28 §4 edge: a marketplace installed by an older ocm whose registry
// records a folded component pair — doctor reports the pair as an error
// with the rename action and leaves the working link alone (removing it
// would uninstall a working command)
phase("18. an installed marketplace whose registry records a folded command pair is a doctor error with the rename action; the link is left alone", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { "case-kit": { "plugin.json": PLUGIN_JSON, commands: { "run.md": COMMAND } } } })
  expect(ocm(home, ["add", mp]).status).toBe(0)
  const link = join(cfg(home), "commands", "case-kit:run.md")
  assertResolves(link, join(mp, "plugins", "case-kit", "commands", "run.md"))
  // the v0.5.0 shape: the registry recorded both spellings while the
  // filesystem served one
  const registry = readRegistry(home)
  registry.marketplaces.mp.plugins["case-kit"].components.command = ["Run.md", "run.md"]
  writeFileSync(registryFile(home), `${JSON.stringify(registry, null, 2)}\n`)
  const diagnosed = ocm(home, ["doctor"], 300_000)
  if (diagnosed.status !== 1) throw new Error(`ocm doctor exited ${diagnosed.status}, expected 1 with a folded pair recorded:\n${diagnosed.output}`)
  const line = diagnosed.output.split("\n").find((l) => /^\s*error\b/.test(l) && l.includes("differ only in case") && l.includes("Run.md") && l.includes("run.md"))
  if (!line) throw new Error(`expected an error finding naming the folded pair Run.md/run.md:\n${diagnosed.output}`)
  if (!line.includes("rename")) throw new Error(`the folded-pair finding must carry the rename action:\n${line}`)
  // the links are left alone: the report never uninstalls a working command
  assertResolves(link, join(mp, "plugins", "case-kit", "commands", "run.md"))
}, 420_000)

// brief 34 §1.4: a shape-invalid ocm-- mcp key written by v0.5.0, before the
// guard existed — doctor reports it naming the plugin and the server, and
// --fix removes exactly the offending key (the only recovery path that does
// not require hand-editing JSON, since ocm still runs when opencode does not)
phase("19. a shape-invalid ocm-- MCP key is a doctor error naming plugin and server; --fix removes exactly that key and leaves the user's own mcp entries byte-identical", async (home) => {
  // config safety: the user's keys predate every ocm write
  const userConfig = { model: "claude-sonnet-4-6", mcp: { "user-server": { type: "local", command: ["echo"] } } }
  writeTree(cfg(home), { "opencode.json": json(userConfig) })
  expect(ocm(home, ["init"]).status).toBe(0)
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { adw: {
    "plugin.json": PLUGIN_JSON,
    commands: { "commit.md": COMMAND },
    "mcp.json": json({ db: { type: "local", command: ["npx", "-y", "@acme/db-mcp"], enabled: true } }),
  } } })
  expect(ocm(home, ["add", mp, "--trust"]).status).toBe(0)
  const configPath = configFile(home)
  const before = JSON.parse(readFileSync(configPath, "utf8"))
  if (before.mcp?.["ocm--adw--db"] === undefined) {
    throw new Error(`expected ocm--adw--db in ${configPath} after the add:\n${JSON.stringify(before.mcp ?? null)}`)
  }
  // the pre-1.18 shape v0.5.0 wrote: no "type", a string command. The plugin
  // is known to the registry, so the orphaned-key check cannot be what fires
  before.mcp["ocm--adw--legacy"] = { command: "node", args: ["server.js"] }
  // review finding: a server name may itself contain "--". Deriving a plugin
  // name from the bad key and handing it to the plugin-scoped writer would
  // take this valid sibling with it through the writer's prefix branch.
  const nested = { type: "local", command: ["date"], enabled: true }
  before.mcp["ocm--adw--legacy--sub"] = nested
  writeFileSync(configPath, json(before))
  const userServer = JSON.stringify(before.mcp["user-server"])

  const diagnosed = ocm(home, ["doctor"], 300_000)
  if (diagnosed.status !== 1) {
    throw new Error(`ocm doctor exited ${diagnosed.status}, expected 1 with a shape-invalid ocm-- key:\n${diagnosed.output}`)
  }
  // the key names the plugin and the server: ocm--<plugin>--<server>
  const line = diagnosed.output.split("\n").find((l) => /^\s*error\b/.test(l) && l.includes("ocm--adw--legacy"))
  if (!line) throw new Error(`expected an error finding naming the bad key ocm--adw--legacy:\n${diagnosed.output}`)

  const fixed = ocm(home, ["doctor", "--fix"], 300_000)
  if (fixed.status !== 0) throw new Error(`ocm doctor --fix exited ${fixed.status}:\n${fixed.output}`)
  const after = JSON.parse(readFileSync(configPath, "utf8"))
  expect(after.mcp["ocm--adw--legacy"]).toBeUndefined() // exactly the offending key removed
  expect(after.mcp["ocm--adw--db"]).toBeDefined() // the valid sibling of the same plugin survives
  expect(after.mcp["ocm--adw--legacy--sub"]).toEqual(nested) // a server whose name contains "--" is not collateral
  expect(JSON.stringify(after.mcp["user-server"])).toBe(userServer) // the user's own entry, byte-identical
  expect(after.model).toBe(userConfig.model) // config safety: outside ocm's keys, untouched
}, 600_000)

// brief 31 §8: a registry record naming a component with no materialization
// and no blocked reason is a stale record — the pre-brief-31 discovery-
// derived shape frozen in the file (F76), with ocm update as the remedy
phase("20. a record naming a component with no materialization is a stale-record error naming the remedy; ocm update drops it and a follow-up doctor is clean", async (home) => {
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
  expect(ocm(home, ["add", `file://${remote}`, "--name", "mp"]).status).toBe(0)
  // the fixture is clean before the hand-edit, so any later finding is the ghost
  const baseline = ocm(home, ["doctor"], 300_000)
  if (baseline.status !== 0) throw new Error(`ocm doctor exited ${baseline.status} on the clean fixture:\n${baseline.output}`)
  // the pre-brief-31 record: discovery-derived components naming a file that
  // never materialized
  const registry = readRegistry(home)
  registry.marketplaces.mp.plugins.adw.components.command.push("ghost.md")
  writeFileSync(registryFile(home), `${JSON.stringify(registry, null, 2)}\n`)
  const diagnosed = ocm(home, ["doctor"], 300_000)
  if (diagnosed.status !== 1) throw new Error(`ocm doctor exited ${diagnosed.status}, expected 1 with a stale record:\n${diagnosed.output}`)
  const line = diagnosed.output.split("\n").find((l) => /^\s*error\b/.test(l) && l.includes("ghost.md"))
  if (!line) throw new Error(`expected an error finding naming ghost.md:\n${diagnosed.output}`)
  for (const needle of ['marketplace "mp"', 'plugin "adw"', 'command "ghost.md"', "stale record", "ocm update mp"]) {
    if (!line.includes(needle)) throw new Error(`the stale-record finding lacks "${needle}":\n${line}`)
  }
  // the remedy works: the update rewrites the record from its outcomes
  const updated = ocm(home, ["update", "mp"], 300_000)
  if (updated.status !== 0) throw new Error(`ocm update mp exited ${updated.status}:\n${updated.output}`)
  expect(readRegistry(home).marketplaces.mp.plugins.adw.components.command).toEqual(["commit.md"])
  const clean = ocm(home, ["doctor"], 300_000)
  if (clean.status !== 0) throw new Error(`ocm doctor exited ${clean.status} after the update:\n${clean.output}`)
}, 600_000)

// brief 31 §8: a component withheld pending trust is blocked, not stale —
// the stale-record check must not turn an undecided trust state into drift
phase("21. an undecided marketplace's blocked plugin and mcp components are withheld, not stale: no stale-record line for them", async (home) => {
  // config safety: the user's own config and mcp key predate the add
  const userConfig = { model: "claude-sonnet-4-6", mcp: { "user-server": { type: "local", command: ["echo"] } } }
  writeTree(cfg(home), { "opencode.json": json(userConfig) })
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { adw: {
    "plugin.json": PLUGIN_JSON,
    commands: { "commit.md": COMMAND },
    plugin: { "notify.js": JS_PLUGIN },
    "mcp.json": MCP,
  } } })
  // a piped add leaves trust undecided, so both executable components are blocked
  expect(ocm(home, ["add", `file://${remote}`, "--name", "mp"]).status).toBe(0)
  const entry = readRegistry(home).marketplaces.mp
  if (entry.trust.code !== "none") throw new Error(`expected the piped add to leave trust undecided, got "${entry.trust.code}"`)
  assertAbsent(pluginLink(home, "adw", "notify.js"))
  const parsed = JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8"))
  expect(parsed.model).toBe(userConfig.model) // the user's keys survive the add
  expect(JSON.stringify(parsed.mcp["user-server"])).toBe(JSON.stringify(userConfig.mcp["user-server"]))
  expect(parsed.mcp["ocm--adw--db"]).toBeUndefined() // the blocked mcp component never materialized
  const configBytes = readFileSync(join(cfg(home), "opencode.json"), "utf8") // doctor must not touch it further
  // the pre-brief-31 record shape: the blocked components recorded although
  // they never materialized
  const registry = readRegistry(home)
  const components = registry.marketplaces.mp.plugins.adw.components
  components.plugin = ["notify.js"]
  components.mcp = ["db"]
  writeFileSync(registryFile(home), `${JSON.stringify(registry, null, 2)}\n`)
  const diagnosed = ocm(home, ["doctor"], 300_000)
  const stale = diagnosed.output.split("\n").filter((l) => l.includes("stale record"))
  if (stale.length) throw new Error(`blocked components must not be reported as stale records:\n${stale.join("\n")}`)
  expect(readFileSync(join(cfg(home), "opencode.json"), "utf8")).toBe(configBytes) // doctor writes nothing
}, 420_000)
}

// brief 38 §2: no finding may claim a fix the run did not perform.
// setSkillsPath returns null both for "I wrote the config" and "nothing to
// do" (including when there is no opencode.json at all), so doctor-orphans
// prints `fixed …: removed from skills.paths` for an orphaned mirror tree
// whose skills dir was never in any skills.paths. The fixed line may print
// only when a write actually happened; brief 38 tests 2 and 7, scoped to
// doctor --fix, live here too.
{
// the file-level ocm helper cannot set the child's XDG_CONFIG_HOME, and the
// two-root test below needs it — same signature as the absorbed block above
function ocm(home, args, timeout = 120_000, options = {}) {
  const r = spawnSync(process.execPath, [OCM_BIN, ...args], {
    env: withFakeOpencode({ ...process.env, HOME: home, ...options.env }, options), encoding: "utf8", timeout,
  })
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` }
}

const fixedLines = (output) => output.split("\n").filter((l) => /^\s*fixed\b/.test(l))

// an orphaned skill mirror under an unregistered marketplace's link tree,
// phase-4 fixture style: a rendered SKILL.md, and no marketplace named
// "ghost" in any registry or config
function seedGhostMirror(linksDir) {
  const mirror = join(linksDir, "ghost", "skills", "demo-kit--tdd")
  writeTree(mirror, { "SKILL.md": "---\nname: \"demo-kit:tdd\"\ndescription: orphaned mirror\n---\n\nBody.\n" })
  return mirror
}

phase("22. doctor --fix on a home with no opencode.json removes an orphaned mirror tree and prints no skills.paths claim", async (home) => {
  expect(ocm(home, ["init"]).status).toBe(0)
  // verified against src/loader.ts: init installs the loader trio and
  // tui.json, never opencode.json
  assertAbsent(configFile(home))
  const mirror = seedGhostMirror(join(rootCacheDir(home), "links"))
  const fixed = ocm(home, ["doctor", "--fix"], 300_000)
  if (fixed.status !== 0) throw new Error(`ocm doctor --fix exited ${fixed.status}:\n${fixed.output}`)
  assertAbsent(mirror) // the removal did happen
  assertAbsent(join(rootCacheDir(home), "links", "ghost"))
  assertAbsent(configFile(home)) // the config the claimed write would have touched
  if (!fixedLines(fixed.output).some((l) => l.includes(mirror))) {
    throw new Error(`expected a fixed line naming the removed mirror ${mirror}:\n${fixed.output}`)
  }
  if (fixed.output.includes("removed from skills.paths")) {
    throw new Error(`doctor claims a skills.paths removal, but ${configFile(home)} never existed:\n${fixed.output}`)
  }
  for (const line of fixedLines(fixed.output)) {
    if (line.includes("skills.paths")) throw new Error(`a fixed line mentions skills.paths for a config that does not exist:\n${line}`)
  }
}, 600_000)

phase("23. doctor --fix under root A with root B installed: B's links and config stay untouched, and no fixed line claims a skills.paths write the run did not make", async (home) => {
  const xdg = join(home, "xdg")
  const env = { XDG_CONFIG_HOME: xdg }
  // root A: the user's config, skills entry and plugin predate every ocm write
  const userSkills = join(home, "my-skills")
  writeTree(userSkills, { "SKILL.md": SKILL("style") })
  writeTree(cfg(home), { "opencode.json": json({ model: "claude-sonnet-4-6", skills: { paths: [userSkills] } }), plugins: { "my-own.js": USER_PLUGIN } })
  expect(ocm(home, ["init"]).status).toBe(0)
  writeTree(join(home, "mp-a"), { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND }, skills: { style: { "SKILL.md": SKILL("style") } } } } })
  expect(ocm(home, ["add", join(home, "mp-a")]).status).toBe(0)
  // root B, reached only through XDG_CONFIG_HOME
  expect(ocm(home, ["init"], 120_000, { env }).status).toBe(0)
  writeTree(join(home, "mp-b"), { plugins: { beta: { "plugin.json": PLUGIN_JSON, commands: { "lint.md": COMMAND }, skills: { lint: { "SKILL.md": SKILL("lint") } } } } })
  expect(ocm(home, ["add", join(home, "mp-b")], 120_000, { env }).status).toBe(0)
  // an orphaned mirror tree in root A's namespace only, registered nowhere
  // and absent from every skills.paths
  const mirror = seedGhostMirror(join(rootCacheDir(home), "links"))
  const bConfigFile = join(xdg, "opencode", "opencode.json")
  const bConfigBefore = readFileSync(bConfigFile, "utf8")
  const bMirror = join(rootCacheDir(home, xdg), "links", "mp-b", "skills", "beta--lint")
  const fixed = ocm(home, ["doctor", "--fix"], 300_000) // root A: no XDG variable
  // exit 1 is expected, not a failure: root B holds a marketplace, so doctor
  // under root A reports it as a stranded install — an error finding that
  // sets the exit code even though the fixes ran (src/commands/doctor.ts
  // pushes strandedRoots() as errors before reportFindings)
  if (fixed.status !== 1) throw new Error(`ocm doctor --fix exited ${fixed.status}, expected 1 with root B stranded:\n${fixed.output}`)
  const errors = fixed.output.split("\n").filter((l) => /^\s*error\b/.test(l))
  if (errors.length !== 1 || !errors[0].includes("an ocm install is stranded in another config root")) {
    throw new Error(`expected exactly one error finding, the stranded root B — anything else means the exit code is 1 for the wrong reason:\n${fixed.output}`)
  }
  if (!fixed.output.includes(`installed at: ${join(xdg, "opencode")}`)) throw new Error(`the stranded finding must name root B:\n${fixed.output}`)
  // root B is untouched: its link tree, its config bytes, its own entry
  assertFileExists(join(bMirror, "SKILL.md"))
  expect(readFileSync(bConfigFile, "utf8")).toBe(bConfigBefore)
  expect(JSON.parse(readFileSync(bConfigFile, "utf8")).skills.paths).toContain(join(rootCacheDir(home, xdg), "links", "mp-b", "skills"))
  // root A's orphan is gone; its own registered entry and the user's survive
  assertAbsent(mirror)
  assertAbsent(join(rootCacheDir(home), "links", "ghost"))
  const aConfig = JSON.parse(readFileSync(configFile(home), "utf8"))
  expect(aConfig.skills.paths).toContain(join(rootCacheDir(home), "links", "mp-a", "skills"))
  expect(aConfig.skills.paths).toContain(userSkills)
  expect(readFileSync(join(cfg(home), "plugins", "my-own.js"), "utf8")).toBe(USER_PLUGIN)
  // every fixed line corresponds to a write: the mirror removal is there,
  // nothing claims a skills.paths write (the ghost dir was never in any
  // config), and nothing mentions root B's cache namespace
  const lines = fixedLines(fixed.output)
  if (!lines.some((l) => l.includes(mirror))) throw new Error(`expected a fixed line naming the removed mirror ${mirror}:\n${fixed.output}`)
  for (const line of lines) {
    if (line.includes("skills.paths")) {
      throw new Error(`doctor claims a skills.paths removal for ${mirror}, which was never in any skills.paths:\n${line}`)
    }
    if (line.includes(rootCacheDir(home, xdg))) throw new Error(`a fixed line mentions root B's cache namespace:\n${line}`)
  }
}, 600_000)

// positive control: the truthful line must not disappear when the fix lands
phase("24. when the orphaned tree's skills dir IS in skills.paths, doctor --fix removes both and the fixed line still prints", async (home) => {
  expect(ocm(home, ["init"]).status).toBe(0)
  const mirror = seedGhostMirror(join(rootCacheDir(home), "links"))
  const ghostSkills = join(rootCacheDir(home), "links", "ghost", "skills")
  const userSkills = join(home, "my-skills")
  writeTree(userSkills, { "SKILL.md": SKILL("style") })
  writeTree(cfg(home), { "opencode.json": json({ model: "claude-sonnet-4-6", skills: { paths: [userSkills, ghostSkills] } }) })
  const fixed = ocm(home, ["doctor", "--fix"], 300_000)
  if (fixed.status !== 0) throw new Error(`ocm doctor --fix exited ${fixed.status}:\n${fixed.output}`)
  if (!fixedLines(fixed.output).some((l) => l.includes("removed from skills.paths") && l.includes(ghostSkills))) {
    throw new Error(`expected a fixed line naming ${ghostSkills} as removed from skills.paths:\n${fixed.output}`)
  }
  expect(JSON.parse(readFileSync(configFile(home), "utf8")).skills.paths).toEqual([userSkills]) // ocm's entry cleaned, the user's stays
  assertAbsent(mirror)
  assertAbsent(join(rootCacheDir(home), "links", "ghost"))
}, 600_000)

phase("25. ownership through doctor --fix: user keys, skills entry, command and plugin survive, and a second --fix is a full no-op", async (home) => {
  expect(ocm(home, ["init"]).status).toBe(0)
  const mirror = seedGhostMirror(join(rootCacheDir(home), "links"))
  const ghostSkills = join(rootCacheDir(home), "links", "ghost", "skills")
  const userSkills = join(home, "my-skills")
  writeTree(userSkills, { "SKILL.md": SKILL("style") })
  const userConfig = { model: "claude-sonnet-4-6", permission: { edit: "allow" }, skills: { paths: [userSkills, ghostSkills] }, mcp: { "user-server": { type: "local", command: ["echo"] } } }
  writeTree(cfg(home), { "opencode.json": json(userConfig), commands: { "mine.md": "# my own command\n" }, plugins: { "my-own.js": USER_PLUGIN } })
  const fixed = ocm(home, ["doctor", "--fix"], 300_000)
  if (fixed.status !== 0) throw new Error(`ocm doctor --fix exited ${fixed.status}:\n${fixed.output}`)
  const after = JSON.parse(readFileSync(configFile(home), "utf8"))
  expect(after.skills.paths).toEqual([userSkills]) // the orphaned entry gone, the user's stays
  expect(after.model).toBe(userConfig.model) // config safety: outside ocm's keys, untouched
  expect(after.permission).toEqual(userConfig.permission)
  expect(after.mcp["user-server"]).toEqual(userConfig.mcp["user-server"])
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n") // ownership
  expect(readFileSync(join(cfg(home), "plugins", "my-own.js"), "utf8")).toBe(USER_PLUGIN)
  assertAbsent(mirror)
  assertAbsent(join(rootCacheDir(home), "links", "ghost"))
  // idempotence: a second --fix writes nothing and claims nothing
  const tracked = [configFile(home), registryFile(home), join(cfg(home), "tui.json")]
  const existing = () => tracked.filter((p) => existsSync(p))
  const beforeFiles = existing()
  const before = beforeFiles.map((p) => readFileSync(p, "utf8"))
  const again = ocm(home, ["doctor", "--fix"], 300_000)
  if (again.status !== 0) throw new Error(`second ocm doctor --fix exited ${again.status}:\n${again.output}`)
  expect(existing()).toEqual(beforeFiles)
  expect(existing().map((p) => readFileSync(p, "utf8"))).toEqual(before)
  if (fixedLines(again.output).length) throw new Error(`a second --fix must claim no fixes:\n${again.output}`)
}, 600_000)
}
