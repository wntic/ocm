// Phase 07 — docs/specs/07-trust.md: one test per numbered item, plus the four
// invariants (config safety, ownership, idempotence in 7 and 4, no plugin
// errors in 2). Spawned stdio is the non-TTY context, so prompting is tested
// via the flags and the "print what would have been asked" rule.
import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, opencodeProbe, withFakeHome } from "./harness.mjs"

const OCM_BIN = fileURLToPath(new URL("../bin/ocm.ts", import.meta.url))
const CORE_MODULE = fileURLToPath(new URL("../loader/core.js", import.meta.url))

function run(home, modulePath, args) {
  const result = spawnSync(process.execPath, [modulePath, ...args], {
    env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 120_000,
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}
const ocm = (home, ...args) => run(home, OCM_BIN, args)

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
const pluginLink = (home, plugin = "adw", file = "notify.js") => join(cfg(home), "plugins", `ocm--${plugin}--${file}`)
const commandLink = (home, plugin = "adw") => join(cfg(home), "commands", `${plugin}:commit.md`)
const skillMirror = (home, mp = "mp", plugin = "adw") => join(home, ".cache", "ocm", "links", mp, "skills", `${plugin}--python-style`)
const mcpKeys = (home) => { try { return JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8")).mcp ?? {} } catch { return {} } }

// realpath on both sides: macOS temp dirs sit behind /var -> /private/var
function assertResolves(dest, source) {
  if (!existsSync(dest) || !lstatSync(dest).isSymbolicLink()) throw new Error(`expected a symlink at ${dest}`)
  expect(realpathSync(dest)).toBe(realpathSync(source))
}

function addAt(home, rel, tree, ...flags) {
  const dir = join(home, rel)
  writeTree(dir, tree)
  const result = ocm(home, "add", dir, ...flags)
  if (result.status !== 0) throw new Error(`ocm add ${dir} exited ${result.status}: ${result.stderr}`)
  return [dir, result]
}

const COMMAND = "---\ndescription: commit helper\n---\n\nCommit body.\n"
const SKILL = "---\nname: python-style\ndescription: Python style guidance\n---\n\n# Python style\n\nUse ruff.\n"
const JS_PLUGIN = 'export default { id: "adw-notify", server: async () => ({}) }\n'
const JS_PLUGIN_CHANGED = `// v2\n${JS_PLUGIN}`
const JS_PLUGIN_PING = 'export default { id: "adw-ping", server: async () => ({}) }\n'
const USER_PLUGIN = 'export default { id: "mine", server: async () => ({}) }\n'
const MCP = { db: { type: "local", command: ["npx", "-y", "@acme/db-mcp"], enabled: true } }
const MCP_COMMAND_CHANGED = { db: { type: "local", command: ["npx", "-y", "@acme/db-mcp@2"], enabled: true } }
// the same server entry as MCP, keys reordered: canonicalised JSON must not change the fingerprint
const MCP_REORDERED = { db: { enabled: true, command: ["npx", "-y", "@acme/db-mcp"], type: "local" } }
const mcpJson = (servers) => `${JSON.stringify(servers, null, 2)}\n`

// one plugin carrying both kinds of executable component plus stuff
function trustedTree(plugin = "adw") {
  return { plugins: { [plugin]: {
    commands: { "commit.md": COMMAND },
    skills: { "python-style": { "SKILL.md": SKILL } },
    plugin: { "notify.js": JS_PLUGIN },
    "mcp.json": mcpJson(MCP),
  } } }
}

phase("1. a marketplace with no executable component never prompts and records code \"none\"", async (home) => {
  const [mp, result] = addAt(home, "mp", { plugins: { adw: {
    commands: { "commit.md": COMMAND },
    skills: { "python-style": { "SKILL.md": SKILL } },
  } } })
  const output = `${result.stdout}\n${result.stderr}`
  // nothing would have been asked, so nothing trust-related is printed
  expect(output).not.toContain("ships code")
  expect(output).not.toContain("trust this marketplace")
  expect(output).not.toContain("blocked")
  expect(readRegistry(home).marketplaces.mp.trust).toEqual({ code: "none" })
  assertResolves(commandLink(home), join(mp, "plugins", "adw", "commands", "commit.md"))
  expect(lstatSync(skillMirror(home)).isDirectory()).toBe(true)
})

phase("2. --trust materializes the JS plugin and the MCP keys; --no-trust materializes the stuff, blocks both executable components and reports them", async (home) => {
  const [yesDir, yes] = addAt(home, "mp-yes", trustedTree("adw"), "--trust")
  expect(`${yes.stdout}\n${yes.stderr}`).not.toContain("trust this marketplace") // the flag answers, no prompt
  const granted = readRegistry(home).marketplaces["mp-yes"].trust
  expect(granted.code).toBe("granted")
  expect(typeof granted.grantedAt).toBe("string")
  expect(typeof granted.fingerprint).toBe("string") // recorded at the grant
  assertResolves(pluginLink(home), join(yesDir, "plugins", "adw", "plugin", "notify.js"))
  expect(mcpKeys(home)["ocm--adw--db"]).toEqual(MCP.db)
  const [noDir, no] = addAt(home, "mp-no", trustedTree("beta"), "--no-trust")
  expect(readRegistry(home).marketplaces["mp-no"].trust.code).toBe("denied")
  assertAbsent(pluginLink(home, "beta"))
  expect(mcpKeys(home)["ocm--beta--db"]).toBeUndefined()
  // both executable components are reported blocked, each named
  const blocked = `${no.stdout}\n${no.stderr}`.split("\n").filter((l) => l.includes("blocked")).join("\n")
  expect(blocked).toContain("notify.js")
  expect(blocked).toContain("mcp")
  assertResolves(commandLink(home, "beta"), join(noDir, "plugins", "beta", "commands", "commit.md"))
  // invariant: no plugin-load errors attributable to ocm-installed files
  const probe = opencodeProbe(cfg(home), home)
  if (!probe.available) console.log("skipped: opencode is not on PATH")
  else {
    if (probe.unreliable) throw new Error("probe cannot trust itself: the canary broken plugin produced no error line")
    expect(probe.pluginErrors).toEqual([])
  }
}, 420_000) // opencode spawns with plugin files present: canary + error scan

// the fingerprint is internal, so each scenario observes whether update treats
// the change as a trust-surface change; each case gets its own throwaway $HOME
async function updateCase(mutate, verify) {
  await withFakeHome(async (home) => {
    const [mp] = addAt(home, "mp", trustedTree(), "--trust")
    // the granted baseline: both executable components are materialized
    assertResolves(pluginLink(home), join(mp, "plugins", "adw", "plugin", "notify.js"))
    expect(mcpKeys(home)["ocm--adw--db"]).toEqual(MCP.db)
    mutate(mp)
    const result = ocm(home, "update", "mp")
    if (result.status !== 0) throw new Error(`ocm update mp exited ${result.status}: ${result.stderr}`)
    verify(home, mp, `${result.stdout}\n${result.stderr}`)
  })
}

test("3. the fingerprint follows executable content: notify.js edits, new plugin files and MCP command changes re-block; mcp.json key order and stuff-only edits do not", async () => {
  await updateCase(
    (mp) => writeFileSync(join(mp, "plugins", "adw", "plugin", "notify.js"), JS_PLUGIN_CHANGED),
    (home, _mp, output) => {
      assertAbsent(pluginLink(home)) // changed component: unlinked pending approval
      expect(mcpKeys(home)["ocm--adw--db"]).toEqual(MCP.db) // unchanged component stays
      expect(output).toContain("blocked")
    })
  await updateCase(
    (mp) => writeFileSync(join(mp, "plugins", "adw", "plugin", "ping.js"), JS_PLUGIN_PING),
    (home, mp, output) => {
      assertResolves(pluginLink(home), join(mp, "plugins", "adw", "plugin", "notify.js")) // trusted file stays
      assertAbsent(pluginLink(home, "adw", "ping.js")) // new component: not linked until approved
      expect(output).toContain("blocked")
      expect(output).toContain("ping")
    })
  await updateCase(
    (mp) => writeFileSync(join(mp, "plugins", "adw", "mcp.json"), mcpJson(MCP_COMMAND_CHANGED)),
    (home, mp, output) => {
      expect(mcpKeys(home)["ocm--adw--db"]).toBeUndefined() // changed entry: removed pending approval
      assertResolves(pluginLink(home), join(mp, "plugins", "adw", "plugin", "notify.js")) // unchanged stays
      expect(output).toContain("blocked")
    })
  // the two "does not change" cases share a verify: nothing re-blocks
  const unchanged = (home, mp, output) => {
    assertResolves(pluginLink(home), join(mp, "plugins", "adw", "plugin", "notify.js"))
    expect(mcpKeys(home)["ocm--adw--db"]).toEqual(MCP.db)
    expect(output).not.toContain("blocked")
  }
  await updateCase((mp) => writeFileSync(join(mp, "plugins", "adw", "mcp.json"), mcpJson(MCP_REORDERED)), unchanged)
  await updateCase(
    (mp) => writeFileSync(join(mp, "plugins", "adw", "commands", "commit.md"), `${COMMAND}<!-- a comment -->\n`),
    unchanged)
}, 240_000)

phase("4. an update that changes a trusted file unlinks it, reports it blocked, and leaves stuff installed", async (home) => {
  const [mp] = addAt(home, "mp", trustedTree(), "--trust")
  assertResolves(pluginLink(home), join(mp, "plugins", "adw", "plugin", "notify.js"))
  writeFileSync(join(mp, "plugins", "adw", "plugin", "notify.js"), JS_PLUGIN_CHANGED)
  const result = ocm(home, "update", "mp")
  if (result.status !== 0) throw new Error(`ocm update mp exited ${result.status}: ${result.stderr}`)
  const output = `${result.stdout}\n${result.stderr}`
  // the link pointed at the working tree the update advanced: unlink and report, never serve new content
  assertAbsent(pluginLink(home))
  expect(output).toContain("blocked")
  expect(output).toContain("notify")
  assertResolves(commandLink(home), join(mp, "plugins", "adw", "commands", "commit.md"))
  expect(lstatSync(skillMirror(home)).isDirectory()).toBe(true)
  // invariant: idempotence — a second update against the same unapproved change links nothing further
  const commandIno = lstatSync(commandLink(home)).ino
  expect(ocm(home, "update", "mp").status).toBe(0)
  assertAbsent(pluginLink(home))
  expect(lstatSync(commandLink(home)).ino).toBe(commandIno)
})

phase("5. without a TTY, add prints what would have been asked, treats it as skip, and exits 0", async (home) => {
  // the CLI runs with piped stdio: !process.stdin.isTTY
  const [mp, result] = addAt(home, "mp", trustedTree())
  const output = `${result.stdout}\n${result.stderr}`
  expect(output).toContain("ships code")
  expect(output).toContain("trust this marketplace")
  // skip, not a default "no": the decision is left open for the next time
  expect(readRegistry(home).marketplaces.mp.trust.code).toBe("none")
  assertAbsent(pluginLink(home))
  expect(mcpKeys(home)["ocm--adw--db"]).toBeUndefined()
  assertResolves(commandLink(home), join(mp, "plugins", "adw", "commands", "commit.md"))
})

const SYNC_RUNNER = "const mod = await import(process.argv[2]); await mod.syncAll({ force: true })\n"

// the loader's startup sync, run the way ocm-loader.js runs it: a child process on the fake $HOME
function loaderSync(home) {
  const runner = join(home, "sync-runner.mjs")
  writeFileSync(runner, SYNC_RUNNER)
  return run(home, runner, [CORE_MODULE])
}

phase("6. the loader's sync never materializes a newly appeared executable component and records trustPending", async (home) => {
  const [mp] = addAt(home, "mp", trustedTree(), "--trust")
  assertResolves(pluginLink(home), join(mp, "plugins", "adw", "plugin", "notify.js"))
  // the threat model's exact shape: a quiet update adds code to run
  writeFileSync(join(mp, "plugins", "adw", "plugin", "ping.js"), JS_PLUGIN_PING)
  const synced = loaderSync(home)
  if (synced.status !== 0) throw new Error(`loader sync exited ${synced.status}: ${synced.stderr}`)
  assertAbsent(pluginLink(home, "adw", "ping.js")) // new code: never linked unattended
  assertResolves(pluginLink(home), join(mp, "plugins", "adw", "plugin", "notify.js")) // unchanged: stays
  // the marketplace is marked so the next ocm invocation and the TUI report it
  expect(readRegistry(home).marketplaces.mp.trustPending).toBeTruthy()
  assertResolves(commandLink(home), join(mp, "plugins", "adw", "commands", "commit.md")) // stuff untouched
})

phase("7. ocm untrust removes the executable components and leaves stuff in place", async (home) => {
  // invariants: config safety and ownership — the user's keys and their own
  // plugin file predate every ocm run and must survive the untrust
  const userConfig = { model: "claude-sonnet-4-6", mcp: { "user-server": { type: "local", command: ["echo"] } } }
  writeTree(cfg(home), { "opencode.json": `${JSON.stringify(userConfig, null, 2)}\n`, plugins: { "my-own.js": USER_PLUGIN } })
  const [mp] = addAt(home, "mp", trustedTree(), "--trust")
  assertResolves(pluginLink(home), join(mp, "plugins", "adw", "plugin", "notify.js"))
  const result = ocm(home, "untrust", "mp")
  if (result.status !== 0) throw new Error(`ocm untrust mp exited ${result.status}: ${result.stderr}`)
  assertAbsent(pluginLink(home)) // executable components go immediately
  expect(mcpKeys(home)["ocm--adw--db"]).toBeUndefined()
  expect(readRegistry(home).marketplaces.mp.trust.code).toBe("denied")
  // stuff stays
  assertResolves(commandLink(home), join(mp, "plugins", "adw", "commands", "commit.md"))
  expect(lstatSync(skillMirror(home)).isDirectory()).toBe(true)
  // the user's plugin file and config keys survived outside ocm's ownership
  expect(readFileSync(join(cfg(home), "plugins", "my-own.js"), "utf8")).toBe(USER_PLUGIN)
  const after = JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8"))
  expect(after.mcp).toEqual({ "user-server": { type: "local", command: ["echo"] } })
  expect(after.model).toBe("claude-sonnet-4-6")
  // invariant: idempotence — a second untrust changes nothing
  const bytes = readFileSync(registryFile(home), "utf8")
  expect(ocm(home, "untrust", "mp").status).toBe(0)
  expect(readFileSync(registryFile(home), "utf8")).toBe(bytes)
  assertAbsent(pluginLink(home))
})
