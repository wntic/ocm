// Phase 22 — docs/specs/22-tui-fixes.md, automated half. The spec splits
// verification: rendering is a manual checklist; what runs here is headless —
// the data-shape functions the views render from (§4), the empty-state flow
// chained into the add flow (§1), the view-stack model behind back
// navigation (§3), and the wrap/sizing/scroll computations (§2). The four
// invariants ride item 4 (the flow performs a real add) and item 1
// (rendering the same registry twice changes nothing).
//
// The spec names behaviours, not symbols; the contracts asserted here:
//   loader/ui-marketplaces.js  marketplaceRows(registry)
//                             marketplaceDetailLines(name, entry)
//   loader/ui-plugins.js       pluginDetailLines(marketplace, name, entry)
//   loader/ui.js               emptyStateFlow(api, back)
//   loader/ui-dialog.js        wrapText(text, width)
//                             dialogSize(lines, terminal)   // raw lines; wraps internally
//                             createViewport(total, visible)
//                             createViewStack()             // push(view), back() -> view | null
import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { expect, test } from "bun:test"
import { opencodeProbe, withFakeHome } from "./harness.mjs"

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url))
const cfg = (home) => join(home, ".config", "opencode")

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

function writeTree(dir, tree) {
  mkdirSync(dir, { recursive: true })
  for (const [name, value] of Object.entries(tree)) {
    if (typeof value === "string") writeFileSync(join(dir, name), value)
    else writeTree(join(dir, name), value)
  }
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

const COMMAND = "---\ndescription: commit helper\n---\n\nCommit body.\n"
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
    const probe = opencodeProbe(cfg(home), home)
    if (!probe.available) console.log("skipped: opencode is not on PATH")
    else if (probe.unreliable) throw new Error("probe cannot trust itself: the canary broken plugin produced no error line")
    else expect(probe.pluginErrors).toEqual([])
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
  })
})

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
