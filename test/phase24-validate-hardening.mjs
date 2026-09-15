// Phase 24 — docs/specs/24-validate-hardening.md: one test per numbered item.
// Validate refuses to run nowhere instead of blessing the wrong directory
// (§1), error messages name the rule that was broken rather than a wrong
// reason (§2), and the README states every rule validate enforces (§3). The
// four invariants ride item 3, the one test that performs a real add: config
// safety and ownership around that add and the remove after it, idempotence
// across an update of an unchanged marketplace, no plugin-load errors via the
// probe. Item 5 is a regression guard — an empty plugins/ dir is valid today
// and must stay that way.
import { spawnSync } from "node:child_process"
import { lstatSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { opencodeProbe, withFakeHome } from "./harness.mjs"

const OCM_BIN = fileURLToPath(new URL("../bin/ocm.ts", import.meta.url))
const README = fileURLToPath(new URL("../README.md", import.meta.url))

function ocm(home, args, options = {}) {
  const result = spawnSync(process.execPath, [OCM_BIN, ...args], {
    env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 120_000, cwd: options.cwd,
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
const commandLink = (home, plugin, file) => join(cfg(home), "commands", `${plugin}:${file}`)
const json = (value) => `${JSON.stringify(value, null, 2)}\n`
function mcpKeys(home) {
  try {
    return JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8")).mcp ?? {}
  } catch {
    return {}
  }
}

// a spec 12 finding line: "  warning plugins/foo/...: message"
function finding(output, severity, ...needles) {
  const line = output.split("\n").find((l) => new RegExp(`^\\s*${severity}\\b`).test(l) && needles.every((n) => l.includes(n)))
  if (!line) throw new Error(`expected a ${severity} finding containing ${JSON.stringify(needles)}:\n${output}`)
  return line
}

const COMMAND = "---\ndescription: commit helper\n---\n\nCommit body.\n"
// frontmatter but no body: the planted error-class defect for item 2
const EMPTY_BODY = "---\ndescription: does nothing\n---\n\n"
const MCP = { db: { type: "local", command: ["npx", "-y", "@acme/db-mcp"], enabled: true } }
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
  const probe = opencodeProbe(cfg(home), home)
  if (!probe.available) console.log("skipped: opencode is not on PATH")
  else {
    if (probe.unreliable) throw new Error("probe cannot trust itself: the canary broken plugin produced no error line")
    expect(probe.pluginErrors).toEqual([])
  }
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
