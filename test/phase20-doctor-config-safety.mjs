// Phase 20 — docs/specs/20-doctor-config-safety.md: one test per numbered
// item, plus the four invariants (config safety and ownership in 4, 7, 8 and
// 9, idempotence in 2 and 9, no plugin-load errors in 9). The fresh-home
// line is asserted as stderr-only with empty stdout: the spec's "nothing
// else" excludes even the "doctor" header. The orphan sweep is scoped the
// way the spec's body scopes it — ocm--named links in plugins/ plus skill
// mirrors under the ocm links dir, both working, neither registry-backed.
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, opencodeProbe, withFakeHome } from "./harness.mjs"

const OCM_BIN = fileURLToPath(new URL("../bin/ocm.ts", import.meta.url))
const CORE_MODULE = fileURLToPath(new URL("../loader/core.js", import.meta.url))

function ocm(home, args, timeout = 120_000) {
  const r = spawnSync(process.execPath, [OCM_BIN, ...args], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout })
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` }
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
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: 120_000 })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${r.stderr}`)
}
const commitAll = (dir, msg) => { git(dir, ["add", "-A"]); git(dir, ["-c", "user.email=ocm@test", "-c", "user.name=ocm", "commit", "-m", msg]) }
const gitRepo = (dir, tree) => { writeTree(dir, tree); git(dir, ["init", "-b", "main"]); commitAll(dir, "fixture") }

// the loader's startup sync, run the way ocm-loader.js runs it: a child
// process on the fake $HOME (phase 07)
function loaderSync(home) {
  const runner = join(home, "sync-runner.mjs")
  writeFileSync(runner, "const mod = await import(process.argv[2]); await mod.syncAll({ force: true })\n")
  const r = spawnSync(process.execPath, [runner, CORE_MODULE], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 120_000 })
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

const cfg = (home) => join(home, ".config", "opencode")
const configFile = (home) => join(cfg(home), "opencode.json")
const registryFile = (home) => join(cfg(home), "ocm", "registry.json")
const readRegistry = (home) => JSON.parse(readFileSync(registryFile(home), "utf8"))
const cloneDir = (home, name = "mp") => join(home, ".cache", "ocm", "marketplaces", name)
const pluginLink = (home, plugin, file) => join(cfg(home), "plugins", `ocm--${plugin}--${file}`)
const json = (value) => `${JSON.stringify(value, null, 2)}\n`

// realpath on both sides: macOS temp dirs sit behind /var -> /private/var
function assertResolves(dest, source) {
  if (!existsSync(dest) || !lstatSync(dest).isSymbolicLink()) throw new Error(`expected a symlink at ${dest}`)
  expect(realpathSync(dest)).toBe(realpathSync(source))
}

const COMMAND = "---\ndescription: commit helper\n---\n\nCommit body.\n"
const SKILL = "---\nname: style\ndescription: style guidance\n---\n\n# Style\n\nBody.\n"
const JS_PLUGIN = 'export default { id: "phase20-notify", server: async () => ({}) }\n'
const JS_PLUGIN_OTHER = 'export default { id: "phase20-other", server: async () => ({}) }\n'
const USER_PLUGIN = 'export default { id: "mine", server: async () => ({}) }\n'
const MCP = json({ db: { type: "local", command: ["npx", "-y", "@acme/db-mcp"], enabled: true } })
const PLUGIN_JSON = json({ description: "demo plugin" }) // spec 19: installable plugins carry a manifest

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
  const probe = opencodeProbe(cfg(home), home)
  if (!probe.available) console.log("skipped: opencode is not on PATH")
  else if (probe.unreliable) throw new Error("probe cannot trust itself: the canary broken plugin produced no error line")
  else expect(probe.pluginErrors).toEqual([])
}, 900_000)
