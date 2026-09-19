// Validate: linting a marketplace repository for its author.

import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, mkdtempSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, assertFileExists, withFakeHome } from "./harness.mjs"

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

function gitRepo(dir, tree) {
  writeTree(dir, tree)
  for (const args of [["init", "-b", "main"], ["add", "-A"], ["-c", "user.email=ocm@test", "-c", "user.name=ocm", "commit", "-m", "fixture"]]) {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" })
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${result.stderr}`)
  }
}

const cfg = (home) => join(home, ".config", "opencode")

const registryFile = (home) => join(cfg(home), "ocm", "registry.json")

const COMMAND = "---\ndescription: commit helper\n---\n\nCommit body.\n"

const SKILL = (name, extra = "") => `---\nname: ${name}\ndescription: ${name} guidance\n${extra}---\n\n# ${name}\n\nBody.\n`

const JS_PLUGIN = 'export default { id: "adw-notify", server: async () => ({}) }\n'

const USER_PLUGIN = 'export default { id: "mine", server: async () => ({}) }\n'

const MCP = { db: { type: "local", command: ["npx", "-y", "@acme/db-mcp"], enabled: true } }

const json = (value) => `${JSON.stringify(value, null, 2)}\n`

const manifest = (plugins) => json({ name: "mp", plugins })

const LONG = "a".repeat(65)

const README = fileURLToPath(new URL("../README.md", import.meta.url))

const readRegistry = (home) => JSON.parse(readFileSync(registryFile(home), "utf8"))

const commandLink = (home, plugin, file) => join(cfg(home), "commands", `${plugin}:${file}`)

function mcpKeys(home) {
  try {
    return JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8")).mcp ?? {}
  } catch {
    return {}
  }
}

// phase12-validate-doctor.mjs (validate half) — absorbed from test/phase12-validate-doctor.mjs
{
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

// spec 19: every valid plugin carries a plugin.json with a description; the
// ERROR_CASES below stay manifest-less on purpose — phase 19 owns that error
const PLUGIN_JSON = json({ description: "demo plugin" })

// the clean fixture must produce zero findings, so its manifest also pins the
// $schema the warning asks for
const CLEAN_PLUGIN_JSON = json({ description: "demo plugin", $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" })

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
  { label: "non-portable-frontmatter", tree: { plugins: { adw: { "plugin.json": PLUGIN_JSON, skills: { style: { "SKILL.md": SKILL("style", "allowed-tools: Bash\n") } } } } }, warnings: [["SKILL.md", 'non-portable frontmatter "allowed-tools"']] },
  { label: "plugin-root-ref", tree: { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: {
    "bad.md": '---\ndescription: bad reference\n---\n\npython3 "${CLAUDE_PLUGIN_ROOT}/scripts/run_report.py"\n',
    "good.md": '---\ndescription: good reference\n---\n\npython3 "${CLAUDE_PLUGIN_ROOT}/plugins/adw/scripts/run_report.py"\n',
  } } } }, warnings: [["bad.md", "CLAUDE_PLUGIN_ROOT"]], absent: [["good.md"]] },
  { label: "version-disagrees", tree: { "marketplace.json": manifest([{ name: "baz", source: "./plugins/baz", version: "1.0.0" }]), plugins: { baz: { "plugin.json": json({ version: "1.1.0", description: "demo plugin" }), commands: { "work.md": COMMAND } } } }, warnings: [["version disagrees", "1.0.0", "1.1.0"]] },
  { label: "command-no-frontmatter", tree: { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "plain.md": "# Just markdown\n" } } } }, warnings: [["plain.md"]] },
  { label: "typo-dirs", tree: { plugins: { typodirs: { "plugin.json": PLUGIN_JSON, skills: { one: { "SKILL.md": SKILL("one") } }, skill: { two: { "SKILL.md": SKILL("two") } } } } }, warnings: [["typodirs", "skill"]] },
  { label: "typo-files", tree: { plugins: { typos: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND }, "plugin.ts": "// typo\n", "SKILLS.md": "# typo\n", "Skill.md": "# typo\n" } } }, warnings: [["plugin.ts"], ["SKILLS.md"], ["Skill.md"]] },
  { label: "shell-substitution", tree: { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "shell.md": "---\ndescription: shell out\n---\n\nRun `!git status --porcelain` first.\n" } } } }, warnings: [["shell.md"]] },
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
  writeTree(join(home, "taken"), { plugins: { a: { "plugin.json": PLUGIN_JSON, commands: { "x.md": COMMAND } } } })
  expect(ocm(home, "add", join(home, "taken")).status).toBe(0)
  const collide = join(home, "name-collide")
  writeTree(collide, { "marketplace.json": json({ name: "taken", plugins: [{ name: "tool", source: "./plugins/tool" }] }), plugins: { tool: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } } } })
  const colliding = ocm(home, "validate", collide)
  const collideOutput = `${colliding.stdout}\n${colliding.stderr}`
  if (colliding.status !== 0) throw new Error(`validate name-collide exited ${colliding.status}, expected 0:\n${collideOutput}`)
  finding(collideOutput, "warning", "taken")
  // clean: exit 0, the header and nothing else
  const clean = join(home, "clean")
  writeTree(clean, { plugins: { tool: { "plugin.json": CLEAN_PLUGIN_JSON, commands: { "work.md": COMMAND }, skills: { one: { "SKILL.md": SKILL("one") } } } } })
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
}

// validate hardening: refuse to run nowhere, name the broken rule — absorbed from test/phase24-validate-hardening.mjs
{
function ocm(home, args, options = {}) {
  const result = spawnSync(process.execPath, [OCM_BIN, ...args], {
    env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 120_000, cwd: options.cwd,
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

// a spec 12 finding line: "  warning plugins/foo/...: message"
function finding(output, severity, ...needles) {
  const line = output.split("\n").find((l) => new RegExp(`^\\s*${severity}\\b`).test(l) && needles.every((n) => l.includes(n)))
  if (!line) throw new Error(`expected a ${severity} finding containing ${JSON.stringify(needles)}:\n${output}`)
  return line
}

// frontmatter but no body: the planted error-class defect for item 2
const EMPTY_BODY = "---\ndescription: does nothing\n---\n\n"

// spec 19: every installable plugin carries a plugin.json with a description
const PLUGIN_JSON = json({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", description: "demo plugin" })

phase("1. validate in a non-marketplace directory errors with the spec's two lines and nothing else", async (home) => {
  const empty = mkdtempSync(join(home, "nowhere-"))
  const expected = [
    "error: not an ocm marketplace directory (no plugins/ and no manifest found)",
    "  run ocm validate at the marketplace repository root",
  ]
  // both forms must refuse: the no-path form (cd <empty> && ocm validate) and the path argument
  for (const [label, result] of [["ocm validate (cwd)", ocm(home, ["validate"], { cwd: empty })], ["ocm validate <dir>", ocm(home, ["validate", empty])]]) {
    if (result.status !== 1) {
      throw new Error(`${label} in a non-marketplace directory exited ${result.status}, expected 1:\n${result.stdout}\n${result.stderr}`)
    }
    for (const line of expected) {
      if (!result.stderr.includes(line)) {
        throw new Error(`${label} must print the spec's error line "${line}" to stderr:\n${result.stderr}`)
      }
    }
    // nothing else: no header, no findings, no summary
    if (result.stderr.trim() !== expected.join("\n")) {
      throw new Error(`${label} must print only the spec's two error lines, got:\n${result.stderr}`)
    }
    if (result.stdout.trim() !== "") {
      throw new Error(`${label} must print nothing to stdout, got:\n${result.stdout}`)
    }
  }
})

phase("2. validate in a plugin subdirectory validates the marketplace root, with a pointer line", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, {
    ".opencode-plugin": { "marketplace.json": json({ plugins: [{ name: "alpha", source: "./plugins/alpha" }] }) },
    plugins: { alpha: { "plugin.json": PLUGIN_JSON, commands: { "empty.md": EMPTY_BODY } } },
  })
  const result = ocm(home, ["validate"], { cwd: join(mp, "plugins", "alpha") })
  const output = `${result.stdout}\n${result.stderr}`
  if (result.status !== 1) {
    throw new Error(`validate in a plugin subdirectory exited ${result.status}, expected 1 (the planted empty-body defect is an error):\n${output}`)
  }
  // the pointer line names the marketplace root, on its own line (spec edge
  // table; realpath because macOS temp dirs sit behind /var -> /private/var)
  const lines = output.split("\n")
  if (!lines.includes(`validating ${mp}`) && !lines.includes(`validating ${realpathSync(mp)}`)) {
    throw new Error(`expected a pointer line "validating ${mp}" on its own line:\n${output}`)
  }
  // the normal finding, with paths relative to the marketplace root as when validating the root directly
  finding(output, "error", "plugins/alpha/commands/empty.md", "empty body")
  // a plugin subdirectory is inside a marketplace — the §1 refusal must not fire
  if (output.includes("not an ocm marketplace directory")) {
    throw new Error(`a plugin subdirectory is inside a marketplace — the nowhere-to-run error must not appear:\n${output}`)
  }
})

phase("3. mcpServers escaping the plugin is refused naming the containment rule, not a JSON error", async (home) => {
  // the user's config and files predate every ocm write (invariants: config safety, ownership)
  const userConfig = {
    model: "claude-sonnet-4-6",
    permission: { edit: "allow" },
    autoupdate: true,
    skills: { paths: ["/users/me/my-skills"], urls: ["https://example.com/skill"] },
    mcp: { "user-server": { type: "local", command: ["echo"] } },
  }
  writeTree(cfg(home), { "opencode.json": json(userConfig), commands: { "mine.md": "# my own command\n" } })
  const mp = join(home, "mp")
  writeTree(mp, {
    "marketplace.json": json({ plugins: [{ name: "p1", source: "./plugins/p1", mcpServers: "../other/mcp.json" }] }),
    plugins: {
      p1: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } },
      // the escape target exists: a careless plugin-relative resolution would serve it
      other: { "plugin.json": PLUGIN_JSON, "mcp.json": json(MCP) },
    },
  })
  const added = ocm(home, ["add", mp, "--trust"])
  if (added.status !== 0) throw new Error(`ocm add ${mp} exited ${added.status}: ${added.stderr}`)
  const output = `${added.stdout}\n${added.stderr}`
  // the refusal names the path and the containment rule that rejected it (spec §2 bullet 1)
  const line = output.split("\n").find((l) => l.includes("../other/mcp.json"))
  if (!line) throw new Error(`expected the refusal to name the mcpServers path ../other/mcp.json:\n${output}`)
  if (!line.includes("must resolve inside the plugin directory")) {
    throw new Error(`the refusal must name the containment rule ("must resolve inside the plugin directory"):\n${line}`)
  }
  // the wrong reason appears nowhere: the escape target exists, the containment rule rejected it
  if (output.includes("not a JSON object")) {
    throw new Error(`"not a JSON object" must not appear — the file exists, the containment rule rejected it:\n${output}`)
  }
  // the refusal itself is unchanged: no mcp servers materialize for p1
  expect(readRegistry(home).marketplaces.mp.plugins.p1.components.mcp).toBeUndefined()
  expect(Object.keys(mcpKeys(home)).filter((key) => key.startsWith("ocm--p1--"))).toEqual([])
  // invariant: config safety — only ocm-owned keys were added
  const configPath = join(cfg(home), "opencode.json")
  const minusOwned = () => {
    const copy = JSON.parse(readFileSync(configPath, "utf8"))
    for (const key of Object.keys(copy.mcp ?? {})) if (key.startsWith("ocm--")) delete copy.mcp[key]
    return copy
  }
  expect(minusOwned()).toEqual(userConfig)
  // invariant: idempotence — an update of an unchanged marketplace writes nothing
  const configBytes = readFileSync(configPath, "utf8")
  const pluginsBefore = readRegistry(home).marketplaces.mp.plugins
  const ino = lstatSync(commandLink(home, "p1", "commit.md")).ino
  const updated = ocm(home, ["update", "mp"])
  if (updated.status !== 0) throw new Error(`ocm update mp exited ${updated.status}: ${updated.stderr}`)
  expect(readFileSync(configPath, "utf8")).toBe(configBytes)
  expect(readRegistry(home).marketplaces.mp.plugins).toEqual(pluginsBefore)
  expect(lstatSync(commandLink(home, "p1", "commit.md")).ino).toBe(ino)
  // invariant: no plugin-load errors attributable to ocm-installed files
  // invariant: ownership — the user's command and config survive remove
  expect(ocm(home, ["remove", "mp"]).status).toBe(0)
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
  // the probe's opencode load adds "$schema" to the config; that key is
  // opencode's, not ocm's, so the comparison tolerates exactly it
  const afterRemove = JSON.parse(readFileSync(configPath, "utf8"))
  if (afterRemove.$schema === "https://opencode.ai/config.json") delete afterRemove.$schema
  expect(afterRemove).toEqual(userConfig)
}, 600_000)

phase("4. malformed plugin.json gets the fix-or-remove error; malformed marketplace.json the not-applied warning", async (home) => {
  // (a) malformed plugin.json: reported, not routed around — the plugin still installs
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { p1: { "plugin.json": "{ not json\n", commands: { "commit.md": COMMAND } } } })
  const added = ocm(home, ["add", mp])
  if (added.status !== 0) {
    throw new Error(`ocm add ${mp} exited ${added.status} — a malformed plugin.json is reported, not routed around:\n${added.stdout}\n${added.stderr}`)
  }
  const addOutput = `${added.stdout}\n${added.stderr}`
  const warningLine = addOutput.split("\n").find((l) => l.includes("warning") && l.includes("plugin.json"))
  if (!warningLine) throw new Error(`expected a warning naming the malformed plugins/p1/plugin.json:\n${addOutput}`)
  for (const fragment of ["not valid JSON", "fix it or remove it", "requires this file to be readable"]) {
    if (!warningLine.includes(fragment)) {
      throw new Error(`the plugin.json warning must contain "${fragment}" (spec 24 §2):\n${warningLine}`)
    }
  }
  if (!warningLine.includes("plugins/p1/plugin.json")) {
    throw new Error(`the plugin.json warning must name the file plugins/p1/plugin.json:\n${warningLine}`)
  }
  // validate reports it as an error naming fix-or-remove
  const validated = ocm(home, ["validate", mp])
  const validateOutput = `${validated.stdout}\n${validated.stderr}`
  if (validated.status !== 1) throw new Error(`validate ${mp} exited ${validated.status}, expected 1:\n${validateOutput}`)
  finding(validateOutput, "error", "plugin.json", "fix it or remove it")

  // (b) malformed .opencode-plugin/marketplace.json: the skip-with-warning shape,
  // amended so "ignored" is never read as "fine"; the manifest is still optional
  const mp2 = join(home, "mp2")
  writeTree(mp2, {
    ".opencode-plugin": { "marketplace.json": "{ not json\n" },
    "marketplace.json": json({ name: "rootname", plugins: [{ name: "adw", source: "./plugins/adw", description: "from the root", version: "1.0.0" }] }),
    plugins: { adw: { "plugin.json": json({ description: "self-described" }), commands: { "commit.md": COMMAND } } },
  })
  const added2 = ocm(home, ["add", mp2])
  if (added2.status !== 0) {
    throw new Error(`ocm add ${mp2} exited ${added2.status} — a broken marketplace manifest is a warning, the plugins still install:\n${added2.stdout}\n${added2.stderr}`)
  }
  const addOutput2 = `${added2.stdout}\n${added2.stderr}`
  const skipLine = addOutput2.split("\n").find((l) => l.includes("warning") && l.includes("marketplace.json"))
  if (!skipLine) throw new Error(`expected a warning naming the malformed .opencode-plugin/marketplace.json:\n${addOutput2}`)
  for (const fragment of ["not a valid JSON object", "entries below were not applied"]) {
    if (!skipLine.includes(fragment)) {
      throw new Error(`the marketplace.json warning must contain "${fragment}" (spec 24 §2):\n${skipLine}`)
    }
  }
  // validate keeps reporting it as an error (exit 1, as today)
  const validated2 = ocm(home, ["validate", mp2])
  const validateOutput2 = `${validated2.stdout}\n${validated2.stderr}`
  if (validated2.status !== 1) throw new Error(`validate ${mp2} exited ${validated2.status}, expected 1:\n${validateOutput2}`)
  finding(validateOutput2, "error", "marketplace.json", "invalid JSON")
})

phase("5. a marketplace with plugins/ but zero plugins stays valid: zero findings, exit 0", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: {} })
  const result = ocm(home, ["validate", mp])
  const output = `${result.stdout}\n${result.stderr}`
  if (result.status !== 0) throw new Error(`ocm validate ${mp} exited ${result.status} — an empty marketplace is legal:\n${output}`)
  const header = output.trim()
  if (header !== `validate ${mp}` && header !== `validate ${realpathSync(mp)}`) {
    throw new Error(`expected only the header "validate ${mp}", got:\n${header}`)
  }
})

phase("6. the README states every rule validate enforces (the documented contract)", async () => {
  const readme = readFileSync(README, "utf8")
  // One needle per rule `ocm validate` enforces, derived from the error and
  // warning strings in src/commands/validate.ts, src/commands/validate-files.ts
  // and src/manifest-lint.ts (the cross-tool warnings live in loader/lint.js,
  // reached through validate). Fragments are prose-compatible — the invariant
  // is "the rule is stated in the README", never "the error string is quoted".
  const needles = [
    // error-severity rules
    ["kebab-case", "plugin directory name charset (validate.ts: \"rename to kebab-case\")"],
    ["64 characters", "plugin name length limit (validate.ts)"],
    ["must equal the directory name", "plugin.json name vs directory name (manifest-lint.ts)"],
    ["plugin.json is required", "a plugin without plugin.json (manifest-lint.ts, spec 19)"],
    ["200 characters", "plugin.json description length cap (manifest-lint.ts)"],
    ["$schema", "$schema pin (manifest-lint.ts)"],
    ["./-relative", "plugins[] source base (manifest-lint.ts)"],
    ["escapes the marketplace", "source ../ rejection (manifest-lint.ts)"],
    ["does not resolve", "source pointing nowhere (manifest-lint.ts)"],
    ["listed twice", "duplicate plugins[] entry (manifest-lint.ts)"],
    ["same command or agent", "cross-plugin component collision (validate.ts)"],
    ["both produce", "namespaced skill collision (validate-files.ts)"],
    ["empty body", "command/agent .md template requirement (validate-files.ts)"],
    ["frontmatter has no", "SKILL.md name/description required (validate-files.ts)"],
    ["1-1024", "skill description length (validate-files.ts)"],
    ['missing "type"', "mcp.json entry shape (manifest-lint.ts)"],
    ["{ id, server }", "plugin js export shape (validate-files.ts)"],
    ["strict YAML", "unquoted \": \" rejection (validate-files.ts)"],
    ["singular and plural", "component dir clash (validate.ts, dirClashes)"],
    ["inside the plugin directory", "mcpServers containment (spec 24 §2)"],
    ["fix it or remove it", "malformed plugin.json error (spec 24 §2)"],
    // warning-class authoring rules
    ["portable subset", "non-portable skill frontmatter (loader/lint.js via validate)"],
    ["typo", "likely-typo files and dir pairs (validate.ts)"],
    ["version disagrees", "manifest version disagreement (validate.ts)"],
    ["dev.wntic.ocm", "top-level category/tags move (manifest-lint.ts)"],
    // the two subsections spec 24 §3 adds
    ["description is required", "command frontmatter: description required"],
    ["allowed-tools", "command frontmatter: recognized field"],
    ["extension", "command frontmatter: recognized field"],
    ["model", "command frontmatter: recognized field"],
    ["category", "extensions category/tags subsection"],
    ["tags", "extensions category/tags subsection"],
    ["search", "what category/tags surface in"],
    ["TUI", "what category/tags surface in"],
    // the rule of thumb itself
    ["documented contract", "the rule-of-thumb sentence (spec 24 §3)"],
  ]
  const missing = needles.filter(([needle]) => !readme.includes(needle))
  if (missing.length) {
    throw new Error(
      `README.md does not state these validate rules — spec 24 §3: validate enforces the documented contract, nothing else:\n` +
        missing.map(([needle, rule]) => `  "${needle}" — ${rule}`).join("\n"),
    )
  }
})
}
