// Phase 15 — docs/specs/15-manifest-location.md: one test per numbered item.
// The manifest moves to .opencode-plugin/marketplace.json (the root path stays
// legal indefinitely), and mcpServers resolves against the plugin directory
// with a marketplace-relative deprecated fallback that warns naming both
// candidates. The four invariants live in 9: config safety and idempotence
// across the add/update cycle, ownership through remove, no plugin-load
// errors via the probe. Items 2 and 7 pin behaviour the spec says stays as
// today ("still works, unchanged", "rejected, as today") — they are regression
// guards for the resolution change and pass before spec 15 by design.
import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, opencodeProbe, withFakeHome } from "./harness.mjs"

const OCM_BIN = fileURLToPath(new URL("../bin/ocm.ts", import.meta.url))
const TEMPLATE = fileURLToPath(new URL("../template", import.meta.url))

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
  commitAll(dir, "fixture")
}
const commitAll = (dir, message) => {
  git(dir, ["add", "-A"])
  git(dir, ["-c", "user.email=ocm@test", "-c", "user.name=ocm", "commit", "-m", message])
}

const cfg = (home) => join(home, ".config", "opencode")
const registryFile = (home) => join(cfg(home), "ocm", "registry.json")
const readRegistry = (home) => JSON.parse(readFileSync(registryFile(home), "utf8"))
const cloneDir = (home, name = "mp") => join(home, ".cache", "ocm", "marketplaces", name)
const commandLink = (home, plugin, file) => join(cfg(home), "commands", `${plugin}:${file}`)
const json = (value) => `${JSON.stringify(value, null, 2)}\n`
function mcpKeys(home) {
  try {
    return JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8")).mcp ?? {}
  } catch {
    return {}
  }
}

// realpath on both sides: macOS temp dirs sit behind /var -> /private/var
function assertResolves(dest, source) {
  if (!existsSync(dest) || !lstatSync(dest).isSymbolicLink()) throw new Error(`expected a symlink at ${dest}`)
  expect(realpathSync(dest)).toBe(realpathSync(source))
}

// a spec 12 finding line: "  warning plugins/foo/...: message"
function finding(output, severity, ...needles) {
  const line = output.split("\n").find((l) => new RegExp(`^\\s*${severity}\\b`).test(l) && needles.every((n) => l.includes(n)))
  if (!line) throw new Error(`expected a ${severity} finding containing ${JSON.stringify(needles)}:\n${output}`)
  return line
}

const COMMAND = "---\ndescription: commit helper\n---\n\nCommit body.\n"
const JS_PLUGIN = 'export default { id: "phase15-notify", server: async () => ({}) }\n'
const MCP = { db: { type: "local", command: ["npx", "-y", "@acme/db-mcp"], enabled: true } }

phase("1. a marketplace with only .opencode-plugin/marketplace.json is added, discovered and listed exactly as a root-manifest one is", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, {
    ".opencode-plugin": { "marketplace.json": json({
      name: "moved",
      description: "moved marketplace",
      plugins: [{ name: "adw", source: "./plugins/adw", description: "from the new location", version: "2.0.0", category: "review", tags: ["mp-tag"] }],
    }) },
    plugins: { adw: { commands: { "commit.md": COMMAND } } },
  })
  const added = ocm(home, "add", mp)
  if (added.status !== 0) throw new Error(`ocm add ${mp} exited ${added.status}: ${added.stderr}`)
  // the manifest name seeds the marketplace key from the new location, as a root manifest's would
  const entry = readRegistry(home).marketplaces.moved
  if (!entry) throw new Error(`expected marketplace "moved" in ${registryFile(home)} — the .opencode-plugin/marketplace.json name must seed the key`)
  // metadata reaches the registry cache
  expect(entry.plugins.adw.manifest.description).toBe("from the new location")
  expect(entry.plugins.adw.version).toBe("2.0.0")
  expect(entry.plugins.adw.manifest.category).toBe("review")
  expect(entry.plugins.adw.manifest.tags).toEqual(["mp-tag"])
  // listed like a root-manifest marketplace
  const listed = ocm(home, "list")
  expect(listed.stdout).toContain("moved")
  expect(listed.stdout).toContain("adw")
  expect(listed.stdout).toContain("2.0.0")
  // discovered and materialized
  assertResolves(commandLink(home, "adw", "commit.md"), join(mp, "plugins", "adw", "commands", "commit.md"))
  // renames reach update: state migrates across a rename declared in .opencode-plugin/
  expect(ocm(home, "uninstall", "adw").status).toBe(0)
  renameSync(join(mp, "plugins", "adw"), join(mp, "plugins", "adw2"))
  writeFileSync(join(mp, ".opencode-plugin", "marketplace.json"), json({
    name: "moved",
    renames: { adw: "adw2" },
    plugins: [{ name: "adw2", source: "./plugins/adw2", description: "from the new location", version: "2.0.0" }],
  }))
  const updated = ocm(home, "update", "moved")
  if (updated.status !== 0) throw new Error(`ocm update moved exited ${updated.status}: ${updated.stderr}`)
  expect(`${updated.stdout}\n${updated.stderr}`).toMatch(/renamed[^\n]*adw[^\n]*adw2/)
  const plugins = readRegistry(home).marketplaces.moved.plugins
  expect(plugins.adw2.enabled).toBe(false) // the uninstall survives the rename
  expect(plugins.adw).toBeUndefined()
  // the disabled one stays disabled through its rename instead of reinstalling
  assertAbsent(commandLink(home, "adw2", "commit.md"))
  assertAbsent(commandLink(home, "adw", "commit.md"))
})

phase("2. a marketplace with only the root manifest still works, unchanged", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, {
    "marketplace.json": json({
      name: "rootonly",
      plugins: [{ name: "adw", source: "./plugins/adw", description: "from the root", version: "1.0.0" }],
    }),
    plugins: { adw: { commands: { "commit.md": COMMAND } } },
  })
  const added = ocm(home, "add", mp)
  if (added.status !== 0) throw new Error(`ocm add ${mp} exited ${added.status}: ${added.stderr}`)
  const entry = readRegistry(home).marketplaces.rootonly
  if (!entry) throw new Error(`expected marketplace "rootonly" in ${registryFile(home)}`)
  expect(entry.plugins.adw.manifest.description).toBe("from the root")
  expect(entry.plugins.adw.version).toBe("1.0.0")
  const listed = ocm(home, "list")
  expect(listed.stdout).toContain("rootonly")
  expect(listed.stdout).toContain("1.0.0")
  assertResolves(commandLink(home, "adw", "commit.md"), join(mp, "plugins", "adw", "commands", "commit.md"))
})

phase("3. both manifest locations present: the .opencode-plugin/ one wins and validate warns naming the ignored file", async (home) => {
  const mp = join(home, "both")
  writeTree(mp, {
    ".opencode-plugin": { "marketplace.json": json({ plugins: [{ name: "adw", source: "./plugins/adw", description: "from the new location", version: "2.0.0" }] }) },
    "marketplace.json": json({ plugins: [{ name: "adw", source: "./plugins/adw", description: "from the root", version: "1.0.0" }] }),
    plugins: { adw: { commands: { "commit.md": COMMAND } } },
  })
  const added = ocm(home, "add", mp)
  if (added.status !== 0) throw new Error(`ocm add ${mp} exited ${added.status}: ${added.stderr}`)
  const entry = readRegistry(home).marketplaces.both
  if (!entry) throw new Error(`expected marketplace "both" in ${registryFile(home)}`)
  expect(entry.plugins.adw.manifest.description).toBe("from the new location")
  expect(entry.plugins.adw.version).toBe("2.0.0")
  const result = ocm(home, "validate", mp)
  const output = `${result.stdout}\n${result.stderr}`
  if (result.status !== 0) throw new Error(`validate ${mp} exited ${result.status}, expected 0 (a warning, not an error):\n${output}`)
  const line = finding(output, "warning", "marketplace.json")
  // the warning must name the ignored root file, not only the winner
  if (!line.replace(/\.opencode-plugin\/marketplace\.json/g, "").includes("marketplace.json")) {
    throw new Error(`the warning must name the ignored root marketplace.json:\n${line}`)
  }
})

phase("4. a malformed .opencode-plugin/marketplace.json is reported and does not fall back to a valid root manifest", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, {
    ".opencode-plugin": { "marketplace.json": "{ not json\n" },
    "marketplace.json": json({ name: "rootname", plugins: [{ name: "adw", source: "./plugins/adw", description: "from the root", version: "1.0.0" }] }),
    plugins: { adw: { commands: { "commit.md": COMMAND } } },
  })
  const added = ocm(home, "add", mp)
  const output = `${added.stdout}\n${added.stderr}`
  if (added.status !== 0) throw new Error(`ocm add ${mp} exited ${added.status} — a broken manifest never hides a plugin:\n${output}`)
  // the broken manifest is reported, not routed around
  if (!output.includes("opencode-plugin") || !output.includes("marketplace.json")) {
    throw new Error(`expected the add to report the malformed .opencode-plugin/marketplace.json:\n${output}`)
  }
  // no fallback: the root manifest's name and metadata reach nothing
  const registry = readRegistry(home)
  if (registry.marketplaces.rootname) {
    throw new Error(`the valid root manifest must not be used as a fallback, but "rootname" is registered in ${registryFile(home)}`)
  }
  const entry = registry.marketplaces.mp
  if (!entry) throw new Error(`expected marketplace "mp" in ${registryFile(home)}`)
  expect(entry.plugins.adw.manifest.description).toBeUndefined()
  expect(entry.plugins.adw.version).toBeNull()
  // the command still materializes: the scan never needed the manifest
  assertResolves(commandLink(home, "adw", "commit.md"), join(mp, "plugins", "adw", "commands", "commit.md"))
  // validate reports the malformed file as an error
  const result = ocm(home, "validate", mp)
  const validateOutput = `${result.stdout}\n${result.stderr}`
  if (result.status !== 1) throw new Error(`validate ${mp} exited ${result.status}, expected 1:\n${validateOutput}`)
  finding(validateOutput, "error", "opencode-plugin", "marketplace.json", "invalid JSON")
})

phase("5. mcpServers resolves inside the plugin directory and its servers materialize", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, {
    "marketplace.json": json({ plugins: [{ name: "adw", source: "./plugins/adw", mcpServers: "./mcp.custom.json" }] }),
    plugins: { adw: { commands: { "commit.md": COMMAND }, "mcp.custom.json": json(MCP) } },
  })
  const added = ocm(home, "add", mp, "--trust")
  if (added.status !== 0) throw new Error(`ocm add ${mp} exited ${added.status}: ${added.stderr}`)
  expect(readRegistry(home).marketplaces.mp.plugins.adw.components.mcp).toEqual(["db"])
  expect(mcpKeys(home)["ocm--adw--db"]).toEqual(MCP.db)
})

phase("6. the same mcpServers value resolving only marketplace-relative still works and warns once, naming both candidates", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, {
    "marketplace.json": json({ plugins: [{ name: "adw", source: "./plugins/adw", mcpServers: "./mcp.custom.json" }] }),
    "mcp.custom.json": json(MCP), // resolves marketplace-relative only
    plugins: { adw: { commands: { "commit.md": COMMAND } } },
  })
  const added = ocm(home, "add", mp, "--trust")
  if (added.status !== 0) throw new Error(`ocm add ${mp} exited ${added.status}: ${added.stderr}`)
  const output = `${added.stdout}\n${added.stderr}`
  // still works: the marketplace-relative file is used
  expect(readRegistry(home).marketplaces.mp.plugins.adw.components.mcp).toEqual(["db"])
  expect(mcpKeys(home)["ocm--adw--db"]).toEqual(MCP.db)
  // warns exactly once, naming both candidates
  const lines = output.split("\n").filter((l) => l.includes("mcp.custom.json"))
  if (lines.length !== 1) throw new Error(`expected exactly one warning naming the mcpServers candidates, got ${lines.length}:\n${output}`)
  const line = lines[0]
  if (!line.includes("warning")) throw new Error(`expected a warning, got:\n${line}`)
  if (!line.includes("plugins/adw")) {
    throw new Error(`the warning must name the plugin-relative candidate plugins/adw/mcp.custom.json:\n${line}`)
  }
  if (!line.replace(/plugins\/adw\/mcp\.custom\.json/g, "").includes("mcp.custom.json")) {
    throw new Error(`the warning must also name the marketplace-relative candidate mcp.custom.json:\n${line}`)
  }
})

phase("7. mcpServers escaping the plugin with ../ is refused", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, {
    "marketplace.json": json({ plugins: [{ name: "adw", source: "./plugins/adw", mcpServers: "../other-plugin/mcp.json" }] }),
    plugins: {
      adw: { commands: { "commit.md": COMMAND } },
      // the escape target exists: a careless plugin-relative resolution would serve it
      "other-plugin": { "mcp.json": json(MCP) },
    },
  })
  const added = ocm(home, "add", mp, "--trust")
  if (added.status !== 0) throw new Error(`ocm add ${mp} exited ${added.status}: ${added.stderr}`)
  const output = `${added.stdout}\n${added.stderr}`
  expect(output).toContain("../other-plugin/mcp.json") // the refusal names the path
  expect(readRegistry(home).marketplaces.mp.plugins.adw.components.mcp).toBeUndefined()
  expect(Object.keys(mcpKeys(home)).filter((key) => key.startsWith("ocm--adw--"))).toEqual([])
})

phase("8. template/ passes ocm validate with zero findings after the move", async (home) => {
  const manifest = join(TEMPLATE, ".opencode-plugin", "marketplace.json")
  if (!existsSync(manifest)) {
    throw new Error(`expected the template manifest at ${manifest} — spec 15 moves template/marketplace.json to .opencode-plugin/`)
  }
  assertAbsent(join(TEMPLATE, "marketplace.json"))
  const result = ocm(home, "validate", TEMPLATE)
  const output = `${result.stdout}\n${result.stderr}`
  if (result.status !== 0) throw new Error(`ocm validate ${TEMPLATE} exited ${result.status}:\n${output}`)
  const header = output.trim()
  if (header !== `validate ${TEMPLATE}` && header !== `validate ${realpathSync(TEMPLATE)}`) {
    throw new Error(`expected only the header "validate ${TEMPLATE}", got:\n${header}`)
  }
})

phase("9. config safety and idempotence across an add/update cycle for a .opencode-plugin/ marketplace", async (home) => {
  // the user's config and files predate every ocm write (invariants: config safety, ownership)
  const userConfig = {
    model: "claude-sonnet-4-6",
    permission: { edit: "allow" },
    autoupdate: true,
    skills: { paths: ["/users/me/my-skills"], urls: ["https://example.com/skill"] },
    mcp: { "user-server": { type: "local", command: ["echo"] } },
  }
  writeTree(cfg(home), { "opencode.json": json(userConfig), commands: { "mine.md": "# my own command\n" } })
  const remote = join(home, "remote")
  gitRepo(remote, {
    ".opencode-plugin": { "marketplace.json": json({ plugins: [{ name: "adw", source: "./plugins/adw", description: "cycle fixture", version: "1.0.0" }] }) },
    plugins: { adw: {
      "plugin.json": json({ version: "1.0.0" }),
      commands: { "commit.md": COMMAND },
      plugin: { "notify.js": JS_PLUGIN },
      "mcp.json": json(MCP),
    } },
  })
  expect(ocm(home, "add", `file://${remote}`, "--name", "mp", "--trust").status).toBe(0)
  const configPath = join(cfg(home), "opencode.json")
  const minusOwned = () => {
    const copy = JSON.parse(readFileSync(configPath, "utf8"))
    for (const key of Object.keys(copy.mcp ?? {})) if (key.startsWith("ocm--")) delete copy.mcp[key]
    return copy
  }
  // config safety: only ocm-owned keys were added
  expect(minusOwned()).toEqual(userConfig)
  expect(mcpKeys(home)["ocm--adw--db"]).toEqual(MCP.db)
  assertResolves(commandLink(home, "adw", "commit.md"), join(cloneDir(home), "plugins", "adw", "commands", "commit.md"))
  assertResolves(join(cfg(home), "plugins", "ocm--adw--notify.js"), join(cloneDir(home), "plugins", "adw", "plugin", "notify.js"))
  // the update: a new command and a version bump declared in .opencode-plugin/
  writeFileSync(join(remote, "plugins", "adw", "commands", "extra.md"), COMMAND)
  writeFileSync(join(remote, ".opencode-plugin", "marketplace.json"), json({ plugins: [{ name: "adw", source: "./plugins/adw", description: "cycle fixture", version: "2.0.0" }] }))
  commitAll(remote, "advance")
  const updated = ocm(home, "update", "mp")
  if (updated.status !== 0) throw new Error(`ocm update mp exited ${updated.status}: ${updated.stderr}`)
  assertResolves(commandLink(home, "adw", "extra.md"), join(cloneDir(home), "plugins", "adw", "commands", "extra.md"))
  expect(readRegistry(home).marketplaces.mp.plugins.adw.version).toBe("2.0.0") // the new location feeds the registry
  expect(minusOwned()).toEqual(userConfig)
  // invariant: idempotence — a second update writes nothing
  const configBytes = readFileSync(configPath, "utf8")
  const pluginsBefore = readRegistry(home).marketplaces.mp.plugins
  const ino = lstatSync(commandLink(home, "adw", "commit.md")).ino
  const again = ocm(home, "update", "mp")
  if (again.status !== 0) throw new Error(`second ocm update mp exited ${again.status}: ${again.stderr}`)
  expect(readFileSync(configPath, "utf8")).toBe(configBytes)
  expect(readRegistry(home).marketplaces.mp.plugins).toEqual(pluginsBefore)
  expect(lstatSync(commandLink(home, "adw", "commit.md")).ino).toBe(ino)
  // invariant: no plugin-load errors attributable to ocm-installed files
  const probe = opencodeProbe(cfg(home), home)
  if (!probe.available) console.log("skipped: opencode is not on PATH")
  else {
    if (probe.unreliable) throw new Error("probe cannot trust itself: the canary broken plugin produced no error line")
    expect(probe.pluginErrors).toEqual([])
  }
  // invariant: ownership — the user's command and config survive remove
  expect(ocm(home, "remove", "mp").status).toBe(0)
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
  // the probe's opencode load adds "$schema" to the config; that key is
  // opencode's, not ocm's, so the comparison tolerates exactly it
  const afterRemove = JSON.parse(readFileSync(configPath, "utf8"))
  if (afterRemove.$schema === "https://opencode.ai/config.json") delete afterRemove.$schema
  expect(afterRemove).toEqual(userConfig)
  assertAbsent(commandLink(home, "adw", "commit.md"))
}, 600_000)
