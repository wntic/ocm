// Materialization: install and uninstall flip registry state and
// create or remove exactly the owned links; a user file claiming the same
// path wins.

import { spawnSync } from "node:child_process"
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, opencodeProbe, withFakeHome } from "./harness.mjs"

// Helpers shared verbatim by the absorbed files below.

const CORE_MODULE = fileURLToPath(new URL("../loader/core.js", import.meta.url))

// `enabled` is a Set in process but JSON on the wire; the runner rebuilds it.
// null means "all discovered" (v1 behaviour).
const RUNNER = `
const [modulePath, calls] = process.argv.slice(2)
const mod = await import(modulePath)
const results = []
for (const [marketplace, dir, enabled] of JSON.parse(calls)) {
  results.push(await mod.materialize(marketplace, dir, {
    enabled: Array.isArray(enabled) ? new Set(enabled) : null,
  }))
}
console.log(JSON.stringify(results))
`

function materialize(home, calls) {
  const runner = join(home, "materialize-runner.mjs")
  writeFileSync(runner, RUNNER)
  const result = spawnSync(process.execPath, [runner, CORE_MODULE, JSON.stringify(calls)], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  })
  if (result.status !== 0) {
    throw new Error(`materialize runner exited ${result.status}: ${result.stderr}`)
  }
  return JSON.parse(result.stdout)
}

function writeTree(dir, tree) {
  mkdirSync(dir, { recursive: true })
  for (const [name, value] of Object.entries(tree)) {
    if (typeof value === "string") writeFileSync(join(dir, name), value)
    else writeTree(join(dir, name), value)
  }
}

const cfg = (home) => join(home, ".config", "opencode")

const skillsLinks = (home) => join(home, ".cache", "ocm", "links", "mp", "skills")

const COMMAND = "---\ndescription: commit helper\n---\n\nCommit body.\n"

const AGENT = "---\ndescription: code reviewer\n---\n\nReviewer body.\n"

const SKILL = "---\nname: python-style\ndescription: Python style guidance\n---\n\n# Python style\n\nUse ruff.\n"

const ADW = {
  commands: { "commit.md": COMMAND },
  agents: { "reviewer.md": AGENT },
  skills: {
    "python-style": {
      "SKILL.md": SKILL,
      "examples.md": "Example.\n",
      references: { "guide.md": "# Guide\n" },
    },
  },
}

function marketplace(home, plugins) {
  const dir = join(home, "mp")
  writeTree(dir, { plugins })
  return dir
}

const OCM_BIN = fileURLToPath(new URL("../bin/ocm.ts", import.meta.url))

function ocm(home, ...args) {
  const result = spawnSync(process.execPath, [OCM_BIN, ...args], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
    timeout: 120_000,
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

const registryFile = (home) => join(cfg(home), "ocm", "registry.json")

const readRegistry = (home) => JSON.parse(readFileSync(registryFile(home), "utf8"))

const cloneDir = (home, name) => join(home, ".cache", "ocm", "marketplaces", name)

// materialization: state flips create and remove exactly the owned links — absorbed from test/phase03-materializer.mjs
{
// realpath on both sides: macOS temp dirs sit behind /var -> /private/var, so
// comparing a raw joined path against realpathSync(dest) would always fail.
function assertResolves(dest, source) {
  let stat
  try {
    stat = lstatSync(dest)
  } catch {
    throw new Error(`expected a symlink at ${dest}, found nothing`)
  }
  if (!stat.isSymbolicLink()) throw new Error(`expected a symlink at ${dest}`)
  expect(realpathSync(dest)).toBe(realpathSync(source))
}

test("1. commands and agents link with <plugin>: names; targets resolve to the source files", async () => {
  await withFakeHome(async (home) => {
    const mp = marketplace(home, { adw: { commands: { "commit.md": COMMAND }, agents: { "reviewer.md": AGENT } } })
    const [report] = materialize(home, [["mp", mp, null]])
    expect(Object.keys(report).sort()).toEqual(["counts", "created", "removed", "skipped", "warnings"])
    expect(Object.keys(report.counts).sort()).toEqual(["agent", "command", "mcp", "plugin", "skill"])
    expect(report.counts.command).toBe(1)
    expect(report.counts.agent).toBe(1)
    assertResolves(join(cfg(home), "commands", "adw:commit.md"), join(mp, "plugins", "adw", "commands", "commit.md"))
    assertResolves(join(cfg(home), "agents", "adw:reviewer.md"), join(mp, "plugins", "adw", "agents", "reviewer.md"))
    expect(readdirSync(join(cfg(home), "commands")).sort()).toEqual(["adw:commit.md"])
  })
})

test("2. a skill renders with name \"<plugin>:<skill>\", a byte-identical body, and symlinked siblings", async () => {
  await withFakeHome(async (home) => {
    const mp = marketplace(home, { adw: ADW })
    materialize(home, [["mp", mp, null]])
    const source = join(mp, "plugins", "adw", "skills", "python-style")
    const rendered = join(skillsLinks(home), "adw--python-style")
    expect(lstatSync(rendered).isDirectory()).toBe(true)
    expect(readdirSync(rendered).sort()).toEqual(["SKILL.md", "examples.md", "references"])
    const skillMd = join(rendered, "SKILL.md")
    expect(lstatSync(skillMd).isSymbolicLink()).toBe(false)
    expect(statSync(skillMd).isFile()).toBe(true)
    const content = readFileSync(skillMd, "utf8")
    expect(content).toMatch(/name:\s*"?adw:python-style"?\s*$/m)
    expect(content).toContain("description: Python style guidance")
    expect(content).toContain(SKILL.slice(SKILL.indexOf("\n---\n") + 5))
    expect(content).toMatch(/<!-- ocm: rendered from .+ @ .+ -->\s*$/)
    assertResolves(join(rendered, "examples.md"), join(source, "examples.md"))
    assertResolves(join(rendered, "references"), join(source, "references"))
  })
})

test("3. re-running is a no-op: no rewrite of an unchanged SKILL.md, no link churn", async () => {
  await withFakeHome(async (home) => {
    const mp = marketplace(home, { adw: ADW })
    materialize(home, [["mp", mp, null]])
    const skillMd = join(skillsLinks(home), "adw--python-style", "SKILL.md")
    const commandLink = join(cfg(home), "commands", "adw:commit.md")
    const sibling = join(skillsLinks(home), "adw--python-style", "examples.md")
    const configPath = join(cfg(home), "opencode.json")
    const before = {
      skillMtime: statSync(skillMd).mtimeMs,
      commandIno: lstatSync(commandLink).ino,
      siblingIno: lstatSync(sibling).ino,
      config: readFileSync(configPath, "utf8"),
    }
    const [report] = materialize(home, [["mp", mp, null]])
    expect(statSync(skillMd).mtimeMs).toBe(before.skillMtime)
    expect(lstatSync(commandLink).ino).toBe(before.commandIno)
    expect(lstatSync(sibling).ino).toBe(before.siblingIno)
    expect(readFileSync(configPath, "utf8")).toBe(before.config)
    // invariant: idempotence — no spurious "created" on a run that created nothing
    const created = Array.isArray(report.created) ? report.created.length : report.created
    expect(created).toBe(0)
  })
})

test("4. disabling a plugin removes exactly its components; a sibling plugin's are untouched", async () => {
  await withFakeHome(async (home) => {
    const mp = marketplace(home, { adw: ADW, other: { commands: { "lint.md": COMMAND } } })
    materialize(home, [["mp", mp, null]])
    materialize(home, [["mp", mp, ["other"]]])
    assertAbsent(join(cfg(home), "commands", "adw:commit.md"))
    assertAbsent(join(cfg(home), "agents", "adw:reviewer.md"))
    assertAbsent(join(skillsLinks(home), "adw--python-style"))
    assertResolves(join(cfg(home), "commands", "other:lint.md"), join(mp, "plugins", "other", "commands", "lint.md"))
  })
})

test("5. a hand-written unowned file at a target path is never modified; the operation reports it and continues", async () => {
  await withFakeHome(async (home) => {
    const mp = marketplace(home, { adw: { commands: { "commit.md": COMMAND }, agents: { "reviewer.md": AGENT } } })
    const dest = join(cfg(home), "commands", "adw:commit.md")
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, "# my own commit command\n")
    const [report] = materialize(home, [["mp", mp, null]])
    // invariant: ownership — no ownership proof, no touch
    expect(readFileSync(dest, "utf8")).toBe("# my own commit command\n")
    expect(JSON.stringify([report.skipped, report.warnings])).toContain(dest)
    assertResolves(join(cfg(home), "agents", "adw:reviewer.md"), join(mp, "plugins", "adw", "agents", "reviewer.md"))
  })
})

test("6. a broken symlink at a target path is replaced", async () => {
  await withFakeHome(async (home) => {
    const mp = marketplace(home, { adw: { commands: { "commit.md": COMMAND } } })
    const dest = join(cfg(home), "commands", "adw:commit.md")
    mkdirSync(dirname(dest), { recursive: true })
    symlinkSync(join(home, "gone", "nowhere.md"), dest)
    materialize(home, [["mp", mp, null]])
    assertResolves(dest, join(mp, "plugins", "adw", "commands", "commit.md"))
  })
})

test("7. skills.paths gains one entry when the first skill appears and loses it when the last one goes", async () => {
  await withFakeHome(async (home) => {
    const mp = marketplace(home, { adw: ADW })
    const configPath = join(cfg(home), "opencode.json")
    // invariant: config safety — arbitrary user keys survive every ocm write
    const userConfig = {
      model: "claude-sonnet-4-6",
      permission: { edit: "allow" },
      skills: { paths: ["/users/me/my-skills"], urls: ["https://example.com/skill"] },
    }
    mkdirSync(cfg(home), { recursive: true })
    writeFileSync(configPath, `${JSON.stringify(userConfig, null, 2)}\n`)

    materialize(home, [["mp", mp, null]])
    const gained = JSON.parse(readFileSync(configPath, "utf8"))
    expect(gained.skills.paths).toContain(skillsLinks(home))
    expect(gained.skills.paths).toContain("/users/me/my-skills")

    materialize(home, [["mp", mp, []]])
    const lost = JSON.parse(readFileSync(configPath, "utf8"))
    expect(lost.skills.paths).not.toContain(skillsLinks(home))
    expect(lost.skills.paths).toEqual(["/users/me/my-skills"])

    // outside the entry ocm owns, both writes left the user's config alone
    const minusOurs = (config) => {
      const copy = JSON.parse(JSON.stringify(config))
      copy.skills.paths = copy.skills.paths.filter((p) => p !== skillsLinks(home))
      return copy
    }
    expect(minusOurs(gained)).toEqual(userConfig)
    expect(minusOurs(lost)).toEqual(userConfig)
  })
})

test("8. a SKILL.md with no name is skipped with a warning, not a crash", async () => {
  await withFakeHome(async (home) => {
    const mp = marketplace(home, {
      adw: {
        commands: { "commit.md": COMMAND },
        skills: {
          good: { "SKILL.md": "---\nname: good\ndescription: a real skill\n---\n\nGood body.\n" },
          nameless: { "SKILL.md": "---\ndescription: no name in this frontmatter\n---\n\nBody.\n" },
        },
      },
    })
    const [report] = materialize(home, [["mp", mp, null]])
    assertAbsent(join(skillsLinks(home), "adw--nameless"))
    expect(JSON.stringify(report.warnings ?? [])).toContain("nameless")
    assertResolves(join(cfg(home), "commands", "adw:commit.md"), join(mp, "plugins", "adw", "commands", "commit.md"))
    expect(lstatSync(join(skillsLinks(home), "adw--good")).isDirectory()).toBe(true)
  })
})
}

// precedence: a user file and an ocm link claiming one path — absorbed from test/phase04-precedence.mjs
{
// A local git remote for the file:// add path (tests 1 and 5).
function gitRepo(dir, tree) {
  writeTree(dir, tree)
  const run = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" })
  run(["init"])
  run(["add", "-A"])
  const commit = run(["-c", "user.email=ocm@test", "-c", "user.name=ocm", "commit", "-m", "fixture"])
  if (commit.status !== 0) throw new Error(`git commit failed in ${dir}: ${commit.stderr}`)
}

// spec 19: every installable plugin carries a plugin.json with a description
const PLUGIN_JSON = `${JSON.stringify({ description: "demo plugin" }, null, 2)}\n`

// realpath on both sides: macOS temp dirs sit behind /var -> /private/var, so
// comparing a raw joined path against realpathSync(dest) would always fail.
function assertResolves(dest, source) {
  let stat
  try {
    stat = lstatSync(dest)
  } catch {
    throw new Error(`expected a symlink at ${dest}, found nothing`)
  }
  if (!stat.isSymbolicLink()) throw new Error(`expected a symlink at ${dest}`)
  expect(realpathSync(dest)).toBe(realpathSync(source))
}

test("1. adding a second marketplace shipping an already-provided plugin name fails, names both marketplaces, and leaves no clone behind", async () => {
  await withFakeHome(async (home) => {
    const incumbent = join(home, "wntic-adw")
    writeTree(incumbent, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
    expect(ocm(home, "add", incumbent).status).toBe(0)

    const remote = join(home, "remote", "other-mp")
    gitRepo(remote, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "deploy.md": COMMAND } } } })
    const refused = ocm(home, "add", `file://${remote}`)
    if (refused.status === 0) {
      throw new Error(`expected a non-zero exit from "ocm add ${remote}" — plugin "adw" is already provided by marketplace "wntic-adw"`)
    }
    const output = `${refused.stdout}\n${refused.stderr}`
    expect(output).toContain("wntic-adw")
    expect(output).toContain("other-mp")
    expect(output).toContain('"adw"')

    // nothing cloned-and-left-behind, nothing registered, nothing materialized
    assertAbsent(cloneDir(home, "remote-other-mp"))
    expect(readRegistry(home).marketplaces["remote-other-mp"]).toBeUndefined()
    assertAbsent(join(cfg(home), "commands", "adw:deploy.md"))
    // invariant: ownership — the incumbent's link is never displaced
    assertResolves(join(cfg(home), "commands", "adw:commit.md"), join(incumbent, "plugins", "adw", "commands", "commit.md"))
  })
}, 120_000)

test("2. an upstream update introducing a colliding plugin name registers it disabled with a collision note and materializes nothing", async () => {
  await withFakeHome(async (home) => {
    const mpA = join(home, "mp-a")
    const mpB = join(home, "mp-b")
    writeTree(mpA, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
    writeTree(mpB, { plugins: { beta: { "plugin.json": PLUGIN_JSON, commands: { "lint.md": COMMAND } } } })
    expect(ocm(home, "add", mpA).status).toBe(0)
    expect(ocm(home, "add", mpB).status).toBe(0)

    // upstream change: B starts shipping a plugin name A already provides
    writeTree(mpB, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "deploy.md": COMMAND } } } })
    ocm(home, "update", "mp-b")

    const colliding = readRegistry(home).marketplaces["mp-b"].plugins.adw
    if (!colliding) throw new Error(`expected plugin "adw" from marketplace "mp-b" in ${registryFile(home)} after update`)
    expect(colliding.enabled).toBe(false)
    const record = JSON.stringify(colliding)
    expect(record).toContain("collision")
    expect(record).toContain("mp-a")

    // never materialized, and the incumbent is never displaced by it
    assertAbsent(join(cfg(home), "commands", "adw:deploy.md"))
    assertResolves(join(cfg(home), "commands", "adw:commit.md"), join(mpA, "plugins", "adw", "commands", "commit.md"))
    assertResolves(join(cfg(home), "commands", "beta:lint.md"), join(mpB, "plugins", "beta", "commands", "lint.md"))

    // invariant: idempotence — a second update changes nothing about it
    ocm(home, "update", "mp-b")
    expect(readRegistry(home).marketplaces["mp-b"].plugins.adw.enabled).toBe(false)
    assertAbsent(join(cfg(home), "commands", "adw:deploy.md"))
  })
}, 120_000)

test("3. no ocm operation creates a path under ~/.claude, .claude, ~/.agents or .agents across a full add/update/remove cycle", async () => {
  await withFakeHome(async (home) => {
    // invariants: config safety and ownership — user keys and unowned files
    // survive the whole cycle
    const userConfig = {
      model: "claude-sonnet-4-6",
      permission: { edit: "allow" },
      skills: { paths: ["/users/me/my-skills"], urls: ["https://example.com/skill"] },
    }
    mkdirSync(join(cfg(home), "commands"), { recursive: true })
    writeFileSync(join(cfg(home), "opencode.json"), `${JSON.stringify(userConfig, null, 2)}\n`)
    writeFileSync(join(cfg(home), "commands", "mine.md"), "# my own command\n")

    const mpA = join(home, "mp-a")
    const mpB = join(home, "mp-b")
    writeTree(mpA, {
      plugins: {
        adw: {
          "plugin.json": PLUGIN_JSON,
          commands: { "commit.md": COMMAND },
          skills: { "python-style": { "SKILL.md": SKILL } },
        },
      },
    })
    writeTree(mpB, { plugins: { beta: { "plugin.json": PLUGIN_JSON, commands: { "lint.md": COMMAND } } } })
    expect(ocm(home, "add", mpA).status).toBe(0)
    expect(ocm(home, "add", mpB).status).toBe(0)
    ocm(home, "update")
    expect(ocm(home, "remove", "mp-a").status).toBe(0)

    // the cycle did real work: A's link is gone, B's remains, and the user's
    // files came through untouched
    assertAbsent(join(cfg(home), "commands", "adw:commit.md"))
    assertResolves(join(cfg(home), "commands", "beta:lint.md"), join(mpB, "plugins", "beta", "commands", "lint.md"))
    expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
    expect(JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8"))).toEqual(userConfig)

    // the walk: no .claude or .agents entry anywhere in the fake home, so no
    // file can reside inside one either
    const forbidden = new Set([".claude", ".agents"])
    const stack = [home]
    while (stack.length) {
      const dir = stack.pop()
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (forbidden.has(entry.name)) {
          throw new Error(`ocm created a path under ${entry.name}: ${join(dir, entry.name)}`)
        }
        if (entry.isDirectory()) stack.push(join(dir, entry.name))
      }
    }
  })
}, 120_000)

test("4. a project .opencode/commands/adw:commit.md wins over the ocm-installed global one in the real binary", async () => {
  await withFakeHome(async (home) => {
    const mp = join(home, "mp")
    writeTree(mp, {
      plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": "---\ndescription: global commit helper\n---\n\nGlobal body.\n" } } },
    })
    expect(ocm(home, "add", mp).status).toBe(0)
    assertResolves(join(cfg(home), "commands", "adw:commit.md"), join(mp, "plugins", "adw", "commands", "commit.md"))

    const project = join(home, "project")
    writeTree(project, {
      ".opencode": { commands: { "adw:commit.md": "---\ndescription: project commit helper\n---\n\nProject body.\n" } },
    })

    const probe = opencodeProbe(cfg(home), home, project)
    if (!probe.available) return console.log("skipped:", probe.optIn ? "OCM_PROBE not set" : "opencode is not on PATH")
    if (probe.unreliable) throw new Error("probe cannot trust itself: the canary broken plugin produced no error line")
    const entry = probe.commandEntries["adw:commit"]
    if (!entry) throw new Error(`expected a resolved command "adw:commit" with cwd ${project}`)
    expect(entry.description).toBe("project commit helper")
    // invariant: no plugin-load errors attributable to ocm-installed files
    expect(probe.pluginErrors).toEqual([])
  })
  // opencode spawns: canary + error scan + config resolution (see harness.mjs)
}, 420_000)

test("5. one unreachable marketplace in a three-marketplace sync leaves the other two updated and its own links intact", async () => {
  await withFakeHome(async (home) => {
    const PLUGINS = { "mp-a": "alpha", "mp-b": "beta", "mp-c": "gamma" }
    for (const [mp, plugin] of Object.entries(PLUGINS)) {
      gitRepo(join(home, "remote", mp), { plugins: { [plugin]: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
      expect(ocm(home, "add", `file://${join(home, "remote", mp)}`).status).toBe(0)
    }
    const link = (plugin) => join(cfg(home), "commands", `${plugin}:commit.md`)
    const cloneSource = (mp, plugin) => join(cloneDir(home, `remote-${mp}`), "plugins", plugin, "commands", "commit.md")
    for (const [mp, plugin] of Object.entries(PLUGINS)) assertResolves(link(plugin), cloneSource(mp, plugin))

    // the middle remote goes away; alpha's and gamma's links are deleted so
    // the sync must re-create them
    rmSync(join(home, "remote", "mp-b"), { recursive: true, force: true })
    rmSync(link("alpha"))
    rmSync(link("gamma"))

    const updated = ocm(home, "update")
    // does not crash: the process exited on its own. Any exit status the
    // failed pull produces is spec 08's concern, not this test's.
    expect(updated.status).not.toBeNull()

    // the two reachable marketplaces re-materialized
    assertResolves(link("alpha"), cloneSource("mp-a", "alpha"))
    assertResolves(link("gamma"), cloneSource("mp-c", "gamma"))
    // the unreachable one's links are intact, still pointing into its clone
    assertResolves(link("beta"), cloneSource("mp-b", "beta"))
  })
}, 120_000)
}

// The suite's one probe of the real binary: a home carrying every component
// shape ocm installs, resolved end to end. The per-file probes this replaces
// were redundant with the on-disk assertions around them; the gate runs this
// with OCM_PROBE=1 and scripts/oc-probe.sh scans plugin errors separately.
test("9. opencode resolves every component shape ocm installs: command, agent, skill, JS plugin, MCP server", async () => {
  await withFakeHome(async (home) => {
    const mp = join(home, "mp")
    writeTree(mp, { plugins: { adw: {
      "plugin.json": `${JSON.stringify({ description: "demo plugin" }, null, 2)}\n`,
      commands: { "commit.md": COMMAND },
      agents: { "reviewer.md": AGENT },
      skills: { "python-style": { "SKILL.md": SKILL } },
      plugin: { "notify.js": 'export default { id: "adw-notify", server: async () => ({}) }\n' },
      "mcp.json": `${JSON.stringify({ db: { type: "local", command: ["npx", "-y", "@acme/db-mcp"], enabled: true } }, null, 2)}\n`,
    } } })
    const added = ocm(home, "add", mp, "--trust")
    if (added.status !== 0) throw new Error(`ocm add --trust exited ${added.status}: ${added.stderr}`)
    const link = (path, source) => {
      if (!lstatSync(path).isSymbolicLink()) throw new Error(`expected a symlink at ${path}`)
      expect(realpathSync(path)).toBe(realpathSync(source))
    }
    link(join(cfg(home), "commands", "adw:commit.md"), join(mp, "plugins", "adw", "commands", "commit.md"))
    link(join(cfg(home), "agents", "adw:reviewer.md"), join(mp, "plugins", "adw", "agents", "reviewer.md"))
    expect(lstatSync(join(skillsLinks(home), "adw--python-style")).isDirectory()).toBe(true)
    link(join(cfg(home), "plugins", "ocm--adw--notify.js"), join(mp, "plugins", "adw", "plugin", "notify.js"))
    expect(JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8")).mcp["ocm--adw--db"]).toBeDefined()
    const probe = opencodeProbe(cfg(home), home)
    if (!probe.available) return console.log("skipped:", probe.optIn ? "OCM_PROBE not set" : "opencode is not on PATH")
    if (probe.unreliable) throw new Error("probe cannot trust itself: the canary broken plugin produced no error line")
    expect(probe.commands.join("\n")).toContain("adw:commit")
    expect(probe.agents.join("\n")).toContain("adw:reviewer")
    expect(probe.skills.join("\n")).toContain("adw:python-style")
    // invariant: no plugin-load errors attributable to ocm-installed files
    expect(probe.pluginErrors).toEqual([])
  })
  // opencode spawns: canary + error scan + name resolution (see harness.mjs)
}, 420_000)
