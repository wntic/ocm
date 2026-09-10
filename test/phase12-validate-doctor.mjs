// Phase 12 — docs/specs/12-validate-doctor.md: one test per numbered item.
// `ocm validate` lints a marketplace repo for its author, `ocm doctor`
// diagnoses an installation for its consumer; both share one finding format.
// The four invariants: config safety in 3, 5 and 6, idempotence in 3,
// ownership in 3 and 6, no plugin-load errors in 3. The spec's collision
// example — two plugins both producing "a:x" — is unrealizable (a plugin
// name namespaces the command and cannot contain ":"), so the command-name
// clash fixture is the singular/plural directory pair inside one plugin,
// the clash discovery itself rejects (spec 06).
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, assertFileExists, opencodeProbe, withFakeHome } from "./harness.mjs"

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

function gitRepo(dir, tree) {
  writeTree(dir, tree)
  for (const args of [["init", "-b", "main"], ["add", "-A"], ["-c", "user.email=ocm@test", "-c", "user.name=ocm", "commit", "-m", "fixture"]]) {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" })
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${result.stderr}`)
  }
}

const cfg = (home) => join(home, ".config", "opencode")
const registryFile = (home) => join(cfg(home), "ocm", "registry.json")

// realpath on both sides: macOS temp dirs sit behind /var -> /private/var
function assertResolves(dest, source) {
  if (!existsSync(dest) || !lstatSync(dest).isSymbolicLink()) throw new Error(`expected a symlink at ${dest}`)
  expect(realpathSync(dest)).toBe(realpathSync(source))
}

// a finding line in the spec 12 format: "  error   plugins/foo/...: message"
function finding(output, severity, ...needles) {
  const line = output.split("\n").find((l) => new RegExp(`^\\s*${severity}\\b`).test(l) && needles.every((n) => l.includes(n)))
  if (!line) throw new Error(`expected a ${severity} finding containing ${JSON.stringify(needles)}:\n${output}`)
}

const COMMAND = "---\ndescription: commit helper\n---\n\nCommit body.\n"
const SKILL = (name, extra = "") => `---\nname: ${name}\ndescription: ${name} guidance\n${extra}---\n\n# ${name}\n\nBody.\n`
const JS_PLUGIN = 'export default { id: "adw-notify", server: async () => ({}) }\n'
const USER_PLUGIN = 'export default { id: "mine", server: async () => ({}) }\n'
const MCP = { db: { type: "local", command: ["npx", "-y", "@acme/db-mcp"], enabled: true } }
const json = (value) => `${JSON.stringify(value, null, 2)}\n`
const manifest = (plugins) => json({ name: "mp", plugins })
const LONG = "a".repeat(65)

// one fixture per error class in the spec's list: [label, tree, needles]
const ERROR_CASES = [
  ["plugin-json", { plugins: { bad: { "plugin.json": "{ not json\n", commands: { "work.md": COMMAND } } } }, ["plugin.json", "invalid JSON at position"]],
  ["marketplace-json", { "marketplace.json": "{ not json\n", plugins: { tool: { commands: { "work.md": COMMAND } } } }, ["marketplace.json", "invalid JSON"]],
  ["plugin-schema", { plugins: { bad: { "plugin.json": json({ tags: "nope" }), commands: { "work.md": COMMAND } } } }, ["plugin.json", "tags"]],
  ["marketplace-schema", { "marketplace.json": json({ plugins: "nope" }), plugins: { tool: { commands: { "work.md": COMMAND } } } }, ["marketplace.json", "plugins"]],
  ["dir-name", { plugins: { bad_name: { commands: { "work.md": COMMAND } } } }, ["bad_name"]],
  ["dir-length", { plugins: { [LONG]: { commands: { "work.md": COMMAND } } } }, [LONG]],
  ["name-mismatch", { plugins: { mismatch: { "plugin.json": json({ name: "other" }), commands: { "work.md": COMMAND } } } }, ["mismatch", "other"]],
  ["skill-no-frontmatter", { plugins: { nofm: { skills: { one: { "SKILL.md": "# No frontmatter\n\nBody.\n" } } } } }, ["nofm", "SKILL.md"]],
  ["skill-no-name", { plugins: { noname: { skills: { one: { "SKILL.md": "---\ndescription: guidance\n---\n\nBody.\n" } } } } }, ["SKILL.md", 'frontmatter has no "name"']],
  ["skill-no-description", { plugins: { nodesc: { skills: { one: { "SKILL.md": "---\nname: one\n---\n\nBody.\n" } } } } }, ["SKILL.md", "description"]],
  ["skill-long-description", { plugins: { longdesc: { skills: { one: { "SKILL.md": `---\nname: one\ndescription: ${"d".repeat(1025)}\n---\n\nBody.\n` } } } } }, ["SKILL.md", "description"]],
  ["skill-collision", { plugins: { dup: { skills: { one: { "SKILL.md": SKILL("same") }, two: { "SKILL.md": SKILL("same") } } } } }, ["one", "two", "same"]],
  ["command-collision", { plugins: { clash: { commands: { "x.md": COMMAND }, command: { "x.md": COMMAND } } } }, ["clash", "x.md"]],
  ["empty-body", { plugins: { empty: { commands: { "empty.md": "---\ndescription: nothing follows\n---\n" } } } }, ["empty.md"]],
  ["wrong-export", { plugins: { badexp: { plugin: { "setup.js": 'export default { id: "x", setup: async () => ({}) }\n' }, commands: { "work.md": COMMAND } } } }, ["setup.js"]],
  ["tui-export", { plugins: { tuiexp: { plugin: { "ui.js": 'export default { id: "x", tui: async () => ({}) }\n' }, commands: { "work.md": COMMAND } } } }, ["ui.js", "tui"]],
  ["mcp-not-object", { plugins: { badmcp: { "mcp.json": "[]\n", commands: { "work.md": COMMAND } } } }, ["mcp.json"]],
  ["mcp-missing-type", { plugins: { notype: { "mcp.json": json({ db: { command: ["echo"] } }), commands: { "work.md": COMMAND } } } }, ["mcp.json", "db"]],
  ["source-unresolved", { "marketplace.json": manifest([{ name: "ghost", source: "./plugins/ghost" }]), plugins: { tool: { commands: { "work.md": COMMAND } } } }, ["ghost"]],
  ["source-escapes", { "marketplace.json": manifest([{ name: "outside", source: "../outside" }]), plugins: { tool: { commands: { "work.md": COMMAND } } } }, ["../outside"]],
]

// one fixture per warning class: { label, tree, warnings, absent? }
const WARNING_CASES = [
  { label: "non-portable-frontmatter", tree: { plugins: { adw: { skills: { style: { "SKILL.md": SKILL("style", "allowed-tools: Bash\n") } } } } }, warnings: [["SKILL.md", 'non-portable frontmatter "allowed-tools"']] },
  { label: "plugin-root-ref", tree: { plugins: { adw: { commands: {
    "bad.md": '---\ndescription: bad reference\n---\n\npython3 "${CLAUDE_PLUGIN_ROOT}/scripts/run_report.py"\n',
    "good.md": '---\ndescription: good reference\n---\n\npython3 "${CLAUDE_PLUGIN_ROOT}/plugins/adw/scripts/run_report.py"\n',
  } } } }, warnings: [["bad.md", "CLAUDE_PLUGIN_ROOT"]], absent: [["good.md"]] },
  { label: "version-disagrees", tree: { "marketplace.json": manifest([{ name: "baz", source: "./plugins/baz", version: "1.0.0" }]), plugins: { baz: { "plugin.json": json({ version: "1.1.0" }), commands: { "work.md": COMMAND } } } }, warnings: [["version disagrees", "1.0.0", "1.1.0"]] },
  { label: "command-no-frontmatter", tree: { plugins: { adw: { commands: { "plain.md": "# Just markdown\n" } } } }, warnings: [["plain.md"]] },
  { label: "typo-dirs", tree: { plugins: { typodirs: { skills: { one: { "SKILL.md": SKILL("one") } }, skill: { two: { "SKILL.md": SKILL("two") } } } } }, warnings: [["typodirs", "skill"]] },
  { label: "typo-files", tree: { plugins: { typos: { commands: { "work.md": COMMAND }, "plugin.ts": "// typo\n", "SKILLS.md": "# typo\n", "Skill.md": "# typo\n" } } }, warnings: [["plugin.ts"], ["SKILLS.md"], ["Skill.md"]] },
  { label: "shell-substitution", tree: { plugins: { adw: { commands: { "shell.md": "---\ndescription: shell out\n---\n\nRun `!git status --porcelain` first.\n" } } } }, warnings: [["shell.md"]] },
]

phase("1. one fixture per error class and per warning class, asserting the exact finding line and the exit code; a clean marketplace exits 0 with only the header", async (home) => {
  for (const [label, tree, needles] of ERROR_CASES) {
    const dir = join(home, label)
    writeTree(dir, tree)
    const result = ocm(home, "validate", dir)
    const output = `${result.stdout}\n${result.stderr}`
    if (result.status !== 1) throw new Error(`validate ${label} exited ${result.status}, expected 1:\n${output}`)
    finding(output, "error", ...needles)
  }
  // not fail-fast: every finding is reported, with a summary line
  const both = join(home, "err-both")
  writeTree(both, { plugins: {
    noname: { skills: { one: { "SKILL.md": "---\ndescription: guidance\n---\n\nBody.\n" } } },
    nodesc: { skills: { one: { "SKILL.md": "---\nname: one\n---\n\nBody.\n" } } },
  } })
  const bothResult = ocm(home, "validate", both)
  const bothOutput = `${bothResult.stdout}\n${bothResult.stderr}`
  if (bothResult.status !== 1) throw new Error(`validate err-both exited ${bothResult.status}, expected 1:\n${bothOutput}`)
  finding(bothOutput, "error", "noname", 'frontmatter has no "name"')
  finding(bothOutput, "error", "nodesc", "description")
  expect(bothOutput).toMatch(/^\d+ errors?, \d+ warnings?$/m)
  for (const { label, tree, warnings, absent } of WARNING_CASES) {
    const dir = join(home, label)
    writeTree(dir, tree)
    const result = ocm(home, "validate", dir)
    const output = `${result.stdout}\n${result.stderr}`
    if (result.status !== 0) throw new Error(`validate ${label} exited ${result.status}, expected 0:\n${output}`)
    for (const needles of warnings) finding(output, "warning", ...needles)
    for (const needles of absent ?? []) {
      if (output.split("\n").some((l) => /^\s*(error|warning)\b/.test(l) && needles.every((n) => l.includes(n)))) {
        throw new Error(`validate ${label}: expected no finding matching ${JSON.stringify(needles)}:\n${output}`)
      }
    }
  }
  // a marketplace name colliding with one already added on this machine
  writeTree(join(home, "taken"), { plugins: { a: { commands: { "x.md": COMMAND } } } })
  expect(ocm(home, "add", join(home, "taken")).status).toBe(0)
  const collide = join(home, "name-collide")
  writeTree(collide, { "marketplace.json": json({ name: "taken", plugins: [{ name: "tool", source: "./plugins/tool" }] }), plugins: { tool: { commands: { "work.md": COMMAND } } } })
  const colliding = ocm(home, "validate", collide)
  const collideOutput = `${colliding.stdout}\n${colliding.stderr}`
  if (colliding.status !== 0) throw new Error(`validate name-collide exited ${colliding.status}, expected 0:\n${collideOutput}`)
  finding(collideOutput, "warning", "taken")
  // clean: exit 0, the header and nothing else
  const clean = join(home, "clean")
  writeTree(clean, { plugins: { tool: { commands: { "work.md": COMMAND }, skills: { one: { "SKILL.md": SKILL("one") } } } } })
  const ok = ocm(home, "validate", clean)
  if (ok.status !== 0) throw new Error(`validate clean exited ${ok.status}, expected 0:\n${ok.stdout}\n${ok.stderr}`)
  const header = `${ok.stdout}\n${ok.stderr}`.trim()
  if (header !== `validate ${clean}` && header !== `validate ${realpathSync(clean)}`) {
    throw new Error(`expected only the header "validate ${clean}", got:\n${header}`)
  }
}, 240_000)

phase("2. validate rejects YAML that opencode's sanitizer would have rescued", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { adw: { commands: {
    "loose.md": "---\ndescription: do it: now\n---\n\nBody.\n",
    "quoted.md": "---\ndescription: \"do it: now\"\n---\n\nBody.\n",
  } } } })
  const result = ocm(home, "validate", mp)
  const output = `${result.stdout}\n${result.stderr}`
  if (result.status !== 1) throw new Error(`validate mp exited ${result.status}, expected 1:\n${output}`)
  finding(output, "error", "loose.md")
  if (output.split("\n").some((l) => /^\s*(error|warning)\b/.test(l) && l.includes("quoted.md"))) {
    throw new Error(`the quoted form parses strictly and must not be flagged:\n${output}`)
  }
})

phase("3. doctor detects a stale core by version comment, a stray ocm file in plugins/, a broken symlink, an orphaned skills.paths entry and an orphaned MCP key; --fix repairs exactly those", async (home) => {
  // config safety + ownership: the user's keys and file predate every ocm write
  const userConfig = { model: "claude-sonnet-4-6", mcp: { "user-server": { type: "local", command: ["echo"] } } }
  writeTree(cfg(home), { "opencode.json": `${JSON.stringify(userConfig, null, 2)}\n`, plugins: { "my-own.js": USER_PLUGIN } })
  expect(ocm(home, "init").status).toBe(0)
  const coreFile = join(cfg(home), "ocm", "core.js")
  const fresh = readFileSync(coreFile, "utf8")
  writeFileSync(coreFile, fresh.replace(/^\/\/ ocm-version:.*$/m, "// ocm-version: 0.0.0 stale")) // a stale core silently no-ops
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { adw: {
    commands: { "commit.md": COMMAND },
    skills: { style: { "SKILL.md": SKILL("style") } },
    plugin: { "notify.js": JS_PLUGIN },
    "mcp.json": json(MCP),
  } } })
  expect(ocm(home, "add", mp, "--trust").status).toBe(0)
  // a stray ocm file no registry entry owns, and a broken symlink in commands/
  writeFileSync(join(cfg(home), "plugins", "ocm--adw--gone.js"), '// left behind\nthrow new Error("stale")\n')
  symlinkSync(join(mp, "plugins", "adw", "commands", "stale.md"), join(cfg(home), "commands", "adw:stale.md"))
  // an orphaned ocm skills.paths entry, a user entry whose target is also gone, an orphaned MCP key
  const configPath = join(cfg(home), "opencode.json")
  const config = JSON.parse(readFileSync(configPath, "utf8"))
  const goneOcm = join(home, ".cache", "ocm", "links", "gone", "skills")
  const goneUser = join(home, "gone-user-skills")
  config.skills ??= { paths: [] }
  config.skills.paths.push(goneOcm, goneUser)
  config.mcp["ocm--ghost--db"] = { type: "local", command: ["echo"] }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

  const diagnosed = ocm(home, "doctor")
  const report = `${diagnosed.stdout}\n${diagnosed.stderr}`
  if (diagnosed.status !== 1) throw new Error(`ocm doctor exited ${diagnosed.status}, expected 1:\n${report}`)
  for (const needle of ["core.js", "ocm--adw--gone.js", "adw:stale.md", goneOcm, "ocm--ghost--db"]) {
    if (!report.includes(needle)) throw new Error(`ocm doctor report lacks "${needle}":\n${report}`)
  }

  const fixed = ocm(home, "doctor", "--fix")
  const fixReport = `${fixed.stdout}\n${fixed.stderr}`
  if (fixed.status !== 0) throw new Error(`ocm doctor --fix exited ${fixed.status}:\n${fixReport}`)
  expect(readFileSync(coreFile, "utf8")).toBe(fresh)
  assertAbsent(join(cfg(home), "plugins", "ocm--adw--gone.js"))
  assertFileExists(join(cfg(home), "plugins", "my-own.js")) // ownership: the user's file is never a stray
  assertFileExists(join(cfg(home), "plugins", "ocm-loader.js"))
  assertAbsent(join(cfg(home), "commands", "adw:stale.md"))
  assertResolves(join(cfg(home), "commands", "adw:commit.md"), join(mp, "plugins", "adw", "commands", "commit.md"))
  const after = JSON.parse(readFileSync(configPath, "utf8"))
  expect(after.skills.paths).not.toContain(goneOcm)
  expect(after.skills.paths).toContain(goneUser) // ownership: the user's orphaned entry stays
  expect(after.skills.paths).toHaveLength(config.skills.paths.length - 1) // exactly the orphan removed
  expect(after.mcp["ocm--ghost--db"]).toBeUndefined()
  expect(after.mcp["ocm--adw--db"]).toBeDefined() // the owned key survives the fix
  expect(after.mcp["user-server"]).toEqual(userConfig.mcp["user-server"])
  expect(after.model).toBe(userConfig.model)
  assertResolves(join(cfg(home), "plugins", "ocm--adw--notify.js"), join(mp, "plugins", "adw", "plugin", "notify.js"))
  expect(lstatSync(join(home, ".cache", "ocm", "links", "mp", "skills", "adw--style")).isDirectory()).toBe(true)

  // idempotence: a second --fix writes nothing
  const before = [coreFile, configPath, registryFile(home)].map((p) => readFileSync(p, "utf8"))
  const again = ocm(home, "doctor", "--fix")
  if (again.status !== 0) throw new Error(`second ocm doctor --fix exited ${again.status}:\n${again.stdout}\n${again.stderr}`)
  expect([coreFile, configPath, registryFile(home)].map((p) => readFileSync(p, "utf8"))).toEqual(before)

  // no plugin-load errors attributable to ocm files
  const probe = opencodeProbe(cfg(home), home)
  if (!probe.available) console.log("skipped: opencode is not on PATH")
  else {
    if (probe.unreliable) throw new Error("probe cannot trust itself: the canary broken plugin produced no error line")
    expect(probe.pluginErrors).toEqual([])
  }
}, 900_000)

phase("4. doctor reports a marketplace whose last sync failed, with the error", async (home) => {
  expect(ocm(home, "init").status).toBe(0)
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { tool: { commands: { "work.md": COMMAND } } } })
  expect(ocm(home, "add", `file://${remote}`, "--name", "mp").status).toBe(0)
  rmSync(remote, { recursive: true, force: true })
  expect(ocm(home, "update", "mp").status).not.toBe(0)
  const lastSync = JSON.parse(readFileSync(registryFile(home), "utf8")).marketplaces.mp.lastSync
  if (!lastSync || lastSync.ok !== false || !lastSync.error) {
    throw new Error(`expected lastSync.ok === false with an error for mp in ${registryFile(home)}, got ${JSON.stringify(lastSync)}`)
  }
  const result = ocm(home, "doctor")
  const output = `${result.stdout}\n${result.stderr}`
  if (result.status !== 1) throw new Error(`ocm doctor exited ${result.status}, expected 1:\n${output}`)
  expect(output).toContain("mp")
  const firstLine = lastSync.error.split("\n").map((l) => l.trim()).find(Boolean)
  if (!firstLine || !output.includes(firstLine)) {
    throw new Error(`ocm doctor report lacks the last-sync error "${firstLine}" for mp:\n${output}`)
  }
}, 420_000)

phase("5. an injected write failure leaves the original opencode.json byte-identical; an unparseable config is never rewritten", async (home) => {
  expect(ocm(home, "init").status).toBe(0)
  const configPath = join(cfg(home), "opencode.json")
  // a config that does not parse is warned about and never rewritten
  const garbage = "{ this is not json\n"
  writeFileSync(configPath, garbage)
  const warned = ocm(home, "doctor", "--fix")
  const warnOut = `${warned.stdout}\n${warned.stderr}`
  if (!warnOut.includes("opencode.json")) throw new Error(`expected the report to name opencode.json:\n${warnOut}`)
  expect(readFileSync(configPath, "utf8")).toBe(garbage)
  // a read-only config directory makes the atomic write fail mid-fix
  const userConfig = { model: "claude-sonnet-4-6", mcp: {
    "user-server": { type: "local", command: ["echo"] },
    "ocm--ghost--db": { type: "local", command: ["echo"] }, // orphaned: no marketplace owns it
  } }
  writeFileSync(configPath, `${JSON.stringify(userConfig, null, 2)}\n`)
  const bytes = readFileSync(configPath, "utf8")
  chmodSync(cfg(home), 0o555)
  try {
    const blocked = ocm(home, "doctor", "--fix")
    const blockOut = `${blocked.stdout}\n${blocked.stderr}`
    if (blocked.status === 0) throw new Error(`expected ocm doctor --fix to exit non-zero when the config write fails:\n${blockOut}`)
    if (!blockOut.includes("opencode.json")) throw new Error(`expected the failure report to name opencode.json:\n${blockOut}`)
    expect(readFileSync(configPath, "utf8")).toBe(bytes)
    expect(JSON.parse(readFileSync(configPath, "utf8")).mcp["ocm--ghost--db"]).toBeDefined()
  } finally {
    chmodSync(cfg(home), 0o755)
  }
}, 600_000)

phase("6. a full add → install → update → remove cycle creates nothing under ~/.claude or ~/.agents", async (home) => {
  const userConfig = { model: "claude-sonnet-4-6", permission: { edit: "allow" }, skills: { paths: ["/users/me/my-skills"] } }
  writeTree(cfg(home), { "opencode.json": `${JSON.stringify(userConfig, null, 2)}\n`, commands: { "mine.md": "# my own command\n" } })
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { adw: { commands: { "commit.md": COMMAND }, skills: { style: { "SKILL.md": SKILL("style") } } } } })
  expect(ocm(home, "add", `file://${remote}`, "--name", "mp", "--explicit").status).toBe(0)
  expect(ocm(home, "install", "adw").status).toBe(0)
  assertResolves(join(cfg(home), "commands", "adw:commit.md"), join(home, ".cache", "ocm", "marketplaces", "mp", "plugins", "adw", "commands", "commit.md"))
  expect(ocm(home, "update", "mp").status).toBe(0)
  expect(ocm(home, "remove", "mp").status).toBe(0)
  assertAbsent(join(cfg(home), "commands", "adw:commit.md"))
  // ownership: the user's command survives every operation including remove
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
  // config safety: ocm's entries are gone; the user's config is exactly itself
  expect(JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8"))).toEqual(userConfig)
  const forbidden = []
  const stack = [home]
  while (stack.length) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.name === ".claude" || entry.name === ".agents") forbidden.push(path)
      if (entry.isDirectory()) stack.push(path)
    }
  }
  if (forbidden.length) throw new Error(`expected nothing under ~/.claude or ~/.agents, found: ${forbidden.join(", ")}`)
})
