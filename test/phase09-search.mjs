// Phase 09 — docs/specs/09-search.md: one test per numbered item, plus the
// four invariants (no plugin errors in 3; config safety, idempotence and
// ownership in 6 — search and info are read-only, so everything the user
// had must be byte-identical after them). Both commands answer from the
// registry's cached manifest; test 6 proves it by deleting the marketplace
// directory. Fixtures carry no `keywords`: spec 09 lists them as a match
// surface, but the spec 06 registry cache has no keywords field yet.
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, opencodeProbe, withFakeHome } from "./harness.mjs"

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
function editRegistry(home, edit) {
  const registry = readRegistry(home)
  edit(registry)
  writeFileSync(registryFile(home), `${JSON.stringify(registry, null, 2)}\n`)
}
const manifest = (plugins) => `${JSON.stringify({ plugins }, null, 2)}\n`

function addNamed(home, name, tree, ...flags) {
  const dir = join(home, name)
  writeTree(dir, tree)
  const result = ocm(home, "add", dir, ...flags)
  if (result.status !== 0) throw new Error(`ocm add ${name} exited ${result.status}: ${result.stderr}`)
  return dir
}

// a plugin's result line: result lines lead with plugin@marketplace (the
// spec's example output), so "review" must not match "reviewer",
// "code-review", a description mentioning review, or a summary header
function findResult(output, plugin) {
  const re = new RegExp(`^\\s*${plugin}(@|\\s|$)`)
  const lines = output.split("\n")
  const index = lines.findIndex((line) => re.test(line))
  if (index === -1) throw new Error(`expected a result line for "${plugin}" in:\n${output}`)
  return { index, line: lines[index] }
}

function assertNoResult(output, plugin) {
  const re = new RegExp(`^\\s*${plugin}(@|\\s|$)`)
  if (output.split("\n").some((line) => re.test(line))) {
    throw new Error(`expected no result line for "${plugin}" in:\n${output}`)
  }
}

const COMMAND = "---\ndescription: commit helper\n---\n\nCommit body.\n"
const AGENT = "---\ndescription: code reviewer\n---\n\nReviewer body.\n"
const SKILL = "---\nname: code-review\ndescription: code review checklist\n---\n\n# Code review\n\nUse the checklist.\n"
const JS_PLUGIN = 'export default { id: "phase09-notify", server: async () => ({}) }\n'

phase("1. ranking: name exact beats prefix beats substring beats tag beats description beats component name", async (home) => {
  addNamed(home, "mp", {
    "marketplace.json": manifest([
      { name: "quality-gate", source: "./plugins/quality-gate", tags: ["review"] },
      { name: "polish", source: "./plugins/polish", description: "polish and review your diffs" },
    ]),
    plugins: {
      review: { commands: { "work.md": COMMAND } }, // name exact
      reviewer: { commands: { "work.md": COMMAND } }, // name prefix
      "code-review": { commands: { "work.md": COMMAND } }, // name substring
      "quality-gate": { commands: { "work.md": COMMAND } }, // tag exact
      polish: { commands: { "work.md": COMMAND } }, // description substring
      adw: { commands: { "pr-review.md": COMMAND } }, // component name substring
    },
  })
  const result = ocm(home, "search", "review")
  if (result.status !== 0) throw new Error(`ocm search review exited ${result.status}: ${result.stderr}`)
  const output = result.stdout
  const ranked = ["review", "reviewer", "code-review", "quality-gate", "polish", "adw"]
  const indexes = ranked.map((plugin) => findResult(output, plugin).index)
  for (let i = 1; i < indexes.length; i++) {
    if (!(indexes[i - 1] < indexes[i])) {
      throw new Error(`expected "${ranked[i - 1]}" to rank above "${ranked[i]}" in:\n${output}`)
    }
  }
})

phase("2. a component-name match surfaces a plugin whose own name does not match, and the output says which component matched", async (home) => {
  addNamed(home, "mp", { plugins: { adw: { commands: { "commit.md": COMMAND } } } })
  const result = ocm(home, "search", "commit")
  if (result.status !== 0) throw new Error(`ocm search commit exited ${result.status}: ${result.stderr}`)
  const output = result.stdout
  findResult(output, "adw") // "adw" does not match "commit"; only its command does
  if (!/matched[^\n]*commit/.test(output)) {
    throw new Error(`expected a "matched: <component>" line naming commit in:\n${output}`)
  }
})

phase("3. disabled and blocked markers; --enabled-only drops the disabled plugin", async (home) => {
  addNamed(home, "mp-a", {
    "marketplace.json": manifest([{ name: "tool-old", source: "./plugins/tool-old", defaultEnabled: false }]),
    plugins: { "tool-old": { commands: { "work.md": COMMAND } } },
  })
  // no --trust and no TTY: the executable component is discovered, recorded
  // and blocked, never linked
  addNamed(home, "mp-b", {
    plugins: { "tool-new": { commands: { "work.md": COMMAND }, plugin: { "notify.js": JS_PLUGIN } } },
  })
  const result = ocm(home, "search", "tool")
  if (result.status !== 0) throw new Error(`ocm search tool exited ${result.status}: ${result.stderr}`)
  const output = result.stdout
  expect(findResult(output, "tool-old").line).toContain("disabled")
  expect(findResult(output, "tool-new").line).toContain("blocked")
  const enabled = ocm(home, "search", "tool", "--enabled-only")
  if (enabled.status !== 0) throw new Error(`ocm search tool --enabled-only exited ${enabled.status}: ${enabled.stderr}`)
  assertNoResult(enabled.stdout, "tool-old")
  // blocked is a trust state, not an enabled state: the plugin stays listed
  findResult(enabled.stdout, "tool-new")
  assertAbsent(join(cfg(home), "plugins", "ocm--tool-new--notify.js"))
  // invariant: no plugin-load errors attributable to ocm-installed files
  const probe = opencodeProbe(cfg(home), home)
  if (!probe.available) console.log("skipped: opencode is not on PATH")
  else {
    if (probe.unreliable) throw new Error("probe cannot trust itself: the canary broken plugin produced no error line")
    expect(probe.pluginErrors).toEqual([])
  }
}, 420_000) // opencode spawns with plugin files present: canary + error scan

phase("4. an empty result exits 1 with no matches for the query, and hints at ocm update only when a marketplace is stale or failed", async (home) => {
  addNamed(home, "mp", { plugins: { solo: { commands: { "work.md": COMMAND } } } })
  editRegistry(home, (registry) => {
    registry.marketplaces.mp.lastSync = { at: new Date().toISOString(), ok: true, error: null }
  })
  const fresh = ocm(home, "search", "zzz-nothing")
  const freshOutput = `${fresh.stdout}\n${fresh.stderr}`
  if (fresh.status !== 1) throw new Error(`expected exit 1 from an empty search, got ${fresh.status}: ${freshOutput}`)
  if (!freshOutput.includes(`no matches for "zzz-nothing"`)) {
    throw new Error(`expected 'no matches for "zzz-nothing"' in:\n${freshOutput}`)
  }
  if (freshOutput.includes("ocm update")) {
    throw new Error(`a fresh marketplace must not produce an update hint:\n${freshOutput}`)
  }
  // a failed sync and a stale one both explain that the cache may be behind
  for (const lastSync of [
    { at: new Date().toISOString(), ok: false, error: "pull failed" },
    { at: new Date(Date.now() - 30 * 24 * 3_600_000).toISOString(), ok: true, error: null },
  ]) {
    editRegistry(home, (registry) => {
      registry.marketplaces.mp.lastSync = lastSync
    })
    const stale = ocm(home, "search", "zzz-nothing")
    const staleOutput = `${stale.stdout}\n${stale.stderr}`
    if (stale.status !== 1) throw new Error(`expected exit 1 from an empty search, got ${stale.status}: ${staleOutput}`)
    if (!staleOutput.includes(`no matches for "zzz-nothing"`)) {
      throw new Error(`expected 'no matches for "zzz-nothing"' in:\n${staleOutput}`)
    }
    if (!staleOutput.includes("ocm update")) {
      throw new Error(`expected an "ocm update" hint with lastSync ${JSON.stringify(lastSync)} in:\n${staleOutput}`)
    }
  }
})

phase("5. info shows resulting opencode names, annotates origins only on disagreement, and works for a disabled plugin", async (home) => {
  addNamed(home, "mp", {
    "marketplace.json": manifest([
      {
        name: "quality-review", source: "./plugins/quality-review",
        description: "from marketplace", version: "1.2.0", category: "review", tags: ["review", "quality"],
      },
      { name: "quiet-tool", source: "./plugins/quiet-tool", defaultEnabled: false },
    ]),
    plugins: {
      "quality-review": {
        // version and description disagree with the marketplace entry;
        // category agrees — that difference is what the annotations track
        "plugin.json": `${JSON.stringify({ description: "from plugin.json", version: "1.0.0", category: "review" }, null, 2)}\n`,
        commands: { "commit.md": COMMAND },
        agents: { "reviewer.md": AGENT },
        skills: { "code-review": { "SKILL.md": SKILL } },
      },
      "quiet-tool": {
        "plugin.json": `${JSON.stringify({ description: "quiet tool, off by default" }, null, 2)}\n`,
        commands: { "work.md": COMMAND },
      },
    },
  })
  const result = ocm(home, "info", "quality-review")
  if (result.status !== 0) throw new Error(`ocm info quality-review exited ${result.status}: ${result.stderr}`)
  const output = result.stdout
  // the resulting opencode names, not the source filenames: the command
  // drops its .md, the skill is namespaced from its frontmatter name
  for (const name of ["quality-review:commit", "quality-review:reviewer", "quality-review:code-review"]) {
    if (!output.includes(name)) throw new Error(`expected the resulting opencode name "${name}" in:\n${output}`)
  }
  const versionLine = output.split("\n").find((line) => line.includes("1.2.0"))
  if (!versionLine) throw new Error(`expected the version 1.2.0 in:\n${output}`)
  if (!versionLine.includes("marketplace.json")) {
    throw new Error(`expected a (marketplace.json) origin on the conflicting version line: ${versionLine}`)
  }
  const categoryLine = output.split("\n").find((line) => line.includes("category"))
  if (!categoryLine) throw new Error(`expected a category line in:\n${output}`)
  for (const origin of ["marketplace.json", "plugin.json", "inferred"]) {
    if (categoryLine.includes(origin)) {
      throw new Error(`an agreeing field carries no origin annotation: ${categoryLine}`)
    }
  }
  const disabled = ocm(home, "info", "quiet-tool")
  if (disabled.status !== 0) throw new Error(`ocm info quiet-tool exited ${disabled.status}: ${disabled.stderr}`)
  const disabledOutput = disabled.stdout
  if (!disabledOutput.includes("quiet tool, off by default")) {
    throw new Error(`expected the cached description in:\n${disabledOutput}`)
  }
  const enabledLine = disabledOutput.split("\n").find((line) => line.includes("enabled"))
  if (!enabledLine || !/\b(no|false)\b/.test(enabledLine)) {
    throw new Error(`expected the enabled field to read no/false for the disabled plugin in:\n${disabledOutput}`)
  }
})

phase("6. search and info both answer from the registry cache with the marketplace directory deleted", async (home) => {
  // invariants: the user's config keys and their own command predate every
  // ocm run and must survive both commands byte-identically
  writeTree(cfg(home), {
    "opencode.json": `${JSON.stringify({ model: "claude-sonnet-4-6", permission: { edit: "allow" } }, null, 2)}\n`,
    commands: { "mine.md": "# my own command\n" },
  })
  addNamed(home, "mp", {
    plugins: {
      solo: {
        "plugin.json": `${JSON.stringify({ description: "works standalone", version: "0.1.0" }, null, 2)}\n`,
        commands: { "work.md": COMMAND },
      },
    },
  })
  const configBytes = readFileSync(join(cfg(home), "opencode.json"), "utf8")
  const registryBytes = readFileSync(registryFile(home), "utf8")
  rmSync(join(home, "mp"), { recursive: true, force: true }) // registry cache only
  const first = ocm(home, "search", "solo")
  if (first.status !== 0) throw new Error(`ocm search solo exited ${first.status}: ${first.stderr}`)
  if (!first.stdout.includes("solo")) throw new Error(`expected solo in:\n${first.stdout}`)
  const info = ocm(home, "info", "solo")
  if (info.status !== 0) throw new Error(`ocm info solo exited ${info.status}: ${info.stderr}`)
  if (!info.stdout.includes("works standalone")) throw new Error(`expected the cached description in:\n${info.stdout}`)
  // invariant: idempotence — a second search prints the same thing
  const second = ocm(home, "search", "solo")
  if (second.status !== 0) throw new Error(`ocm search solo exited ${second.status}: ${second.stderr}`)
  expect(second.stdout).toBe(first.stdout)
  expect(readFileSync(registryFile(home), "utf8")).toBe(registryBytes)
  expect(readFileSync(join(cfg(home), "opencode.json"), "utf8")).toBe(configBytes)
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
})
