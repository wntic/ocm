// Phase 14 — docs/specs/14-agent-plugins.md: one test per numbered item, plus
// the four invariants (config safety, ownership and idempotence in 1, no
// plugin errors in 1). Items 3 and 4 are partly landed: phase 06 tests 9–10
// already pin AP stdio and sse translation, so item 3's test here covers only
// the missing streamable-http transport, and item 4's the trust fingerprint
// over the AP shape. Item 8's `claude plugin validate` half skips when the
// claude CLI is absent.
import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { opencodeProbe, withFakeHome } from "./harness.mjs"

const OCM_BIN = fileURLToPath(new URL("../bin/ocm.ts", import.meta.url))
const TEMPLATE = fileURLToPath(new URL("../template", import.meta.url))
const AP_PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
const AP_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"

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
const registryFile = (home) => join(cfg(home), "ocm", "registry.json")
const readRegistry = (home) => JSON.parse(readFileSync(registryFile(home), "utf8"))
const json = (value) => `${JSON.stringify(value, null, 2)}\n`
// spec 19: description is the one required plugin.json field
const PLUGIN_JSON = json({ description: "demo plugin" })
const COMMAND = "---\ndescription: commit helper\n---\n\nCommit body.\n"
const SKILL = (name) => `---\nname: ${name}\ndescription: ${name} guidance\n---\n\n# ${name}\n\nBody.\n`

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
  const probe = opencodeProbe(cfg(home), home)
  if (!probe.available) console.log("skipped: opencode is not on PATH")
  else {
    if (probe.unreliable) throw new Error("probe cannot trust itself: the canary broken plugin produced no error line")
    expect(probe.pluginErrors).toEqual([])
  }
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
