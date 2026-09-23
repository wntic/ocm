// Brief 36 — display & TUI polish: the shared component renderer (§2), the
// line width budgets (§1) and the /ocm dialog readability (§4). Sections are
// marked per brief section so later subtasks append their own.

import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { expect, test } from "bun:test"
import { opencodeProbe, withFakeHome, withFakeOpencode } from "./harness.mjs"

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

const registryFile = (home) => join(cfg(home), "ocm", "registry.json")

const readRegistry = (home) => JSON.parse(readFileSync(registryFile(home), "utf8"))

const json = (value) => `${JSON.stringify(value, null, 2)}\n`

const lineWith = (output, needle) => {
  const line = output.split("\n").find((l) => l.includes(needle))
  if (line === undefined) throw new Error(`expected a line containing "${needle}" in:\n${output}`)
  return line
}

const COMMAND = "---\ndescription: commit helper\n---\n\nCommit body.\n"

// §1 — every line has a width budget (F113)

// like ocm, but with extra env for the child — the OCM_COLUMNS seam that
// stands in for a TTY a spawned child cannot have
function ocmEnv(home, env, ...args) {
  const result = spawnSync(process.execPath, [OCM_BIN, ...args], {
    env: { ...process.env, HOME: home, ...env }, encoding: "utf8", timeout: 120_000,
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

const ok = (result, label) => {
  if (result.status !== 0) throw new Error(`ocm ${label} exited ${result.status}: ${result.stderr}`)
  return result.stdout
}

const LONG_DESC =
  "demonstrates the width budget by carrying a long description that cannot fit on one eighty column head line and must therefore wrap beneath it with a hanging indent when stdout is a terminal"

const PLUGIN_JSON_BUDGET = json({
  description: LONG_DESC,
  version: "1.2.0",
  extensions: { "dev.wntic.ocm": { category: "testing" } },
})

const SKILL_NAMES = Array.from({ length: 30 }, (_, i) => `skill-${String(i + 1).padStart(2, "0")}`)

const skillsTree = () => {
  const skills = {}
  for (const name of SKILL_NAMES) {
    skills[name] = { "SKILL.md": `---\nname: ${name}\ndescription: ${name} body\n---\n\nBody.\n` }
  }
  return skills
}

const SKILL = "---\nname: greeting\ndescription: greeting skill\n---\n\nBody.\n"

const PLUGIN_JSON = json({ description: "demo plugin" })

const JS_PLUGIN = 'export default { id: "f115-notify", server: async () => ({}) }\n'

const SERVER = { type: "local", command: ["npx", "-y", "@acme/db-mcp"], enabled: true }

// §2 — one component renderer, one spelling (F115)

phase("list and search print one shared renderer's component spelling: commands: parse, skills: greeting, plugins: notify.js, mcp: everything", async (home) => {
  // invariants: config safety and ownership — the user's keys and their own
  // command predate every ocm run and must survive the renders
  writeTree(cfg(home), {
    "opencode.json": json({ model: "claude-sonnet-4-6", mcp: { "user-server": { type: "local", command: ["echo"] } } }),
    commands: { "mine.md": "# my own command\n" },
  })
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { kit: {
    "plugin.json": PLUGIN_JSON,
    commands: { "parse.md": COMMAND },
    skills: { greeting: { "SKILL.md": SKILL } },
    plugin: { "notify.js": JS_PLUGIN },
    "mcp.json": json({ everything: SERVER }),
  } } })
  const added = ocm(home, "add", mp, "--trust")
  if (added.status !== 0) throw new Error(`ocm add exited ${added.status}: ${added.stderr}`)
  const registryBytes = readFileSync(registryFile(home), "utf8")
  const configBytes = readFileSync(join(cfg(home), "opencode.json"), "utf8")

  const run = (...args) => {
    const result = ocm(home, ...args)
    if (result.status !== 0) throw new Error(`ocm ${args.join(" ")} exited ${result.status}: ${result.stderr}`)
    return result.stdout
  }
  const listed = run("list")
  const searched = run("search", "kit") // matches the plugin name only, so the summary line prints

  // the expectation is the renderer's own output, not a second hand-typed one
  const { componentSummary, bareComponents } = await import("../src/commands/display.ts")
  if (typeof componentSummary !== "function" || typeof bareComponents !== "function") {
    throw new Error("src/commands/display.ts must export componentSummary and bareComponents — the one renderer list and search share (brief 36 §2)")
  }
  const record = readRegistry(home).marketplaces.mp.plugins.kit
  const summary = componentSummary(record.components)
  expect(summary).toBe("commands: parse · skills: greeting · plugins: notify.js · mcp: everything")
  lineWith(searched, summary) // search's component line is the renderer's output
  for (const fragment of summary.split(" · ")) {
    const line = lineWith(listed, fragment)
    if (line.trim() !== fragment) throw new Error(`list must print the shared spelling "${fragment}" verbatim, got "${line.trim()}"`)
  }
  expect(listed).not.toContain("parse.md") // the raw registry spelling is gone from the human output

  // list --json is the raw registry and stays byte-identical; search --json keeps the bare spelling
  expect(run("list", "--json")).toBe(registryBytes)
  expect(JSON.parse(run("search", "kit", "--json"))[0].components).toEqual(bareComponents(record.components))

  // invariants: idempotence (a second render writes nothing), config safety, ownership
  expect(run("list")).toBe(listed)
  expect(readFileSync(registryFile(home), "utf8")).toBe(registryBytes)
  expect(readFileSync(join(cfg(home), "opencode.json"), "utf8")).toBe(configBytes)
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
  const probe = opencodeProbe(cfg(home), home)
  if (probe.available && !probe.unreliable) expect(probe.pluginErrors).toEqual([])
})

phase("search wraps the description beneath the head line only when stdout is a TTY", async (home) => {
  if (LONG_DESC.length < 190) throw new Error(`fixture: the description must be ~190 chars, got ${LONG_DESC.length}`)
  // invariants: config safety and ownership — the user's keys and their own
  // command predate every ocm run and must survive the renders
  writeTree(cfg(home), {
    "opencode.json": json({ model: "claude-sonnet-4-6" }),
    commands: { "mine.md": "# my own command\n" },
  })
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { kit: {
    "plugin.json": PLUGIN_JSON_BUDGET,
    commands: { "parse.md": COMMAND },
  } } })
  const added = ocm(home, "add", mp, "--trust")
  if (added.status !== 0) throw new Error(`ocm add exited ${added.status}: ${added.stderr}`)
  const registryBytes = readFileSync(registryFile(home), "utf8")
  const configBytes = readFileSync(join(cfg(home), "opencode.json"), "utf8")

  // piped: one logical line per record — the head line is today's full join
  const piped = ok(ocm(home, "search", "kit"), "search kit")
  expect(lineWith(piped, "kit@mp")).toBe(`kit@mp  1.2.0  testing  ${LONG_DESC}`)

  // TTY: the description always moves beneath the head line
  const tty = ok(ocmEnv(home, { OCM_COLUMNS: "80" }, "search", "kit"), "search kit (OCM_COLUMNS=80)")
  const lines = tty.split("\n")
  const head = lineWith(tty, "kit@mp")
  expect(head).toBe("kit@mp  1.2.0  testing")
  expect(head.length).toBeLessThanOrEqual(80)
  const summaryIdx = lines.indexOf("  commands: parse")
  if (summaryIdx === -1) throw new Error(`expected the component summary line in:\n${tty}`)
  const desc = lines.slice(lines.indexOf(head) + 1, summaryIdx)
  if (desc.length < 2) throw new Error(`expected the ${LONG_DESC.length}-char description to wrap onto several lines under 80 columns`)
  if (!/^ {2}\S/.test(desc[0])) throw new Error(`the description's first line must be indented exactly 2: "${desc[0]}"`)
  for (const line of desc.slice(1)) {
    if (!/^ {4}\S/.test(line)) throw new Error(`description continuation lines must be indented exactly 4: "${line}"`)
  }
  for (const line of desc) {
    if (line.length > 80) throw new Error(`description line exceeds the 80-column budget (${line.length}): "${line}"`)
  }
  expect(desc.map((line) => line.trim()).join(" ")).toBe(LONG_DESC)

  // invariants: idempotence (a second render writes nothing), config safety, ownership
  expect(ok(ocmEnv(home, { OCM_COLUMNS: "80" }, "search", "kit"), "search kit again")).toBe(tty)
  expect(readFileSync(registryFile(home), "utf8")).toBe(registryBytes)
  expect(readFileSync(join(cfg(home), "opencode.json"), "utf8")).toBe(configBytes)
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
})

phase("list wraps component names with a hanging indent only when stdout is a TTY", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { kit: {
    "plugin.json": PLUGIN_JSON,
    skills: skillsTree(),
  } } })
  const added = ocm(home, "add", mp, "--trust")
  if (added.status !== 0) throw new Error(`ocm add exited ${added.status}: ${added.stderr}`)
  const registryBytes = readFileSync(registryFile(home), "utf8")

  // piped: ALL names on one line, exactly as today
  const piped = ok(ocm(home, "list"), "list")
  expect(lineWith(piped, "skills:")).toBe(`    skills: ${SKILL_NAMES.join(", ")}`)
  expect(piped.split("\n").every((line) => !line.startsWith("      "))).toBe(true)

  // TTY: the label once, names wrapped beneath it, nothing elided
  const tty = ok(ocmEnv(home, { OCM_COLUMNS: "80" }, "list"), "list (OCM_COLUMNS=80)")
  const lines = tty.split("\n").filter(Boolean)
  const labelled = lines.filter((line) => line.includes("skills:"))
  if (labelled.length !== 1) throw new Error(`the skills label must print exactly once, found ${labelled.length}`)
  const block = []
  for (const line of lines.slice(lines.indexOf(labelled[0]))) {
    if (block.length && !line.startsWith("    ")) break
    block.push(line)
  }
  if (block.length < 2) throw new Error("expected the 30-name skills line to wrap onto several lines under 80 columns")
  if (!block[0].startsWith("    skills: ")) throw new Error(`the first skills line must be indented 4 with the label once: "${block[0]}"`)
  for (const line of block.slice(1)) {
    if (!/^ {6}\S/.test(line)) throw new Error(`skills continuation lines must be indented exactly 6: "${line}"`)
  }
  for (const line of block) {
    if (line.length > 80) throw new Error(`skills line exceeds the 80-column budget (${line.length}): "${line}"`)
  }
  expect(block.map((line) => line.trim()).join(" ")).toBe(`skills: ${SKILL_NAMES.join(", ")}`)

  // invariant: idempotence — the renders wrote nothing
  expect(readFileSync(registryFile(home), "utf8")).toBe(registryBytes)
})

phase("info moves the arrow onto an indented continuation line only when stdout is a TTY", async (home) => {
  const file = "deploy-the-cluster-to-production-with-extra-flags.md"
  const name = `kit:${file.replace(/\.md$/, "")}`
  const target = join(cfg(home), "commands", `kit:${file}`)
  const single = `    command ${name}  → ${target}`
  if (single.length < 136) throw new Error(`fixture: the info component line must reach 136 chars, got ${single.length}`)
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { kit: {
    "plugin.json": PLUGIN_JSON,
    commands: { [file]: COMMAND },
  } } })
  const added = ocm(home, "add", mp, "--trust")
  if (added.status !== 0) throw new Error(`ocm add exited ${added.status}: ${added.stderr}`)
  const registryBytes = readFileSync(registryFile(home), "utf8")

  // piped: the single line exactly as today
  const piped = ok(ocm(home, "info", "kit"), "info kit")
  expect(lineWith(piped, "→")).toBe(single)

  // TTY: type and name stay together, the arrow and target move as one unit
  const tty = ok(ocmEnv(home, { OCM_COLUMNS: "80" }, "info", "kit"), "info kit (OCM_COLUMNS=80)")
  const head = lineWith(tty, name)
  expect(head).toBe(`    command ${name}`)
  expect(head.length).toBeLessThanOrEqual(80)
  const lines = tty.split("\n")
  expect(lines[lines.indexOf(head) + 1]).toBe(`      → ${target}`)

  // invariant: idempotence — the renders wrote nothing
  expect(readFileSync(registryFile(home), "utf8")).toBe(registryBytes)
})

phase("a component target longer than the budget prints whole on its own line", async (home) => {
  const file = "unbreakable-path-exceeding-the-eighty-column-width-budget.md"
  const target = join(cfg(home), "commands", `kit:${file}`)
  if (target.length < 100) throw new Error(`fixture: the target path must reach 100 chars, got ${target.length}`)
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { kit: {
    "plugin.json": PLUGIN_JSON,
    commands: { [file]: COMMAND },
  } } })
  const added = ocm(home, "add", mp, "--trust")
  if (added.status !== 0) throw new Error(`ocm add exited ${added.status}: ${added.stderr}`)

  const tty = ok(ocmEnv(home, { OCM_COLUMNS: "80" }, "info", "kit"), "info kit (OCM_COLUMNS=80)")
  const lines = tty.split("\n").filter(Boolean)
  const arrow = lines.filter((line) => line.includes("→"))
  expect(arrow).toEqual([`      → ${target}`])
  // the token was never broken: no other line carries a fragment of it
  const tail = target.slice(-30)
  for (const line of lines) {
    if (line !== `      → ${target}` && line.includes(tail)) {
      throw new Error(`a line carries a broken-off fragment of the target: "${line}"`)
    }
  }
})

phase("--json output is byte-identical with and without OCM_COLUMNS", async (home) => {
  // a regression pin: --json is never wrapped, so forcing a width changes nothing
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { kit: {
    "plugin.json": PLUGIN_JSON_BUDGET,
    commands: { "parse.md": COMMAND },
  } } })
  const added = ocm(home, "add", mp, "--trust")
  if (added.status !== 0) throw new Error(`ocm add exited ${added.status}: ${added.stderr}`)
  for (const args of [["search", "kit"], ["list"], ["info", "kit"]]) {
    const plain = ok(ocm(home, ...args, "--json"), `${args.join(" ")} --json`)
    const forced = ok(ocmEnv(home, { OCM_COLUMNS: "40" }, ...args, "--json"), `${args.join(" ")} --json (OCM_COLUMNS=40)`)
    if (forced !== plain) throw new Error(`ocm ${args.join(" ")} --json must ignore OCM_COLUMNS:\n${forced}`)
  }
})

phase("columns() and wrapping() read OCM_COLUMNS per invocation, floored at 40", async () => {
  const display = await import("../src/commands/display.ts")
  if (typeof display.columns !== "function" || typeof display.wrapping !== "function") {
    throw new Error("src/commands/display.ts must export columns() and wrapping() — the OCM_COLUMNS seam (brief 36 §1)")
  }
  const previous = process.env.OCM_COLUMNS
  try {
    delete process.env.OCM_COLUMNS
    // bun test pipes stdout, so the unset case here is today's piped behaviour
    if (!process.stdout.isTTY) {
      expect(display.columns()).toBe(80)
      expect(display.wrapping()).toBe(false)
    }
    process.env.OCM_COLUMNS = "80"
    expect(display.columns()).toBe(80)
    expect(display.wrapping()).toBe(true)
    process.env.OCM_COLUMNS = "30"
    expect(display.columns()).toBe(40)
    expect(display.wrapping()).toBe(true)
  } finally {
    if (previous === undefined) delete process.env.OCM_COLUMNS
    else process.env.OCM_COLUMNS = previous
  }
})

// §3 — matched: annotations are not suppressed by rank (F122)

const CORE_MODULE = fileURLToPath(new URL("../loader/core.js", import.meta.url))

// searchPlugins must run in a child on the fake home: loader/core.js fixes
// its registry path from homedir() at module load
const SEARCH_RUNNER = 'const mod = await import(process.argv[2]); process.stdout.write(JSON.stringify(mod.searchPlugins(process.argv[3])))\n'

function searchIn(home, query) {
  const runner = join(home, "search-runner.mjs")
  writeFileSync(runner, SEARCH_RUNNER)
  const result = spawnSync(process.execPath, [runner, CORE_MODULE, query], {
    env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 120_000,
  })
  if (result.status !== 0) throw new Error(`searchPlugins("${query}") exited ${result.status}: ${result.stderr}`)
  return JSON.parse(result.stdout)
}

phase("a rank-0 name hit colliding with its own command carries the matched annotation", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { parse: {
    "plugin.json": PLUGIN_JSON,
    commands: { "parse.md": COMMAND },
  } } })
  const added = ocm(home, "add", mp, "--trust")
  if (added.status !== 0) throw new Error(`ocm add exited ${added.status}: ${added.stderr}`)
  const registryBytes = readFileSync(registryFile(home), "utf8")

  // unit: the name-exact rank wins, but the component match is still reported
  const matches = searchIn(home, "parse")
  expect(matches).toHaveLength(1)
  expect(matches[0].rank).toBe(0)
  expect(matches[0].matched).toEqual(["commands/parse"])

  // CLI: the matched line replaces the component summary for that hit
  const out = ok(ocm(home, "search", "parse"), "search parse")
  expect(lineWith(out, "matched:").trim()).toBe("matched: commands/parse")
  expect(out).not.toContain("commands: parse")

  // --json: same key, now the non-empty array instead of null
  const parsed = JSON.parse(ok(ocm(home, "search", "parse", "--json"), "search parse --json"))
  expect(parsed[0].matched).toEqual(["commands/parse"])

  // invariant: idempotence — the renders wrote nothing
  expect(readFileSync(registryFile(home), "utf8")).toBe(registryBytes)
})

phase("a rank-0 name hit with no component collision keeps matched empty and prints the summary", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { kit: {
    "plugin.json": PLUGIN_JSON,
    commands: { "parse.md": COMMAND },
  } } })
  const added = ocm(home, "add", mp, "--trust")
  if (added.status !== 0) throw new Error(`ocm add exited ${added.status}: ${added.stderr}`)
  const registryBytes = readFileSync(registryFile(home), "utf8")

  const matches = searchIn(home, "kit")
  expect(matches).toHaveLength(1)
  expect(matches[0].rank).toBe(0)
  expect(matches[0].matched).toEqual([])

  const out = ok(ocm(home, "search", "kit"), "search kit")
  expect(lineWith(out, "commands:").trim()).toBe("commands: parse")
  expect(out).not.toContain("matched:")

  expect(JSON.parse(ok(ocm(home, "search", "kit", "--json"), "search kit --json"))[0].matched).toBe(null)

  // invariant: idempotence — the renders wrote nothing
  expect(readFileSync(registryFile(home), "utf8")).toBe(registryBytes)
})

// §5 — trust: none is not a security state (F125)

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url))

// loader/ui-plugins.js fixes its paths at module load; the query string
// binds a fresh instance to this fake home (the tui.test.mjs pattern)
let uiCounter = 0
const loadUiPlugins = () =>
  import(`${pathToFileURL(join(REPO_ROOT, "loader", "ui-plugins.js")).href}?t=${Date.now()}-${uiCounter++}`)

// the trust field line only — output for marketplaces with pending
// executables carries "awaiting trust" lines that start with a component path
const trustField = (output) => {
  const line = output.split("\n").find((l) => /^\s*trust\b/.test(l))
  if (line === undefined) throw new Error(`expected a trust line in:\n${output}`)
  return line
}

const TRUST_NA = "  trust        n/a — no executable components"
const TRUST_NONE = "  trust        none"

phase("info prints 'n/a — no executable components' when trust is none and nothing ships code; --json keeps the raw enum", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { kit: {
    "plugin.json": PLUGIN_JSON,
    commands: { "parse.md": COMMAND },
  } } })
  const added = ocm(home, "add", mp)
  if (added.status !== 0) throw new Error(`ocm add exited ${added.status}: ${added.stderr}`)
  if (readRegistry(home).marketplaces.mp.trust.code !== "none") {
    throw new Error('fixture: a piped add with no flags must leave trust code "none"')
  }
  const registryBytes = readFileSync(registryFile(home), "utf8")

  expect(trustField(ok(ocm(home, "info", "kit"), "info kit"))).toBe(TRUST_NA)
  expect(JSON.parse(ok(ocm(home, "info", "kit", "--json"), "info kit --json")).trust).toBe("none")

  // invariant: idempotence — the renders wrote nothing
  expect(readFileSync(registryFile(home), "utf8")).toBe(registryBytes)
})

phase("info keeps the plain none trust line when the marketplace ships executable components", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { kit: {
    "plugin.json": PLUGIN_JSON,
    commands: { "parse.md": COMMAND },
    plugin: { "notify.js": JS_PLUGIN },
    "mcp.json": json({ everything: SERVER }),
  } } })
  const added = ocm(home, "add", mp)
  if (added.status !== 0) throw new Error(`ocm add exited ${added.status}: ${added.stderr}`)
  if (readRegistry(home).marketplaces.mp.trust.code !== "none") {
    throw new Error('fixture: a piped add with no flags must leave trust code "none"')
  }
  const registryBytes = readFileSync(registryFile(home), "utf8")

  expect(trustField(ok(ocm(home, "info", "kit"), "info kit"))).toBe(TRUST_NONE)
  expect(JSON.parse(ok(ocm(home, "info", "kit", "--json"), "info kit --json")).trust).toBe("none")

  // invariant: idempotence — the renders wrote nothing
  expect(readFileSync(registryFile(home), "utf8")).toBe(registryBytes)
})

phase("info keeps the none trust line when the marketplace directory is missing", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { kit: {
    "plugin.json": PLUGIN_JSON,
    commands: { "parse.md": COMMAND },
  } } })
  const added = ocm(home, "add", mp)
  if (added.status !== 0) throw new Error(`ocm add exited ${added.status}: ${added.stderr}`)
  const registryBytes = readFileSync(registryFile(home), "utf8")

  rmSync(mp, { recursive: true, force: true })
  expect(trustField(ok(ocm(home, "info", "kit"), "info kit"))).toBe(TRUST_NONE)

  // invariant: idempotence — the render wrote nothing
  expect(readFileSync(registryFile(home), "utf8")).toBe(registryBytes)
})

phase("granted and denied marketplaces keep their trust word once nothing ships code", async (home) => {
  // a trust flag only records a decision when code ships, so the grant rides
  // an executable that is then gone from the tree — the word must survive it
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { alpha: {
    "plugin.json": PLUGIN_JSON,
    commands: { "parse.md": COMMAND },
    plugin: { "notify.js": JS_PLUGIN },
  } } })
  const granted = ocm(home, "add", mp, "--trust")
  if (granted.status !== 0) throw new Error(`ocm add --trust exited ${granted.status}: ${granted.stderr}`)
  const mp2 = join(home, "mp2")
  writeTree(mp2, { plugins: { beta: {
    "plugin.json": PLUGIN_JSON,
    commands: { "parse.md": COMMAND },
    plugin: { "notify.js": JS_PLUGIN },
  } } })
  const denied = ocm(home, "add", mp2, "--no-trust")
  if (denied.status !== 0) throw new Error(`ocm add --no-trust exited ${denied.status}: ${denied.stderr}`)
  rmSync(join(mp, "plugins", "alpha", "plugin"), { recursive: true, force: true })
  rmSync(join(mp2, "plugins", "beta", "plugin"), { recursive: true, force: true })
  const registryBytes = readFileSync(registryFile(home), "utf8")

  expect(trustField(ok(ocm(home, "info", "alpha@mp"), "info alpha@mp"))).toBe("  trust        granted")
  expect(trustField(ok(ocm(home, "info", "beta@mp2"), "info beta@mp2"))).toBe("  trust        denied")

  // invariant: idempotence — the renders wrote nothing
  expect(readFileSync(registryFile(home), "utf8")).toBe(registryBytes)
})

phase("the TUI plugin detail trust line follows the same rule as info", async (home) => {
  const mod = await loadUiPlugins()
  if (typeof mod.pluginDetailLines !== "function") {
    throw new Error("loader/ui-plugins.js must export pluginDetailLines() — the plugin detail view renders its lines from it")
  }
  const trustDetail = (mpName, pluginName, entry) => {
    const lines = mod.pluginDetailLines(mpName, pluginName, entry)
    const line = lines.find((l) => /^trust: /.test(l))
    if (line === undefined) throw new Error(`expected a trust line in:\n${lines.join("\n")}`)
    return line
  }

  // nothing executable, trust none: n/a
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { alpha: {
    "plugin.json": PLUGIN_JSON,
    commands: { "parse.md": COMMAND },
  } } })
  ok(ocm(home, "add", mp), "add mp")
  expect(trustDetail("mp", "alpha", readRegistry(home).marketplaces.mp)).toBe("trust: n/a — no executable components")

  // executable components, trust none: the plain word
  const mp2 = join(home, "mp2")
  writeTree(mp2, { plugins: { beta: {
    "plugin.json": PLUGIN_JSON,
    commands: { "parse.md": COMMAND },
    plugin: { "notify.js": JS_PLUGIN },
    "mcp.json": json({ everything: SERVER }),
  } } })
  ok(ocm(home, "add", mp2), "add mp2")
  expect(trustDetail("mp2", "beta", readRegistry(home).marketplaces.mp2)).toBe("trust: none")

  // the tree cannot be read: the plain word
  rmSync(mp, { recursive: true, force: true })
  expect(trustDetail("mp", "alpha", readRegistry(home).marketplaces.mp)).toBe("trust: none")

  // granted keeps its word once nothing ships code
  const mp3 = join(home, "mp3")
  writeTree(mp3, { plugins: { gamma: {
    "plugin.json": PLUGIN_JSON,
    commands: { "parse.md": COMMAND },
    plugin: { "notify.js": JS_PLUGIN },
  } } })
  ok(ocm(home, "add", mp3, "--trust"), "add mp3 --trust")
  rmSync(join(mp3, "plugins", "gamma", "plugin"), { recursive: true, force: true })
  const registryBytes = readFileSync(registryFile(home), "utf8")
  expect(trustDetail("mp3", "gamma", readRegistry(home).marketplaces.mp3)).toBe("trust: granted")

  // invariant: idempotence — the detail renders wrote nothing
  expect(readFileSync(registryFile(home), "utf8")).toBe(registryBytes)
})

// §4 — the /ocm details view readable at 80×24

// loader/ui-dialog.js is loaded per test for the same cache-busting reason
// as loadUiPlugins above
let dialogCounter = 0
const loadUiDialog = () =>
  import(`${pathToFileURL(join(REPO_ROOT, "loader", "ui-dialog.js")).href}?t=${Date.now()}-${dialogCounter++}`)

const SELECT_PROPS_WHY =
  "loader/ui-dialog.js must export selectProps() — the choke point every select dialog builds its wrapped props through (brief 36 §4)"

// medium bucket at 80 columns: frame 60, row budget 60 − 12 (ROW_CHROME)
const BUDGET_80 = 48

phase("the dialog bucket is the largest that fits the terminal, and content never shrinks it", async () => {
  const dialog = await loadUiDialog()
  // fit is exercised first because it exists today: this failure names the
  // current smallest-bucket rule, not only the missing export
  const columns = process.stdout.columns
  const rows = process.stdout.rows
  try {
    Object.defineProperty(process.stdout, "columns", { value: 200, configurable: true })
    Object.defineProperty(process.stdout, "rows", { value: 50, configurable: true })
    expect(dialog.fit(["a short line"]).size).toBe("xlarge")
    Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true })
    expect(dialog.fit(["a short line"]).size).toBe("medium")
  } finally {
    Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true })
    Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true })
  }
  if (typeof dialog.selectProps !== "function") throw new Error(SELECT_PROPS_WHY)
  const small = { title: "menu", options: [{ title: "only", value: "only" }], onSelect: () => {} }
  for (const [width, size] of [[80, "medium"], [100, "large"], [200, "xlarge"], [30, "medium"]]) {
    expect(dialog.selectProps(small, { width, height: 24 }).size).toBe(size)
  }
  // content need never shrinks the bucket below the terminal's best fit
  const long = "x".repeat(300)
  const huge = dialog.selectProps(
    { title: long, options: [{ title: long, value: "v", description: long }], onSelect: () => {} },
    { width: 200, height: 24 },
  )
  expect(huge.size).toBe("xlarge")
})

phase("selectProps wraps the title, option titles and descriptions to the bucket's row budget", async () => {
  const dialog = await loadUiDialog()
  if (typeof dialog.selectProps !== "function") throw new Error(SELECT_PROPS_WHY)
  const built = dialog.selectProps(
    {
      title: "t".repeat(100),
      options: [
        { title: "w".repeat(70), value: "long", description: "d".repeat(120) },
        { title: "short", value: "short", description: "fits" },
      ],
      onSelect: () => {},
    },
    { width: 80, height: 24 },
  )
  const titleLines = String(built.props.title).split("\n")
  if (titleLines.length < 2) {
    throw new Error(`a 100-char title cannot fit the ${BUDGET_80}-char budget; built title: ${JSON.stringify(built.props.title)}`)
  }
  for (const line of titleLines) {
    if (line.length > BUDGET_80) throw new Error(`built title line exceeds the ${BUDGET_80}-char budget (${line.length}): "${line}"`)
  }
  for (const option of built.props.options) {
    if (String(option.title).length > BUDGET_80) {
      throw new Error(`option title exceeds the ${BUDGET_80}-char budget (${String(option.title).length}): "${option.title}"`)
    }
    if (option.description !== undefined && String(option.description).length > BUDGET_80) {
      throw new Error(`option description exceeds the ${BUDGET_80}-char budget (${String(option.description).length}): "${option.description}"`)
    }
  }
})

phase("the details view at 80×24 keeps every source line, wrapped to budget, with an intact back row", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { kit: {
    "plugin.json": PLUGIN_JSON_BUDGET,
    skills: skillsTree(),
  } } })
  ok(ocm(home, "add", mp, "--trust"), "add mp --trust")
  const entry = readRegistry(home).marketplaces.mp
  const registryBytes = readFileSync(registryFile(home), "utf8")

  const plugins = await loadUiPlugins()
  const dialog = await loadUiDialog()
  if (typeof dialog.selectProps !== "function") throw new Error(SELECT_PROPS_WHY)
  const lines = plugins.pluginDetailLines("mp", "kit", entry)
  // built exactly as showDetails will: one option per source line, plus back
  const built = dialog.selectProps(
    {
      title: "kit@mp",
      skipFilter: true,
      options: [
        ...lines.map((line, i) => ({ title: line, value: i })),
        { title: "← back", value: "back", description: "or press Escape" },
      ],
      onSelect: () => {},
    },
    { width: 80, height: 24 },
  )
  const options = built.props.options
  for (const option of options) {
    if (String(option.title).length > BUDGET_80) {
      throw new Error(`details row exceeds the ${BUDGET_80}-char budget (${String(option.title).length}): "${option.title}"`)
    }
    if (option.disabled === true) {
      throw new Error(`details rows are selectable-but-inert, never disabled: ${JSON.stringify(option)}`)
    }
  }
  const back = options.find((o) => o.value === "back")
  if (!back || back.title !== "← back" || back.description !== "or press Escape") {
    throw new Error(`the ← back row must survive intact with its description; got: ${JSON.stringify(back)}`)
  }
  // every source line becomes rows carrying its index, in order, wrapped to budget
  const groups = new Map()
  for (const option of options) {
    if (option.value === "back") continue
    if (!groups.has(option.value)) groups.set(option.value, [])
    groups.get(option.value).push(option.title)
  }
  expect([...groups.keys()]).toEqual(lines.map((_, i) => i))
  for (let i = 0; i < lines.length; i++) {
    expect(groups.get(i)).toEqual(dialog.wrapText(lines[i], BUDGET_80))
  }

  // invariant: idempotence — building the props wrote nothing
  expect(readFileSync(registryFile(home), "utf8")).toBe(registryBytes)
})

phase("an over-long description folds into disabled rows beneath the option; a long title continues on selectable rows", async () => {
  const dialog = await loadUiDialog()
  if (typeof dialog.selectProps !== "function") throw new Error(SELECT_PROPS_WHY)
  const { selectProps, wrapText } = dialog
  const overLong =
    "this description is deliberately longer than the forty-eight character row budget so it must fold beneath its option as several continuation rows instead of staying inline where the widget would ellipsize it"
  if (overLong.length < 150) throw new Error(`fixture: the over-long description must reach 150 chars, got ${overLong.length}`)
  const longTitle = "a title long enough that it cannot fit the row budget and must continue on a second selectable row"
  const built = selectProps(
    {
      title: "menu",
      options: [
        { title: "folded", value: "folded", description: overLong },
        { title: "inline", value: "inline", description: "fits the budget" },
        { title: longTitle, value: "titled" },
      ],
      onSelect: () => {},
    },
    { width: 80, height: 24 },
  )
  const options = built.props.options

  // over-long description: gone from the option, folded beneath as disabled rows
  const folded = options.find((o) => o.value === "folded")
  if (folded.description !== undefined) {
    throw new Error(`an over-long description must be removed from the option; still present: ${JSON.stringify(folded.description)}`)
  }
  const foldedAt = options.indexOf(folded)
  const foldedRows = options.slice(foldedAt + 1, foldedAt + 1 + wrapText(overLong, BUDGET_80).length)
  expect(foldedRows.map((o) => o.title)).toEqual(wrapText(overLong, BUDGET_80))
  for (const row of foldedRows) {
    if (row.value !== "folded" || row.disabled !== true) {
      throw new Error(`description continuation rows are disabled and carry the parent value; got: ${JSON.stringify(row)}`)
    }
  }

  // a fitting description stays inline and adds no rows
  const inline = options.find((o) => o.value === "inline")
  if (inline.description !== "fits the budget") {
    throw new Error(`a fitting description stays inline; got: ${JSON.stringify(inline.description)}`)
  }
  const afterInline = options[options.indexOf(inline) + 1]
  if (afterInline.value !== "titled") {
    throw new Error(`a fitting description adds no continuation rows; next row: ${JSON.stringify(afterInline)}`)
  }

  // a long title continues on selectable rows carrying the parent value
  const titled = options.find((o) => o.value === "titled")
  const titledAt = options.indexOf(titled)
  const titleLines = wrapText(longTitle, BUDGET_80)
  expect(titled.title).toBe(titleLines[0])
  const contRows = options.slice(titledAt + 1, titledAt + titleLines.length)
  expect(contRows.map((o) => o.title)).toEqual(titleLines.slice(1))
  for (const row of contRows) {
    if (row.value !== "titled" || row.disabled === true) {
      throw new Error(`title continuation rows carry the parent value and are selectable, not disabled; got: ${JSON.stringify(row)}`)
    }
  }
})

// §6 — the startup sync's warnings are persisted, then shown (F222)

// the loader's startup sync, run the way ocm-loader.js runs it: a child on
// the fake $HOME, throttled (no force), carrying the startup reason
const SYNC_RUNNER = 'const mod = await import(process.argv[2]); await mod.syncAll({ reason: "startup" })\n'

function loaderSync(home, env = {}) {
  const runner = join(home, "sync-runner.mjs")
  writeFileSync(runner, SYNC_RUNNER)
  const result = spawnSync(process.execPath, [runner, CORE_MODULE], {
    env: { ...process.env, HOME: home, ...env }, encoding: "utf8", timeout: 120_000,
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

// a local marketplace whose manifest renames map cycles — both sync paths
// reconcile it and emit exactly CYCLE_WARNING — beside a clean one
const CYCLE_MANIFEST = json({ renames: { alpha: "beta", beta: "alpha" } })
const CYCLE_WARNING = "rename cycle ignored: alpha → beta → alpha"

function addCycleAndClean(home) {
  writeTree(join(home, "mp"), {
    "marketplace.json": CYCLE_MANIFEST,
    plugins: { kit: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } } },
  })
  writeTree(join(home, "other"), {
    plugins: { tool: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } } },
  })
  for (const name of ["mp", "other"]) {
    const added = ocm(home, "add", join(home, name))
    if (added.status !== 0) throw new Error(`ocm add ${name} exited ${added.status}: ${added.stderr}`)
  }
}

phase("the startup sync persists per-marketplace warnings in lastSync", async (home) => {
  // invariants: config safety and ownership — the user's keys and their own
  // command predate every ocm run and must survive the sync
  writeTree(cfg(home), {
    "opencode.json": json({ model: "claude-sonnet-4-6" }),
    commands: { "mine.md": "# my own command\n" },
  })
  addCycleAndClean(home)
  const configBytes = readFileSync(join(cfg(home), "opencode.json"), "utf8")
  const synced = loaderSync(home)
  if (synced.status !== 0) throw new Error(`the startup sync exited ${synced.status}: ${synced.stderr}`)
  const marketplaces = readRegistry(home).marketplaces
  const stored = marketplaces.mp.lastSync?.warnings
  if (!Array.isArray(stored) || !stored.includes(CYCLE_WARNING)) {
    throw new Error(`marketplaces.mp.lastSync.warnings must contain "${CYCLE_WARNING}" in ${registryFile(home)}; got ${JSON.stringify(stored)}`)
  }
  if ((marketplaces.other.lastSync?.warnings ?? []).length !== 0) {
    throw new Error(`marketplaces.other.lastSync.warnings must stay empty in ${registryFile(home)}; got ${JSON.stringify(marketplaces.other.lastSync?.warnings)}`)
  }
  // invariants: config safety, ownership
  expect(readFileSync(join(cfg(home), "opencode.json"), "utf8")).toBe(configBytes)
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
})

phase("list prints a marketplace's stored warnings on stderr, never stdout", async (home) => {
  addCycleAndClean(home)
  const synced = loaderSync(home)
  if (synced.status !== 0) throw new Error(`the startup sync exited ${synced.status}: ${synced.stderr}`)
  const listed = ocm(home, "list")
  if (listed.status !== 0) throw new Error(`ocm list exited ${listed.status}: ${listed.stderr}`)
  if (!listed.stderr.split("\n").includes(`  warning: ${CYCLE_WARNING}`)) {
    throw new Error(`list's stderr must carry "  warning: ${CYCLE_WARNING}" beneath mp's row; stderr:\n${listed.stderr}`)
  }
  if (!listed.stdout.split("\n").includes("mp")) {
    throw new Error(`list's stdout must still carry mp's row; stdout:\n${listed.stdout}`)
  }
  if (listed.stdout.includes(CYCLE_WARNING)) {
    throw new Error(`warnings are stderr, data is stdout — list's stdout must not carry "${CYCLE_WARNING}":\n${listed.stdout}`)
  }
})

phase("doctor reports each stored warning as an exit-code-neutral warning finding", async (home) => {
  addCycleAndClean(home)
  const synced = loaderSync(home)
  if (synced.status !== 0) throw new Error(`the startup sync exited ${synced.status}: ${synced.stderr}`)
  // doctor probes opencode, so it runs with the fake-opencode stub on PATH
  const diagnosed = spawnSync(process.execPath, [OCM_BIN, "doctor"], {
    env: withFakeOpencode({ ...process.env, HOME: home }), encoding: "utf8", timeout: 120_000,
  })
  if (diagnosed.status !== 0) {
    throw new Error(`ocm doctor must exit 0 — a warning finding never fails the run (exit ${diagnosed.status}):\n${diagnosed.stdout}\n${diagnosed.stderr}`)
  }
  const line = (diagnosed.stdout ?? "").split("\n").find((l) => /^\s*warning\b/.test(l) && l.includes(CYCLE_WARNING))
  if (!line) throw new Error(`doctor's stdout must carry a warning finding containing "${CYCLE_WARNING}":\n${diagnosed.stdout}`)
})

phase("ocm update leaves the same lastSync.warnings the startup sync stored", async (home) => {
  addCycleAndClean(home)
  const synced = loaderSync(home)
  if (synced.status !== 0) throw new Error(`the startup sync exited ${synced.status}: ${synced.stderr}`)
  const fromLoader = readRegistry(home).marketplaces.mp.lastSync?.warnings
  const updated = ocm(home, "update", "mp")
  if (updated.status !== 0) throw new Error(`ocm update mp exited ${updated.status}: ${updated.stderr}`)
  const fromCli = readRegistry(home).marketplaces.mp.lastSync?.warnings
  if (JSON.stringify(fromCli) !== JSON.stringify([CYCLE_WARNING])) {
    throw new Error(`ocm update must store marketplaces.mp.lastSync.warnings = ["${CYCLE_WARNING}"] in ${registryFile(home)}; got ${JSON.stringify(fromCli)}`)
  }
  expect(fromCli).toEqual(fromLoader) // the two paths leave the same record
})

phase("a later clean sync replaces the stored warnings", async (home) => {
  addCycleAndClean(home)
  const first = loaderSync(home, { OCM_SYNC_INTERVAL_MS: "0" })
  if (first.status !== 0) throw new Error(`the startup sync exited ${first.status}: ${first.stderr}`)
  if (!readRegistry(home).marketplaces.mp.lastSync?.warnings?.includes(CYCLE_WARNING)) {
    throw new Error(`marketplaces.mp.lastSync.warnings must contain "${CYCLE_WARNING}" in ${registryFile(home)} after the first sync`)
  }
  writeFileSync(join(home, "mp", "marketplace.json"), json({})) // the cycle is gone
  const second = loaderSync(home, { OCM_SYNC_INTERVAL_MS: "0" })
  if (second.status !== 0) throw new Error(`the second startup sync exited ${second.status}: ${second.stderr}`)
  const stored = readRegistry(home).marketplaces.mp.lastSync?.warnings ?? []
  if (stored.length !== 0) {
    throw new Error(`a clean sync must replace the stored warnings in ${registryFile(home)}; still present: ${JSON.stringify(stored)}`)
  }
})
