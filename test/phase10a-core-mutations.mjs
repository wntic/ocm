// Phase 10a — docs/specs/10a-core-mutations.md: one test per numbered item
// (item 7 is the phase 01–09 suite passing unmodified, which that suite
// itself verifies), plus the four invariants (idempotence in 1 and 6, config
// safety and ownership in 3, no plugin errors in 4). The mutation core runs
// in a spawned child on the fake $HOME — the same trick as the loader-sync
// tests in phases 07/08 — because loader/*.js computes its path constants at
// module load. The CLI is spawned only for setup.
import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, assertFileExists, opencodeProbe, withFakeHome } from "./harness.mjs"

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

// realpath on both sides: macOS temp dirs sit behind /var -> /private/var
function assertResolves(dest, source) {
  if (!existsSync(dest) || !lstatSync(dest).isSymbolicLink()) throw new Error(`expected a symlink at ${dest}`)
  expect(realpathSync(dest)).toBe(realpathSync(source))
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

function core(home, calls) {
  const runner = join(home, "core-runner.mjs")
  writeFileSync(runner, CORE_RUNNER)
  const result = spawnSync(process.execPath, [runner, CORE_MODULE, JSON.stringify(calls)], {
    env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 120_000,
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

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

phase("1. install/uninstall through the core flip enabled/installedAt and materialize/remove exactly that plugin's links", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: {
    adw: { commands: { "commit.md": COMMAND }, skills: { "python-style": { "SKILL.md": SKILL } } },
    beta: { commands: { "lint.md": COMMAND } },
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
  writeTree(mpA, { plugins: { adw: { commands: { "commit.md": COMMAND } } } })
  coreOk(home, [{ fn: "addMarketplace", args: [mpA] }])
  const entry = readRegistry(home).marketplaces["mp-a"]
  if (!entry) throw new Error(`expected a "mp-a" record in ${registryFile(home)}`)
  expect(entry.plugins.adw.enabled).toBe(true)
  assertResolves(commandLink(home, "adw", "commit.md"), join(mpA, "plugins", "adw", "commands", "commit.md"))

  const bytes = readFileSync(registryFile(home), "utf8")
  const mpB = join(home, "mp-b")
  writeTree(mpB, { plugins: { adw: { commands: { "deploy.md": COMMAND } } } })
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
  writeTree(mp, { plugins: { adw: { commands: { "commit.md": COMMAND }, skills: { "python-style": { "SKILL.md": SKILL } } } } })
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
  const probe = opencodeProbe(cfg(home), home)
  if (!probe.available) console.log("skipped: opencode is not on PATH")
  else {
    if (probe.unreliable) throw new Error("probe cannot trust itself: the canary broken plugin produced no error line")
    expect(probe.pluginErrors).toEqual([])
  }

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
}, 420_000) // opencode spawns: canary + error scan

phase("5. search through the core returns the spec 09 ranking", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, {
    "marketplace.json": `${JSON.stringify({ plugins: [
      { name: "quality-gate", source: "./plugins/quality-gate", tags: ["review"] },
      { name: "polish", source: "./plugins/polish", description: "polish and review your diffs" },
    ] }, null, 2)}\n`,
    plugins: {
      review: { commands: { "work.md": COMMAND } }, // name exact
      reviewer: { commands: { "work.md": COMMAND } }, // name prefix
      "code-review": { commands: { "work.md": COMMAND } }, // name substring
      "quality-gate": { commands: { "work.md": COMMAND } }, // tag exact
      polish: { commands: { "work.md": COMMAND } }, // description substring
      adw: { commands: { "pr-review.md": COMMAND } }, // component name substring
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
  writeTree(mp, { plugins: { adw: { commands: { "commit.md": COMMAND } } } })
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
