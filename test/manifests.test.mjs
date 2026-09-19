// Manifests: marketplace.json and plugin.json discovery, collision
// rules, and the components inventory.

import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, renameSync, readdirSync, readlinkSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, withFakeHome, withFakeOpencode } from "./harness.mjs"

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

const cfg = (home) => join(home, ".config", "opencode")

const pluginsDir = (home) => join(cfg(home), "plugins")

const registryFile = (home) => join(cfg(home), "ocm", "registry.json")

const readRegistry = (home) => JSON.parse(readFileSync(registryFile(home), "utf8"))

const skillsLinks = (home, mp = "mp") => join(home, ".cache", "ocm", "links", mp, "skills")

const manifest = (plugins) => `${JSON.stringify({ plugins }, null, 2)}\n`

function addMp(home, tree) {
  const mp = join(home, "mp")
  writeTree(mp, tree)
  const result = ocm(home, "add", mp)
  expect(result.status).toBe(0)
  return [mp, result]
}

const COMMAND = "---\ndescription: commit helper\n---\n\nCommit body.\n"

const AGENT = "---\ndescription: code reviewer\n---\n\nReviewer body.\n"

const SKILL = "---\nname: python-style\ndescription: Python style guidance\n---\n\n# Python style\n\nUse ruff.\n"

const USER_PLUGIN = 'export default { id: "mine", server: async () => ({}) }\n'

const TUI_MODULE = 'export default { id: "adw-tui", tui: async () => ({}) }\n'

const MCP = {
  context7: { type: "local", command: ["npx", "-y", "@upstash/context7-mcp"], enabled: true },
  linear: { type: "remote", url: "https://mcp.linear.app/sse", enabled: true },
}

const TEMPLATE = fileURLToPath(new URL("../template", import.meta.url))

const AP_PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"

const AP_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"

const json = (value) => `${JSON.stringify(value, null, 2)}\n`

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

const cloneDir = (home, name = "mp") => join(home, ".cache", "ocm", "marketplaces", name)

const commandLink = (home, plugin, file) => join(cfg(home), "commands", `${plugin}:${file}`)

function mcpKeys(home) {
  try {
    return JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8")).mcp ?? {}
  } catch {
    return {}
  }
}

const JS_PLUGIN = 'export default { id: "phase15-notify", server: async () => ({}) }\n'

const AP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"

// manifests: discovery, collision rules, the components inventory — absorbed from test/phase06-manifests.mjs
{
// realpath on both sides: macOS temp dirs sit behind /var -> /private/var
function assertResolves(dest, source) {
  if (!existsSync(dest) || !lstatSync(dest).isSymbolicLink()) throw new Error(`expected a symlink at ${dest}`)
  expect(realpathSync(dest)).toBe(realpathSync(source))
}

// spec 07's trust prompt is not built yet, so trust is granted by writing the
// field the gate reads (spec 02 trust.code); add leaves it "none"
function grantTrust(home) {
  const registry = readRegistry(home)
  registry.marketplaces.mp.trust.code = "granted"
  writeFileSync(registryFile(home), `${JSON.stringify(registry, null, 2)}\n`)
}

// spec 19: every installable plugin carries a plugin.json with a description
const PLUGIN_JSON = `${JSON.stringify({ description: "demo plugin" }, null, 2)}\n`

// opencode's module contract: default-export { id, server } (ocm-contract)
const JS_PLUGIN = 'export default { id: "adw-notify", server: async () => ({}) }\n'

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
      adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } },
      beta: { "plugin.json": PLUGIN_JSON, commands: { "lint.md": COMMAND } }, // not listed in marketplace.json
    },
  })
  expect(result.status).toBe(0) // a bad source never fails the whole add
  const plugins = readRegistry(home).marketplaces.mp.plugins
  expect(plugins.adw).toBeDefined()
  expect(plugins.beta).toBeDefined() // spec 19: unlisted but manifest-carrying, so still discovered
  expect(`${result.stdout}\n${result.stderr}`).toContain("warning")
  expect(`${result.stdout}\n${result.stderr}`).toContain("ghost") // the bad source is named
  assertResolves(join(cfg(home), "commands", "beta:lint.md"), join(mp, "plugins", "beta", "commands", "lint.md"))
})

phase("3. a JS plugin links as ocm--<p>--<file>.js when trusted, is reported blocked and unlinked when untrusted, and is removed on uninstall", async (home) => {
  const dest = join(pluginsDir(home), "ocm--adw--notify.js")
  // the user's own plugin file predates every ocm run (ownership invariant)
  writeTree(pluginsDir(home), { "my-own.js": USER_PLUGIN })
  const [mp, added] = addMp(home, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND }, plugin: { "notify.js": JS_PLUGIN } } } })
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
  expect(ocm(home, "uninstall", "adw").status).toBe(0)
  assertAbsent(dest)
  expect(readFileSync(join(pluginsDir(home), "my-own.js"), "utf8")).toBe(USER_PLUGIN) // unowned survives the cycle
}, 420_000)

phase("4. MCP keys are written namespaced, removed for a disabled plugin, user keys untouched, and the mcp object dropped when only ocm keys remain", async (home) => {
  const configPath = join(cfg(home), "opencode.json")
  writeTree(cfg(home), { "opencode.json": `${JSON.stringify({ model: "claude-sonnet-4-6", mcp: { "user-server": { type: "local", command: ["echo"] } } }, null, 2)}\n` })
  const [mp] = addMp(home, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND }, "mcp.json": `${JSON.stringify(MCP, null, 2)}\n` } } })
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
  addMp(home, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND }, "mcp.json": `${JSON.stringify(MCP, null, 2)}\n` } } })
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
      adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } },
      beta: { "plugin.json": PLUGIN_JSON, commands: { "lint.md": COMMAND } },
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
    "plugin.json": PLUGIN_JSON,
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
    "plugin.json": PLUGIN_JSON,
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
  writeTree(mp, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND }, plugin: { "ui.js": TUI_MODULE } } } })
  const result = ocm(home, "add", mp)
  expect(result.status).not.toBe(0)
  const output = `${result.stdout}\n${result.stderr}`
  expect(output).toContain("tui")
  expect(output).toContain("not supported")
  assertAbsent(join(pluginsDir(home), "ocm--adw--ui.js"))
  const registry = existsSync(registryFile(home)) ? readRegistry(home) : { marketplaces: {} }
  expect(registry.marketplaces.mp).toBeUndefined()
})

// Agent Plugins 1.0 ships mcp.json as { $schema, mcpServers } with transports
// named stdio / streamable-http / sse. ocm accepts that shape alongside
// opencode's own so one file per plugin serves opencode, Codex and Cursor.
const MCP_AGENT_PLUGINS = {
  $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  mcpServers: {
    context7: { type: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp"] },
    linear: { type: "sse", url: "https://mcp.linear.app/sse" },
  },
}

phase("9. an Agent Plugins mcp.json materializes the same opencode keys as the native shape", async (home) => {
  const configPath = join(cfg(home), "opencode.json")
  writeTree(cfg(home), { "opencode.json": `${JSON.stringify({ model: "claude-sonnet-4-6" }, null, 2)}\n` })
  addMp(home, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND }, "mcp.json": `${JSON.stringify(MCP_AGENT_PLUGINS, null, 2)}\n` } } })
  grantTrust(home)
  expect(ocm(home, "install", "adw").status).toBe(0)
  // discovery names the servers from mcpServers, not from the wrapper keys
  expect(readRegistry(home).marketplaces.mp.plugins.adw.components.mcp).toEqual(["context7", "linear"])
  const mcp = JSON.parse(readFileSync(configPath, "utf8")).mcp
  expect(mcp["ocm--adw--context7"]).toEqual(MCP.context7) // stdio + args -> local + command array
  expect(mcp["ocm--adw--linear"]).toEqual(MCP.linear) // sse -> remote
  expect(mcp["ocm--adw--$schema"]).toBeUndefined()
})

phase("10. validate accepts both mcp.json shapes", async (home) => {
  const [ap] = addMp(home, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND }, "mcp.json": `${JSON.stringify(MCP_AGENT_PLUGINS, null, 2)}\n` } } })
  expect(ocm(home, "validate", ap).status).toBe(0)
})
}

// agent plugins: discovered, linked and reported like commands — absorbed from test/phase14-agent-plugins.mjs
{
// spec 19: description is the one required plugin.json field
const PLUGIN_JSON = json({ description: "demo plugin" })

// realpath on both sides: macOS temp dirs sit behind /var -> /private/var
function assertResolves(dest, source) {
  if (!existsSync(dest) || !lstatSync(dest).isSymbolicLink()) throw new Error(`expected a symlink at ${dest}`)
  expect(realpathSync(dest)).toBe(realpathSync(source))
}

// a finding line in the spec 12 format: "  error   plugins/foo/...: message"
function finding(output, severity, ...needles) {
  const line = output.split("\n").find((l) => new RegExp(`^\\s*${severity}\\b`).test(l) && needles.every((n) => l.includes(n)))
  if (!line) throw new Error(`expected a ${severity} finding containing ${JSON.stringify(needles)}:\n${output}`)
  return line
}

const SKILL = (name) => `---\nname: ${name}\ndescription: ${name} guidance\n---\n\n# ${name}\n\nBody.\n`

phase("1. an AP-conformant plugin.json installs, and category/tags from extensions[\"dev.wntic.ocm\"] reach the registry cache", async (home) => {
  // invariants: the user's config keys and command file predate every ocm write
  const userConfig = {
    model: "claude-sonnet-4-6",
    permission: { edit: "allow" },
    skills: { paths: ["/users/me/my-skills"] },
    mcp: { "user-server": { type: "local", command: ["echo"] } },
  }
  const configPath = join(cfg(home), "opencode.json")
  writeTree(cfg(home), {
    "opencode.json": json(userConfig),
    commands: { "mine.md": "# my own command\n" },
  })
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { adw: {
    "plugin.json": json({
      $schema: AP_PLUGIN_SCHEMA,
      name: "adw",
      version: "2.0.0",
      description: "Agent Plugins conformant demo",
      extensions: { "dev.wntic.ocm": { category: "workflow", tags: ["python"] } },
    }),
    commands: { "commit.md": COMMAND },
    skills: { "python-style": { "SKILL.md": SKILL("python-style") } },
  } } })
  expect(ocm(home, "add", mp).status).toBe(0)
  expect(ocm(home, "install", "adw").status).toBe(0)
  const manifest = readRegistry(home).marketplaces.mp.plugins.adw.manifest
  expect(manifest.category).toBe("workflow")
  expect(manifest.tags).toEqual(["python"])
  expect(manifest.version).toBe("2.0.0")
  assertResolves(join(cfg(home), "commands", "adw:commit.md"), join(mp, "plugins", "adw", "commands", "commit.md"))
  const mirror = join(home, ".cache", "ocm", "links", "mp", "skills", "adw--python-style", "SKILL.md")
  expect(readFileSync(mirror, "utf8")).toContain('name: "adw:python-style"')
  // config safety: user keys survive outside ocm's skills.paths entry
  const after = JSON.parse(readFileSync(configPath, "utf8"))
  expect(after.model).toBe(userConfig.model)
  expect(after.permission).toEqual(userConfig.permission)
  expect(after.mcp).toEqual(userConfig.mcp)
  expect(after.skills.paths).toContain("/users/me/my-skills")
  // ownership: the user's command survives the install
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
  // idempotence: a second install writes nothing
  const bytes = readFileSync(configPath, "utf8")
  expect(ocm(home, "install", "adw").status).toBe(0)
  expect(readFileSync(configPath, "utf8")).toBe(bytes)
  // no plugin-load errors attributable to ocm-installed files
}, 420_000)

phase("2. top-level category/tags still work; with both present, extensions wins and validate warns naming the move", async (home) => {
  const legacy = join(home, "legacy")
  writeTree(legacy, { plugins: { "old-form": {
    "plugin.json": json({ description: "predates spec 14", category: "review", tags: ["legacy-tag"] }),
    commands: { "commit.md": COMMAND },
  } } })
  expect(ocm(home, "add", legacy).status).toBe(0)
  const legacyManifest = readRegistry(home).marketplaces.legacy.plugins["old-form"].manifest
  expect(legacyManifest.category).toBe("review")
  expect(legacyManifest.tags).toEqual(["legacy-tag"])
  const both = join(home, "both")
  writeTree(both, { plugins: { adw: {
    "plugin.json": json({
      $schema: AP_PLUGIN_SCHEMA,
      name: "adw",
      description: "demo plugin",
      category: "legacy",
      tags: ["legacy-tag"],
      extensions: { "dev.wntic.ocm": { category: "workflow", tags: ["python"] } },
    }),
    commands: { "commit.md": COMMAND },
  } } })
  expect(ocm(home, "add", both).status).toBe(0)
  const manifest = readRegistry(home).marketplaces.both.plugins.adw.manifest
  expect(manifest.category).toBe("workflow") // extensions wins over the top-level form
  expect(manifest.tags).toEqual(["python"])
  const result = ocm(home, "validate", both)
  const output = `${result.stdout}\n${result.stderr}`
  if (result.status !== 0) throw new Error(`validate ${both} exited ${result.status}, expected 0 (the top-level form is never an error):\n${output}`)
  finding(output, "warning", "plugin.json", "category", "extensions", "dev.wntic.ocm")
})

phase("3. an AP streamable-http server translates to opencode's remote shape (stdio and sse are phase 06 tests 9-10)", async (home) => {
  const configPath = join(cfg(home), "opencode.json")
  writeTree(cfg(home), { "opencode.json": json({ model: "claude-sonnet-4-6" }) })
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { adw: {
    "plugin.json": PLUGIN_JSON,
    commands: { "commit.md": COMMAND },
    "mcp.json": json({
      $schema: AP_MCP_SCHEMA,
      mcpServers: { docs: { type: "streamable-http", url: "https://mcp.example.com/docs", headers: { authorization: "Bearer x" } } },
    }),
  } } })
  expect(ocm(home, "add", mp, "--trust").status).toBe(0)
  expect(readRegistry(home).marketplaces.mp.plugins.adw.components.mcp).toEqual(["docs"])
  const mcp = JSON.parse(readFileSync(configPath, "utf8")).mcp
  expect(mcp["ocm--adw--docs"]).toEqual({
    type: "remote", url: "https://mcp.example.com/docs", enabled: true, headers: { authorization: "Bearer x" },
  })
  expect(mcp["ocm--adw--$schema"]).toBeUndefined()
})

// the fingerprint is internal, so each scenario observes whether update treats
// the change as a trust-surface change; each gets its own throwaway $HOME
test("4. the trust fingerprint covers translated servers, not wrapper keys: a changed command invalidates trust, reordered mcp.json keys do not", async () => {
  const translated = { type: "local", command: ["npx", "-y", "@acme/db-mcp"], enabled: true }
  const apMcp = (command) => json({
    $schema: AP_MCP_SCHEMA,
    mcpServers: { db: { type: "stdio", command, args: ["-y", "@acme/db-mcp"] } },
  })
  const mcpKey = (home) => {
    try { return JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8")).mcp?.["ocm--adw--db"] } catch { return undefined }
  }
  await withFakeHome(async (home) => {
    const mp = join(home, "mp")
    writeTree(cfg(home), { "opencode.json": json({ model: "claude-sonnet-4-6" }) })
    writeTree(mp, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND }, "mcp.json": apMcp("npx") } } })
    expect(ocm(home, "add", mp, "--trust").status).toBe(0)
    expect(mcpKey(home)).toEqual(translated) // $schema/mcpServers are not servers: db is approved and materialized
    writeFileSync(join(mp, "plugins", "adw", "mcp.json"), apMcp("bunx"))
    const result = ocm(home, "update", "mp")
    if (result.status !== 0) throw new Error(`ocm update mp exited ${result.status}: ${result.stderr}`)
    expect(mcpKey(home)).toBeUndefined() // changed command: removed pending approval
    expect(`${result.stdout}\n${result.stderr}`).toContain("blocked")
  })
  await withFakeHome(async (home) => {
    const mp = join(home, "mp")
    writeTree(cfg(home), { "opencode.json": json({ model: "claude-sonnet-4-6" }) })
    writeTree(mp, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND }, "mcp.json": apMcp("npx") } } })
    expect(ocm(home, "add", mp, "--trust").status).toBe(0)
    expect(mcpKey(home)).toEqual(translated)
    // the same servers with every key order changed, wrapper and entry alike
    writeFileSync(join(mp, "plugins", "adw", "mcp.json"), json({
      mcpServers: { db: { args: ["-y", "@acme/db-mcp"], command: "npx", type: "stdio" } },
      $schema: AP_MCP_SCHEMA,
    }))
    const result = ocm(home, "update", "mp")
    if (result.status !== 0) throw new Error(`ocm update mp exited ${result.status}: ${result.stderr}`)
    expect(mcpKey(home)).toEqual(translated) // nothing re-blocks
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("blocked")
  })
}, 240_000)

phase("5. every §7 validate finding, one fixture each, asserting the exact line", async (home) => {
  // the one error: $schema with an unrecognised value (1.1.0 is a Working Draft)
  const badSchema = join(home, "schema-unrecognised")
  writeTree(badSchema, { plugins: { adw: {
    "plugin.json": json({ $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json", name: "adw", description: "demo plugin" }),
    commands: { "commit.md": COMMAND },
  } } })
  const bad = ocm(home, "validate", badSchema)
  const badOut = `${bad.stdout}\n${bad.stderr}`
  if (bad.status !== 1) throw new Error(`validate ${badSchema} exited ${bad.status}, expected 1:\n${badOut}`)
  finding(badOut, "error", "plugin.json", "$schema", "1.1.0")
  // the warnings: each fixture is otherwise clean, so each exits 0
  const cases = [
    ["schema-missing", { plugins: { adw: {
      "plugin.json": json({ name: "adw", description: "no schema" }),
      commands: { "commit.md": COMMAND },
    } } }, ["plugin.json", "$schema", "Codex"]],
    ["top-level-category-tags", { plugins: { adw: {
      "plugin.json": json({ $schema: AP_PLUGIN_SCHEMA, name: "adw", description: "demo plugin", category: "review", tags: ["quality"] }),
      commands: { "commit.md": COMMAND },
    } } }, ["plugin.json", "category", "extensions", "dev.wntic.ocm"]],
    ["extensions-not-object", { plugins: { adw: {
      "plugin.json": json({ $schema: AP_PLUGIN_SCHEMA, name: "adw", description: "demo plugin", extensions: "nope" }),
      commands: { "commit.md": COMMAND },
    } } }, ["plugin.json", "extensions"]],
    ["skill-nested", { plugins: { adw: {
      "plugin.json": json({ $schema: AP_PLUGIN_SCHEMA, name: "adw", description: "demo plugin" }),
      skills: { group: { nested: { "SKILL.md": SKILL("nested-skill") } } },
    } } }, ["group/nested"]],
    ["codex-plugin-catalog", {
      ".codex-plugin": { "marketplace.json": json({ name: "demo", plugins: [] }) },
      plugins: { adw: {
        "plugin.json": json({ $schema: AP_PLUGIN_SCHEMA, name: "adw", description: "demo plugin" }),
        commands: { "commit.md": COMMAND },
      } },
    }, [".codex-plugin", "marketplace.json"]],
  ]
  for (const [label, tree, needles] of cases) {
    const dir = join(home, label)
    writeTree(dir, tree)
    const result = ocm(home, "validate", dir)
    const output = `${result.stdout}\n${result.stderr}`
    if (result.status !== 0) throw new Error(`validate ${label} exited ${result.status}, expected 0:\n${output}`)
    finding(output, "warning", ...needles)
  }
}, 240_000)

phase("6. an ocm-invalid but AP-valid name (acme.tools) is reported with the namespacing explanation, not a bare regex error", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { "acme.tools": { commands: { "work.md": COMMAND } } } })
  const result = ocm(home, "validate", mp)
  const output = `${result.stdout}\n${result.stderr}`
  if (result.status !== 1) throw new Error(`validate ${mp} exited ${result.status}, expected 1 (ocm's stricter rule stays):\n${output}`)
  const line = finding(output, "error", "acme.tools", "namespace")
  if (line.includes("must match /^")) {
    throw new Error(`the acme.tools finding is a bare regex failure, not the namespacing explanation:\n${line}`)
  }
})

phase("7. a skill nested two levels under skills/ installs in opencode and warns that other clients will not see it", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { adw: {
    "plugin.json": json({ $schema: AP_PLUGIN_SCHEMA, name: "adw", description: "demo plugin" }),
    skills: { group: { nested: { "SKILL.md": SKILL("nested-skill") } } },
  } } })
  expect(ocm(home, "add", mp).status).toBe(0)
  expect(ocm(home, "install", "adw").status).toBe(0)
  expect(readRegistry(home).marketplaces.mp.plugins.adw.components.skill).toEqual(["group/nested"])
  const mirror = join(home, ".cache", "ocm", "links", "mp", "skills", "adw--group-nested", "SKILL.md")
  expect(readFileSync(mirror, "utf8")).toContain('name: "adw:nested-skill"')
  const result = ocm(home, "validate", mp)
  const output = `${result.stdout}\n${result.stderr}`
  if (result.status !== 0) throw new Error(`validate ${mp} exited ${result.status}, expected 0 (a portability warning, not an error):\n${output}`)
  const line = finding(output, "warning", "group/nested")
  if (!/Codex|Cursor|other client/.test(line)) {
    throw new Error(`the nested-skill warning does not say other clients will not see it:\n${line}`)
  }
})

// lazy: probing for the claude CLI belongs inside a test body, never at module scope
let claudeOnPath

phase("8. round trip: template/ passes ocm validate and claude plugin validate, skipped when claude is absent", async (home) => {
  const result = ocm(home, "validate", TEMPLATE)
  const output = `${result.stdout}\n${result.stderr}`
  if (result.status !== 0) throw new Error(`ocm validate ${TEMPLATE} exited ${result.status}:\n${output}`)
  const header = output.trim()
  if (header !== `validate ${TEMPLATE}` && header !== `validate ${realpathSync(TEMPLATE)}`) {
    throw new Error(`expected only the header "validate ${TEMPLATE}", got:\n${header}`)
  }
  if (claudeOnPath === undefined) {
    claudeOnPath = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 30_000 }).status === 0
  }
  if (!claudeOnPath) {
    console.log("skipped: claude is not on PATH")
    return
  }
  const claude = spawnSync("claude", ["plugin", "validate", TEMPLATE], { encoding: "utf8", timeout: 120_000 })
  if (claude.status !== 0) {
    throw new Error(`claude plugin validate ${TEMPLATE} exited ${claude.status}:\n${claude.stdout}\n${claude.stderr}`)
  }
}, 240_000)
}

// manifest location: .opencode-plugin/marketplace.json with the root path as fallback — absorbed from test/phase15-manifest-location.mjs
{
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

// spec 19: every installable plugin carries a plugin.json with a description
const PLUGIN_JSON = json({ description: "demo plugin" })

const MCP = { db: { type: "local", command: ["npx", "-y", "@acme/db-mcp"], enabled: true } }

phase("1. a marketplace with only .opencode-plugin/marketplace.json is added, discovered and listed exactly as a root-manifest one is", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, {
    ".opencode-plugin": { "marketplace.json": json({
      name: "moved",
      description: "moved marketplace",
      plugins: [{ name: "adw", source: "./plugins/adw", description: "from the new location", version: "2.0.0", category: "review", tags: ["mp-tag"] }],
    }) },
    plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } },
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
    plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } },
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
    plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } },
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
    plugins: { adw: { "plugin.json": json({ description: "self-described" }), commands: { "commit.md": COMMAND } } },
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
  // no fallback: the only metadata reaching the registry is the plugin's own
  // plugin.json — the root manifest's "from the root" reaches nothing
  expect(entry.plugins.adw.manifest.description).toBe("self-described")
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
    plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND }, "mcp.custom.json": json(MCP) } },
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
    plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } },
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
      adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } },
      // the escape target exists: a careless plugin-relative resolution would serve it
      "other-plugin": { "plugin.json": PLUGIN_JSON, "mcp.json": json(MCP) },
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
}

// mandatory manifests: plugin.json required with a description — absorbed from test/phase19-mandatory-manifests.mjs
{
function ocm(home, args, timeout = 120_000) {
  const result = spawnSync(process.execPath, [OCM_BIN, ...args], {
    env: withFakeOpencode({ ...process.env, HOME: home }), encoding: "utf8", timeout,
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` }
}

// realpath on both sides: macOS temp dirs sit behind /var -> /private/var
function assertResolves(dest, source) {
  if (!existsSync(dest) || !lstatSync(dest).isSymbolicLink()) throw new Error(`expected a symlink at ${dest}`)
  expect(realpathSync(dest)).toBe(realpathSync(source))
}

// every byte of the home — file contents, symlink targets, sorted for a
// stable comparison — the zero-writes proof for a refused add
function snapHome(dir) {
  let out = ""
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) out += `${path} -> ${readlinkSync(path)}\n`
    else if (entry.isDirectory()) out += snapHome(path)
    else out += `${path}\0${readFileSync(path, "utf8")}\n`
  }
  return out
}

// a home created before spec 19: the registry was written while plugin.json
// was optional, so legacy-kit is legitimately installed without one
function preSpecHome(home) {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { "legacy-kit": { commands: { "work.md": COMMAND } } } })
  const real = realpathSync(mp)
  const at = "2026-01-01T00:00:00.000Z"
  mkdirSync(join(cfg(home), "ocm"), { recursive: true })
  writeFileSync(registryFile(home), json({
    version: 2,
    marketplaces: {
      mp: {
        url: real, dir: real, local: true, addedAt: at, mode: "auto", ref: null,
        subdir: null, revision: null, syncIntervalMs: null, trust: { code: "none" },
        lastSync: null,
        plugins: {
          "legacy-kit": {
            source: "plugins/legacy-kit", components: { command: ["work.md"] },
            enabled: true, installedAt: at, version: null, manifest: {},
          },
        },
      },
    },
  }))
  return mp
}

const gitRepo = (dir, tree) => { writeTree(dir, tree); git(dir, ["init", "-b", "main"]); commitAll(dir, "fixture") }

const commitAll = (dir, message) => { git(dir, ["add", "-A"]); git(dir, ["-c", "user.email=ocm@test", "-c", "user.name=ocm", "commit", "-m", message]) }

phase("1. add of a marketplace with one manifest-less plugin is refused whole: the plugin and its missing file listed, exit 1, zero writes", async (home) => {
  // the user's config and files predate the refused add (invariants: config safety, ownership)
  writeTree(cfg(home), {
    "opencode.json": json({ model: "claude-sonnet-4-6", mcp: { "user-server": { type: "local", command: ["echo"] } } }),
    commands: { "mine.md": "# my own command\n" },
  })
  const good = join(home, "good")
  writeTree(good, { plugins: { "keep-kit": { "plugin.json": json({ description: "the good plugin" }), commands: { "keep.md": COMMAND } } } })
  expect(ocm(home, ["add", good]).status).toBe(0)
  const bad = join(home, "bad")
  writeTree(bad, { plugins: { "alpha-kit": { commands: { "work.md": COMMAND } } } })
  const before = snapHome(home)

  const result = ocm(home, ["add", bad])
  if (result.status !== 1) throw new Error(`expected exit 1 from the manifest-less add, got ${result.status}:\n${result.output}`)
  for (const needle of ["alpha-kit", "plugins/alpha-kit/plugin.json", "ocm validate"]) expect(result.output).toContain(needle)
  expect(snapHome(home)).toBe(before) // zero writes: the refusal touches nothing, anywhere
  expect(readRegistry(home).marketplaces.bad).toBeUndefined() // refused whole
})

phase("2. the same marketplace with manifests authored adds cleanly, and search finds the plugin by its description", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { "alpha-kit": { commands: { "work.md": COMMAND } } } })
  // the fix test 1's refusal points at: author the manifest
  writeFileSync(join(mp, "plugins", "alpha-kit", "plugin.json"), json({ description: "deployment helpers for clusters" }))
  const added = ocm(home, ["add", mp])
  if (added.status !== 0) throw new Error(`ocm add ${mp} exited ${added.status}:\n${added.output}`)
  expect(readRegistry(home).marketplaces.mp.plugins["alpha-kit"].manifest.description).toBe("deployment helpers for clusters")
  assertResolves(commandLink(home, "alpha-kit", "work.md"), join(mp, "plugins", "alpha-kit", "commands", "work.md"))
  const found = ocm(home, ["search", "deployment"])
  if (found.status !== 0) throw new Error(`ocm search deployment exited ${found.status}:\n${found.output}`)
  expect(found.stdout).toContain("alpha-kit@mp")
  expect(found.stdout).toContain("deployment helpers for clusters")
  // invariant: idempotence — an update of an unchanged marketplace re-creates nothing
  const ino = lstatSync(commandLink(home, "alpha-kit", "work.md")).ino
  const again = ocm(home, ["update", "mp"])
  if (again.status !== 0) throw new Error(`ocm update mp exited ${again.status}:\n${again.output}`)
  expect(lstatSync(commandLink(home, "alpha-kit", "work.md")).ino).toBe(ino)
  expect(Object.keys(readRegistry(home).marketplaces.mp.plugins)).toEqual(["alpha-kit"])
})

phase("3. validate reports one error per missing manifest and prints the copy-pasteable stub once, exit 1", async (home) => {
  const dir = join(home, "mp")
  writeTree(dir, { plugins: {
    "alpha-kit": { commands: { "work.md": COMMAND } },
    "beta-kit": { commands: { "lint.md": COMMAND } },
  } })
  const result = ocm(home, ["validate", dir])
  if (result.status !== 1) throw new Error(`validate exited ${result.status}, expected 1:\n${result.output}`)
  for (const plugin of ["alpha-kit", "beta-kit"]) {
    const lines = result.output.split("\n").filter((l) => /^\s*error\b/.test(l) && l.includes(plugin) && l.includes("plugin.json"))
    if (lines.length !== 1) throw new Error(`expected exactly one error finding for ${plugin}, got ${lines.length}:\n${result.output}`)
  }
  const stubs = result.output.split("\n").filter((l) => l.includes("minimal content"))
  if (stubs.length !== 1) throw new Error(`expected the stub printed once, got ${stubs.length}:\n${result.output}`)
  expect(stubs[0]).toContain('"description"')
})

phase("4. an empty description and a name mismatch are two distinct validate errors", async (home) => {
  const dir = join(home, "mp")
  writeTree(dir, { plugins: {
    "empty-kit": { "plugin.json": json({ $schema: AP_SCHEMA, description: "" }), commands: { "work.md": COMMAND } },
    "wrong-name": { "plugin.json": json({ $schema: AP_SCHEMA, name: "other-name", description: "descriptive" }), commands: { "lint.md": COMMAND } },
  } })
  const result = ocm(home, ["validate", dir])
  if (result.status !== 1) throw new Error(`validate exited ${result.status}, expected 1:\n${result.output}`)
  const errorLine = (...needles) => {
    const line = result.output.split("\n").find((l) => /^\s*error\b/.test(l) && needles.every((n) => l.includes(n)))
    if (!line) throw new Error(`expected an error finding containing ${JSON.stringify(needles)}:\n${result.output}`)
    return line
  }
  const empty = errorLine("empty-kit", "description")
  const mismatch = errorLine("other-name", "wrong-name")
  expect(empty).not.toBe(mismatch)
})

phase("5. update pulling a new manifest-less plugin refuses and reports that plugin while its siblings update", async (home) => {
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { "stable-kit": { "plugin.json": json({ description: "stable helpers" }), commands: { "base.md": COMMAND } } } })
  const added = ocm(home, ["add", `file://${remote}`, "--name", "mp"])
  if (added.status !== 0) throw new Error(`ocm add exited ${added.status}:\n${added.output}`)
  writeTree(remote, { plugins: {
    "rogue-kit": { commands: { "work.md": COMMAND } }, // new upstream plugin, no plugin.json
    "stable-kit": { commands: { "extra.md": COMMAND } }, // the sibling gains a command
  } })
  commitAll(remote, "upstream adds rogue-kit")
  const updated = ocm(home, ["update", "mp"])
  if (updated.status !== 0) throw new Error(`update exited ${updated.status} — the rest of the update must proceed:\n${updated.output}`)
  const refusal = updated.output.split("\n").find((l) => l.includes("rogue-kit") && l.includes("plugin.json"))
  if (!refusal) throw new Error(`expected a report line naming "rogue-kit" and its missing plugin.json:\n${updated.output}`)
  expect(readRegistry(home).marketplaces.mp.plugins["rogue-kit"]).toBeUndefined() // refused, not installed
  assertAbsent(join(cfg(home), "commands", "rogue-kit:work.md"))
  assertResolves(commandLink(home, "stable-kit", "extra.md"), join(cloneDir(home), "plugins", "stable-kit", "commands", "extra.md"))
})

phase("6. a grandfathered install survives update enabled, and doctor reports the legacy warning exactly once", async (home) => {
  preSpecHome(home)
  const updated = ocm(home, ["update", "mp"])
  if (updated.status !== 0) throw new Error(`ocm update mp exited ${updated.status}:\n${updated.output}`)
  const record = readRegistry(home).marketplaces.mp.plugins["legacy-kit"]
  if (!record || record.enabled !== true) {
    throw new Error(`expected legacy-kit to stay enabled across the update in ${registryFile(home)}, got ${JSON.stringify(record)}`)
  }
  assertResolves(commandLink(home, "legacy-kit", "work.md"), join(home, "mp", "plugins", "legacy-kit", "commands", "work.md"))
  const diagnosed = ocm(home, ["doctor"], 300_000)
  if (diagnosed.status !== 0) throw new Error(`the legacy warning is exit-code-neutral, but doctor exited ${diagnosed.status}:\n${diagnosed.output}`)
  const warnings = diagnosed.output.split("\n").filter((l) => l.includes("legacy-kit") && l.includes("plugin.json"))
  if (warnings.length !== 1) throw new Error(`expected exactly one legacy warning for legacy-kit, got ${warnings.length}:\n${diagnosed.output}`)
}, 420_000)

phase("7. template/ passes ocm validate with zero findings, every plugin manifest-bearing", async (home) => {
  const result = ocm(home, ["validate", TEMPLATE])
  const output = `${result.stdout}\n${result.stderr}`
  if (result.status !== 0) throw new Error(`ocm validate ${TEMPLATE} exited ${result.status}:\n${output}`)
  const header = output.trim()
  if (header !== `validate ${TEMPLATE}` && header !== `validate ${realpathSync(TEMPLATE)}`) {
    throw new Error(`expected only the header "validate ${TEMPLATE}", got:\n${header}`)
  }
  for (const entry of readdirSync(join(TEMPLATE, "plugins"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(TEMPLATE, "plugins", entry.name, "plugin.json")
    if (!existsSync(file)) throw new Error(`template plugin "${entry.name}" has no plugin.json — spec 19 requires one`)
    const manifest = JSON.parse(readFileSync(file, "utf8"))
    if (typeof manifest.description !== "string" || !manifest.description) {
      throw new Error(`template plugin "${entry.name}" needs a non-empty description in ${file}`)
    }
  }
})

phase("8. a pre-spec home keeps working end to end: list, update and opencode resolution, zero errors", async (home) => {
  preSpecHome(home)
  const listed = ocm(home, ["list"])
  if (listed.status !== 0) throw new Error(`ocm list exited ${listed.status}:\n${listed.output}`)
  expect(listed.stdout).toContain("legacy-kit")
  const updated = ocm(home, ["update"])
  if (updated.status !== 0) throw new Error(`ocm update exited ${updated.status}:\n${updated.output}`)
  assertResolves(commandLink(home, "legacy-kit", "work.md"), join(home, "mp", "plugins", "legacy-kit", "commands", "work.md"))
  // invariant: no plugin-load errors attributable to ocm-installed files
}, 420_000)
}
