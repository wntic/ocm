// Phase 05 — docs/specs/05-install.md: one test per numbered item, plus the
// add-time behaviours the spec spells out (zero-plugin add, registry-wide
// name collision, list --all) and the four invariants (ownership in 5 and 6,
// config safety in 6, idempotence in 8, no plugin errors in 1). Each phase()
// call is one test in a throwaway $HOME running the spawned CLI — no network.
import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, assertFileExists, opencodeProbe, withFakeHome } from "./harness.mjs"

const OCM_BIN = fileURLToPath(new URL("../bin/ocm.ts", import.meta.url))

function ocm(home, ...args) {
  const result = spawnSync(process.execPath, [OCM_BIN, ...args], {
    env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 120_000,
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

const phase = (name, body, timeout = 120_000) => test(name, () => withFakeHome(body), timeout)

function fails(home, args, ...needles) {
  const result = ocm(home, ...args)
  if (result.status === 0) throw new Error(`expected a non-zero exit from "ocm ${args.join(" ")}"`)
  for (const needle of needles) expect(`${result.stdout}\n${result.stderr}`).toContain(needle)
}

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
const TWO_PLUGINS = {
  adw: { commands: { "commit.md": COMMAND }, skills: { "python-style": { "SKILL.md": SKILL } } },
  beta: { commands: { "lint.md": COMMAND } },
}

function addMp(home, plugins = TWO_PLUGINS, ...flags) {
  const dir = join(home, "mp")
  writeTree(dir, { plugins })
  const result = ocm(home, "add", dir, ...flags)
  expect(result.status).toBe(0)
  return [dir, result]
}

// realpath on both sides: macOS temp dirs sit behind /var -> /private/var
function assertResolves(dest, source) {
  if (!existsSync(dest) || !lstatSync(dest).isSymbolicLink()) throw new Error(`expected a symlink at ${dest}`)
  expect(realpathSync(dest)).toBe(realpathSync(source))
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
  const probe = opencodeProbe(cfg(home), home)
  if (!probe.available) return console.log("skipped: opencode is not on PATH")
  if (probe.unreliable) throw new Error("probe cannot trust itself: the canary broken plugin produced no error line")
  expect(probe.commands.join("\n")).toContain("adw:commit")
  expect(probe.pluginErrors).toEqual([])
}, 420_000) // opencode spawns: canary + error scan + name resolution

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
  const [mp] = addMp(home, { adw: { commands: { "commit.md": COMMAND }, agents: { "reviewer.md": AGENT } } }, "--explicit")
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
  writeTree(remote, { plugins: { adw: { commands: { "commit.md": COMMAND } } } })
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
  writeTree(incumbent, { plugins: { adw: { commands: { "commit.md": COMMAND } } } })
  expect(ocm(home, "add", incumbent).status).toBe(0)
  writeTree(rival, { plugins: { adw: { commands: { "deploy.md": COMMAND } } } })
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
