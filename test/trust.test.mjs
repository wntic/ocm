// Trust: executable components stay blocked until a marketplace is
// trusted, and an update that changes a trusted file blocks it.

import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, withFakeHome, assertFileExists, withFakeOpencode } from "./harness.mjs"

// Helpers shared verbatim by the absorbed files below.

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

const mcpJson = (servers) => `${JSON.stringify(servers, null, 2)}\n`

const PTY_SCRIPT = fileURLToPath(new URL("./ocm-pty.py", import.meta.url))

function git(dir, args) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: 120_000 })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${r.stderr}`)
}

const commitAll = (dir, msg) => { git(dir, ["add", "-A"]); git(dir, ["-c", "user.email=ocm@test", "-c", "user.name=ocm", "commit", "-m", msg]) }

const gitRepo = (dir, tree) => { writeTree(dir, tree); git(dir, ["init", "-b", "main"]); commitAll(dir, "fixture") }

const cloneDir = (home, name = "mp") => join(home, ".cache", "ocm", "marketplaces", name)

const json = (value) => `${JSON.stringify(value, null, 2)}\n`

const localMp = (home) => { const mp = join(home, "mp"); writeTree(mp, trustedTree()); return mp }

// spec 19: every installable plugin carries a plugin.json with a description
const PLUGIN_JSON = `${JSON.stringify({ description: "demo plugin" }, null, 2)}\n`

// one plugin carrying both kinds of executable component plus stuff
function trustedTree(plugin = "adw") {
  return { plugins: { [plugin]: {
    "plugin.json": PLUGIN_JSON,
    commands: { "commit.md": COMMAND },
    skills: { "python-style": { "SKILL.md": SKILL } },
    plugin: { "notify.js": JS_PLUGIN },
    "mcp.json": mcpJson(MCP),
  } } }
}

// trust: executable components stay blocked until granted — absorbed from test/phase07-trust.mjs
{
// realpath on both sides: macOS temp dirs sit behind /var -> /private/var
function assertResolves(dest, source) {
  if (!existsSync(dest) || !lstatSync(dest).isSymbolicLink()) throw new Error(`expected a symlink at ${dest}`)
  expect(realpathSync(dest)).toBe(realpathSync(source))
}

// the same server entry as MCP, keys reordered: canonicalised JSON must not change the fingerprint
const MCP_REORDERED = { db: { enabled: true, command: ["npx", "-y", "@acme/db-mcp"], type: "local" } }

phase("1. a marketplace with no executable component never prompts and records code \"none\"", async (home) => {
  const [mp, result] = addAt(home, "mp", { plugins: { adw: {
    "plugin.json": PLUGIN_JSON,
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
}, 420_000)

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
}

// the trust flow: add-time decisions, fingerprints, what stays blocked — absorbed from test/phase16-trust-flow.mjs
{
function ocm(home, args, timeout = 120_000) {
  const r = spawnSync(process.execPath, [OCM_BIN, ...args], { env: withFakeOpencode({ ...process.env, HOME: home }), encoding: "utf8", timeout })
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` }
}

const readRegistry = (home) => JSON.parse(readFileSync(join(cfg(home), "ocm", "registry.json"), "utf8"))

const commandLink = (home, plugin = "adw", file = "commit.md") => join(cfg(home), "commands", `${plugin}:${file}`)

// realpath on both sides: macOS temp dirs sit behind /var -> /private/var
function assertResolves(dest, source) {
  if (!existsSync(dest) || !lstatSync(dest).isSymbolicLink()) throw new Error(`expected a symlink at ${dest}`)
  expect(realpathSync(dest)).toBe(realpathSync(source))
}

// runs `ocm <args>` under the pty fixture (protocol in ocm-pty.py); throws
// unless the trust prompt appeared and ocm exited on its own
function ptyOcm(home, mode, args) {
  const result = spawnSync("python3", [PTY_SCRIPT, mode, process.execPath, OCM_BIN, ...args], {
    env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 120_000,
  })
  if (result.error || result.status === null) throw new Error(`the pty run failed: ${result.error?.message ?? result.stderr}`)
  let run
  try { run = JSON.parse(result.stdout) } catch { throw new Error(`the pty helper printed no JSON: ${result.stdout}\n${result.stderr}`) }
  if (!run.acted) throw new Error(`the trust prompt never appeared under the pty:\n${run.stderr}`)
  if (run.timed_out) throw new Error(`ocm never exited after the prompt interaction:\n${run.stderr}`)
  return { ...run, output: `${run.stdout}\n${run.stderr}` }
}

// one plugin carrying both kinds of executable component plus stuff
function trustedTree(plugin = "adw") {
  return { plugins: { [plugin]: {
    "plugin.json": json({ description: "demo plugin" }), // spec 19
    commands: { "commit.md": COMMAND }, plugin: { "notify.js": JS_PLUGIN },
    "mcp.json": `${JSON.stringify(MCP, null, 2)}\n`,
  } } }
}

// a git-remote marketplace added under flags — undecided for tests 4 and 9
function addRemote(home, flags) {
  const remote = join(home, "remote")
  gitRepo(remote, trustedTree())
  expect(ocm(home, ["add", `file://${remote}`, "--name", "mp", ...flags]).status).toBe(0)
  return remote
}

// addRemote granted up front, then one plugin file changed and committed
const grantedChanged = (home, file, content) => {
  const remote = addRemote(home, ["--trust"])
  writeFileSync(join(remote, "plugins", "adw", "plugin", file), content)
  commitAll(remote, "change the executable component")
  return remote
}

const JS_PLUGIN = 'export default { id: "phase16-notify", server: async () => ({}) }\n'

const JS_PLUGIN_PING = 'export default { id: "phase16-ping", server: async () => ({}) }\n'

phase("1. Ctrl+C at the add trust prompt exits 130 with the loader installed and a summary block naming the state, leaving a doctor-clean installation", async (home) => {
  const mp = localMp(home)
  const result = ptyOcm(home, "sigint", ["add", mp])
  expect(result.status).toBe(130) // the SIGINT convention, never a silent 0
  assertFileExists(join(cfg(home), "plugins", "ocm-loader.js")) // rule 1.1: the loader precedes the prompt
  for (const needle of ["interrupted", "undecided", "ocm trust mp", "ocm remove mp"]) expect(result.stderr).toContain(needle)
  // the state the summary names is true: registered, undecided, stuff materialized, executables blocked
  expect(readRegistry(home).marketplaces.mp.trust).toEqual({ code: "none" })
  assertResolves(commandLink(home), join(mp, "plugins", "adw", "commands", "commit.md"))
  assertAbsent(pluginLink(home))
  expect(mcpKeys(home)["ocm--adw--db"]).toBeUndefined()
  const doctor = ocm(home, ["doctor"], 300_000) // registry and links agree: the interrupted mutation is consistent
  if (doctor.status !== 0) throw new Error(`ocm doctor exited ${doctor.status} after the interrupted add:\n${doctor.output}`)
}, 420_000)

phase("2. ocm trust mp --yes grants non-interactively: fingerprint recorded, executable components linked, exit 0", async (home) => {
  const mp = localMp(home)
  expect(ocm(home, ["add", mp]).status).toBe(0) // non-TTY add: undecided, executables blocked
  expect(readRegistry(home).marketplaces.mp.trust.code).toBe("none")
  expect(ocm(home, ["trust", "mp", "--yes"]).status).toBe(0)
  const trust = readRegistry(home).marketplaces.mp.trust
  expect(trust.code).toBe("granted")
  expect(trust.fingerprint).toMatch(/^[0-9a-f]{64}$/) // recorded at the grant
  assertResolves(pluginLink(home), join(mp, "plugins", "adw", "plugin", "notify.js"))
  expect(mcpKeys(home)["ocm--adw--db"]).toEqual(MCP.db)
})

phase("3. ocm trust mp without --yes on a non-TTY exits 1 naming --yes and leaves trust unchanged", async (home) => {
  const mp = localMp(home)
  expect(ocm(home, ["add", mp]).status).toBe(0)
  const result = ocm(home, ["trust", "mp"])
  expect(result.status).toBe(1) // today it exits 0 having granted nothing — a lie by exit code
  expect(result.output).toContain("--yes")
  expect(readRegistry(home).marketplaces.mp.trust.code).toBe("none") // trust unchanged
  assertAbsent(pluginLink(home))
})

phase("4. an update with undecided trust and nothing new prints one reminder line, not the risk block or the prompt", async (home) => {
  addRemote(home, [])
  const result = ocm(home, ["update", "mp"])
  expect(result.status).toBe(0)
  expect(result.output).not.toContain("ships code") // no risk block
  expect(result.output).not.toContain("trust this marketplace to run code?") // no prompt
  const reminders = result.output.split("\n").filter((line) => line.includes("trust pending"))
  if (reminders.length !== 1) throw new Error(`expected exactly one trust-pending reminder line, got ${reminders.length}:\n${result.output}`)
  expect(reminders[0]).toContain("ocm trust mp")
})

phase("5. declining a changed-code re-prompt blocks and unlinks only the changed component, and the same change never re-prompts", async (home) => {
  grantedChanged(home, "notify.js", JS_PLUGIN_CHANGED)
  assertResolves(pluginLink(home), join(cloneDir(home), "plugins", "adw", "plugin", "notify.js"))
  expect(mcpKeys(home)["ocm--adw--db"]).toEqual(MCP.db)
  const declined = ptyOcm(home, "n\r", ["update", "mp"]) // the re-prompt is interactive: answer N under the pty
  expect(declined.status).toBe(0)
  assertAbsent(pluginLink(home)) // the changed component: blocked and unlinked
  expect(mcpKeys(home)["ocm--adw--db"]).toEqual(MCP.db) // the unchanged sibling keeps running
  expect(declined.output).toContain("blocked")
  expect(declined.output).toContain("notify")
  const again = ocm(home, ["update", "mp"]) // the decline is recorded: the same change never re-prompts
  expect(again.status).toBe(0)
  expect(again.output).not.toContain("changed since you trusted") // no risk block
  expect(again.output).not.toContain("trust this marketplace to run code?") // no prompt
}, 240_000)

test("6. a decline states the functional cost when a previously-running component is blocked, and stays silent when nothing was running", async () => {
  // a changed component that was running under the previous grant: the decline says so
  await withFakeHome(async (home) => {
    grantedChanged(home, "notify.js", JS_PLUGIN_CHANGED)
    const declined = ptyOcm(home, "n\r", ["update", "mp"])
    assertAbsent(pluginLink(home)) // the decline blocked it
    const cost = declined.output.split("\n").filter((l) => l.includes("running") && l.includes("blocked"))
    if (!cost.some((l) => l.includes("notify"))) throw new Error(`expected the decline to state that notify was running and is now blocked:\n${declined.stderr}`)
  })
  // a new component that never ran: the decline blocks it without the cost line
  await withFakeHome(async (home) => {
    grantedChanged(home, "ping.js", JS_PLUGIN_PING)
    const declined = ptyOcm(home, "n\r", ["update", "mp"])
    assertAbsent(pluginLink(home, "adw", "ping.js")) // the new component: blocked
    assertResolves(pluginLink(home), join(cloneDir(home), "plugins", "adw", "plugin", "notify.js")) // the old one keeps running
    const cost = declined.output.split("\n").filter((l) => l.includes("running") && l.includes("blocked"))
    expect(cost).toEqual([]) // nothing was running under the previous grant: nothing extra to say
  })
}, 240_000)

phase("7. ocm add --trust prints the component listing before the grant", async (home) => {
  const mp = localMp(home)
  const result = ocm(home, ["add", mp, "--trust"])
  expect(result.status).toBe(0)
  // the same listing the interactive prompt shows: type, plugin, path, command line
  expect(result.output).toContain("ships code that opencode will execute")
  expect(result.output).toContain("plugins/adw/plugin/notify.js")
  expect(result.output).toContain("npx -y @acme/db-mcp")
  expect(result.output.indexOf("ships code")).toBeLessThan(result.output.indexOf("added marketplace")) // the listing precedes the grant's effects
  expect(readRegistry(home).marketplaces.mp.trust.code).toBe("granted") // and the grant still happens
  assertResolves(pluginLink(home), join(mp, "plugins", "adw", "plugin", "notify.js"))
})

phase("8. the MCP blocked warning ends with the ocm trust hint", async (home) => {
  const mp = localMp(home)
  const result = ocm(home, ["add", mp]) // non-TTY: undecided, both executable components blocked
  expect(result.status).toBe(0)
  const line = result.output.split("\n").find((l) => l.includes("blocked (untrusted)") && l.includes(":mcp/"))
  if (!line) throw new Error(`expected an MCP blocked warning in the add output:\n${result.output}`)
  expect(line).toContain("ocm trust") // the next action rides the warning, as the JS-plugin one's already does
  expect(line.trimEnd().endsWith("to approve")).toBe(true)
})

phase("9. ownership and config safety across the trust flow: no writes outside ocm's keys and links", async (home) => {
  // the user's config and files predate every ocm run (invariants: config safety, ownership)
  const userConfig = { model: "claude-sonnet-4-6", permission: { edit: "allow" }, skills: { paths: ["/users/me/my-skills"] }, mcp: { "user-server": { type: "local", command: ["echo"] } } }
  writeTree(cfg(home), {
    "opencode.json": json(userConfig), "tui.json": json({ plugin: ["my-own-tui-plugin"] }),
    commands: { "mine.md": "# my own command\n" }, plugins: { "my-own.js": USER_PLUGIN },
  })
  const remote = addRemote(home, []) // undecided
  const configPath = join(cfg(home), "opencode.json")
  const userIntact = () => {
    const config = JSON.parse(readFileSync(configPath, "utf8"))
    for (const key of Object.keys(config.mcp ?? {})) if (key.startsWith("ocm--")) delete config.mcp[key]
    expect(config).toEqual(userConfig)
    expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
    expect(readFileSync(join(cfg(home), "plugins", "my-own.js"), "utf8")).toBe(USER_PLUGIN)
    expect(JSON.parse(readFileSync(join(cfg(home), "tui.json"), "utf8")).plugin).toContain("my-own-tui-plugin")
  }
  userIntact()
  expect(ocm(home, ["trust", "mp", "--yes"]).status).toBe(0) // the grant
  userIntact()
  expect(mcpKeys(home)["ocm--adw--db"]).toEqual(MCP.db)
  expect(ocm(home, ["update", "mp"]).status).toBe(0) // nothing new
  userIntact()
  writeFileSync(join(remote, "plugins", "adw", "plugin", "notify.js"), JS_PLUGIN_CHANGED)
  commitAll(remote, "change the executable component")
  expect(ocm(home, ["update", "mp", "--no-trust"]).status).toBe(0) // the decline
  userIntact()
  // invariant: idempotence — a second update writes nothing and re-creates no links
  const configBytes = readFileSync(configPath, "utf8")
  const ino = lstatSync(commandLink(home)).ino
  expect(ocm(home, ["update", "mp"]).status).toBe(0)
  expect(readFileSync(configPath, "utf8")).toBe(configBytes)
  expect(lstatSync(commandLink(home)).ino).toBe(ino)
  userIntact()
  // invariant: no plugin-load errors attributable to ocm-installed files
}, 420_000)

// brief 28 §4: two JS plugin files folding to one link name. The refusal
// must precede the trust record — the fingerprint never covers a module
// that cannot be linked.

// git hash-object -w --stdin: create a blob without touching the working
// tree, so the index can hold a path the checkout cannot represent
function gitBlob(dir, contents) {
  const result = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: dir, encoding: "utf8", input: contents })
  if (result.status !== 0) throw new Error(`git hash-object failed in ${dir}: ${result.stderr}`)
  return result.stdout.trim()
}

phase("10. two JS plugin files folding to one link are refused before any trust record is written", async (home) => {
  // invariants: config safety and ownership — the user's keys and file
  // predate the refused add and survive it
  writeTree(cfg(home), {
    "opencode.json": json({ model: "claude-sonnet-4-6", mcp: { "user-server": { type: "local", command: ["echo"] } } }),
    commands: { "mine.md": "# my own command\n" },
  })
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { p: { "plugin.json": PLUGIN_JSON, plugin: { "Run.js": JS_PLUGIN } } } })
  // the index gains the folded sibling beside the on-disk Run.js: the tree
  // ships both paths even where a checkout cannot hold both (F66)
  git(remote, ["update-index", "--add", "--cacheinfo", `100644,${gitBlob(remote, JS_PLUGIN)},plugins/p/plugin/run.js`])
  git(remote, ["-c", "user.email=ocm@test", "-c", "user.name=ocm", "commit", "-m", "folded sibling"])
  const tree = spawnSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: remote, encoding: "utf8" })
  if (tree.status !== 0) throw new Error(`git ls-tree failed in ${remote}: ${tree.stderr}`)
  const listed = tree.stdout.trim().split("\n")
  for (const path of ["plugins/p/plugin/Run.js", "plugins/p/plugin/run.js"]) {
    if (!listed.includes(path)) throw new Error(`fixture error: ${remote} HEAD does not ship ${path}: ${JSON.stringify(listed)}`)
  }
  const result = ocm(home, ["add", `file://${remote}`, "--name", "mp", "--trust"])
  if (result.status !== 1) throw new Error(`expected exit 1 from the folded plugin-file add, got ${result.status}:\n${result.output}`)
  for (const needle of ["differ only in case", "plugins/p/plugin/Run.js and plugins/p/plugin/run.js", "ocm--p--run.js"]) {
    expect(result.output).toContain(needle)
  }
  // refused before any write: no registry (so no trust record and no
  // fingerprint covering a module that cannot be linked), no mcp keys, no
  // plugin links, no clone left behind
  assertAbsent(registryFile(home))
  expect(Object.keys(mcpKeys(home)).filter((key) => key.startsWith("ocm--"))).toEqual([])
  expect(mcpKeys(home)["user-server"]).toEqual({ type: "local", command: ["echo"] })
  assertAbsent(pluginLink(home, "p", "Run.js"))
  assertAbsent(pluginLink(home, "p", "run.js"))
  assertAbsent(cloneDir(home))
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
}, 240_000)
}
