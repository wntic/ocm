// The TUI: core mutations, the /ocm dialog, back navigation and text
// layout.

import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, assertFileExists, withFakeHome } from "./harness.mjs"

// Helpers shared verbatim by the absorbed files below.

const OCM_BIN = fileURLToPath(new URL("../bin/ocm.ts", import.meta.url))

const CORE_MODULE = fileURLToPath(new URL("../loader/core.js", import.meta.url))

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
  git(dir, ["add", "-A"])
  git(dir, ["-c", "user.email=ocm@test", "-c", "user.name=ocm", "commit", "-m", "fixture"])
}

const cfg = (home) => join(home, ".config", "opencode")

const registryFile = (home) => join(cfg(home), "ocm", "registry.json")

const readRegistry = (home) => JSON.parse(readFileSync(registryFile(home), "utf8"))

const commandLink = (home, plugin, file) => join(cfg(home), "commands", `${plugin}:${file}`)

const skillMirror = (home, mp, plugin) => join(home, ".cache", "ocm", "links", mp, "skills", `${plugin}--python-style`)

const mcpKeys = (home) => {
  try {
    return JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8")).mcp ?? {}
  } catch {
    return {}
  }
}

function core(home, calls) {
  const runner = join(home, "core-runner.mjs")
  writeFileSync(runner, CORE_RUNNER)
  const result = spawnSync(process.execPath, [runner, CORE_MODULE, JSON.stringify(calls)], {
    env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 120_000,
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

// The mutation core, run the way ocm-loader.js runs it: a child process on
// the fake $HOME executing a list of {fn, args} calls. The runner prints
// the results as one JSON document — stdout that is not exactly that
// document means a core function printed (spec 10a: the core never prints).
const CORE_RUNNER = `
const [modulePath, payload] = process.argv.slice(2)
const mod = await import(modulePath)
const results = []
for (const call of JSON.parse(payload)) {
  if (typeof mod[call.fn] !== "function") {
    throw new Error('loader/core.js does not export a function "' + call.fn + '" (spec 10a)')
  }
  results.push(await mod[call.fn](...call.args))
}
process.stdout.write(JSON.stringify(results))
`

function coreOk(home, calls) {
  const names = calls.map((call) => call.fn).join(", ")
  const result = core(home, calls)
  if (result.status !== 0) throw new Error(`core ${names} exited ${result.status}: ${result.stderr}`)
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(`core functions must not print; stdout after ${names}:\n${result.stdout}`)
  }
}

function coreFails(home, calls, ...needles) {
  const result = core(home, calls)
  if (result.status === 0) throw new Error(`expected a non-zero exit from core ${calls.map((call) => call.fn).join(", ")}`)
  for (const needle of needles) expect(`${result.stdout}\n${result.stderr}`).toContain(needle)
}

const COMMAND = "---\ndescription: commit helper\n---\n\nCommit body.\n"

const SKILL = "---\nname: python-style\ndescription: Python style guidance\n---\n\n# Python style\n\nUse ruff.\n"

const JS_PLUGIN = 'export default { id: "phase10a-notify", server: async () => ({}) }\n'

const MCP = { db: { type: "local", command: ["npx", "-y", "@acme/db-mcp"], enabled: true } }

const mcpJson = (servers) => `${JSON.stringify(servers, null, 2)}\n`

function expectOk(result) {
  if (result.status !== 0) throw new Error(`installLoader exited ${result.status}: ${result.stderr}`)
  return result
}

function cli(home, ...args) {
  const result = spawnSync(process.execPath, [OCM_BIN, ...args], {
    env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 120_000,
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

// The fake TUI api. Steps are consumed strictly in order; a dialog the next
// step cannot answer stays open, exactly like a user staring at a menu they
// did not want — the drive then reports the step as never offered. An
// `optional: true` step that never matched is dropped (e.g. a Pin prompt an
// implementation might replace with a different input). Alerts are
// informational and auto-confirmed.
const UI_RUNNER = `
import { setTimeout as sleep } from "node:timers/promises"

const [uiUrl, payload] = process.argv.slice(2)
const steps = JSON.parse(payload)
const recording = { toasts: [], dialogs: [], keymap: null, consumed: 0, unmatched: [], error: null }
let events = 0

function answer(kind, props) {
  events++
  recording.dialogs.push({
    kind,
    title: String(props?.title ?? ""),
    message: String(props?.message ?? ""),
    options: Array.isArray(props?.options)
      ? props.options.map((o) => ({ title: String(o?.title ?? ""), value: o?.value }))
      : [],
  })
  const step = steps[recording.consumed]
  if (step) {
    if (kind === "select" && step.select !== undefined) {
      const option = (props?.options ?? []).find(
        (o) => o && (o.value === step.select || String(o.title ?? "").includes(step.select)),
      )
      if (option) {
        recording.consumed++
        if (typeof option.onSelect === "function") option.onSelect()
        else if (typeof props?.onSelect === "function") props.onSelect(option)
      }
    } else if (kind === "confirm" && step.confirm !== undefined) {
      recording.consumed++
      if (step.confirm) props?.onConfirm?.()
      else props?.onCancel?.()
    } else if (kind === "prompt" && step.prompt !== undefined) {
      recording.consumed++
      props?.onConfirm?.(step.prompt)
    }
  }
  if (kind === "alert" && typeof props?.onConfirm === "function") props.onConfirm()
}

const api = {
  keymap: {
    registerLayer: (layer) => {
      recording.keymap = layer
      return () => {}
    },
  },
  lifecycle: { onDispose: () => () => {} },
  ui: {
    DialogSelect: (props) => answer("select", props),
    DialogConfirm: (props) => answer("confirm", props),
    DialogPrompt: (props) => answer("prompt", props),
    DialogAlert: (props) => answer("alert", props),
    toast: (input) => {
      events++
      recording.toasts.push({ variant: String(input?.variant ?? ""), message: String(input?.message ?? input ?? "") })
    },
    dialog: { replace: (render) => render?.(), clear: () => {}, setSize: () => {}, size: "medium", depth: 0, open: true },
  },
}

try {
  const mod = await import(uiUrl)
  if (!mod.default || typeof mod.default.tui !== "function") {
    recording.error = "the installed ui.js does not default-export a tui function"
  } else {
    await mod.default.tui(api)
    const commands = Array.isArray(recording.keymap?.commands) ? recording.keymap.commands : []
    const cmd =
      commands.find((c) => c?.slash?.name === "ocm") ??
      commands.find((c) => String(c?.name ?? "").includes("ocm"))
    if (!cmd || typeof cmd.run !== "function") {
      recording.error = "keymap.registerLayer registered no runnable /ocm command"
    } else {
      await cmd.run()
      const deadline = Date.now() + 5000
      while (recording.consumed < steps.length && Date.now() < deadline) await sleep(25)
      // settle detection: the flows are callback-driven and loop back to
      // menus, so "done" is no new dialogs or toasts for a while
      let last = events
      let quiet = 0
      const end = Date.now() + 5000
      while (Date.now() < end && quiet < 750) {
        await sleep(50)
        if (events === last) quiet += 50
        else { last = events; quiet = 0 }
      }
    }
  }
} catch (err) {
  recording.error = err instanceof Error ? err.stack : String(err)
}
recording.unmatched = steps.slice(recording.consumed).filter((step) => !step.optional)
process.stdout.write(JSON.stringify(recording))
`
function uiDrive(home, steps) {
  const runner = join(home, "ui-runner.mjs")
  writeFileSync(runner, UI_RUNNER)
  const uiUrl = pathToFileURL(join(cfg(home), "ocm", "ui.js")).href
  const result = spawnSync(process.execPath, [runner, uiUrl, JSON.stringify(steps)], {
    env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 60_000,
  })
  if (result.status !== 0) throw new Error(`ui drive exited ${result.status}: ${result.stderr}`)
  let recording
  try {
    recording = JSON.parse(result.stdout)
  } catch {
    throw new Error(`the dialog must not print; stdout was:\n${result.stdout}`)
  }
  if (recording.error) throw new Error(`the dialog flow threw:\n${recording.error}`)
  if (recording.unmatched.length) {
    throw new Error(
      `no dialog ever offered a match for ${JSON.stringify(recording.unmatched)}; recorded dialogs: ${JSON.stringify(recording.dialogs)}`,
    )
  }
  return recording
}

const NOTICE = /restart opencode to activate/i

const allMessages = (rec) => [
  ...rec.toasts.map((t) => t.message),
  ...rec.dialogs.map((d) => `${d.title}\n${d.message}`),
]

const hasNotice = (rec) => allMessages(rec).some((m) => NOTICE.test(m))

const confirmText = (rec) => rec.dialogs.filter((d) => d.kind === "confirm").map((d) => d.message).join("\n")

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url))

// loader/*.js computes its path constants at module load; the query string
// forces a fresh instance per call so no state leaks between tests
let counter = 0

const loadModule = (name) =>
  import(`${pathToFileURL(join(REPO_ROOT, "loader", name)).href}?t=${Date.now()}-${counter++}`)

function required(mod, name, file, why) {
  if (typeof mod[name] !== "function") {
    throw new Error(`${file} does not export ${name}() — ${why}`)
  }
  return mod[name]
}

const lineWith = (lines, needle) => {
  const line = lines.find((l) => l.includes(needle))
  if (line === undefined) throw new Error(`expected a line containing "${needle}" in:\n${lines.join("\n")}`)
  return line
}

// a registry entry shaped like the real thing (loader/registry.js entry keys)
const demoEntry = (fields = {}) => ({
  url: "https://example.com/demo-marketplace.git",
  dir: "/demo-clone",
  local: false,
  addedAt: "2026-09-01T00:00:00.000Z",
  mode: "auto",
  ref: null,
  subdir: null,
  revision: "abc123def456789",
  syncIntervalMs: null,
  trust: { code: "granted" },
  lastSync: null,
  plugins: {
    adw: {
      source: "plugins/adw",
      components: { command: ["commit.md"] },
      enabled: true,
      installedAt: null,
      version: "2.3.1",
      manifest: { description: "demo plugin", version: "2.3.1" },
    },
  },
  ...fields,
})

const demoRegistry = (fields) => ({ version: 2, marketplaces: { "demo-marketplace": demoEntry(fields) } })

const PLUGIN_JSON = `${JSON.stringify({ description: "demo plugin" }, null, 2)}\n`

// A recorded fake api (the phase10b pattern): prompts and confirms answer a
// scripted queue, alerts auto-confirm, and the recording comes back as one
// JSON document on stdout — stdout that is not exactly that document means
// the flow printed.
const FLOW_RUNNER = `
import { setTimeout as sleep } from "node:timers/promises"

const [uiUrl, payload] = process.argv.slice(2)
const steps = JSON.parse(payload)
const recording = { dialogs: [], toasts: [], error: null, consumed: 0 }
let events = 0

function answer(kind, props) {
  events++
  recording.dialogs.push({ kind, title: String(props?.title ?? ""), message: String(props?.message ?? "") })
  const step = steps[recording.consumed]
  if (step) {
    if (kind === "prompt" && step.prompt !== undefined) {
      recording.consumed++
      props?.onConfirm?.(step.prompt)
    } else if (kind === "confirm" && step.confirm !== undefined) {
      recording.consumed++
      step.confirm ? props?.onConfirm?.() : props?.onCancel?.()
    }
  }
  if (kind === "alert" && typeof props?.onConfirm === "function") props.onConfirm()
}

const api = {
  ui: {
    DialogSelect: (props) => answer("select", props),
    DialogConfirm: (props) => answer("confirm", props),
    DialogPrompt: (props) => answer("prompt", props),
    DialogAlert: (props) => answer("alert", props),
    toast: (input) => { events++; recording.toasts.push(String(input?.message ?? input ?? "")) },
    dialog: { replace: (render) => render?.(), clear: () => {}, setSize: () => {}, size: "medium", depth: 0, open: true },
  },
}

try {
  const mod = await import(uiUrl)
  if (typeof mod.emptyStateFlow !== "function") {
    recording.error = "loader/ui.js does not export emptyStateFlow(api, back) — spec 22 §1: the empty state must chain into the add flow"
  } else {
    await mod.emptyStateFlow(api, () => {})
    const deadline = Date.now() + 5000
    while (recording.consumed < steps.length && Date.now() < deadline) await sleep(25)
    // settle detection: the flows are callback-driven, so "done" is no new
    // dialogs or toasts for a while
    let last = events
    let quiet = 0
    const end = Date.now() + 5000
    while (Date.now() < end && quiet < 750) {
      await sleep(50)
      if (events === last) quiet += 50
      else { last = events; quiet = 0 }
    }
  }
} catch (err) {
  recording.error = err instanceof Error ? err.stack : String(err)
}
process.stdout.write(JSON.stringify(recording))
`
function flowDrive(home, steps) {
  const runner = join(home, "flow-runner.mjs")
  writeFileSync(runner, FLOW_RUNNER)
  const uiUrl = pathToFileURL(join(REPO_ROOT, "loader", "ui.js")).href
  const result = spawnSync(process.execPath, [runner, uiUrl, JSON.stringify(steps)], {
    env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 60_000,
  })
  if (result.status !== 0) throw new Error(`flow drive exited ${result.status}: ${result.stderr}`)
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(`the flow must not print; stdout was:\n${result.stdout}`)
  }
}

// core mutations: loader/core.js driven headless in a spawned child — absorbed from test/phase10a-core-mutations.mjs
{
// realpath on both sides: macOS temp dirs sit behind /var -> /private/var
function assertResolves(dest, source) {
  if (!existsSync(dest) || !lstatSync(dest).isSymbolicLink()) throw new Error(`expected a symlink at ${dest}`)
  expect(realpathSync(dest)).toBe(realpathSync(source))
}

// spec 19: every installable plugin carries a plugin.json with a description
const PLUGIN_JSON = `${JSON.stringify({ description: "demo plugin" }, null, 2)}\n`

phase("1. install/uninstall through the core flip enabled/installedAt and materialize/remove exactly that plugin's links", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: {
    adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND }, skills: { "python-style": { "SKILL.md": SKILL } } },
    beta: { "plugin.json": PLUGIN_JSON, commands: { "lint.md": COMMAND } },
  } })
  expect(ocm(home, "add", mp).status).toBe(0)
  const betaLink = commandLink(home, "beta", "lint.md")
  const betaIno = lstatSync(betaLink).ino

  coreOk(home, [{ fn: "setEnabled", args: ["adw", false] }])
  let adw = readRegistry(home).marketplaces.mp.plugins.adw
  expect(adw.enabled).toBe(false)
  expect(adw.installedAt).toBeNull()
  assertAbsent(commandLink(home, "adw", "commit.md"))
  assertAbsent(skillMirror(home, "mp", "adw"))
  expect(lstatSync(betaLink).ino).toBe(betaIno) // the sibling's link is not re-created

  coreOk(home, [{ fn: "setEnabled", args: ["adw", true] }])
  adw = readRegistry(home).marketplaces.mp.plugins.adw
  expect(adw.enabled).toBe(true)
  expect(typeof adw.installedAt).toBe("string")
  assertResolves(commandLink(home, "adw", "commit.md"), join(mp, "plugins", "adw", "commands", "commit.md"))
  expect(lstatSync(skillMirror(home, "mp", "adw")).isDirectory()).toBe(true)
  expect(lstatSync(betaLink).ino).toBe(betaIno)

  // invariant: idempotence — installing an installed plugin writes nothing
  const bytes = readFileSync(registryFile(home), "utf8")
  coreOk(home, [{ fn: "setEnabled", args: ["adw", true] }])
  expect(readFileSync(registryFile(home), "utf8")).toBe(bytes)
  expect(lstatSync(betaLink).ino).toBe(betaIno)
})

phase("2. marketplace add through the core registers and materializes, and refuses a plugin-name collision without writing anything", async (home) => {
  const mpA = join(home, "mp-a")
  writeTree(mpA, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
  coreOk(home, [{ fn: "addMarketplace", args: [mpA] }])
  const entry = readRegistry(home).marketplaces["mp-a"]
  if (!entry) throw new Error(`expected a "mp-a" record in ${registryFile(home)}`)
  expect(entry.plugins.adw.enabled).toBe(true)
  assertResolves(commandLink(home, "adw", "commit.md"), join(mpA, "plugins", "adw", "commands", "commit.md"))

  const bytes = readFileSync(registryFile(home), "utf8")
  const mpB = join(home, "mp-b")
  writeTree(mpB, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "deploy.md": COMMAND } } } })
  coreFails(home, [{ fn: "addMarketplace", args: [mpB] }], "mp-a", '"adw"')
  expect(readRegistry(home).marketplaces["mp-b"]).toBeUndefined()
  expect(readFileSync(registryFile(home), "utf8")).toBe(bytes) // the refusal wrote nothing
  assertAbsent(commandLink(home, "adw", "deploy.md"))
  assertAbsent(join(home, ".cache", "ocm", "links", "mp-b"))
})

phase("3. remove through the core leaves zero ocm-- traces, no links, no skills.paths entry, no registry record — and keeps a local marketplace's directory", async (home) => {
  // invariants: config safety and ownership — the user's keys and files
  // predate every ocm run and must survive the removal
  const userConfig = {
    model: "claude-sonnet-4-6",
    permission: { edit: "allow" },
    skills: { paths: ["/users/me/my-skills"] },
    mcp: {
      "ocm--adw--context7": { type: "local", command: ["npx", "-y", "@upstash/context7"] },
      "user-server": { type: "local", command: ["echo"] },
    },
  }
  writeTree(cfg(home), {
    "opencode.json": `${JSON.stringify(userConfig, null, 2)}\n`,
    commands: { "mine.md": "# my own command\n" },
  })
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND }, skills: { "python-style": { "SKILL.md": SKILL } } } } })
  expect(ocm(home, "add", mp).status).toBe(0)
  const skillsEntry = join(home, ".cache", "ocm", "links", "mp", "skills")
  expect(JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8")).skills.paths).toContain(skillsEntry)

  coreOk(home, [{ fn: "removeMarketplace", args: ["mp"] }])
  const after = JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8"))
  expect(JSON.stringify(after)).not.toContain("ocm--") // zero ocm-- traces
  expect(after.mcp).toEqual({ "user-server": { type: "local", command: ["echo"] } })
  expect(after.skills.paths).toEqual(["/users/me/my-skills"]) // no entry for mp
  expect(after.model).toBe("claude-sonnet-4-6")
  assertAbsent(commandLink(home, "adw", "commit.md"))
  assertAbsent(join(home, ".cache", "ocm", "links", "mp"))
  expect(readRegistry(home).marketplaces.mp).toBeUndefined()
  assertFileExists(join(mp, "plugins", "adw", "commands", "commit.md")) // a local dir is the user's
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
})

phase("4. trust grant/deny/revoke and pin through the core update the registry and re-materialize accordingly", async (home) => {
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { tool: {
    "plugin.json": PLUGIN_JSON,
    commands: { "work.md": COMMAND },
    plugin: { "notify.js": JS_PLUGIN },
    "mcp.json": mcpJson(MCP),
  } } })
  git(remote, ["checkout", "-b", "feature"])
  writeFileSync(join(remote, "plugins", "tool", "commands", "feature.md"), COMMAND)
  git(remote, ["add", "-A"])
  git(remote, ["-c", "user.email=ocm@test", "-c", "user.name=ocm", "commit", "-m", "feature work"])
  git(remote, ["checkout", "main"])
  // spawned stdio is not a TTY: add leaves trust undecided and the
  // executable components blocked
  expect(ocm(home, "add", `file://${remote}`, "--name", "mp").status).toBe(0)
  const clone = join(home, ".cache", "ocm", "marketplaces", "mp")
  const notifyLink = join(cfg(home), "plugins", "ocm--tool--notify.js")
  const workLink = () => assertResolves(commandLink(home, "tool", "work.md"), join(clone, "plugins", "tool", "commands", "work.md"))

  coreOk(home, [{ fn: "denyTrust", args: ["mp"] }])
  expect(readRegistry(home).marketplaces.mp.trust.code).toBe("denied")
  assertAbsent(notifyLink)
  expect(mcpKeys(home)["ocm--tool--db"]).toBeUndefined()
  workLink() // stuff is untouched by a trust decision

  coreOk(home, [{ fn: "grantTrust", args: ["mp"] }])
  const trust = readRegistry(home).marketplaces.mp.trust
  expect(trust.code).toBe("granted")
  expect(typeof trust.grantedAt).toBe("string")
  expect(typeof trust.fingerprint).toBe("string")
  assertResolves(notifyLink, join(clone, "plugins", "tool", "plugin", "notify.js"))
  expect(mcpKeys(home)["ocm--tool--db"]).toEqual(MCP.db)
  // invariant: no plugin-load errors attributable to ocm-installed files

  coreOk(home, [{ fn: "revokeTrust", args: ["mp"] }])
  expect(readRegistry(home).marketplaces.mp.trust.code).toBe("denied")
  assertAbsent(notifyLink)
  expect(mcpKeys(home)["ocm--tool--db"]).toBeUndefined()
  workLink()

  // pin: a typoed ref fails without saving; a real ref is recorded and the
  // next sync re-materializes to it; null clears the pin
  coreFails(home, [{ fn: "pinMarketplace", args: ["mp", "nosuch-ref"] }], "nosuch-ref")
  expect(readRegistry(home).marketplaces.mp.ref).toBeNull()
  coreOk(home, [{ fn: "pinMarketplace", args: ["mp", "feature"] }])
  expect(readRegistry(home).marketplaces.mp.ref).toBe("feature")
  coreOk(home, [{ fn: "syncAll", args: [{ force: true }] }])
  assertResolves(commandLink(home, "tool", "feature.md"), join(clone, "plugins", "tool", "commands", "feature.md"))
  coreOk(home, [{ fn: "pinMarketplace", args: ["mp", null] }])
  expect(readRegistry(home).marketplaces.mp.ref).toBeNull()
}, 420_000)

phase("5. search through the core returns the spec 09 ranking", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, {
    "marketplace.json": `${JSON.stringify({ plugins: [
      { name: "quality-gate", source: "./plugins/quality-gate", tags: ["review"] },
      { name: "polish", source: "./plugins/polish", description: "polish and review your diffs" },
    ] }, null, 2)}\n`,
    plugins: {
      review: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } }, // name exact
      reviewer: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } }, // name prefix
      "code-review": { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } }, // name substring
      "quality-gate": { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } }, // tag exact
      polish: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } }, // description substring
      adw: { "plugin.json": PLUGIN_JSON, commands: { "pr-review.md": COMMAND } }, // component name substring
    },
  })
  expect(ocm(home, "add", mp).status).toBe(0)
  const [results] = coreOk(home, [{ fn: "searchPlugins", args: ["review"] }])
  if (!Array.isArray(results) || results.some((r) => typeof r?.plugin !== "string" || typeof r?.marketplace !== "string")) {
    throw new Error(`expected searchPlugins to return [{ plugin, marketplace, ... }] entries, got: ${JSON.stringify(results)}`)
  }
  expect(results.map((r) => r.plugin)).toEqual(["review", "reviewer", "code-review", "quality-gate", "polish", "adw"])
})

phase("6. the registry save is atomic and idempotent: an unchanged save is byte-identical and user-added keys survive", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
  expect(ocm(home, "add", mp).status).toBe(0)

  const bytes = readFileSync(registryFile(home), "utf8")
  coreOk(home, [{ fn: "saveRegistry", args: [JSON.parse(bytes)] }])
  expect(readFileSync(registryFile(home), "utf8")).toBe(bytes) // a no-op save is byte-identical

  const withUserKeys = JSON.parse(bytes)
  withUserKeys.userNote = "keep me"
  withUserKeys.marketplaces.mp.userField = "mine"
  coreOk(home, [{ fn: "saveRegistry", args: [withUserKeys] }])
  const saved = JSON.parse(readFileSync(registryFile(home), "utf8"))
  expect(saved.userNote).toBe("keep me")
  expect(saved.marketplaces.mp.userField).toBe("mine")

  const bytes2 = readFileSync(registryFile(home), "utf8")
  coreOk(home, [{ fn: "saveRegistry", args: [JSON.parse(bytes2)] }])
  expect(readFileSync(registryFile(home), "utf8")).toBe(bytes2)

  // atomic: the temp file never survives a save
  expect(readdirSync(join(cfg(home), "ocm")).filter((name) => name.includes("tmp"))).toEqual([])
})
}

// the /ocm dialog: the installed ui.js driven by a recorded fake api — absorbed from test/phase10b-tui-dialog.mjs
{
// realpath on both sides: macOS temp dirs sit behind /var -> /private/var
function assertResolves(dest, source) {
  if (!existsSync(dest) || !lstatSync(dest).isSymbolicLink()) throw new Error(`expected a symlink at ${dest}`)
  expect(realpathSync(dest)).toBe(realpathSync(source))
}

// spec 19: every installable plugin carries a plugin.json with a description
const PLUGIN_JSON = `${JSON.stringify({ description: "demo plugin" }, null, 2)}\n`

const JS_PLUGIN = 'export default { id: "phase10b-notify", server: async () => ({}) }\n'

phase("1. the installed ui.js default-exports { id, tui } with an async tui and no server export", async (home, ocm) => {
  expectOk(await ocm.installLoader())
  const ui = (await import(pathToFileURL(join(cfg(home), "ocm", "ui.js")).href)).default
  expect(typeof ui.id).toBe("string")
  expect(ui.server).toBeUndefined()
  const fakeApi = { keymap: { registerLayer: () => () => {} }, lifecycle: { onDispose: () => {} } }
  const result = ui.tui(fakeApi)
  if (!(result instanceof Promise)) throw new Error("expected tui() to return a promise (spec 10b: tui is async)")
  await result
})

phase("2. the installed ui.js imports ./core.js successfully from its installed location", async (home, ocm) => {
  expectOk(await ocm.installLoader())
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
  expect(cli(home, "add", mp).status).toBe(0)
  // a child on the fake $HOME imports the installed ui.js and opens /ocm;
  // the main menu only renders if ui.js's ./core.js import resolved there
  const rec = uiDrive(home, [])
  const menu = rec.dialogs.find((d) => d.kind === "select")
  if (!menu) throw new Error(`expected the /ocm main menu to open; recorded: ${JSON.stringify(rec.dialogs)}`)
  expect(menu.options.some((o) => o.title.includes("Browse"))).toBe(true)
})

phase("3. tui.json: the ./ocm/ui.js entry is added once beside user keys and removed cleanly on uninstall", async (home, ocm) => {
  const root = cfg(home)
  mkdirSync(root, { recursive: true })
  const tuiPath = join(root, "tui.json")
  const theme = { primary: "#00ff00" }
  const keybinds = { leader: "space" }
  const original = `${JSON.stringify({ theme, keybinds, plugin: ["./user-tui.js"] }, null, 2)}\n`
  writeFileSync(tuiPath, original)

  expectOk(await ocm.installLoader())
  const added = JSON.parse(readFileSync(tuiPath, "utf8"))
  const entries = added.plugin.filter((entry) => entry === "./ocm/ui.js")
  if (entries.length !== 1) {
    throw new Error(`expected exactly one "./ocm/ui.js" entry in ${tuiPath}, found ${entries.length}`)
  }
  expect(added.plugin).toContain("./user-tui.js")
  expect(added.theme).toEqual(theme)
  expect(added.keybinds).toEqual(keybinds)

  // invariant: idempotence — a second install adds nothing
  const bytes = readFileSync(tuiPath, "utf8")
  expectOk(await ocm.installLoader())
  expect(readFileSync(tuiPath, "utf8")).toBe(bytes)

  expect(cli(home, "loader", "uninstall").status).toBe(0)
  expect(readFileSync(tuiPath, "utf8")).toBe(original) // the entry removed, the rest byte-identical
  // invariant: idempotence — a second uninstall changes nothing
  expect(cli(home, "loader", "uninstall").status).toBe(0)
  expect(readFileSync(tuiPath, "utf8")).toBe(original)
})

phase("4. a recorded fake api drives main menu → browse → per-plugin menu → confirm → install, and the core mutation runs", async (home, ocm) => {
  expectOk(await ocm.installLoader())
  // empty registry: /ocm explains ocm add rather than showing an empty menu
  const empty = uiDrive(home, [])
  const emptyAlert = empty.dialogs.find((d) => d.kind === "alert")
  if (!emptyAlert || !/add/i.test(emptyAlert.message)) {
    throw new Error(`expected an alert explaining ocm add on the empty registry; recorded: ${JSON.stringify(empty.dialogs)}`)
  }

  const mp = join(home, "mp")
  writeTree(mp, { plugins: {
    adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND }, skills: { "python-style": { "SKILL.md": SKILL } } },
    beta: { "plugin.json": PLUGIN_JSON, commands: { "lint.md": COMMAND } },
  } })
  // invariant: ownership — a hand-written command survives every ocm operation
  mkdirSync(join(cfg(home), "commands"), { recursive: true })
  writeFileSync(join(cfg(home), "commands", "mine.md"), "# my own command\n")
  expect(cli(home, "add", mp).status).toBe(0)
  expect(cli(home, "uninstall", "adw").status).toBe(0)

  const rec = uiDrive(home, [
    { select: "Browse" },
    { select: "adw@mp" },
    { select: "Install" },
    { confirm: true },
  ])

  // the browse list marks state, and refreshes it in place after the mutation
  const browse = rec.dialogs.filter((d) => d.options.some((o) => o.title.includes("adw@mp")))
  if (browse.length < 2) {
    throw new Error(`expected the browse list before and after the install; recorded: ${JSON.stringify(rec.dialogs)}`)
  }
  const first = browse[0].options.find((o) => o.title.includes("adw@mp")).title
  const last = browse[browse.length - 1].options.find((o) => o.title.includes("adw@mp")).title
  expect(first).toContain("(disabled)")
  expect(last).not.toContain("(disabled)")

  // the mutation is confirmed first, then runs through the core
  expect(rec.dialogs.some((d) => d.kind === "confirm")).toBe(true)
  const adw = readRegistry(home).marketplaces.mp.plugins.adw
  expect(adw.enabled).toBe(true)
  expect(typeof adw.installedAt).toBe("string")
  assertResolves(commandLink(home, "adw", "commit.md"), join(mp, "plugins", "adw", "commands", "commit.md"))
  expect(lstatSync(join(home, ".cache", "ocm", "links", "mp", "skills", "adw--python-style")).isDirectory()).toBe(true)
  assertResolves(commandLink(home, "beta", "lint.md"), join(mp, "plugins", "beta", "commands", "lint.md"))
  expect(rec.toasts.some((t) => t.message.includes("adw"))).toBe(true)
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")

  // Search: a prompt, then the ranked list reusing the browse shape
  const search = uiDrive(home, [
    { select: "Search" },
    { prompt: "adw" },
    { select: "adw@mp" },
  ])
  const promptAt = search.dialogs.findIndex((d) => d.kind === "prompt")
  const resultsAt = search.dialogs.findIndex(
    (d) => d.kind === "select" && d.options.some((o) => o.title.includes("adw@mp")),
  )
  if (promptAt === -1 || resultsAt === -1 || resultsAt < promptAt) {
    throw new Error(`expected a prompt then a ranked result list containing adw@mp; recorded: ${JSON.stringify(search.dialogs)}`)
  }
}, 180_000)

phase("5. failure paths: unreachable marketplace on update, plugin-name collision on add, blocked components on install", async (home) => {
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { tool: {
    "plugin.json": PLUGIN_JSON,
    commands: { "work.md": COMMAND },
    plugin: { "notify.js": JS_PLUGIN },
    "mcp.json": mcpJson(MCP),
  } } })
  expect(cli(home, "add", `file://${remote}`, "--name", "gitmp").status).toBe(0)
  expect(cli(home, "uninstall", "tool").status).toBe(0) // the per-plugin menu must offer Install
  const clone = join(home, ".cache", "ocm", "marketplaces", "gitmp")
  const notifyLink = join(cfg(home), "plugins", "ocm--tool--notify.js")

  const mpA = join(home, "mp-a")
  writeTree(mpA, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
  expect(cli(home, "add", mpA).status).toBe(0)
  const mpB = join(home, "mp-b")
  writeTree(mpB, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "deploy.md": COMMAND } } } })

  // unreachable marketplace on update: the remote is gone, the clone remains
  rmSync(remote, { recursive: true, force: true })
  const failed = uiDrive(home, [
    { select: "Marketplaces" },
    { select: "gitmp" },
    { select: "Update" },
  ])
  const surfaced = allMessages(failed).filter(
    (m) => m.includes("gitmp") && /fail|error|fatal|not found|unreachable|unable/i.test(m),
  )
  if (!surfaced.length) {
    throw new Error(`expected the failed update of gitmp to be surfaced, not swallowed; recorded: ${JSON.stringify(failed)}`)
  }

  // plugin-name collision on add: refused, nothing written
  const bytes = readFileSync(registryFile(home), "utf8")
  const collision = uiDrive(home, [
    { select: "Marketplaces" },
    { select: "Add" },
    { prompt: mpB },
  ])
  const named = allMessages(collision).filter((m) => m.includes("adw") && m.includes("mp-a"))
  if (!named.length) {
    throw new Error(`expected the collision naming "adw" and its incumbent "mp-a"; recorded: ${JSON.stringify(collision)}`)
  }
  expect(readRegistry(home).marketplaces["mp-b"]).toBeUndefined()
  expect(readFileSync(registryFile(home), "utf8")).toBe(bytes) // the refusal wrote nothing
  assertAbsent(join(home, ".cache", "ocm", "links", "mp-b"))

  // blocked components on install, then the Trust route out of the block
  const blocked = uiDrive(home, [
    { select: "Browse" },
    { select: "tool@gitmp" },
    { select: "Install" },
    { confirm: true },
    { select: "tool@gitmp" },
    { select: "Trust" },
    { confirm: true },
  ])
  if (!allMessages(blocked).some((m) => /blocked|untrusted/i.test(m))) {
    throw new Error(`expected the install to surface the blocked executable components; recorded: ${JSON.stringify(blocked)}`)
  }
  expect(blocked.dialogs.some((d) => d.options.some((o) => /trust/i.test(o.title)))).toBe(true)
  expect(confirmText(blocked)).toContain("notify") // the trust prompt carries the component list
  expect(readRegistry(home).marketplaces.gitmp.trust.code).toBe("granted")
  assertResolves(notifyLink, join(clone, "plugins", "tool", "plugin", "notify.js"))
  expect(mcpKeys(home)["ocm--tool--db"]).toEqual(MCP.db)

  // invariant: no plugin-load errors attributable to ocm-installed files
}, 420_000)

phase("6. every mutation path ends by emitting the restart notice; an unchanged update does not", async (home) => {
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { tool: {
    "plugin.json": PLUGIN_JSON,
    commands: { "work.md": COMMAND },
    plugin: { "notify.js": JS_PLUGIN },
  } } })
  git(remote, ["checkout", "-b", "feature"])
  writeFileSync(join(remote, "plugins", "tool", "commands", "feature.md"), COMMAND)
  git(remote, ["add", "-A"])
  git(remote, ["-c", "user.email=ocm@test", "-c", "user.name=ocm", "commit", "-m", "feature work"])
  git(remote, ["checkout", "main"])
  // spawned stdio is not a TTY: add leaves trust undecided
  expect(cli(home, "add", `file://${remote}`, "--name", "gitmp").status).toBe(0)

  const mp = join(home, "mp")
  writeTree(mp, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
  expect(cli(home, "add", mp).status).toBe(0)
  expect(cli(home, "uninstall", "adw").status).toBe(0)

  const mpx = join(home, "mpx")
  writeTree(mpx, { plugins: { fresh: { "plugin.json": PLUGIN_JSON, commands: { "hop.md": COMMAND }, plugin: { "notify.js": JS_PLUGIN } } } })

  const install = uiDrive(home, [{ select: "Browse" }, { select: "adw@mp" }, { select: "Install" }, { confirm: true }])
  expect(hasNotice(install)).toBe(true)
  expect(readRegistry(home).marketplaces.mp.plugins.adw.enabled).toBe(true)

  const uninstall = uiDrive(home, [{ select: "Browse" }, { select: "adw@mp" }, { select: "Uninstall" }, { confirm: true }])
  expect(hasNotice(uninstall)).toBe(true)
  expect(readRegistry(home).marketplaces.mp.plugins.adw.enabled).toBe(false)

  const add = uiDrive(home, [{ select: "Marketplaces" }, { select: "Add" }, { prompt: mpx }, { confirm: true }])
  expect(hasNotice(add)).toBe(true)
  const added = readRegistry(home).marketplaces.mpx
  if (!added) throw new Error(`expected an "mpx" record in ${registryFile(home)} after the Add flow`)
  expect(added.trust.code).toBe("granted")
  expect(confirmText(add)).toContain("notify") // the add-time trust prompt names what runs
  assertResolves(join(cfg(home), "plugins", "ocm--fresh--notify.js"), join(mpx, "plugins", "fresh", "plugin", "notify.js"))

  const remove = uiDrive(home, [{ select: "Marketplaces" }, { select: "mpx" }, { select: "Remove" }, { confirm: true }])
  expect(hasNotice(remove)).toBe(true)
  expect(confirmText(remove)).toContain("fresh") // the confirmation shows what will be removed
  expect(readRegistry(home).marketplaces.mpx).toBeUndefined()
  assertAbsent(join(home, ".cache", "ocm", "links", "mpx"))

  const trust = uiDrive(home, [{ select: "Marketplaces" }, { select: "gitmp" }, { select: "Trust" }, { confirm: true }])
  expect(hasNotice(trust)).toBe(true)
  expect(readRegistry(home).marketplaces.gitmp.trust.code).toBe("granted")

  // an update that pulled no changes is not a mutation: no notice
  const unchanged = uiDrive(home, [{ select: "Marketplaces" }, { select: "gitmp" }, { select: "Update" }])
  expect(hasNotice(unchanged)).toBe(false)

  const pin = uiDrive(home, [
    { select: "Marketplaces" },
    { select: "gitmp" },
    { select: "Pin" },
    { prompt: "feature", optional: true },
  ])
  expect(hasNotice(pin)).toBe(true)
  expect(readRegistry(home).marketplaces.gitmp.ref).toBe("feature")
}, 240_000)
}

// tui fixes: back navigation, wrap/sizing/scroll, the empty-state flow — absorbed from test/phase22-tui-fixes.mjs
{

test("1. marketplace list rows show the pin when held — 'demo-marketplace (auto, pinned @ v1.0.0)' — and never claim one when unpinned", async () => {
  await withFakeHome(async () => {
    const mod = await loadModule("ui-marketplaces.js")
    const rows = required(mod, "marketplaceRows", "loader/ui-marketplaces.js", "spec 22 §4: the marketplace list renders its rows from it")
    const pinned = rows(demoRegistry({ ref: "v1.0.0" }))
    const row = pinned.find((r) => String(r?.title ?? "").includes("demo-marketplace"))
    if (!row) throw new Error(`expected a demo-marketplace row ({ title, ... } option shape) in ${JSON.stringify(pinned)}`)
    expect(row.title).toContain("demo-marketplace (auto, pinned @ v1.0.0)")
    const plain = rows(demoRegistry())
    const unpinned = plain.find((r) => String(r?.title ?? "").includes("demo-marketplace"))
    if (!unpinned) throw new Error(`expected a demo-marketplace row ({ title, ... } option shape) in ${JSON.stringify(plain)}`)
    expect(unpinned.title).not.toContain("pinned")
    // invariant: idempotence — rendering the same registry twice changes nothing
    expect(rows(demoRegistry())).toEqual(plain)
  })
})

test("2. marketplace detail lines state 'pinned @ <ref>' (or 'not pinned') and the current revision", async () => {
  await withFakeHome(async () => {
    const mod = await loadModule("ui-marketplaces.js")
    const detail = required(mod, "marketplaceDetailLines", "loader/ui-marketplaces.js", "spec 22 §4: the marketplace detail view renders its lines from it")
    const pinned = detail("demo-marketplace", demoEntry({ ref: "v1.0.0" }))
    lineWith(pinned, "pinned @ v1.0.0")
    lineWith(pinned, "abc123d") // the current revision, short or full sha
    lineWith(detail("demo-marketplace", demoEntry()), "not pinned")
  })
})

test("3. plugin detail lines show the plugin's manifest version next to the name", async () => {
  await withFakeHome(async () => {
    const mod = await loadModule("ui-plugins.js")
    const detail = required(mod, "pluginDetailLines", "loader/ui-plugins.js", "spec 22 §4: the plugin detail view renders its lines from it")
    const lines = detail("demo-marketplace", "adw", demoEntry())
    const version = lines.find((l) => l.includes("2.3.1"))
    if (version === undefined) throw new Error(`expected the manifest version 2.3.1 in:\n${lines.join("\n")}`)
    expect(version.includes("adw")).toBe(true) // next to the name, as ocm info shows it
  })
})

test("4. the empty-state flow chains the 'add one here' alert into the add flow: prompt offered, marketplace added", async () => {
  await withFakeHome(async (home) => {
    const mp = join(home, "mp")
    writeTree(mp, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
    // invariants: config safety and ownership ride the add the flow performs
    mkdirSync(join(cfg(home), "commands"), { recursive: true })
    writeFileSync(join(cfg(home), "commands", "mine.md"), "# my own command\n")
    writeFileSync(join(cfg(home), "opencode.json"), `${JSON.stringify({ model: "sonnet-4-6", permission: { edit: "allow" } }, null, 2)}\n`)

    const rec = flowDrive(home, [{ prompt: mp }])
    if (rec.error) throw new Error(`the empty-state flow failed:\n${rec.error}`)
    const alertAt = rec.dialogs.findIndex((d) => d.kind === "alert" && /add/i.test(d.message))
    const promptAt = rec.dialogs.findIndex((d) => d.kind === "prompt" && /add/i.test(d.title))
    if (alertAt === -1) throw new Error(`expected the empty-state alert; recorded: ${JSON.stringify(rec.dialogs)}`)
    if (promptAt === -1 || promptAt < alertAt) {
      throw new Error(`expected the "Add marketplace" prompt after the alert; recorded: ${JSON.stringify(rec.dialogs)}`)
    }
    expect(rec.toasts.some((t) => t.includes('"mp"'))).toBe(true)
    const registry = JSON.parse(readFileSync(join(cfg(home), "ocm", "registry.json"), "utf8"))
    expect(registry.marketplaces.mp.plugins.adw).toBeDefined()
    const link = join(cfg(home), "commands", "adw:commit.md")
    if (!existsSync(link) || !lstatSync(link).isSymbolicLink()) throw new Error(`expected a symlink at ${link}`)
    expect(realpathSync(link)).toBe(realpathSync(join(mp, "plugins", "adw", "commands", "commit.md")))
    // invariant: config safety — the user's keys survive the add
    const config = JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8"))
    expect(config.model).toBe("sonnet-4-6")
    expect(config.permission).toEqual({ edit: "allow" })
    // invariant: ownership — a hand-written command survives
    expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
    // invariant: no plugin-load errors attributable to ocm-installed files
  })
}, 420_000)

test("5. the view stack returns the previous view on back, one level at a time", async () => {
  await withFakeHome(async () => {
    const mod = await loadModule("ui-dialog.js")
    const createViewStack = required(mod, "createViewStack", "loader/ui-dialog.js", "spec 22 §3: back navigation runs through it")
    const stack = createViewStack()
    const root = { id: "marketplace-list" }
    const plugins = { id: "plugin-list" }
    const details = { id: "plugin-details" }
    stack.push(root)
    stack.push(plugins)
    stack.push(details)
    expect(stack.back()).toBe(plugins)
    expect(stack.back()).toBe(root)
  })
})

test("6. back at the root of the stack signals close: Escape at root closes the dialog", async () => {
  await withFakeHome(async () => {
    const mod = await loadModule("ui-dialog.js")
    const createViewStack = required(mod, "createViewStack", "loader/ui-dialog.js", "spec 22 §3: back navigation runs through it")
    const stack = createViewStack()
    stack.push({ id: "marketplace-list" })
    const closed = stack.back()
    if (closed !== null) throw new Error(`back() at the root must return null (the close signal); got ${JSON.stringify(closed)}`)
  })
})

test("7. a list view keeps its selection and scroll position when back returns to it", async () => {
  await withFakeHome(async () => {
    const mod = await loadModule("ui-dialog.js")
    const createViewStack = required(mod, "createViewStack", "loader/ui-dialog.js", "spec 22 §3: back navigation runs through it")
    const stack = createViewStack()
    const list = { id: "plugin-list", state: { selected: 0, scroll: 0 } }
    stack.push(list)
    list.state = { selected: 2, scroll: 8 } // the view moved its selection while on top
    stack.push({ id: "plugin-details" })
    const returned = stack.back()
    expect(returned).toBe(list)
    expect(returned.state).toEqual({ selected: 2, scroll: 8 })
  })
})

test("8. wrapText wraps at the width: the expected line count, no line wider than the width, words preserved", async () => {
  await withFakeHome(async () => {
    const mod = await loadModule("ui-dialog.js")
    const wrapText = required(mod, "wrapText", "loader/ui-dialog.js", "spec 22 §2: help and description text wraps instead of clipping")
    expect(wrapText("install plugins from marketplaces", 100)).toEqual(["install plugins from marketplaces"])
    const wrapped = wrapText("aaaa bbbb cccc dddd eeee ffff", 10)
    expect(wrapped.length).toBe(3)
    expect(wrapped.every((l) => l.length <= 10)).toBe(true)
    expect(wrapped.join(" ")).toBe("aaaa bbbb cccc dddd eeee ffff")
    // a word longer than the width is broken across lines, never clipped
    const broken = wrapText("abcdefghij", 4)
    expect(broken.length).toBe(3)
    expect(broken.every((l) => l.length <= 4)).toBe(true)
    // round-4 F206: a terminal reporting zero columns makes every derived
    // width negative. slice(0, -n) is "" and slice(-n) is the whole word, so
    // the hard-break loop above never terminated and opencode span at 100%
    // CPU until it was killed. Nothing sensible to wrap to: hand it back.
    expect(wrapText("a long word here", -11)).toEqual(["a long word here"])
    expect(wrapText("x", 0)).toEqual(["x"])
    expect(wrapText("one\ntwo", -1)).toEqual(["one", "two"])
  })
})

test("8b. fit() terminates and stays inside the frame when the terminal reports no size (round-4 F206)", async () => {
  await withFakeHome(async () => {
    const mod = await loadModule("ui-dialog.js")
    const fit = required(mod, "fit", "loader/ui-dialog.js", "round-4 F206: an unsized pty must not hang the dialog")
    const columns = process.stdout.columns
    const rows = process.stdout.rows
    try {
      Object.defineProperty(process.stdout, "columns", { value: 0, configurable: true })
      Object.defineProperty(process.stdout, "rows", { value: 0, configurable: true })
      // the assertion is that this returns at all — before the fix it spun
      const result = fit(["a long option description that would need wrapping", "second"])
      expect(Array.isArray(result.lines)).toBe(true)
      expect(result.lines.length).toBeGreaterThan(0)
    } finally {
      Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true })
      Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true })
    }
  })
}, 30_000)

test("9. dialogSize: width = min(content need, terminal width − 4) with floor 40; height = min(wrapped lines, terminal height − 2)", async () => {
  await withFakeHome(async () => {
    const mod = await loadModule("ui-dialog.js")
    const dialogSize = required(mod, "dialogSize", "loader/ui-dialog.js", "spec 22 §2: dialogs size to the terminal")
    // small content in a roomy terminal: the width floor applies, the height is the line count
    const small = dialogSize(["install plugins", "from marketplaces"], { width: 100, height: 50 })
    expect(small.width).toBe(40)
    expect(small.height).toBe(2)
    // a 120-column line is capped at 76 and wraps there, so the height need is 2
    const capped = dialogSize(["x".repeat(120)], { width: 80, height: 24 })
    expect(capped.width).toBe(76)
    expect(capped.height).toBe(2)
    // a terminal narrower than the floor still gets the 40-column floor
    const narrow = dialogSize(["hi"], { width: 30, height: 20 })
    expect(narrow.width).toBe(40)
    expect(narrow.height).toBe(1)
    // tall content is capped at the terminal height minus 2
    const tall = dialogSize(Array.from({ length: 30 }, () => "line"), { width: 80, height: 24 })
    expect(tall.width).toBe(40)
    expect(tall.height).toBe(22)
  })
})

test("10. the scroll viewport moves on ↑/↓/j/k, clamps at the ends, and indicates position like 3/17", async () => {
  await withFakeHome(async () => {
    const mod = await loadModule("ui-dialog.js")
    const createViewport = required(mod, "createViewport", "loader/ui-dialog.js", "spec 22 §2: overflowing bodies scroll")
    // the viewport is created with the body height — the action row sits
    // outside it, fixed; the clamp below proves the window never extends
    // past the content into where the action row renders
    const vp = createViewport(17, 5)
    expect(vp.indicator).toBe("1/17")
    vp.key("down")
    vp.key("down")
    expect(vp.indicator).toBe("3/17")
    vp.key("j")
    expect(vp.indicator).toBe("4/17")
    vp.key("k")
    expect(vp.indicator).toBe("3/17")
    for (let i = 0; i < 20; i++) vp.key("down")
    expect(vp.indicator).toBe("13/17") // 17 − 5 + 1: the last line is visible, no further
    for (let i = 0; i < 20; i++) vp.key("up")
    expect(vp.indicator).toBe("1/17")
  })
})
}

// brief 34 §2: the TUI's trust message and the CLI's trust listing are one
// block (spec 07) — compared directly, so the two renderers cannot drift
// apart again
test("1. trustMessage equals the CLI trust listing for the same components, across every command form", async () => {
  await withFakeHome(async (home) => {
    // invariants: config safety and ownership — the user's keys and file
    // predate the add and survive it
    writeTree(cfg(home), {
      "opencode.json": `${JSON.stringify({ model: "claude-sonnet-4-6", mcp: { "user-server": { type: "local", command: ["echo"] } } }, null, 2)}\n`,
      commands: { "mine.md": "# my own command\n" },
    })
    const mp = join(home, "mp")
    // every form §2 renders: array command, string command + args, remote
    // url, nothing renderable — the last two are shape-invalid, so their
    // lines carry the annotation
    writeTree(mp, { plugins: { p: {
      "plugin.json": PLUGIN_JSON,
      plugin: { "notify.js": JS_PLUGIN },
      "mcp.json": mcpJson({
        array: { type: "local", command: ["node", "server.js"], enabled: true },
        bare: {},
        remote: { type: "remote", url: "https://mcp.example.com/sse", enabled: true },
        string: { command: "node", args: ["/path/server.js", "--port", "3000"] },
      }),
    } } })
    const added = cli(home, "add", mp, "--trust")
    if (added.status !== 0) throw new Error(`ocm add --trust exited ${added.status}:\n${added.stdout}\n${added.stderr}`)
    const lines = added.stdout.split("\n")
    const start = lines.findIndex((l) => l.includes("ships code that opencode will execute"))
    const end = lines.findIndex((l) => l.startsWith("review it at "))
    if (start === -1 || end === -1 || end < start) throw new Error(`expected the trust listing block in:\n${added.stdout}`)
    const block = lines.slice(start, end + 1)
    const name = block[0].match(/^marketplace "(.+)" ships code/)?.[1]
    const dir = block[block.length - 1].slice("review it at ".length)
    const core = await loadModule("core.js")
    const components = core.executableComponents(mp, null)
    const ui = await loadModule("ui-trust.js")
    if (typeof ui.trustMessage !== "function") throw new Error("loader/ui-trust.js does not export trustMessage()")
    // trustMessage ends with the question the CLI asks separately (with its
    // [y/N/skip] hint, on stderr); everything before it is the listing
    expect(ui.trustMessage(name, dir, components)).toBe([...block, "trust this marketplace to run code?"].join("\n"))
    const config = JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8"))
    expect(config.model).toBe("claude-sonnet-4-6")
    expect(config.mcp["user-server"]).toEqual({ type: "local", command: ["echo"] })
    expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
    // invariant: no plugin-load errors attributable to ocm-installed files
  })
})
