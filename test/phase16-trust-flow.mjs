// Phase 16 — docs/specs/16-trust-flow.md: one test per numbered item, plus the
// four invariants (config safety, ownership and idempotence in 9, no
// plugin-load errors in 9; test 1's doctor pass checks the interrupted state).
// The prompt paths run ocm under the pty fixture ocm-pty.py — spawned stdio is
// never a TTY, and the interrupt summary must be captured on stderr.
import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, assertFileExists, opencodeProbe, withFakeHome } from "./harness.mjs"

const OCM_BIN = fileURLToPath(new URL("../bin/ocm.ts", import.meta.url))
const PTY_SCRIPT = fileURLToPath(new URL("./ocm-pty.py", import.meta.url))

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

const cfg = (home) => join(home, ".config", "opencode")
const readRegistry = (home) => JSON.parse(readFileSync(join(cfg(home), "ocm", "registry.json"), "utf8"))
const cloneDir = (home, name = "mp") => join(home, ".cache", "ocm", "marketplaces", name)
const commandLink = (home, plugin = "adw", file = "commit.md") => join(cfg(home), "commands", `${plugin}:${file}`)
const pluginLink = (home, plugin = "adw", file = "notify.js") => join(cfg(home), "plugins", `ocm--${plugin}--${file}`)
const mcpKeys = (home) => { try { return JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8")).mcp ?? {} } catch { return {} } }
const json = (value) => `${JSON.stringify(value, null, 2)}\n`

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

const COMMAND = "---\ndescription: commit helper\n---\n\nCommit body.\n"
const JS_PLUGIN = 'export default { id: "phase16-notify", server: async () => ({}) }\n'
const JS_PLUGIN_CHANGED = `// v2\n${JS_PLUGIN}`
const JS_PLUGIN_PING = 'export default { id: "phase16-ping", server: async () => ({}) }\n'
const USER_PLUGIN = 'export default { id: "mine", server: async () => ({}) }\n'
const MCP = { db: { type: "local", command: ["npx", "-y", "@acme/db-mcp"], enabled: true } }

// one plugin carrying both kinds of executable component plus stuff
function trustedTree(plugin = "adw") {
  return { plugins: { [plugin]: {
    "plugin.json": json({ description: "demo plugin" }), // spec 19
    commands: { "commit.md": COMMAND }, plugin: { "notify.js": JS_PLUGIN },
    "mcp.json": `${JSON.stringify(MCP, null, 2)}\n`,
  } } }
}

const localMp = (home) => { const mp = join(home, "mp"); writeTree(mp, trustedTree()); return mp }

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
  const probe = opencodeProbe(cfg(home), home)
  if (!probe.available) console.log("skipped: opencode is not on PATH")
  else if (probe.unreliable) throw new Error("probe cannot trust itself: the canary broken plugin produced no error line")
  else expect(probe.pluginErrors).toEqual([])
}, 420_000)
