// Phase 06 — docs/specs/06-manifests.md: one test per numbered item, plus the
// four invariants (ownership in 3 and 4, config safety and idempotence in 5,
// no plugin errors in 3). Trust gating goes through the registry's trust.code
// field because spec 07's prompt is not built yet: add leaves "none", and the
// test writes "granted" by hand before the install that materializes it.
import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, opencodeProbe, withFakeHome } from "./harness.mjs"

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

const cfg = (home) => join(home, ".config", "opencode")
const pluginsDir = (home) => join(cfg(home), "plugins")
const registryFile = (home) => join(cfg(home), "ocm", "registry.json")
const readRegistry = (home) => JSON.parse(readFileSync(registryFile(home), "utf8"))
const skillsLinks = (home, mp = "mp") => join(home, ".cache", "ocm", "links", mp, "skills")
const manifest = (plugins) => `${JSON.stringify({ plugins }, null, 2)}\n`

// realpath on both sides: macOS temp dirs sit behind /var -> /private/var
function assertResolves(dest, source) {
  if (!existsSync(dest) || !lstatSync(dest).isSymbolicLink()) throw new Error(`expected a symlink at ${dest}`)
  expect(realpathSync(dest)).toBe(realpathSync(source))
}

function addMp(home, tree) {
  const mp = join(home, "mp")
  writeTree(mp, tree)
  const result = ocm(home, "add", mp)
  expect(result.status).toBe(0)
  return [mp, result]
}

// spec 07's trust prompt is not built yet, so trust is granted by writing the
// field the gate reads (spec 02 trust.code); add leaves it "none"
function grantTrust(home) {
  const registry = readRegistry(home)
  registry.marketplaces.mp.trust.code = "granted"
  writeFileSync(registryFile(home), `${JSON.stringify(registry, null, 2)}\n`)
}

const COMMAND = "---\ndescription: commit helper\n---\n\nCommit body.\n"
const AGENT = "---\ndescription: code reviewer\n---\n\nReviewer body.\n"
const SKILL = "---\nname: python-style\ndescription: Python style guidance\n---\n\n# Python style\n\nUse ruff.\n"
// opencode's module contract: default-export { id, server } (ocm-contract)
const JS_PLUGIN = 'export default { id: "adw-notify", server: async () => ({}) }\n'
const USER_PLUGIN = 'export default { id: "mine", server: async () => ({}) }\n'
const TUI_MODULE = 'export default { id: "adw-tui", tui: async () => ({}) }\n'
const MCP = {
  context7: { type: "local", command: ["npx", "-y", "@upstash/context7-mcp"], enabled: true },
  linear: { type: "remote", url: "https://mcp.linear.app/sse", enabled: true },
}

phase("1. manifest metadata reaches the registry cache; the marketplace entry beats plugin.json on conflict", async (home) => {
  addMp(home, {
    "marketplace.json": manifest([
      { name: "adw", source: "./plugins/adw", description: "from marketplace", version: "2.0.0", category: "review", tags: ["mp-tag"] },
    ]),
    plugins: {
      adw: {
        "plugin.json": `${JSON.stringify({ description: "from plugin.json", version: "1.0.0", category: "legacy", tags: ["pj-tag"] }, null, 2)}\n`,
        commands: { "commit.md": COMMAND },
      },
      beta: {
        "plugin.json": `${JSON.stringify({ description: "beta from plugin.json", version: "0.5.0" }, null, 2)}\n`,
        commands: { "lint.md": COMMAND },
      },
    },
  })
  const plugins = readRegistry(home).marketplaces.mp.plugins
  // marketplace entry > plugin.json on every conflicting field
  expect(plugins.adw.manifest.description).toBe("from marketplace")
  expect(plugins.adw.manifest.category).toBe("review")
  expect(plugins.adw.manifest.tags).toEqual(["mp-tag"])
  expect(plugins.adw.version).toBe("2.0.0")
  // plugin.json still feeds a plugin the marketplace does not list
  expect(plugins.beta.manifest.description).toBe("beta from plugin.json")
  expect(plugins.beta.version).toBe("0.5.0")
})

phase("2. an unlisted plugin directory is still discovered; a bad source warns and does not fail the add", async (home) => {
  const [mp, result] = addMp(home, {
    "marketplace.json": manifest([
      { name: "adw", source: "./plugins/adw" },
      { name: "ghost", source: "./plugins/ghost" },
    ]),
    plugins: {
      adw: { commands: { "commit.md": COMMAND } },
      beta: { commands: { "lint.md": COMMAND } }, // not listed anywhere
    },
  })
  expect(result.status).toBe(0) // a bad source never fails the whole add
  const plugins = readRegistry(home).marketplaces.mp.plugins
  expect(plugins.adw).toBeDefined()
  expect(plugins.beta).toBeDefined() // manifests add metadata; they never hide a plugin
  expect(`${result.stdout}\n${result.stderr}`).toContain("warning")
  expect(`${result.stdout}\n${result.stderr}`).toContain("ghost") // the bad source is named
  assertResolves(join(cfg(home), "commands", "beta:lint.md"), join(mp, "plugins", "beta", "commands", "lint.md"))
})

phase("3. a JS plugin links as ocm--<p>--<file>.js when trusted, is reported blocked and unlinked when untrusted, and is removed on uninstall", async (home) => {
  const dest = join(pluginsDir(home), "ocm--adw--notify.js")
  // the user's own plugin file predates every ocm run (ownership invariant)
  writeTree(pluginsDir(home), { "my-own.js": USER_PLUGIN })
  const [mp, added] = addMp(home, { plugins: { adw: { commands: { "commit.md": COMMAND }, plugin: { "notify.js": JS_PLUGIN } } } })
  expect(`${added.stdout}\n${added.stderr}`).toContain("blocked")
  expect(`${added.stdout}\n${added.stderr}`).toContain("untrusted")
  expect(readRegistry(home).marketplaces.mp.plugins.adw.components.plugin).toEqual(["notify.js"]) // discovered and recorded
  assertAbsent(dest)
  // untrusted install: the command materializes, the executable does not
  const untrusted = ocm(home, "install", "adw")
  expect(untrusted.status).toBe(0)
  expect(`${untrusted.stdout}\n${untrusted.stderr}`).toContain("blocked")
  assertResolves(join(cfg(home), "commands", "adw:commit.md"), join(mp, "plugins", "adw", "commands", "commit.md"))
  assertAbsent(dest)
  grantTrust(home)
  expect(ocm(home, "install", "adw").status).toBe(0)
  assertResolves(dest, join(mp, "plugins", "adw", "plugin", "notify.js"))
  // invariant: no plugin-load errors attributable to ocm-installed files
  const probe = opencodeProbe(cfg(home), home)
  if (!probe.available) console.log("skipped: opencode is not on PATH")
  else {
    if (probe.unreliable) throw new Error("probe cannot trust itself: the canary broken plugin produced no error line")
    expect(probe.pluginErrors).toEqual([])
  }
  expect(ocm(home, "uninstall", "adw").status).toBe(0)
  assertAbsent(dest)
  expect(readFileSync(join(pluginsDir(home), "my-own.js"), "utf8")).toBe(USER_PLUGIN) // unowned survives the cycle
}, 420_000) // opencode spawns with plugin files present: canary + error scan

phase("4. MCP keys are written namespaced, removed for a disabled plugin, user keys untouched, and the mcp object dropped when only ocm keys remain", async (home) => {
  const configPath = join(cfg(home), "opencode.json")
  writeTree(cfg(home), { "opencode.json": `${JSON.stringify({ model: "claude-sonnet-4-6", mcp: { "user-server": { type: "local", command: ["echo"] } } }, null, 2)}\n` })
  const [mp] = addMp(home, { plugins: { adw: { commands: { "commit.md": COMMAND }, "mcp.json": `${JSON.stringify(MCP, null, 2)}\n` } } })
  grantTrust(home)
  expect(ocm(home, "install", "adw").status).toBe(0)
  expect(readRegistry(home).marketplaces.mp.plugins.adw.components.mcp).toEqual(["context7", "linear"])
  const read = () => JSON.parse(readFileSync(configPath, "utf8"))
  // namespaced keys carrying opencode's entry shape verbatim
  expect(read().mcp["ocm--adw--context7"]).toEqual(MCP.context7)
  expect(read().mcp["ocm--adw--linear"]).toEqual(MCP.linear)
  expect(ocm(home, "uninstall", "adw").status).toBe(0)
  expect(read().mcp).toEqual({ "user-server": { type: "local", command: ["echo"] } }) // user keys kept, object kept
  // with no user servers left, the mcp object is dropped entirely
  writeFileSync(configPath, `${JSON.stringify({ model: "claude-sonnet-4-6" }, null, 2)}\n`)
  expect(ocm(home, "install", "adw").status).toBe(0)
  expect(Object.keys(read().mcp).sort()).toEqual(["ocm--adw--context7", "ocm--adw--linear"])
  expect(ocm(home, "uninstall", "adw").status).toBe(0)
  expect(read().mcp).toBeUndefined()
  expect(read().model).toBe("claude-sonnet-4-6")
})

phase("5. config safety across an MCP write: user keys survive outside ocm-owned ones, and a second install is byte-identical", async (home) => {
  const configPath = join(cfg(home), "opencode.json")
  const userConfig = {
    model: "claude-sonnet-4-6",
    permission: { edit: "allow" },
    autoupdate: true,
    skills: { paths: ["/users/me/my-skills"], urls: ["https://example.com/skill"] },
    mcp: { "user-server": { type: "local", command: ["echo"] } },
  }
  writeTree(cfg(home), { "opencode.json": `${JSON.stringify(userConfig, null, 2)}\n` })
  addMp(home, { plugins: { adw: { commands: { "commit.md": COMMAND }, "mcp.json": `${JSON.stringify(MCP, null, 2)}\n` } } })
  grantTrust(home)
  expect(ocm(home, "install", "adw").status).toBe(0)
  const after = JSON.parse(readFileSync(configPath, "utf8"))
  expect(Object.keys(after.mcp).sort()).toEqual(["ocm--adw--context7", "ocm--adw--linear", "user-server"])
  const minusOwned = JSON.parse(JSON.stringify(after))
  for (const key of Object.keys(minusOwned.mcp)) if (key.startsWith("ocm--")) delete minusOwned.mcp[key]
  expect(minusOwned).toEqual(userConfig)
  // invariant: idempotence — running the operation again changes nothing
  const bytes = readFileSync(configPath, "utf8")
  expect(ocm(home, "install", "adw").status).toBe(0)
  expect(readFileSync(configPath, "utf8")).toBe(bytes)
})

phase("6. defaultEnabled: false stays disabled in an auto marketplace until explicitly installed", async (home) => {
  const [mp] = addMp(home, {
    "marketplace.json": manifest([
      { name: "adw", source: "./plugins/adw", defaultEnabled: false },
      { name: "beta", source: "./plugins/beta" },
    ]),
    plugins: {
      adw: { commands: { "commit.md": COMMAND } },
      beta: { commands: { "lint.md": COMMAND } },
    },
  })
  const plugins = readRegistry(home).marketplaces.mp.plugins
  expect(plugins.adw.enabled).toBe(false)
  expect(plugins.beta.enabled).toBe(true) // the sibling without the flag auto-enables
  assertAbsent(join(cfg(home), "commands", "adw:commit.md"))
  assertResolves(join(cfg(home), "commands", "beta:lint.md"), join(mp, "plugins", "beta", "commands", "lint.md"))
  expect(ocm(home, "install", "adw").status).toBe(0) // disabled, not broken
  assertResolves(join(cfg(home), "commands", "adw:commit.md"), join(mp, "plugins", "adw", "commands", "commit.md"))
})

phase("7. singular and plural component directories are both discovered; a name clash between them errors", async (home) => {
  const solo = join(home, "solo-mp")
  writeTree(solo, { plugins: { solo: {
    command: { "deploy.md": COMMAND },
    agent: { "reviewer.md": AGENT },
    skill: { "python-style": { "SKILL.md": SKILL } },
  } } })
  expect(ocm(home, "add", solo).status).toBe(0)
  assertResolves(join(cfg(home), "commands", "solo:deploy.md"), join(solo, "plugins", "solo", "command", "deploy.md"))
  assertResolves(join(cfg(home), "agents", "solo:reviewer.md"), join(solo, "plugins", "solo", "agent", "reviewer.md"))
  expect(lstatSync(join(skillsLinks(home, "solo-mp"), "solo--python-style")).isDirectory()).toBe(true)
  const clash = join(home, "clash-mp")
  writeTree(clash, { plugins: { duo: {
    commands: { "commit.md": COMMAND },
    command: { "commit.md": COMMAND },
  } } })
  const result = ocm(home, "add", clash)
  expect(result.status).not.toBe(0) // the clash is an error, not a warning
  expect(`${result.stdout}\n${result.stderr}`).toContain("commit.md")
  expect(readRegistry(home).marketplaces["clash-mp"]).toBeUndefined() // a failed add registers nothing
  assertAbsent(join(cfg(home), "commands", "duo:commit.md"))
})

phase("8. a tui-shaped module under plugin/ is rejected with the documented message", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { adw: { commands: { "commit.md": COMMAND }, plugin: { "ui.js": TUI_MODULE } } } })
  const result = ocm(home, "add", mp)
  expect(result.status).not.toBe(0)
  const output = `${result.stdout}\n${result.stderr}`
  expect(output).toContain("tui")
  expect(output).toContain("not supported")
  assertAbsent(join(pluginsDir(home), "ocm--adw--ui.js"))
  const registry = existsSync(registryFile(home)) ? readRegistry(home) : { marketplaces: {} }
  expect(registry.marketplaces.mp).toBeUndefined()
})
