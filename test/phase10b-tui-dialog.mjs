// Phase 10b — docs/specs/10b-tui-dialog.md: one test per numbered item, plus
// the four invariants (config safety and idempotence in 3, ownership in 4,
// no plugin errors in 5). The TUI cannot run headless, so a recorded fake api
// drives the INSTALLED ocm/ui.js in a spawned child on the fake $HOME —
// loader/*.js computes its path constants at module load, the same constraint
// that made phase 10a use CORE_RUNNER children. The fake answers a scripted
// queue of choices and prints the recording as one JSON document; stdout that
// is not exactly that document means the dialog printed.
import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, opencodeProbe, withFakeHome } from "./harness.mjs"

const OCM_BIN = fileURLToPath(new URL("../bin/ocm.ts", import.meta.url))

const phase = (name, body, timeout = 120_000) => test(name, () => withFakeHome(body), timeout)

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
const mcpKeys = (home) => {
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

const COMMAND = "---\ndescription: commit helper\n---\n\nCommit body.\n"
const SKILL = "---\nname: python-style\ndescription: Python style guidance\n---\n\n# Python style\n\nUse ruff.\n"
const JS_PLUGIN = 'export default { id: "phase10b-notify", server: async () => ({}) }\n'
const MCP = { db: { type: "local", command: ["npx", "-y", "@acme/db-mcp"], enabled: true } }
const mcpJson = (servers) => `${JSON.stringify(servers, null, 2)}\n`

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
  writeTree(mp, { plugins: { adw: { commands: { "commit.md": COMMAND } } } })
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
    adw: { commands: { "commit.md": COMMAND }, skills: { "python-style": { "SKILL.md": SKILL } } },
    beta: { commands: { "lint.md": COMMAND } },
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
    commands: { "work.md": COMMAND },
    plugin: { "notify.js": JS_PLUGIN },
    "mcp.json": mcpJson(MCP),
  } } })
  expect(cli(home, "add", `file://${remote}`, "--name", "gitmp").status).toBe(0)
  expect(cli(home, "uninstall", "tool").status).toBe(0) // the per-plugin menu must offer Install
  const clone = join(home, ".cache", "ocm", "marketplaces", "gitmp")
  const notifyLink = join(cfg(home), "plugins", "ocm--tool--notify.js")

  const mpA = join(home, "mp-a")
  writeTree(mpA, { plugins: { adw: { commands: { "commit.md": COMMAND } } } })
  expect(cli(home, "add", mpA).status).toBe(0)
  const mpB = join(home, "mp-b")
  writeTree(mpB, { plugins: { adw: { commands: { "deploy.md": COMMAND } } } })

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
  const probe = opencodeProbe(cfg(home), home)
  if (!probe.available) console.log("skipped: opencode is not on PATH")
  else {
    if (probe.unreliable) throw new Error("probe cannot trust itself: the canary broken plugin produced no error line")
    expect(probe.pluginErrors).toEqual([])
  }
}, 420_000) // opencode spawns: canary + error scan

phase("6. every mutation path ends by emitting the restart notice; an unchanged update does not", async (home) => {
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { tool: {
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
  writeTree(mp, { plugins: { adw: { commands: { "commit.md": COMMAND } } } })
  expect(cli(home, "add", mp).status).toBe(0)
  expect(cli(home, "uninstall", "adw").status).toBe(0)

  const mpx = join(home, "mpx")
  writeTree(mpx, { plugins: { fresh: { commands: { "hop.md": COMMAND }, plugin: { "notify.js": JS_PLUGIN } } } })

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
