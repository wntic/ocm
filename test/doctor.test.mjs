// Doctor: diagnosing an installation for its consumer.

import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, assertFileExists, withFakeHome } from "./harness.mjs"

// Helpers shared verbatim by the absorbed files below.

const OCM_BIN = fileURLToPath(new URL("../bin/ocm.ts", import.meta.url))

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

const cloneDir = (home, name = "mp") => join(home, ".cache", "ocm", "marketplaces", name)

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
  const goneOcm = join(home, ".cache", "ocm", "links", "gone", "skills")
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
  expect(lstatSync(join(home, ".cache", "ocm", "links", "mp", "skills", "adw--style")).isDirectory()).toBe(true)

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
  assertResolves(join(cfg(home), "commands", "adw:commit.md"), join(home, ".cache", "ocm", "marketplaces", "mp", "plugins", "adw", "commands", "commit.md"))
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
function ocm(home, args, timeout = 120_000) {
  const r = spawnSync(process.execPath, [OCM_BIN, ...args], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout })
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
  const ghostCommand = join(home, ".cache", "ocm", "marketplaces", "ghost", "plugins", "demo-kit", "commands", "tdd.md")
  writeTree(join(home, ".cache", "ocm", "marketplaces", "ghost", "plugins", "demo-kit", "commands"), { "tdd.md": COMMAND })
  const orphanLink = join(cfg(home), "plugins", "ocm--demo-kit--tdd.md")
  symlinkSync(ghostCommand, orphanLink)
  const ghostSkills = join(home, ".cache", "ocm", "links", "ghost", "skills")
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
  expect(result.output).toContain(join(home, ".cache", "ocm", "links", "mp", "skills")) // the exact edit to make by hand
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
}
