// Installing: add, install and uninstall end to end — path spellings,
// plugin-name collisions, displaced originals.

import { spawnSync, spawn } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, mkdtempSync, readlinkSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, assertFileExists, opencodeProbe, withFakeHome, withFakeOpencode } from "./harness.mjs"
import http from "node:http"
import { tmpdir } from "node:os"

// Helpers shared verbatim by the absorbed files below.

const OCM_BIN = fileURLToPath(new URL("../bin/ocm.ts", import.meta.url))

function ocm(home, args, timeout = 120_000) {
  const r = spawnSync(process.execPath, [OCM_BIN, ...args], { env: withFakeOpencode({ ...process.env, HOME: home }), encoding: "utf8", timeout })
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

const cfg = (home) => join(home, ".config", "opencode")

const registryFile = (home) => join(cfg(home), "ocm", "registry.json")

const readRegistry = (home) => JSON.parse(readFileSync(registryFile(home), "utf8"))

const skillsLinks = (home) => join(home, ".cache", "ocm", "links", "mp", "skills")

const COMMAND = "---\ndescription: commit helper\n---\n\nCommit body.\n"

const AGENT = "---\ndescription: code reviewer\n---\n\nReviewer body.\n"

const SKILL = "---\nname: python-style\ndescription: Python style guidance\n---\n\n# Python style\n\nUse ruff.\n"

const json = (value) => `${JSON.stringify(value, null, 2)}\n`

const PLUGIN_JSON = json({ description: "demo plugin" }) // spec 19: installable plugins carry a manifest

const TWO_PLUGINS = {
  adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND }, skills: { "python-style": { "SKILL.md": SKILL } } },
  beta: { "plugin.json": PLUGIN_JSON, commands: { "lint.md": COMMAND } },
}

function materialized(home) {
  const names = []
  for (const dir of [join(cfg(home), "commands"), join(cfg(home), "agents"), skillsLinks(home)]) {
    try {
      names.push(...readdirSync(dir))
    } catch {}
  }
  return names.sort()
}

function walkPaths(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? [path, ...walkPaths(path)] : [path]
  })
}

const PTY_SCRIPT = fileURLToPath(new URL("./ocm-pty.py", import.meta.url))

function git(dir, args) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: 120_000 })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${result.stderr}`)
  return result.stdout.trim()
}

const commitAll = (dir, message) => {
  git(dir, ["add", "-A"])
  git(dir, ["-c", "user.email=ocm@test", "-c", "user.name=ocm", "commit", "-m", message])
}

const gitRepo = (dir, tree) => { writeTree(dir, tree); git(dir, ["init", "-b", "main"]); commitAll(dir, "fixture") }

const commandLink = (home, plugin = "adw", file = "commit.md") => join(cfg(home), "commands", `${plugin}:${file}`)

const JS_PLUGIN = 'export default { id: "phase18-notify", server: async () => ({}) }\n'

const MCP = json({ db: { type: "local", command: ["npx", "-y", "@acme/db-mcp"], enabled: true } })

const configFile = (home) => join(cfg(home), "opencode.json")

const displacedRoot = (home) => join(home, ".cache", "ocm", "displaced")

function lineWith(output, word) {
  const line = output.split("\n").find((l) => l.includes(word))
  if (!line) throw new Error(`expected a "${word}" line in:\n${output}`)
  return line
}

const GREET = "---\ndescription: my own greet\n---\n\nMy hand-written greet.\n"

const GREET_RECREATED = "---\ndescription: my newer greet\n---\n\nRe-created by hand after the takeover.\n"

const USER_PLUGIN = 'export default { id: "mine", server: async () => ({}) }\n'

// install: add/install/uninstall end to end — absorbed from test/phase05-install.mjs
{
function ocm(home, ...args) {
  const result = spawnSync(process.execPath, [OCM_BIN, ...args], {
    env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 120_000,
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

function fails(home, args, ...needles) {
  const result = ocm(home, ...args)
  if (result.status === 0) throw new Error(`expected a non-zero exit from "ocm ${args.join(" ")}"`)
  for (const needle of needles) expect(`${result.stdout}\n${result.stderr}`).toContain(needle)
}

function addMp(home, plugins = TWO_PLUGINS, ...flags) {
  const dir = join(home, "mp")
  writeTree(dir, { plugins })
  const result = ocm(home, "add", dir, ...flags)
  expect(result.status).toBe(0)
  return [dir, result]
}

// spec 19: every installable plugin carries a plugin.json with a description
const PLUGIN_JSON = `${JSON.stringify({ description: "demo plugin" }, null, 2)}\n`

// realpath on both sides: macOS temp dirs sit behind /var -> /private/var
function assertResolves(dest, source) {
  if (!existsSync(dest) || !lstatSync(dest).isSymbolicLink()) throw new Error(`expected a symlink at ${dest}`)
  expect(realpathSync(dest)).toBe(realpathSync(source))
}

phase("1. install/uninstall/enable/disable matrix: the materialized set matches enabled after every operation", async (home) => {
  addMp(home)
  const BOTH = ["adw--python-style", "adw:commit.md", "beta:lint.md"]
  expect(materialized(home)).toEqual(BOTH)
  const steps = [
    ["uninstall", "adw", ["beta:lint.md"], "adw", false], ["enable", "adw", BOTH, "adw", true],
    ["disable", "beta", ["adw--python-style", "adw:commit.md"], "beta", false], ["install", "beta", BOTH, "beta", true]]
  for (const [verb, plugin, set, name, enabled] of steps) {
    expect(ocm(home, verb, plugin).status).toBe(0)
    expect(materialized(home)).toEqual(set)
    expect(readRegistry(home).marketplaces.mp.plugins[name].enabled).toBe(enabled)
  }
  // invariant: no plugin-load errors attributable to ocm-installed files
}, 420_000)

phase("2. uninstall removes only that plugin's components; the sibling's links, the record and the auto mode survive", async (home) => {
  const [mp] = addMp(home)
  const betaLink = join(cfg(home), "commands", "beta:lint.md")
  const betaIno = lstatSync(betaLink).ino
  expect(ocm(home, "uninstall", "adw").status).toBe(0)
  assertAbsent(join(cfg(home), "commands", "adw:commit.md"))
  assertAbsent(join(skillsLinks(home), "adw--python-style"))
  expect(lstatSync(betaLink).ino).toBe(betaIno) // the sibling link is the same inode, not re-created
  assertResolves(betaLink, join(mp, "plugins", "beta", "commands", "lint.md"))
  // the record is kept for instant offline re-install; one uninstall never flips an auto mode
  const adw = readRegistry(home).marketplaces.mp.plugins.adw
  expect(adw.enabled).toBe(false)
  expect(adw.installedAt).toBeNull()
  expect(readRegistry(home).marketplaces.mp.mode).toBe("auto")
})

phase("3. an --explicit add materializes nothing; a later install materializes one plugin", async (home) => {
  const [mp, report] = addMp(home, TWO_PLUGINS, "--explicit")
  for (const needle of ["available", "adw", "beta"]) expect(report.stdout).toContain(needle)
  expect(materialized(home)).toEqual([])
  const entry = readRegistry(home).marketplaces.mp
  expect(entry.mode).toBe("explicit")
  for (const plugin of Object.values(entry.plugins)) expect(plugin.enabled).toBe(false)
  expect(ocm(home, "install", "adw").status).toBe(0)
  assertResolves(join(cfg(home), "commands", "adw:commit.md"), join(mp, "plugins", "adw", "commands", "commit.md"))
  expect(lstatSync(join(skillsLinks(home), "adw--python-style")).isDirectory()).toBe(true)
  assertAbsent(join(cfg(home), "commands", "beta:lint.md"))
  expect(readRegistry(home).marketplaces.mp.plugins.beta.enabled).toBe(false)
})

phase("4. bare-name and plugin@marketplace resolution, and the resolution error paths", async (home) => {
  const [mp] = addMp(home, TWO_PLUGINS, "--explicit")
  // bare name: one provider proceeds; plugin@marketplace addresses the record
  expect(ocm(home, "install", "adw").status).toBe(0)
  assertResolves(join(cfg(home), "commands", "adw:commit.md"), join(mp, "plugins", "adw", "commands", "commit.md"))
  expect(ocm(home, "install", "beta@mp").status).toBe(0)
  assertResolves(join(cfg(home), "commands", "beta:lint.md"), join(mp, "plugins", "beta", "commands", "lint.md"))
  fails(home, ["install", "adw@nosuch-mp"], "nosuch-mp") // missing marketplace, named
  fails(home, ["install", "nosuch@mp"], "nosuch") // missing plugin, named
  // bare name matching nothing in any marketplace: the error suggests the fix
  fails(home, ["install", "nosuch-plugin"], '"nosuch-plugin"', "not found in any marketplace", "ocm add", "ocm update")
  rmSync(join(mp, "plugins", "adw"), { recursive: true, force: true }) // registered, gone from disk
  fails(home, ["install", "adw"], "ocm update", "mp")
})

phase("5. install --force displaces an unowned file into ~/.cache/ocm/displaced/ and prints the path; without --force it is untouched", async (home) => {
  // the unowned files predate every ocm run, so nothing writes through a link
  const commandDest = join(cfg(home), "commands", "adw:commit.md")
  const agentDest = join(cfg(home), "agents", "adw:reviewer.md")
  writeTree(cfg(home), { commands: { "adw:commit.md": "# my own commit command\n" },
    agents: { "adw:reviewer.md": "# my own reviewer\n" } })
  const [mp] = addMp(home, { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND }, agents: { "reviewer.md": AGENT } } }, "--explicit")
  // invariant: ownership — without --force, no ownership proof means no touch
  const plain = ocm(home, "install", "adw")
  expect(plain.status).toBe(0) // a refusal is never fatal to the operation
  expect(readFileSync(commandDest, "utf8")).toBe("# my own commit command\n")
  expect(readFileSync(agentDest, "utf8")).toBe("# my own reviewer\n")
  expect(`${plain.stdout}\n${plain.stderr}`).toContain(commandDest)
  const forced = ocm(home, "install", "adw", "--force")
  expect(forced.status).toBe(0)
  assertResolves(commandDest, join(mp, "plugins", "adw", "commands", "commit.md"))
  assertResolves(agentDest, join(mp, "plugins", "adw", "agents", "reviewer.md"))
  // the displaced files are moved, not deleted, and the path is printed
  const files = walkPaths(join(home, ".cache", "ocm", "displaced")).filter((p) => lstatSync(p).isFile())
  expect(files.map((p) => readFileSync(p, "utf8")).sort()).toEqual(["# my own commit command\n", "# my own reviewer\n"])
  for (const needle of ["displaced", "adw:commit.md"]) expect(`${forced.stdout}\n${forced.stderr}`).toContain(needle)
})

phase("6. ocm remove leaves zero ocm-- traces in opencode.json, no links, no skills.paths entry, no registry record — and keeps a local marketplace's directory", async (home) => {
  // invariants: config safety and ownership — user keys survive the cycle
  const mcp = { "ocm--adw--context7": { type: "local", command: ["npx", "-y", "@upstash/context7-mcp"] },
    "user-server": { type: "local", command: ["echo"] } }
  const userConfig = { model: "claude-sonnet-4-6", permission: { edit: "allow" }, skills: { paths: ["/users/me/my-skills"] }, mcp }
  writeTree(cfg(home), { "opencode.json": `${JSON.stringify(userConfig, null, 2)}\n` })
  const [mp] = addMp(home)
  expect(ocm(home, "remove", "mp").status).toBe(0)
  const after = JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8"))
  expect(JSON.stringify(after)).not.toContain("ocm--") // zero ocm-- traces
  expect(after.mcp).toEqual({ "user-server": { type: "local", command: ["echo"] } })
  expect(after.skills.paths).toEqual(["/users/me/my-skills"]) // no entry for mp
  expect(after.model).toBe("claude-sonnet-4-6")
  for (const gone of [join(cfg(home), "commands", "adw:commit.md"), join(cfg(home), "commands", "beta:lint.md"),
    join(home, ".cache", "ocm", "links", "mp")]) assertAbsent(gone)
  expect(readRegistry(home).marketplaces.mp).toBeUndefined()
  assertFileExists(join(mp, "plugins", "adw", "commands", "commit.md")) // a local dir is the user's
})

phase("7. scan of a URL leaves no temp directory and no registry change", async (home) => {
  const remote = join(home, "remote", "mp")
  writeTree(remote, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
  const git = (...args) => spawnSync("git", args, { cwd: remote, encoding: "utf8" })
  for (const args of [["init"], ["add", "-A"], ["-c", "user.email=ocm@test", "-c", "user.name=ocm", "commit", "-m", "fixture"]]) {
    expect(git(...args).status).toBe(0)
  }
  const scanned = ocm(home, "scan", `file://${remote}`)
  expect(scanned.status).toBe(0)
  expect(scanned.stdout).toContain("adw") // reports what would be installed
  // never modifies the registry, never writes outside its temp directory
  assertAbsent(registryFile(home))
  assertAbsent(join(home, ".cache", "ocm", "marketplaces"))
  expect(walkPaths(join(home, ".cache")).filter((p) => p.includes(".scan-"))).toEqual([])
})

phase("8. idempotence: every per-plugin verb run twice is a no-op the second time", async (home) => {
  addMp(home)
  // add and remove refuse on a repeat by design (spec 05 add step 3)
  const snap = () => [readFileSync(registryFile(home), "utf8"), materialized(home).join(",")]
  const verbs = [["uninstall", "adw"], ["install", "adw"], ["uninstall", "beta"], ["enable", "beta"], ["disable", "adw"], ["install", "adw"]]
  for (const [verb, plugin] of verbs) {
    expect(ocm(home, verb, plugin).status).toBe(0)
    const afterFirst = snap()
    const second = ocm(home, verb, plugin)
    expect(second.status).toBe(0)
    expect(snap()).toEqual(afterFirst)
    expect(second.stdout).not.toContain("restart opencode") // nothing created
  }
})

phase("add of a marketplace with zero plugins errors naming the expected layout and registers nothing", async (home) => {
  const empty = join(home, "empty-mp")
  writeTree(empty, { "readme.md": "not a marketplace\n" })
  fails(home, ["add", empty], "no plugins", "plugins/<name>")
  const registry = existsSync(registryFile(home)) ? readRegistry(home) : { marketplaces: {} }
  expect(registry.marketplaces["empty-mp"]).toBeUndefined()
})

phase("add checks plugin-name collisions against the whole registry before writing anything", async (home) => {
  const incumbent = join(home, "mp-a")
  const rival = join(home, "mp-b")
  writeTree(incumbent, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
  expect(ocm(home, "add", incumbent).status).toBe(0)
  writeTree(rival, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "deploy.md": COMMAND } } } })
  fails(home, ["add", rival], "mp-a", "mp-b", '"adw"')
  expect(readRegistry(home).marketplaces["mp-b"]).toBeUndefined()
  assertAbsent(join(cfg(home), "commands", "adw:deploy.md"))
})

phase("list --all shows disabled plugins with a (disabled) marker; plain list omits them", async (home) => {
  addMp(home)
  expect(ocm(home, "uninstall", "beta").status).toBe(0)
  const all = ocm(home, "list", "--all")
  expect(all.status).toBe(0)
  for (const needle of ["beta", "(disabled)", "auto"]) expect(all.stdout).toContain(needle)
  const plain = ocm(home, "list")
  expect(plain.status).toBe(0)
  expect(plain.stdout).toContain("adw")
  expect(plain.stdout).not.toContain("beta")
})
}

// add integrity: path spellings agree; a private repo fails cleanly — absorbed from test/phase17-add-integrity.mjs
{
function ocm(home, args, options = {}) {
  const result = spawnSync(process.execPath, [OCM_BIN, ...args], {
    env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 120_000, cwd: options.cwd,
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` }
}

// realpath on both sides: macOS temp dirs sit behind /var -> /private/var
function assertResolves(dest, source) {
  if (!existsSync(dest) || !lstatSync(dest).isSymbolicLink()) throw new Error(`expected a symlink at ${dest}`)
  expect(realpathSync(dest)).toBe(realpathSync(source))
}

// every directory ocm writes links into, as one comparable string of names
// and symlink targets
function snapTree(dir) {
  if (!existsSync(dir)) return ""
  let out = ""
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(dir, entry.name)
    out += `${entry.name}${entry.isSymbolicLink() ? ` -> ${readlinkSync(path)}` : ""}\n`
    if (entry.isDirectory()) out += snapTree(path)
  }
  return out
}
const snapOutput = (home) => [join(home, ".cache", "ocm", "links"), join(cfg(home), "commands"), join(cfg(home), "agents"), join(cfg(home), "plugins")].map(snapTree).join("--\n")

const COMMAND = "---\ndescription: commit helper\n---\n\nCommit body.\n"
const SKILL = "---\nname: python-style\ndescription: Python style guidance\n---\n\n# Python style\n\nUse ruff.\n"
// spec 19: every installable plugin carries a plugin.json with a description
const PLUGIN_JSON = `${JSON.stringify({ description: "demo plugin" }, null, 2)}\n`

phase("1. a relative path from $HOME installs live links and survives ocm update from an unrelated cwd", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND }, skills: { "python-style": { "SKILL.md": SKILL } } } } })
  const added = ocm(home, ["add", "mp"], { cwd: home })
  if (added.status !== 0) throw new Error(`ocm add mp (relative, cwd $HOME) exited ${added.status}: ${added.output}`)
  const real = realpathSync(mp)
  const entry = readRegistry(home).marketplaces.mp
  if (entry.dir !== real) throw new Error(`expected mp.dir to hold the absolute real path ${real} in ${registryFile(home)}, got ${entry.dir}`)
  assertResolves(commandLink(home), join(mp, "plugins", "adw", "commands", "commit.md"))
  assertFileExists(join(home, ".cache", "ocm", "links", "mp", "skills", "adw--python-style", "SKILL.md"))
  const updated = ocm(home, ["update"], { cwd: tmpdir() })
  if (updated.status !== 0) throw new Error(`ocm update from ${tmpdir()} exited ${updated.status}: ${updated.output}`)
  expect(updated.output).not.toContain("directory missing")
  // invariant: idempotence — a second update from the same unrelated cwd re-creates nothing
  const ino = lstatSync(commandLink(home)).ino
  const again = ocm(home, ["update"], { cwd: tmpdir() })
  if (again.status !== 0) throw new Error(`second ocm update exited ${again.status}: ${again.output}`)
  expect(lstatSync(commandLink(home)).ino).toBe(ino)
  expect(Object.keys(readRegistry(home).marketplaces)).toEqual(["mp"])
  // invariant: no plugin-load errors attributable to ocm-installed files
}, 420_000)

test("2. the relative and absolute spellings of one marketplace produce identical registry bytes", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "ocm-shared-"))
  const mp = join(scratch, "mp")
  writeTree(mp, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
  const bytes = []
  for (const [arg, cwd] of [["mp", scratch], [mp, tmpdir()]]) {
    await withFakeHome(async (home) => {
      const added = ocm(home, ["add", arg], { cwd })
      if (added.status !== 0) throw new Error(`ocm add ${arg} (cwd ${cwd}) exited ${added.status}: ${added.output}`)
      bytes.push(readFileSync(registryFile(home), "utf8"))
    })
  }
  rmSync(scratch, { recursive: true, force: true })
  const normalise = (text) => {
    const registry = JSON.parse(text)
    registry.marketplaces.mp.addedAt = "T"
    for (const plugin of Object.values(registry.marketplaces.mp.plugins)) plugin.installedAt = "T"
    return `${JSON.stringify(registry, null, 2)}\n`
  }
  expect(normalise(bytes[1])).toBe(normalise(bytes[0]))
}, 240_000)

phase("3. a nonexistent path is refused before any write: no registry file, no links", async (home) => {
  const result = ocm(home, ["add", "ocm-no-such-marketplace"], { cwd: tmpdir() })
  expect(result.status).toBe(1)
  expect(result.output).toContain("path does not exist")
  assertAbsent(registryFile(home))
  assertAbsent(join(home, ".cache", "ocm", "links"))
})

phase("4. a 200-char plugin name is refused whole before any write: one error naming the limit, exit 1, zero writes", async (home) => {
  // the user's config and file predate the refused add (invariants: config safety, ownership)
  writeTree(cfg(home), {
    "opencode.json": `${JSON.stringify({ model: "claude-sonnet-4-6", mcp: { "user-server": { type: "local", command: ["echo"] } } }, null, 2)}\n`,
    commands: { "mine.md": "# my own command\n" },
  })
  const good = join(home, "good")
  writeTree(good, { plugins: { keep: { "plugin.json": PLUGIN_JSON, commands: { "keep.md": COMMAND }, skills: { "python-style": { "SKILL.md": SKILL } } } } })
  expect(ocm(home, ["add", good]).status).toBe(0)
  const longName = "a".repeat(200)
  const bad = join(home, "bad")
  writeTree(bad, { plugins: { [longName]: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } }, fine: { "plugin.json": PLUGIN_JSON, commands: { "fine.md": COMMAND } } } })
  const registryBytes = readFileSync(registryFile(home), "utf8")
  const configBytes = readFileSync(join(cfg(home), "opencode.json"), "utf8")
  const links = snapOutput(home)

  const result = ocm(home, ["add", bad])
  expect(result.status).toBe(1)
  const offenders = result.output.split("\n").filter((line) => line.includes("exceeds"))
  if (offenders.length !== 1) throw new Error(`expected exactly one limit error, got ${offenders.length}:\n${result.output}`)
  expect(offenders[0]).toContain("64") // the plugin-name limit the 200-char name breaks
  expect(result.output).not.toContain("ENAMETOOLONG") // never a raw syscall message
  // zero writes: registry, config and every link surface are byte-identical
  expect(readFileSync(registryFile(home), "utf8")).toBe(registryBytes)
  expect(readFileSync(join(cfg(home), "opencode.json"), "utf8")).toBe(configBytes)
  expect(snapOutput(home)).toBe(links)
  expect(readRegistry(home).marketplaces.bad).toBeUndefined() // refused whole, the fine plugin included
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
})

phase("5. an unreachable repo under a tty fails fast with the ocm error instead of hanging at git's prompt", async (home) => {
  // a loopback server answering 401 to everything: git's only way forward is
  // a credential prompt, which in a tty hangs forever (F31)
  const server = http.createServer((req, res) => {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="ocm"' })
    res.end("auth required")
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${server.address().port}/ocm-test/private-repo.git`
  // git config and askpass helpers are neutralised so the terminal is the
  // only credential source; GIT_TERMINAL_PROMPT stays unset — setting it on
  // ocm's own git spawns is the implementation's job
  const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }
  delete env.GIT_TERMINAL_PROMPT
  delete env.GIT_ASKPASS
  delete env.SSH_ASKPASS
  try {
    const started = Date.now()
    // an async spawn (the 401 server lives in this process and must answer
    // while ocm runs); python's own stderr goes to ours
    const child = spawn("python3", [PTY_SCRIPT, "n\r", process.execPath, OCM_BIN, "add", url], {
      env, stdio: ["ignore", "pipe", "inherit"],
    })
    let stdout = ""
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 70_000)
      child.stdout.setEncoding("utf8")
      child.stdout.on("data", (chunk) => (stdout += chunk))
      child.on("error", (err) => { clearTimeout(timer); resolve({ error: err }) })
      child.on("close", () => { clearTimeout(timer); resolve({ stdout }) })
    })
    let run
    try {
      run = JSON.parse(result.stdout ?? "")
    } catch {
      throw new Error(`the pty helper printed no JSON: ${JSON.stringify(result)}`)
    }
    const elapsed = Date.now() - started
    if (run.timed_out) throw new Error(`ocm never exited under the tty (hung at git's credential prompt?), after ${elapsed}ms:\n${run.stderr}`)
    if (run.status === 0) throw new Error(`ocm add of an unreachable repo exited 0:\n${run.stderr}`)
    if (elapsed >= 2000) throw new Error(`expected the failure within 2s, took ${elapsed}ms:\n${run.stderr}`)
    expect(run.stderr).toContain("cannot access")
    expect(run.stderr).toContain(url)
    assertAbsent(join(home, ".cache", "ocm", "marketplaces", "ocm-test--private-repo")) // no clone left behind
  } finally {
    server.closeAllConnections?.()
    server.close()
  }
}, 120_000)

phase("6. add --ref records the cloned revision and a successful lastSync at add time", async (home) => {
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { tool: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } } } })
  git(remote, ["checkout", "-b", "feature"])
  writeFileSync(join(remote, "plugins", "tool", "commands", "feature.md"), COMMAND)
  commitAll(remote, "feature work")
  const featureSha = git(remote, ["rev-parse", "--short", "feature"])
  const added = ocm(home, ["add", `file://${remote}`, "--name", "mp", "--ref", "feature"])
  if (added.status !== 0) throw new Error(`ocm add --ref feature exited ${added.status}: ${added.output}`)
  const entry = readRegistry(home).marketplaces.mp
  if (!entry.revision?.includes(featureSha)) {
    throw new Error(`expected mp.revision to contain ${featureSha} right after the add, got ${JSON.stringify(entry.revision)} in ${registryFile(home)}`)
  }
  if (entry.lastSync?.ok !== true || !entry.lastSync.at) {
    throw new Error(`expected mp.lastSync.ok === true with a timestamp right after the add, got ${JSON.stringify(entry.lastSync)}`)
  }
})

phase("7. a no-match search on a local marketplace does not hint at a stale sync", async (home) => {
  writeTree(join(home, "mp"), { plugins: { solo: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } } } })
  expect(ocm(home, ["add", join(home, "mp")]).status).toBe(0)
  const result = ocm(home, ["search", "zzz-nothing"])
  expect(result.status).toBe(1)
  expect(result.output).toContain('no matches for "zzz-nothing"')
  expect(result.output).not.toContain("ocm update")
  expect(result.output).not.toContain("stale")
})

test("8. a quoted ~/ argument is expanded by ocm itself, and a bare owner/repo gains the repository-shorthand hint", async () => {
  await withFakeHome(async (home) => {
    writeTree(join(home, "mp"), { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
    // the shell passed the tilde through unexpanded; the cwd is unrelated,
    // so only ocm's own expansion can find the directory
    const result = ocm(home, ["add", "~/mp"], { cwd: tmpdir() })
    if (result.status !== 0) throw new Error(`ocm add "~/mp" exited ${result.status}: ${result.output}`)
    const real = realpathSync(join(home, "mp"))
    const entry = readRegistry(home).marketplaces.mp
    if (entry.dir !== real) throw new Error(`expected mp.dir to hold ${real} in ${registryFile(home)}, got ${entry.dir}`)
    assertResolves(commandLink(home), join(home, "mp", "plugins", "adw", "commands", "commit.md"))
  })
  await withFakeHome(async (home) => {
    const result = ocm(home, ["add", "wntic/some-repo"], { cwd: tmpdir() })
    expect(result.status).toBe(1)
    expect(result.output).toContain("path does not exist")
    expect(result.output).toContain("shorthand")
    expect(result.output).toContain("https://github.com")
    assertAbsent(registryFile(home))
  })
}, 240_000)

// brief 28 §3: case-folded plugin directories. Two plugins/ entries that
// differ only in case cannot both be represented on a case-insensitive
// filesystem, so the pair is refused before any write.

// git hash-object -w --stdin: create a blob without touching the working
// tree, so the index can hold a path the checkout cannot represent
function gitBlob(dir, contents) {
  const result = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: dir, encoding: "utf8", input: contents })
  if (result.status !== 0) throw new Error(`git hash-object failed in ${dir}: ${result.stderr}`)
  return result.stdout.trim()
}

// commit a plugins/case-kit sibling beside the on-disk plugins/case-Kit:
// the tree ships both names even where a checkout cannot hold both (F66)
function commitFoldedSibling(dir) {
  for (const [path, contents] of [
    ["plugins/case-kit/plugin.json", PLUGIN_JSON],
    ["plugins/case-kit/commands/run.md", COMMAND],
  ]) {
    git(dir, ["update-index", "--add", "--cacheinfo", `100644,${gitBlob(dir, contents)},${path}`])
  }
  // the index is committed directly: git add -A would collapse the folded
  // entries back to the working tree's single directory on this host
  git(dir, ["-c", "user.email=ocm@test", "-c", "user.name=ocm", "commit", "-m", "folded sibling"])
  const listed = git(dir, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n")
  for (const path of ["plugins/case-Kit/plugin.json", "plugins/case-kit/plugin.json"]) {
    if (!listed.includes(path)) throw new Error(`fixture error: ${dir} HEAD does not ship ${path}: ${JSON.stringify(listed)}`)
  }
}

// invariant: ocm never writes under another tool's directories
function assertNoForeignToolDirs(home) {
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
}

phase("9. a local directory shipping a folded plugins pair is refused whole; a lone mixed-case directory adds cleanly", async (home) => {
  // the user's config and command predate the refused add (invariants: config safety, ownership)
  writeTree(cfg(home), {
    "opencode.json": `${JSON.stringify({ model: "claude-sonnet-4-6", mcp: { "user-server": { type: "local", command: ["echo"] } } }, null, 2)}\n`,
    commands: { "mine.md": "# my own command\n" },
  })
  // negative control, runs on every host: mixed case alone is not a refusal
  const lone = join(home, "lone-mp")
  writeTree(lone, { plugins: { "mixed-Kit": { "plugin.json": PLUGIN_JSON, commands: { "run.md": COMMAND } } } })
  const loneAdd = ocm(home, ["add", lone])
  if (loneAdd.status !== 0) {
    throw new Error(`a lone mixed-case plugin directory must add cleanly — the refusal is about the pair, not the case — got exit ${loneAdd.status}:\n${loneAdd.output}`)
  }
  assertResolves(commandLink(home, "mixed-kit", "run.md"), join(lone, "plugins", "mixed-Kit", "commands", "run.md"))

  const folded = join(home, "folded-mp")
  writeTree(folded, { plugins: {
    "case-Kit": { "plugin.json": PLUGIN_JSON, commands: { "run.md": COMMAND } },
    "case-kit": { "plugin.json": PLUGIN_JSON, commands: { "run.md": COMMAND } },
  } })
  // a case-insensitive host folds the pair onto one directory; the refusal
  // is only observable where both names really exist
  const shipped = readdirSync(join(folded, "plugins"))
  if (!shipped.includes("case-Kit") || !shipped.includes("case-kit")) return
  const registryBytes = readFileSync(registryFile(home), "utf8")
  const configBytes = readFileSync(join(cfg(home), "opencode.json"), "utf8")
  const links = snapOutput(home)
  const result = ocm(home, ["add", folded])
  if (result.status !== 1) throw new Error(`expected exit 1 from the folded-pair add, got ${result.status}:\n${result.output}`)
  for (const needle of ["differ only in case", "plugins/case-Kit and plugins/case-kit", "ask the author to rename one"]) {
    expect(result.output).toContain(needle)
  }
  // zero writes: registry, config and every link surface are byte-identical
  expect(readFileSync(registryFile(home), "utf8")).toBe(registryBytes)
  expect(readFileSync(join(cfg(home), "opencode.json"), "utf8")).toBe(configBytes)
  expect(snapOutput(home)).toBe(links)
  expect(readRegistry(home).marketplaces["folded-mp"]).toBeUndefined()
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
  assertNoForeignToolDirs(home)
}, 240_000)

phase("10. a git marketplace whose tree ships a folded plugins pair is refused whole: exit 1, the clone removed, zero writes", async (home) => {
  // the user's config and command predate the refused add (invariants: config safety, ownership)
  writeTree(cfg(home), {
    "opencode.json": `${JSON.stringify({ model: "claude-sonnet-4-6", mcp: { "user-server": { type: "local", command: ["echo"] } } }, null, 2)}\n`,
    commands: { "mine.md": "# my own command\n" },
  })
  const good = join(home, "good")
  writeTree(good, { plugins: { keep: { "plugin.json": PLUGIN_JSON, commands: { "keep.md": COMMAND } } } })
  expect(ocm(home, ["add", good]).status).toBe(0)
  const registryBytes = readFileSync(registryFile(home), "utf8")
  const configBytes = readFileSync(join(cfg(home), "opencode.json"), "utf8")
  const links = snapOutput(home)

  const remote = join(home, "remote-case")
  gitRepo(remote, { plugins: { "case-Kit": { "plugin.json": PLUGIN_JSON, commands: { "run.md": COMMAND } } } })
  commitFoldedSibling(remote)
  const result = ocm(home, ["add", `file://${remote}`, "--name", "case-mp"])
  if (result.status !== 1) throw new Error(`expected exit 1 from the folded-pair add, got ${result.status}:\n${result.output}`)
  for (const needle of ["differ only in case", "plugins/case-Kit and plugins/case-kit", "ask the author to rename one"]) {
    expect(result.output).toContain(needle)
  }
  assertAbsent(join(home, ".cache", "ocm", "marketplaces", "case-mp")) // the refused clone is cleaned up
  // zero writes: registry, config and every link surface are byte-identical
  expect(readFileSync(registryFile(home), "utf8")).toBe(registryBytes)
  expect(readFileSync(join(cfg(home), "opencode.json"), "utf8")).toBe(configBytes)
  expect(snapOutput(home)).toBe(links)
  expect(readRegistry(home).marketplaces["case-mp"]).toBeUndefined()
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
  assertNoForeignToolDirs(home)
}, 240_000)

// brief 28 §4: case folding inside a plugin. Two component files that
// differ only in case install to one link name on a case-insensitive
// filesystem, so the pair is refused before any write — a name-level rule,
// and the git half fires from the tree where a checkout cannot hold both.

// commit a commands/run.md blob beside the on-disk commands/Run.md: the
// tree ships both names even where a checkout cannot hold both
function commitFoldedCommand(dir) {
  git(dir, ["update-index", "--add", "--cacheinfo", `100644,${gitBlob(dir, COMMAND)},plugins/case-kit/commands/run.md`])
  // the index is committed directly: git add -A would collapse the folded
  // entry back to the working tree's single file on this host
  git(dir, ["-c", "user.email=ocm@test", "-c", "user.name=ocm", "commit", "-m", "folded command sibling"])
  const listed = git(dir, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n")
  for (const path of ["plugins/case-kit/commands/Run.md", "plugins/case-kit/commands/run.md"]) {
    if (!listed.includes(path)) throw new Error(`fixture error: ${dir} HEAD does not ship ${path}: ${JSON.stringify(listed)}`)
  }
}

phase("11. a plugin shipping commands that differ only in case is refused whole; a lone mixed-case command adds cleanly", async (home) => {
  // the user's config and command predate the refused add (invariants: config safety, ownership)
  writeTree(cfg(home), {
    "opencode.json": `${JSON.stringify({ model: "claude-sonnet-4-6", mcp: { "user-server": { type: "local", command: ["echo"] } } }, null, 2)}\n`,
    commands: { "mine.md": "# my own command\n" },
  })
  // negative control, runs on every host: mixed case alone is not a refusal
  const lone = join(home, "lone-mp")
  writeTree(lone, { plugins: { solo: { "plugin.json": PLUGIN_JSON, commands: { "Run.md": COMMAND } } } })
  const loneAdd = ocm(home, ["add", lone])
  if (loneAdd.status !== 0) {
    throw new Error(`a lone mixed-case command must add cleanly — the refusal is about the pair, not the case — got exit ${loneAdd.status}:\n${loneAdd.output}`)
  }
  assertResolves(commandLink(home, "solo", "Run.md"), join(lone, "plugins", "solo", "commands", "Run.md"))

  // local half: a case-insensitive host folds the pair onto one file; the
  // refusal is only observable where both names really exist
  const folded = join(home, "folded-mp")
  writeTree(folded, { plugins: { "case-kit": { "plugin.json": PLUGIN_JSON, commands: { "Run.md": COMMAND, "run.md": COMMAND } } } })
  const shipped = readdirSync(join(folded, "plugins", "case-kit", "commands"))
  if (shipped.includes("Run.md") && shipped.includes("run.md")) {
    const registryBytes = readFileSync(registryFile(home), "utf8")
    const configBytes = readFileSync(join(cfg(home), "opencode.json"), "utf8")
    const links = snapOutput(home)
    const result = ocm(home, ["add", folded])
    if (result.status !== 1) throw new Error(`expected exit 1 from the folded-command add, got ${result.status}:\n${result.output}`)
    for (const needle of [
      'plugin "case-kit" ships two commands that differ only in case',
      "commands/Run.md and commands/run.md both install as case-kit:run.md",
      "rename one in the marketplace",
    ]) {
      expect(result.output).toContain(needle)
    }
    // zero writes: registry, config and every link surface are byte-identical
    expect(readFileSync(registryFile(home), "utf8")).toBe(registryBytes)
    expect(readFileSync(join(cfg(home), "opencode.json"), "utf8")).toBe(configBytes)
    expect(snapOutput(home)).toBe(links)
    expect(readRegistry(home).marketplaces["folded-mp"]).toBeUndefined()
  }

  // git half, runs on every host: the tree ships both paths even where a
  // checkout cannot hold both — this is the half that covers F66
  const good = join(home, "good")
  writeTree(good, { plugins: { keep: { "plugin.json": PLUGIN_JSON, commands: { "keep.md": COMMAND } } } })
  expect(ocm(home, ["add", good]).status).toBe(0)
  const registryBytes = readFileSync(registryFile(home), "utf8")
  const configBytes = readFileSync(join(cfg(home), "opencode.json"), "utf8")
  const links = snapOutput(home)
  const remote = join(home, "remote-case")
  gitRepo(remote, { plugins: { "case-kit": { "plugin.json": PLUGIN_JSON, commands: { "Run.md": COMMAND } } } })
  commitFoldedCommand(remote)
  const result = ocm(home, ["add", `file://${remote}`, "--name", "case-mp"])
  if (result.status !== 1) throw new Error(`expected exit 1 from the folded-command add, got ${result.status}:\n${result.output}`)
  for (const needle of ["differ only in case", "plugins/case-kit/commands/Run.md and plugins/case-kit/commands/run.md", "both install as case-kit:run.md"]) {
    expect(result.output).toContain(needle)
  }
  assertAbsent(join(home, ".cache", "ocm", "marketplaces", "case-mp")) // the refused clone is cleaned up
  // zero writes: registry, config and every link surface are byte-identical
  expect(readFileSync(registryFile(home), "utf8")).toBe(registryBytes)
  expect(readFileSync(join(cfg(home), "opencode.json"), "utf8")).toBe(configBytes)
  expect(snapOutput(home)).toBe(links)
  expect(readRegistry(home).marketplaces["case-mp"]).toBeUndefined()
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
  assertNoForeignToolDirs(home)
}, 240_000)

phase("12. mcp.json server keys that differ only in case stay two servers: the fold rule guards link names, never JSON keys", async (home) => {
  // invariant: config safety — the user's key predates the add and survives it
  writeTree(cfg(home), { "opencode.json": `${JSON.stringify({ model: "claude-sonnet-4-6", mcp: { "user-server": { type: "local", command: ["echo"] } } }, null, 2)}\n` })
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { p: {
    "plugin.json": PLUGIN_JSON,
    commands: { "work.md": COMMAND },
    "mcp.json": json({ Everything: { type: "local", command: ["echo", "upper"], enabled: true }, everything: { type: "local", command: ["echo", "lower"], enabled: true } }),
  } } })
  const added = ocm(home, ["add", mp, "--trust"])
  if (added.status !== 0) throw new Error(`ocm add --trust exited ${added.status}:\n${added.output}`)
  const mcp = JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8")).mcp
  expect(mcp["ocm--p--Everything"]).toEqual({ type: "local", command: ["echo", "upper"], enabled: true })
  expect(mcp["ocm--p--everything"]).toEqual({ type: "local", command: ["echo", "lower"], enabled: true })
  expect(mcp["user-server"]).toEqual({ type: "local", command: ["echo"] })
})
}

// collisions: plugin-name collisions across marketplaces — absorbed from test/phase18-collisions.mjs
{
const SKILL = "---\nname: style\ndescription: style guidance\n---\n\n# Style\n\nBody.\n"

// realpath on both sides: macOS temp dirs sit behind /var -> /private/var
function assertResolves(dest, source) {
  if (!existsSync(dest) || !lstatSync(dest).isSymbolicLink()) throw new Error(`expected a symlink at ${dest}`)
  expect(realpathSync(dest)).toBe(realpathSync(source))
}

// spec 19: every installable plugin carries a plugin.json with a description
const PLUGIN_JSON = json({ description: "demo plugin" })

// the retroactive collision: "collide" ships "review-tools" only after both
// marketplaces are already registered, so the update — not add — meets it
function colliding(home) {
  const big = join(home, "big")
  const collide = join(home, "collide")
  writeTree(big, { plugins: { "review-tools": { "plugin.json": PLUGIN_JSON, commands: { "review.md": COMMAND } } } })
  writeTree(collide, { plugins: { filler: { "plugin.json": PLUGIN_JSON, commands: { "fill.md": COMMAND } } } })
  expect(ocm(home, ["add", big]).status).toBe(0)
  expect(ocm(home, ["add", collide]).status).toBe(0)
  writeTree(collide, { plugins: { "review-tools": { "plugin.json": PLUGIN_JSON, commands: { "review.md": COMMAND } } } })
  const updated = ocm(home, ["update", "collide"])
  expect(updated.status).toBe(0)
  return { big, collide, updated }
}

phase("1. install of a colliding plugin refuses: both marketplaces and the paths named, exit 1, registry byte-identical, incumbent's link untouched", async (home) => {
  const { big } = colliding(home)
  const before = readFileSync(registryFile(home), "utf8")
  const refused = ocm(home, ["install", "review-tools@collide"])
  if (refused.status !== 1) throw new Error(`expected exit 1 from the collision install, got ${refused.status}:\n${refused.output}`)
  for (const needle of ['plugin "review-tools" is already provided by marketplace "big"', "collide", "review.md", "--force"]) {
    expect(refused.output).toContain(needle)
  }
  expect(readFileSync(registryFile(home), "utf8")).toBe(before) // invariant: idempotence — a refusal writes nothing
  // invariant: ownership — the incumbent's link is never displaced by a refusal
  assertResolves(join(cfg(home), "commands", "review-tools:review.md"), join(big, "plugins", "review-tools", "commands", "review.md"))
})

phase("2. install --force takes over: the report states it, the incumbent yields, the user's config survives; a second --force is a clean no-op; the probe stays clean", async (home) => {
  // invariants: config safety and ownership — the user's files predate every ocm run
  const userConfig = { model: "claude-sonnet-4-6", mcp: { "user-server": { type: "local", command: ["echo"] } } }
  writeTree(cfg(home), { "opencode.json": json(userConfig), "tui.json": json({ plugin: ["my-own-tui-plugin"] }), commands: { "mine.md": "# my own command\n" } })
  const configBytes = readFileSync(join(cfg(home), "opencode.json"), "utf8")
  const { collide } = colliding(home)
  const forced = ocm(home, ["install", "review-tools@collide", "--force"])
  if (forced.status !== 0) throw new Error(`install --force exited ${forced.status}:\n${forced.output}`)
  expect(forced.output).toContain('took over "review-tools" from marketplace "big"')
  assertResolves(join(cfg(home), "commands", "review-tools:review.md"), join(collide, "plugins", "review-tools", "commands", "review.md"))
  expect(readRegistry(home).marketplaces.big.plugins["review-tools"].enabled).toBe(false) // the incumbent yields the name
  expect(readFileSync(join(cfg(home), "opencode.json"), "utf8")).toBe(configBytes)
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
  expect(JSON.parse(readFileSync(join(cfg(home), "tui.json"), "utf8")).plugin).toContain("my-own-tui-plugin")
  // invariant: idempotence — the second --force re-takes nothing and warns about nothing
  const registryBytes = readFileSync(registryFile(home), "utf8")
  const again = ocm(home, ["install", "review-tools@collide", "--force"])
  expect(again.status).toBe(0)
  expect(again.output).toContain("already installed")
  expect(again.output).not.toContain("took over")
  expect(again.output).not.toContain("warning")
  expect(readFileSync(registryFile(home), "utf8")).toBe(registryBytes)
  // invariant: no plugin-load errors attributable to ocm-installed files
}, 420_000)

phase("3. update reports the collision as a line, not an action, and never flips an explicit install back to disabled", async (home) => {
  const { collide, updated } = colliding(home)
  for (const needle of ['name owned by marketplace "big"', "kept disabled", "ocm install review-tools@collide --force"]) {
    expect(updated.output).toContain(needle)
  }
  expect(ocm(home, ["install", "review-tools@collide", "--force"]).status).toBe(0)
  expect(readRegistry(home).marketplaces.collide.plugins["review-tools"].enabled).toBe(true)
  expect(ocm(home, ["update", "collide"]).status).toBe(0)
  expect(readRegistry(home).marketplaces.collide.plugins["review-tools"].enabled).toBe(true) // the explicit choice survives
  assertResolves(join(cfg(home), "commands", "review-tools:review.md"), join(collide, "plugins", "review-tools", "commands", "review.md"))
})

phase("4. add-time refusal lists every colliding plugin with its paths, capped at 10 with an ellipsis", async (home) => {
  const big = join(home, "big")
  writeTree(big, { plugins: { "review-tools": { "plugin.json": PLUGIN_JSON, commands: { "review.md": COMMAND } }, "lint-tools": { "plugin.json": PLUGIN_JSON, commands: { "lint.md": COMMAND } } } })
  expect(ocm(home, ["add", big]).status).toBe(0)
  const rival = join(home, "rival")
  writeTree(rival, { plugins: { "review-tools": { "plugin.json": PLUGIN_JSON, commands: { "review.md": COMMAND } }, "lint-tools": { "plugin.json": PLUGIN_JSON, commands: { "lint.md": COMMAND } } } })
  const refused = ocm(home, ["add", rival])
  if (refused.status === 0) throw new Error(`expected a non-zero exit from "ocm add ${rival}"`)
  for (const needle of ['"review-tools"', "review.md", '"lint-tools"', "lint.md"]) expect(refused.output).toContain(needle)
  expect(readRegistry(home).marketplaces.rival).toBeUndefined()
  // the cap: 12 colliding names list 10, then point at the rest
  const names = Array.from({ length: 12 }, (_, i) => `tool-${String(i + 1).padStart(2, "0")}`)
  const wide = (dir) => writeTree(dir, { plugins: Object.fromEntries(names.map((n) => [n, { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } }])) })
  wide(join(home, "wide"))
  expect(ocm(home, ["add", join(home, "wide")]).status).toBe(0)
  const wideRival = join(home, "wide-rival")
  wide(wideRival)
  const capped = ocm(home, ["add", wideRival])
  expect(capped.status).not.toBe(0)
  expect(capped.output).toContain("… and 2 more")
})

phase("5. doctor reports a recorded collision with the install remedy and exits 1; --fix changes nothing", async (home) => {
  colliding(home)
  const bytes = readFileSync(registryFile(home), "utf8")
  const diagnosed = ocm(home, ["doctor"], 300_000)
  if (diagnosed.status !== 1) throw new Error(`expected doctor to exit 1 on a recorded collision, got ${diagnosed.status}:\n${diagnosed.output}`)
  for (const needle of ['plugin "review-tools"', '"big"', '"collide"', "ocm install review-tools@collide --force"]) {
    expect(diagnosed.output).toContain(needle)
  }
  const fixed = ocm(home, ["doctor", "--fix"], 300_000)
  expect(fixed.status).toBe(1) // no --fix action: the remedy is a user decision, not a repair
  expect(fixed.output).toContain("ocm install review-tools@collide --force")
  expect(readFileSync(registryFile(home), "utf8")).toBe(bytes)
}, 600_000)

phase("6. scan of an uninstalled plugin: every component 'would create', executables '(trust-gated)', zero collision lines; the real install then needs no --force", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { "review-tools": {
    "plugin.json": PLUGIN_JSON,
    commands: { "review.md": COMMAND }, agents: { "reviewer.md": AGENT }, skills: { style: { "SKILL.md": SKILL } },
    plugin: { "notify.js": JS_PLUGIN }, "mcp.json": MCP,
  } } })
  expect(ocm(home, ["add", mp, "--explicit"]).status).toBe(0)
  const scanned = ocm(home, ["scan", "review-tools@mp"])
  expect(scanned.status).toBe(0)
  const lines = scanned.stdout.split("\n")
  expect(lines.filter((l) => l.includes("collision"))).toEqual([])
  for (const marker of ["review.md", "reviewer", "style", "notify", "ocm--review-tools--db"]) {
    const line = lines.find((l) => l.includes(marker))
    if (!line) throw new Error(`scan output lacks a line for ${marker}:\n${scanned.stdout}`)
    expect(line).toContain("would create")
    if (marker === "notify" || marker === "ocm--review-tools--db") expect(line).toContain("trust-gated")
  }
  expect(ocm(home, ["install", "review-tools@mp"]).status).toBe(0)
  assertResolves(join(cfg(home), "commands", "review-tools:review.md"), join(mp, "plugins", "review-tools", "commands", "review.md"))
})

phase("7. scan of a directory with no plugins explains the expected layout and points at ocm validate", async (home) => {
  const empty = join(home, "empty")
  writeTree(empty, { "readme.md": "not a marketplace\n" })
  const scanned = ocm(home, ["scan", empty])
  expect(scanned.status).toBe(0)
  for (const needle of ["no plugins found", "plugins/<name>", "see ocm validate and the README's marketplace format"]) {
    expect(scanned.output).toContain(needle)
  }
})

phase("8. validate flags duplicate plugins[] entries and a cross-plugin basename clash in one run", async (home) => {
  const dir = join(home, "mp")
  writeTree(dir, {
    "marketplace.json": json({ name: "mp", plugins: [
      { name: "dup", source: "./plugins/dup" }, { name: "dup", source: "./plugins/dup" },
      { name: "alpha", source: "./plugins/alpha" }, { name: "beta", source: "./plugins/beta" },
    ] }),
    plugins: {
      dup: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } },
      alpha: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } },
      beta: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } },
    },
  })
  const result = ocm(home, ["validate", dir])
  if (result.status !== 1) throw new Error(`validate exited ${result.status}, expected 1:\n${result.output}`)
  const errorLine = (...needles) => {
    const line = result.output.split("\n").find((l) => /^\s*error\b/.test(l) && needles.every((n) => l.includes(n)))
    if (!line) throw new Error(`expected an error finding containing ${JSON.stringify(needles)}:\n${result.output}`)
  }
  errorLine("marketplace.json", 'plugin "dup" listed twice')
  errorLine("alpha", "beta", "commit.md")
})

phase("scan of an installed plugin reads 'already linked' for every component, with no collision noise", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { adw: {
    "plugin.json": PLUGIN_JSON,
    commands: { "commit.md": COMMAND }, agents: { "reviewer.md": AGENT },
    skills: { style: { "SKILL.md": SKILL } }, plugin: { "notify.js": JS_PLUGIN },
  } } })
  expect(ocm(home, ["add", mp, "--trust"]).status).toBe(0)
  const scanned = ocm(home, ["scan", "adw@mp"])
  expect(scanned.status).toBe(0)
  const lines = scanned.stdout.split("\n")
  expect(lines.filter((l) => l.includes("collision"))).toEqual([])
  for (const marker of ["commit.md", "reviewer", "style", "notify"]) {
    const line = lines.find((l) => l.includes(marker))
    if (!line) throw new Error(`scan output lacks a line for ${marker}:\n${scanned.stdout}`)
    expect(line).toContain("already linked")
  }
})

phase("scan with a hand-written file at a destination reports that one collision, names the file, and leaves it untouched", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "review.md": COMMAND }, agents: { "reviewer.md": AGENT } } } })
  expect(ocm(home, ["add", mp, "--explicit"]).status).toBe(0)
  const foreign = join(cfg(home), "commands", "adw:review.md")
  writeTree(join(cfg(home), "commands"), { "adw:review.md": "# my own review command\n" })
  const scanned = ocm(home, ["scan", "adw@mp"])
  expect(scanned.status).toBe(0)
  const commandLine = scanned.stdout.split("\n").find((l) => l.includes("review.md"))
  if (!commandLine) throw new Error(`scan output lacks the command line:\n${scanned.stdout}`)
  expect(commandLine).toContain("collision")
  expect(commandLine).toContain(foreign)
  expect(readFileSync(foreign, "utf8")).toBe("# my own review command\n") // invariant: ownership — scan never touches it
  const agentLine = scanned.stdout.split("\n").find((l) => l.includes("reviewer"))
  if (!agentLine) throw new Error(`scan output lacks the agent line:\n${scanned.stdout}`)
  expect(agentLine).toContain("would create") // the empty destination is not a collision
})
}

// displaced originals: install --force displaces, remove restores — absorbed from test/phase21-displaced-originals.mjs
{
const COMMAND = "---\ndescription: greet helper\n---\n\nGreet body.\n"

// the displaced cache nests copies under <ts>/<absolute-original-path>, so a
// flat readdir cannot find them
function findUnder(dir, name) {
  const found = []
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.name === name) found.push(path)
    }
  }
  return found
}

// the F9 scenario: a hand-written command sits at the exact destination
// alpha-kit will claim, and `install --force` takes it over
function displaced(home) {
  const mp = join(home, "alpha")
  writeTree(mp, { plugins: { "alpha-kit": { "plugin.json": PLUGIN_JSON, commands: { "greet.md": COMMAND } } } })
  const added = ocm(home, ["add", mp, "--explicit"])
  if (added.status !== 0) throw new Error(`ocm add exited ${added.status}:\n${added.output}`)
  const greet = join(cfg(home), "commands", "alpha-kit:greet.md")
  writeTree(join(cfg(home), "commands"), { "alpha-kit:greet.md": GREET })
  const forced = ocm(home, ["install", "alpha-kit", "--force"])
  if (forced.status !== 0) throw new Error(`ocm install alpha-kit --force exited ${forced.status}:\n${forced.output}`)
  return { greet, forced }
}

phase("1. install --force displaces a hand-written command: the report names where it went, the file leaves commands/, and a second --force displaces nothing new", async (home) => {
  const { greet, forced } = displaced(home)
  const line = lineWith(forced.output, "displaced")
  for (const needle of ["displaced your", "greet.md", displacedRoot(home)]) {
    if (!line.includes(needle)) throw new Error(`the displacement line lacks "${needle}":\n${line}`)
  }
  // the original path now belongs to the takeover: ocm's symlink to the
  // marketplace copy occupies it, so the user's bytes are gone from commands/
  // (they survive only in the displaced cache copy asserted below)
  if (!existsSync(greet) || !lstatSync(greet).isSymbolicLink()) throw new Error(`expected a symlink at ${greet}`)
  expect(realpathSync(greet)).toBe(realpathSync(join(home, "alpha", "plugins", "alpha-kit", "commands", "greet.md")))
  expect(readFileSync(greet, "utf8")).toBe(COMMAND)
  const copies = findUnder(displacedRoot(home), "alpha-kit:greet.md")
  if (copies.length !== 1) throw new Error(`expected one displaced copy under ${displacedRoot(home)}, found ${copies.length}`)
  expect(readFileSync(copies[0], "utf8")).toBe(GREET) // moved, not deleted
  // invariant: idempotence — the second --force re-takes nothing
  const again = ocm(home, ["install", "alpha-kit", "--force"])
  expect(again.status).toBe(0)
  expect(again.output).not.toContain("displaced")
  expect(findUnder(displacedRoot(home), "alpha-kit:greet.md")).toEqual(copies)
})

phase("2. ocm remove restores the displaced original byte-identically, reports the restore, and keeps the cache copy", async (home) => {
  const { greet } = displaced(home)
  const removed = ocm(home, ["remove", "alpha"])
  if (removed.status !== 0) throw new Error(`ocm remove exited ${removed.status}:\n${removed.output}`)
  if (!existsSync(greet)) throw new Error(`expected ${greet} restored by ocm remove alpha`)
  expect(readFileSync(greet, "utf8")).toBe(GREET) // content only; mtime is irrelevant
  const line = lineWith(removed.output, "restored")
  for (const needle of ["restored your", "greet.md", "was displaced by alpha-kit"]) {
    if (!line.includes(needle)) throw new Error(`the restore line lacks "${needle}":\n${line}`)
  }
  const copies = findUnder(displacedRoot(home), "alpha-kit:greet.md")
  if (!copies.length) throw new Error(`expected the cache copy to survive the restore under ${displacedRoot(home)}`)
  expect(readFileSync(copies[0], "utf8")).toBe(GREET) // restore is a copy-back, not a move
})

phase("3. occupied target: a hand-re-created greet.md wins over the restore, and the cache path is reported", async (home) => {
  const { greet } = displaced(home)
  // the link comes down first: a user re-creating the path cannot write
  // through ocm's symlink into the marketplace
  rmSync(greet)
  writeFileSync(greet, GREET_RECREATED) // the user re-created it after the takeover
  const removed = ocm(home, ["remove", "alpha"])
  if (removed.status !== 0) throw new Error(`ocm remove exited ${removed.status}:\n${removed.output}`)
  expect(readFileSync(greet, "utf8")).toBe(GREET_RECREATED) // no restore: theirs wins
  const line = lineWith(removed.output, "displaced")
  for (const needle of ["greet.md", "alpha-kit", "path is taken", displacedRoot(home)]) {
    if (!line.includes(needle)) throw new Error(`the occupied-target line lacks "${needle}":\n${line}`)
  }
  const copies = findUnder(displacedRoot(home), "alpha-kit:greet.md")
  if (!copies.length) throw new Error(`expected the cache copy kept under ${displacedRoot(home)}`)
  expect(readFileSync(copies[0], "utf8")).toBe(GREET)
})

phase("4. uninstalling just the plugin restores the displaced original like a marketplace remove", async (home) => {
  const { greet } = displaced(home)
  const un = ocm(home, ["uninstall", "alpha-kit"])
  if (un.status !== 0) throw new Error(`ocm uninstall exited ${un.status}:\n${un.output}`)
  if (!existsSync(greet)) throw new Error(`expected ${greet} restored by ocm uninstall alpha-kit`)
  expect(readFileSync(greet, "utf8")).toBe(GREET)
  const line = lineWith(un.output, "restored")
  for (const needle of ["restored your", "greet.md", "was displaced by alpha-kit"]) {
    if (!line.includes(needle)) throw new Error(`the restore line lacks "${needle}":\n${line}`)
  }
  const copies = findUnder(displacedRoot(home), "alpha-kit:greet.md")
  if (!copies.length) throw new Error(`expected the cache copy to survive the restore under ${displacedRoot(home)}`)
  expect(readFileSync(copies[0], "utf8")).toBe(GREET)
})

phase("5. a teardown with no displaced files prints nothing extra: remove and uninstall outputs byte-identical to today", async (home) => {
  const mp = join(home, "alpha")
  writeTree(mp, { plugins: { "alpha-kit": { "plugin.json": PLUGIN_JSON, commands: { "greet.md": COMMAND } } } })
  expect(ocm(home, ["add", mp]).status).toBe(0)
  const removed = ocm(home, ["remove", "alpha"])
  expect(removed.status).toBe(0)
  expect(removed.stdout).toBe('removed marketplace "alpha"\n  alpha-kit: 1 commands removed\n')
  expect(removed.stderr).toBe("")
  expect(ocm(home, ["add", mp]).status).toBe(0)
  const un = ocm(home, ["uninstall", "alpha-kit"])
  expect(un.status).toBe(0)
  expect(un.stdout).toBe("uninstalled alpha-kit@alpha\nrestart opencode to activate\n")
  expect(un.stderr).toBe("")
})

phase("6. ownership and cache layout: user config and files survive the cycle, the copy keeps <ts>/<absolute-path>, nothing under ~/.claude or ~/.agents, probe clean", async (home) => {
  const userConfig = { model: "claude-sonnet-4-6", permission: { edit: "allow" }, mcp: { "user-server": { type: "local", command: ["echo"] } } }
  writeTree(cfg(home), {
    "opencode.json": json(userConfig), "tui.json": json({ plugin: ["my-own-tui-plugin"] }),
    commands: { "mine.md": "# my own command\n" }, plugins: { "my-own.js": USER_PLUGIN },
  })
  const { greet } = displaced(home)
  // the cache layout is unchanged, so older caches stay readable:
  // <timestamp>/<absolute-original-path>
  const root = displacedRoot(home)
  const copies = findUnder(root, "alpha-kit:greet.md")
  if (copies.length !== 1) throw new Error(`expected one displaced copy under ${root}, found ${copies.length}`)
  const rel = relative(root, copies[0])
  const slash = rel.indexOf("/")
  if (!/^\d{4}-/.test(rel.slice(0, slash))) throw new Error(`expected a timestamp directory in the displaced layout, got ${rel}`)
  if (`/${rel.slice(slash + 1)}` !== greet) throw new Error(`the displaced copy must mirror the absolute original path ${greet}, got ${rel}`)
  const removed = ocm(home, ["remove", "alpha"])
  expect(removed.status).toBe(0)
  if (!existsSync(greet)) throw new Error(`expected ${greet} restored by ocm remove alpha`)
  expect(readFileSync(greet, "utf8")).toBe(GREET)
  expect(readFileSync(copies[0], "utf8")).toBe(GREET) // the cache copy is never consumed
  // invariant: config safety — this flow owns no opencode.json key, so the
  // user's file survives byte-identically
  expect(readFileSync(configFile(home), "utf8")).toBe(json(userConfig))
  // invariant: ownership — files ocm cannot prove it created are untouched
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
  expect(readFileSync(join(cfg(home), "plugins", "my-own.js"), "utf8")).toBe(USER_PLUGIN)
  expect(JSON.parse(readFileSync(join(cfg(home), "tui.json"), "utf8")).plugin).toContain("my-own-tui-plugin")
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
  // invariant: no plugin-load errors attributable to ocm-installed files
}, 900_000)
}

// brief 28 §2.3: the stranded-install mutation notice — add, init, update,
// install and trust warn once on stderr and proceed; nothing is refused
{
const NOTICE_LEAD = "warning: an ocm install is stranded in another config root"

// the file-level ocm helper cannot set the child's XDG_CONFIG_HOME, and the
// notice only exists when the variable moves the active root
function ocmEnv(home, args, env = {}, timeout = 120_000) {
  const r = spawnSync(process.execPath, [OCM_BIN, ...args], {
    env: withFakeOpencode({ ...process.env, HOME: home, ...env }), encoding: "utf8", timeout,
  })
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` }
}

const noticeCount = (stderr) => stderr.split("\n").filter((l) => l.includes(NOTICE_LEAD)).length

// the whole default config tree as one comparable string: names and contents
// (walkPaths lists directories too; only files and links carry bytes)
const snapConfig = (home) => {
  const root = join(home, ".config")
  return walkPaths(root)
    .filter((p) => !lstatSync(p).isDirectory())
    .map((p) => `${relative(root, p)}\n${readFileSync(p, "utf8")}`)
    .join("\n--\n")
}

phase("1. ocm add under a set XDG_CONFIG_HOME warns once about the install stranded in the default root, still succeeds, and leaves the default root byte-identical", async (home) => {
  expect(ocmEnv(home, ["init"]).status).toBe(0)
  writeTree(join(home, "mp-one"), { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
  expect(ocmEnv(home, ["add", join(home, "mp-one")]).status).toBe(0)
  const configSnapshot = snapConfig(home)
  const xdg = join(home, "xdg")
  writeTree(join(home, "mp-two"), { plugins: { beta: { "plugin.json": PLUGIN_JSON, commands: { "lint.md": COMMAND } } } })
  const added = ocmEnv(home, ["add", join(home, "mp-two")], { XDG_CONFIG_HOME: xdg })
  if (added.status !== 0) throw new Error(`ocm add exited ${added.status}, expected the mutation to proceed:\n${added.output}`)
  if (noticeCount(added.stderr) !== 1) throw new Error(`expected the stranded notice exactly once on stderr, got ${noticeCount(added.stderr)}:\n${added.stderr}`)
  for (const needle of [`installed at: ${join(home, ".config", "opencode")} (1 marketplace)`, `this shell:   ${join(xdg, "opencode")} (XDG_CONFIG_HOME is set)`]) {
    if (!added.stderr.includes(needle)) throw new Error(`the stranded notice lacks "${needle}":\n${added.stderr}`)
  }
  const xdgRegistry = JSON.parse(readFileSync(join(xdg, "opencode", "ocm", "registry.json"), "utf8"))
  if (!xdgRegistry.marketplaces["mp-two"]) {
    throw new Error(`expected marketplace "mp-two" in ${join(xdg, "opencode", "ocm", "registry.json")}, got ${JSON.stringify(Object.keys(xdgRegistry.marketplaces))}`)
  }
  expect(snapConfig(home)).toBe(configSnapshot) // the default root does not move
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

phase("2. a fresh install under a set XDG_CONFIG_HOME, with no install anywhere, prints no stranded notice and breadcrumbs its own root", async (home) => {
  const env = { XDG_CONFIG_HOME: join(home, "xdg") }
  const init = ocmEnv(home, ["init"], env)
  if (init.status !== 0) throw new Error(`ocm init exited ${init.status}:\n${init.output}`)
  if (noticeCount(init.stderr) !== 0) throw new Error(`nothing is stranded anywhere, yet stderr carries the notice:\n${init.stderr}`)
  writeTree(join(home, "mp"), { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
  const added = ocmEnv(home, ["add", join(home, "mp")], env)
  if (added.status !== 0) throw new Error(`ocm add exited ${added.status}:\n${added.output}`)
  if (noticeCount(added.stderr) !== 0) throw new Error(`nothing is stranded anywhere, yet stderr carries the notice:\n${added.stderr}`)
  assertFileExists(join(home, "xdg", "opencode", "ocm", "registry.json"))
  const rootsFile = join(home, ".cache", "ocm", "roots.json")
  const recorded = existsSync(rootsFile) ? JSON.parse(readFileSync(rootsFile, "utf8")) : null
  if (!recorded?.roots?.includes(join(home, "xdg", "opencode"))) {
    throw new Error(`expected the breadcrumb at ${rootsFile} to record the xdg root after a registry write, got ${JSON.stringify(recorded)}`)
  }
}, 300_000)

phase("3. every noticing command prints the stranded notice once before its own behaviour: init, update, install, trust", async (home) => {
  expect(ocmEnv(home, ["init"]).status).toBe(0)
  writeTree(join(home, "mp"), { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
  expect(ocmEnv(home, ["add", join(home, "mp")]).status).toBe(0)
  const xdg = join(home, "xdg")
  const env = { XDG_CONFIG_HOME: xdg }
  const defaultRoot = join(home, ".config", "opencode")
  const noticed = (label, result) => {
    const count = noticeCount(result.stderr)
    if (count !== 1) throw new Error(`expected the stranded notice exactly once on stderr from ocm ${label}, got ${count}:\n${result.stderr}`)
    if (!result.stderr.includes(`installed at: ${defaultRoot}`)) throw new Error(`the notice from ocm ${label} must name the stranded default root:\n${result.stderr}`)
  }
  const init = ocmEnv(home, ["init"], env)
  if (init.status !== 0) throw new Error(`ocm init exited ${init.status}:\n${init.output}`)
  noticed("init", init)
  // every remaining command must see an active root with no registry file —
  // the notice's condition — so the xdg root is cleared before each run
  for (const args of [["update"], ["install", "some-plugin"], ["trust", "mp"]]) {
    rmSync(xdg, { recursive: true, force: true })
    noticed(args.join(" "), ocmEnv(home, args, env))
  }
}, 600_000)
}

// brief 34 §1: the MCP shape guard — no server entry that fails the shape
// predicate is ever written into opencode.json. A pre-1.18 native entry is
// blocked per server with a warning while the rest of the plugin installs;
// a modern native entry without "enabled" is written normalised to
// enabled: true at the write, never in readMcpServers — that reader's output
// is what the trust fingerprint hashes, so normalising there would force a
// spurious re-trust prompt on upgrade (§1.2).
{
// realpath on both sides: macOS temp dirs sit behind /var -> /private/var
function assertResolves(dest, source) {
  if (!existsSync(dest) || !lstatSync(dest).isSymbolicLink()) throw new Error(`expected a symlink at ${dest}`)
  expect(realpathSync(dest)).toBe(realpathSync(source))
}

// invariant: ocm never writes under another tool's directories
function assertNoForeignToolDirs(home) {
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
}

// v0.5.0's values for the AP fixture below, computed against the pre-brief-34
// code and verified deterministic across two fresh homes. The fingerprint
// hashes canonicalJson of what readMcpServers returns, so normalising
// "enabled" inside that reader (§1.2's trap) would change these and force a
// spurious re-trust prompt for every affected marketplace on upgrade.
const AP_FINGERPRINT_V050 = "b643fd833f33fde0b940a4f491c17950e7ac52fa7e0e0ecaeca317604c10ce70"
const AP_COMPONENT_HASH_V050 = "4efc701136870ddc247b064443fa8a2321c8d4479622c80b4398b6e2f9fa620b" // plugins/apkit/mcp.json:everything

const SKILL = "---\nname: notify-style\ndescription: notify style guidance\n---\n\n# Notify style\n\nBody.\n"

// the pre-1.18 opencode-native shape: a bare map with no "type" per entry
const PRE_1_18_MCP = json({ everything: { command: "node", args: ["server.js"] } })

const MODERN_MCP = json({ time: { type: "local", command: ["date"] } })

const AP_MCP = json({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", mcpServers: { everything: { type: "stdio", command: "npx", args: ["-y", "some-server"] } } })

phase("1. a pre-1.18 native mcp.json entry is blocked at add: exit 0, no server in opencode.json, the warning names the entry and the fix, the command still links", async (home) => {
  // invariant: config safety — the user's config and own server predate the add;
  // the blocked entry must not take the user's server down with it
  const userServer = { type: "local", command: ["echo"], enabled: true }
  writeTree(cfg(home), { "opencode.json": json({ model: "claude-sonnet-4-6", mcp: { "user-server": userServer } }) })
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { notify: {
    "plugin.json": PLUGIN_JSON,
    commands: { "ping.md": COMMAND },
    "mcp.json": PRE_1_18_MCP,
  } } })
  const added = ocm(home, ["add", mp, "--trust"])
  if (added.status !== 0) throw new Error(`ocm add --trust exited ${added.status}:\n${added.stdout}\n${added.stderr}`)
  const output = `${added.stdout}\n${added.stderr}`
  for (const needle of [
    "notify:mcp/everything not installed",
    'mcp.json entry "everything" is missing "type" (expected "local" or "remote")',
    "opencode would refuse to start with it",
    "ask the author to fix it",
    "ocm validate",
  ]) {
    if (!output.includes(needle)) throw new Error(`the add output lacks "${needle}":\n${output}`)
  }
  const mcp = JSON.parse(readFileSync(configFile(home), "utf8")).mcp ?? {}
  if (mcp["ocm--notify--everything"] !== undefined) {
    throw new Error(`expected no "ocm--notify--everything" key in ${configFile(home)}, got ${JSON.stringify(mcp["ocm--notify--everything"])}`)
  }
  // opencode refuses the whole config over one entry lacking "type", so nothing ocm wrote may lack it
  const typeless = Object.entries(mcp).filter(([, value]) =>
    typeof value !== "object" || value === null || Array.isArray(value) || value.type === undefined,
  ).map(([key]) => key)
  if (typeless.length) throw new Error(`mcp entries lacking "type" in ${configFile(home)}: ${typeless.join(", ")}`)
  // the user's own server survives beside the blocked one, value unchanged
  expect(mcp["user-server"]).toEqual(userServer)
  assertResolves(join(cfg(home), "commands", "notify:ping.md"), join(mp, "plugins", "notify", "commands", "ping.md"))
})

phase("2. the pre-1.18 fixture the whole way through: the probe reports zero config errors — opencode still starts with what ocm wrote", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { notify: {
    "plugin.json": PLUGIN_JSON,
    commands: { "ping.md": COMMAND },
    skills: { "notify-style": { "SKILL.md": SKILL } },
    "mcp.json": PRE_1_18_MCP,
  } } })
  const added = ocm(home, ["add", mp, "--trust"])
  if (added.status !== 0) throw new Error(`ocm add --trust exited ${added.status}:\n${added.stdout}\n${added.stderr}`)
  const probe = opencodeProbe(cfg(home), home)
  if (!probe.available) return console.log("skipped:", probe.optIn ? "OCM_PROBE not set" : "opencode is not on PATH")
  if (probe.unreliable) throw new Error("probe cannot trust itself: the canary broken plugin produced no error line")
  expect(probe.pluginErrors).toEqual([])
  // an invalid opencode.json makes opencode exit non-zero before anything
  // loads — the lazy getters throw with opencode's own config error, so
  // touching one is the assertion that the config ocm handed over is valid
  expect(probe.commands.join("\n")).toContain("notify:ping")
  expect(probe.skills.join("\n")).toContain("notify-style")
  // opencode spawns: canary + error scan + name resolution (see harness.mjs)
}, 420_000)

phase("3. a modern native entry without enabled is written normalised to enabled: true, and a second ocm update reports no change", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { clock: {
    "plugin.json": PLUGIN_JSON,
    commands: { "tick.md": COMMAND },
    "mcp.json": MODERN_MCP,
  } } })
  const added = ocm(home, ["add", mp, "--trust"])
  if (added.status !== 0) throw new Error(`ocm add --trust exited ${added.status}:\n${added.stdout}\n${added.stderr}`)
  const entry = () => JSON.parse(readFileSync(configFile(home), "utf8")).mcp?.["ocm--clock--time"]
  expect(entry()).toEqual({ type: "local", command: ["date"], enabled: true })
  const first = ocm(home, ["update"])
  if (first.status !== 0) throw new Error(`ocm update exited ${first.status}:\n${first.stdout}\n${first.stderr}`)
  expect(entry()).toEqual({ type: "local", command: ["date"], enabled: true }) // update must not strip the normalised value
  const bytes = readFileSync(configFile(home), "utf8")
  const second = ocm(home, ["update"])
  if (second.status !== 0) throw new Error(`second ocm update exited ${second.status}:\n${second.stdout}\n${second.stderr}`)
  const output = `${second.stdout}\n${second.stderr}`
  expect(output).not.toContain("restart opencode") // nothing created
  expect(output).not.toContain("created") // the materializer's all-zero line says nothing
  expect(readFileSync(configFile(home), "utf8")).toBe(bytes) // invariant: idempotence — the second update writes nothing
})

phase("4. an Agent Plugins mcp.json installs unchanged and its registry fingerprint is byte-identical to v0.5.0's", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { apkit: {
    "plugin.json": PLUGIN_JSON,
    commands: { "ap.md": COMMAND },
    "mcp.json": AP_MCP,
  } } })
  const added = ocm(home, ["add", mp, "--trust"])
  if (added.status !== 0) throw new Error(`ocm add --trust exited ${added.status}:\n${added.stdout}\n${added.stderr}`)
  expect(JSON.parse(readFileSync(configFile(home), "utf8")).mcp?.["ocm--apkit--everything"]).toEqual({ type: "local", command: ["npx", "-y", "some-server"], enabled: true })
  const trust = readRegistry(home).marketplaces.mp.trust
  if (trust?.fingerprint !== AP_FINGERPRINT_V050) {
    throw new Error(`expected v0.5.0's fingerprint ${AP_FINGERPRINT_V050} in ${registryFile(home)}, got ${trust?.fingerprint} — §1.2: normalisation must not happen in readMcpServers`)
  }
  const hash = trust?.components?.["plugins/apkit/mcp.json:everything"]
  if (hash !== AP_COMPONENT_HASH_V050) {
    throw new Error(`expected v0.5.0's component hash ${AP_COMPONENT_HASH_V050} for plugins/apkit/mcp.json:everything in ${registryFile(home)}, got ${hash}`)
  }
})

// the config minus the keys ocm owns (mcp.ocm--* and skills.paths): the
// user's half of every structure below must survive byte-identically
function userOwned(config) {
  const copy = { ...config }
  if (copy.mcp) {
    const mcp = Object.fromEntries(Object.entries(copy.mcp).filter(([key]) => !key.startsWith("ocm--")))
    if (Object.keys(mcp).length) copy.mcp = mcp
    else delete copy.mcp
  }
  if (copy.skills) {
    const { paths, ...rest } = copy.skills
    if (Object.keys(rest).length) copy.skills = rest
    else delete copy.skills
  }
  return copy
}

phase("5. invariants across every case: opencode.json keys outside mcp.ocm--* and skills.paths byte-identical, nothing under ~/.claude or ~/.agents", async (home) => {
  const userConfig = { model: "claude-sonnet-4-6", permission: { edit: "allow" }, mcp: { "user-server": { type: "local", command: ["echo"], enabled: true } } }
  writeTree(cfg(home), { "opencode.json": json(userConfig) })
  const cases = [
    ["mp-bad", { notify: { "plugin.json": PLUGIN_JSON, commands: { "ping.md": COMMAND }, skills: { "notify-style": { "SKILL.md": SKILL } }, "mcp.json": PRE_1_18_MCP } }],
    ["mp-modern", { clock: { "plugin.json": PLUGIN_JSON, commands: { "tick.md": COMMAND }, "mcp.json": MODERN_MCP } }],
    ["mp-ap", { apkit: { "plugin.json": PLUGIN_JSON, commands: { "ap.md": COMMAND }, "mcp.json": AP_MCP } }],
  ]
  for (const [name, plugins] of cases) {
    const mp = join(home, name)
    writeTree(mp, { plugins })
    const added = ocm(home, ["add", mp, "--trust"])
    if (added.status !== 0) throw new Error(`ocm add ${name} exited ${added.status}:\n${added.stdout}\n${added.stderr}`)
  }
  const updated = ocm(home, ["update"])
  if (updated.status !== 0) throw new Error(`ocm update exited ${updated.status}:\n${updated.stdout}\n${updated.stderr}`)
  // invariant: config safety — only ocm-owned keys moved
  const after = JSON.parse(readFileSync(configFile(home), "utf8"))
  expect(JSON.stringify(userOwned(after))).toBe(JSON.stringify(userOwned(userConfig)))
  assertNoForeignToolDirs(home)
}, 240_000)

phase("6. a native mcp.json's top-level $schema is metadata, not a server entry: no shape warning, no ocm--*--$schema key, the real server installs", async (home) => {
  // invariant: config safety — the user's config and own server predate the add
  const userServer = { type: "local", command: ["echo"], enabled: true }
  writeTree(cfg(home), { "opencode.json": json({ model: "claude-sonnet-4-6", mcp: { "user-server": userServer } }) })
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { clock: {
    "plugin.json": PLUGIN_JSON,
    commands: { "tick.md": COMMAND },
    // native shape (no mcpServers wrapper), so readMcpServers returns it
    // verbatim including $schema — lintMcpJson skips that key, syncMcp must too
    "mcp.json": json({ $schema: "https://opencode.ai/schema/mcp.json", time: { type: "local", command: ["date"] } }),
  } } })
  const added = ocm(home, ["add", mp, "--trust"])
  if (added.status !== 0) throw new Error(`ocm add --trust exited ${added.status}:\n${added.stdout}\n${added.stderr}`)
  const output = `${added.stdout}\n${added.stderr}`
  for (const needle of ["$schema not installed", 'mcp.json entry "$schema"']) {
    if (output.includes(needle)) throw new Error(`the add output must not treat $schema as a server entry ("${needle}"):\n${output}`)
  }
  const mcp = JSON.parse(readFileSync(configFile(home), "utf8")).mcp ?? {}
  expect(mcp["ocm--clock--time"]).toEqual({ type: "local", command: ["date"], enabled: true })
  const schemaKeys = Object.keys(mcp).filter((key) => key.endsWith("--$schema"))
  if (schemaKeys.length) throw new Error(`expected no ocm--*--$schema key in ${configFile(home)}, found: ${schemaKeys.join(", ")}`)
  expect(mcp["user-server"]).toEqual(userServer)
  // review finding: skipping $schema at the write is half the job — it must
  // not be a component either, or ocm list offers a phantom server and the
  // trust prompt asks the user to approve a metadata key
  const listed = ocm(home, ["list", "--all"])
  if (listed.stdout.includes("$schema")) throw new Error(`$schema must not be listed as a component:\n${listed.stdout}`)
  const info = ocm(home, ["info", "clock"])
  if (info.stdout.includes("$schema")) throw new Error(`$schema must not appear in ocm info:\n${info.stdout}`)
})
}
