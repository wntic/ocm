// Materialization: install and uninstall flip registry state and
// create or remove exactly the owned links; a user file claiming the same
// path wins.

import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, opencodeProbe, rootCacheDir, withFakeHome, withFakeOpencode } from "./harness.mjs"

// Helpers shared verbatim by the absorbed files below.

const CORE_MODULE = fileURLToPath(new URL("../loader/core.js", import.meta.url))

// `enabled` and `changed` are Sets in process but JSON on the wire; the
// runner rebuilds them. enabled null means "all discovered" (v1 behaviour);
// changed absent means no source is marked as changed in this pass.
const RUNNER = `
const [modulePath, calls] = process.argv.slice(2)
const mod = await import(modulePath)
const results = []
for (const [marketplace, dir, enabled, changed] of JSON.parse(calls)) {
  results.push(await mod.materialize(marketplace, dir, {
    enabled: Array.isArray(enabled) ? new Set(enabled) : null,
    changed: Array.isArray(changed) ? new Set(changed) : undefined,
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

const skillsLinks = (home) => join(rootCacheDir(home), "links", "mp", "skills")

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

const cloneDir = (home, name) => join(rootCacheDir(home), "marketplaces", name)

// failing with the whole report in the message beats failing on
// "cannot read .map of undefined" when the outcome record is absent
function outcomesOf(report) {
  if (!Array.isArray(report.outcomes)) {
    throw new Error(`expected materialize to return an outcomes array, got: ${JSON.stringify(report)}`)
  }
  return report.outcomes
}

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
    expect(Object.keys(report).sort()).toEqual(["marketplace", "outcomes", "warnings"])
    expect(outcomesOf(report).filter((o) => o.type === "command").length).toBe(1)
    expect(outcomesOf(report).filter((o) => o.type === "agent").length).toBe(1)
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
    expect(outcomesOf(report).filter((o) => o.state === "created").length).toBe(0)
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
    expect(JSON.stringify(report.warnings)).toContain(dest)
    const outcome = outcomesOf(report).find((o) => o.type === "command" && o.plugin === "adw")
    if (!outcome) throw new Error(`expected an outcome for the unowned command at ${dest}`)
    expect(outcome.state).toBe("skipped")
    if (typeof outcome.reason !== "string" || outcome.reason === "") {
      throw new Error(`expected a non-null reason on the skipped outcome for ${dest}`)
    }
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

// brief 28 §4: after the add-time refusals, no materialization run may
// produce two desired link names that fold to one — the folded sibling is
// skipped with a warning instead of silently replacing its twin
test("10. a plugin shipping folded component names materializes at most one of each pair: no destination holds two names that fold to one", async () => {
  await withFakeHome(async (home) => {
    const JS = 'export default { id: "case-kit-notify", server: async () => ({}) }\n'
    const mp = marketplace(home, { "case-kit": {
      commands: { "Run.md": COMMAND, "run.md": COMMAND },
      skills: {
        Thing: { "SKILL.md": "---\nname: Thing\ndescription: thing guidance\n---\n\nBody.\n" },
        thing: { "SKILL.md": "---\nname: thing\ndescription: thing guidance\n---\n\nBody.\n" },
      },
      plugin: { "Notify.js": JS, "notify.js": JS },
    } })
    const [report] = materialize(home, [["mp", mp, null]])
    // compared folded, so the assertion also holds on a case-sensitive CI
    // host: the guard must have skipped the sibling the pair folds onto
    for (const dir of [join(cfg(home), "commands"), join(cfg(home), "agents"), join(cfg(home), "plugins"), skillsLinks(home)]) {
      let names
      try {
        names = readdirSync(dir)
      } catch {
        continue // nothing materialized there
      }
      const seen = new Set()
      for (const name of names) {
        const folded = name.toLowerCase()
        if (seen.has(folded)) throw new Error(`two materialized names fold to one in ${dir}: ${name}`)
        seen.add(folded)
      }
    }
    // where the fixture really ships both spellings, the folded sibling is
    // skipped with a warning naming the collision; a case-insensitive host
    // cannot hold the pair, so the fixture itself collapses there
    const shipped = readdirSync(join(mp, "plugins", "case-kit", "commands"))
    if (shipped.includes("Run.md") && shipped.includes("run.md")) {
      const foldWarnings = (report.warnings ?? []).filter((l) => l.includes("only in case"))
      if (!foldWarnings.some((l) => l.includes("case-kit"))) {
        throw new Error(`expected a warning naming the folded command pair:\n${JSON.stringify(report.warnings)}`)
      }
    }
  })
})

test("11. materialize returns one outcome per component; a second identical run reports every state current and writes nothing", async () => {
  await withFakeHome(async (home) => {
    const mp = marketplace(home, { adw: ADW })
    const [first] = materialize(home, [["mp", mp, null]])
    expect(first.marketplace).toBe("mp")
    expect(Array.isArray(first.warnings)).toBe(true)
    const key = (o) => `${o.type}/${o.plugin}/${o.component}`
    const run1 = new Map(outcomesOf(first).map((o) => [key(o), o]))
    expect([...run1.keys()].sort()).toEqual(["agent/adw/reviewer.md", "command/adw/commit.md", "skill/adw/python-style"])
    const expected = {
      "command/adw/commit.md": [join(cfg(home), "commands", "adw:commit.md"), join(mp, "plugins", "adw", "commands", "commit.md")],
      "agent/adw/reviewer.md": [join(cfg(home), "agents", "adw:reviewer.md"), join(mp, "plugins", "adw", "agents", "reviewer.md")],
      "skill/adw/python-style": [join(skillsLinks(home), "adw--python-style"), join(mp, "plugins", "adw", "skills", "python-style")],
    }
    for (const [k, [dest, source]] of Object.entries(expected)) {
      const o = run1.get(k)
      if (!o) throw new Error(`expected an outcome for ${k}: ${JSON.stringify(first.outcomes)}`)
      expect(o.dest).toBe(dest)
      expect(o.source).toBe(source)
      expect(o.state).toBe("created")
      expect(o.reason).toBe(null)
    }
    const skillMd = join(skillsLinks(home), "adw--python-style", "SKILL.md")
    const commandLink = join(cfg(home), "commands", "adw:commit.md")
    const agentLink = join(cfg(home), "agents", "adw:reviewer.md")
    const configPath = join(cfg(home), "opencode.json")
    const before = {
      skillMtime: statSync(skillMd).mtimeMs,
      commandIno: lstatSync(commandLink).ino,
      agentIno: lstatSync(agentLink).ino,
      config: readFileSync(configPath, "utf8"),
    }
    const [second] = materialize(home, [["mp", mp, null]])
    expect(outcomesOf(second).map(key).sort()).toEqual([...run1.keys()].sort())
    for (const o of outcomesOf(second)) {
      if (o.state !== "current") throw new Error(`expected state "current" for ${key(o)} on the second run, got "${o.state}"`)
    }
    // invariant: idempotence — the second run wrote nothing
    expect(statSync(skillMd).mtimeMs).toBe(before.skillMtime)
    expect(lstatSync(commandLink).ino).toBe(before.commandIno)
    expect(lstatSync(agentLink).ino).toBe(before.agentIno)
    expect(readFileSync(configPath, "utf8")).toBe(before.config)
  })
})

test("12. a source in options.changed reports refreshed instead of current; without the set, current", async () => {
  await withFakeHome(async (home) => {
    const mp = marketplace(home, { adw: { commands: { "commit.md": COMMAND } } })
    materialize(home, [["mp", mp, null]])
    writeFileSync(join(mp, "plugins", "adw", "commands", "commit.md"), "---\ndescription: commit helper\n---\n\nChanged body.\n")
    const commandState = (report) => {
      const outcome = outcomesOf(report).find((o) => o.type === "command")
      if (!outcome) throw new Error(`expected a command outcome: ${JSON.stringify(report.outcomes)}`)
      return outcome.state
    }
    const [withoutSet] = materialize(home, [["mp", mp, null]])
    expect(commandState(withoutSet)).toBe("current")
    const [withSet] = materialize(home, [["mp", mp, null, ["plugins/adw/commands/commit.md"]]])
    expect(commandState(withSet)).toBe("refreshed")
  })
})

// duplicates the precedence block's scope-local gitRepo; the two merge when
// phases absorb
function gitRepo(dir, tree) {
  writeTree(dir, tree)
  const run = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" })
  run(["init"])
  run(["add", "-A"])
  const commit = run(["-c", "user.email=ocm@test", "-c", "user.name=ocm", "commit", "-m", "fixture"])
  if (commit.status !== 0) throw new Error(`git commit failed in ${dir}: ${commit.stderr}`)
}

test("13. a revision advance with an unchanged skill body reports current for the mirror and moves only the trailer", async () => {
  await withFakeHome(async (home) => {
    const mp = join(home, "mp")
    gitRepo(mp, { plugins: { adw: ADW } })
    const git = (args) => spawnSync("git", args, { cwd: mp, encoding: "utf8" })
    const rev = () => git(["rev-parse", "HEAD"]).stdout.trim()
    const rev1 = rev()
    const [first] = materialize(home, [["mp", mp, null]])
    const skillOf = (report) => {
      const outcome = outcomesOf(report).find((o) => o.type === "skill")
      if (!outcome) throw new Error(`expected a skill outcome: ${JSON.stringify(report.outcomes)}`)
      return outcome
    }
    expect(skillOf(first).state).toBe("created")
    const mirror = join(skillsLinks(home), "adw--python-style", "SKILL.md")
    const read = () => {
      const content = readFileSync(mirror, "utf8")
      const at = content.lastIndexOf("<!-- ocm: rendered from ")
      if (at === -1) throw new Error(`expected the ownership marker in ${mirror}`)
      return { body: content.slice(0, at), trailer: content.slice(at) }
    }
    const run1 = read()
    expect(run1.trailer).toBe(`<!-- ocm: rendered from plugins/adw/skills/python-style/SKILL.md @ ${rev1} -->\n`)
    // a commit that does not touch the skill body advances only the revision
    writeFileSync(join(mp, "plugins", "adw", "commands", "commit.md"), "---\ndescription: commit helper\n---\n\nChanged body.\n")
    const commit = git(["-c", "user.email=ocm@test", "-c", "user.name=ocm", "commit", "-am", "edit command"])
    if (commit.status !== 0) throw new Error(`git commit failed in ${mp}: ${commit.stderr}`)
    const rev2 = rev()
    const [second] = materialize(home, [["mp", mp, null]])
    const outcome = skillOf(second)
    if (outcome.state !== "current") {
      throw new Error(`expected state "current" for the skill mirror at ${mirror} after a revision-only change, got "${outcome.state}"`)
    }
    const run2 = read()
    expect(run2.trailer).toBe(`<!-- ocm: rendered from plugins/adw/skills/python-style/SKILL.md @ ${rev2} -->\n`)
    expect(run2.body).toBe(run1.body)
    expect(readFileSync(mirror, "utf8")).toMatch(/<!-- ocm: rendered from .+ @ .+ -->\s*$/)
  })
})

// brief 41: a body referencing a plugin-root variable renders with the
// marketplace root substituted instead of symlinking. The token appears once
// in a ! block and once in prose — one text substitution covers both
const ROOTED_COMMAND = `---
description: deploy helper
---

\`\`\`!
python3 "\${OCM_PLUGIN_ROOT}/plugins/adw/scripts/deploy.sh" --all
\`\`\`

Relay the output; the script lives at \${OCM_PLUGIN_ROOT}/plugins/adw/scripts/deploy.sh.
`

test("14. a command or agent body referencing a plugin-root variable materializes as a rendered file naming the marketplace root; a body without one keeps its symlink", async () => {
  await withFakeHome(async (home) => {
    const mp = marketplace(home, { adw: {
      commands: { "deploy.md": ROOTED_COMMAND, "commit.md": COMMAND },
      agents: {
        "auditor.md": "---\ndescription: auditor\n---\n\nRead ${CLAUDE_PLUGIN_ROOT}/plugins/adw/notes/audit.md before reviewing.\n",
        "reviewer.md": AGENT,
      },
    } })
    const [report] = materialize(home, [["mp", mp, null]])
    const stateOf = (type, component) => {
      const outcome = outcomesOf(report).find((o) => o.type === type && o.component === component)
      if (!outcome) throw new Error(`expected a ${type} outcome for ${component}: ${JSON.stringify(report.outcomes)}`)
      return outcome.state
    }
    const dest = join(cfg(home), "commands", "adw:deploy.md")
    const stat = lstatSync(dest)
    if (stat.isSymbolicLink()) throw new Error(`expected a regular file at ${dest}, found a symlink`)
    expect(stat.isFile()).toBe(true)
    const content = readFileSync(dest, "utf8")
    // both references — the ! block and the prose — landed on the root
    expect(content.split(`${mp}/plugins/adw/scripts/deploy.sh`).length - 1).toBe(2)
    expect(content).not.toContain("${OCM_PLUGIN_ROOT}")
    // invariant: ownership — the marker is what proves a rendered file is ocm's
    expect(content).toContain("ocm: rendered from ")
    expect(stateOf("command", "deploy.md")).toBe("created")
    const agentDest = join(cfg(home), "agents", "adw:auditor.md")
    if (lstatSync(agentDest).isSymbolicLink()) throw new Error(`expected a regular file at ${agentDest}, found a symlink`)
    const agentContent = readFileSync(agentDest, "utf8")
    expect(agentContent).toContain(`${mp}/plugins/adw/notes/audit.md`)
    expect(agentContent).not.toContain("${CLAUDE_PLUGIN_ROOT}")
    expect(stateOf("agent", "auditor.md")).toBe("created")
    const resolves = (d, source) => {
      if (!lstatSync(d).isSymbolicLink()) throw new Error(`expected a symlink at ${d}`)
      expect(realpathSync(d)).toBe(realpathSync(source))
    }
    resolves(join(cfg(home), "commands", "adw:commit.md"), join(mp, "plugins", "adw", "commands", "commit.md"))
    resolves(join(cfg(home), "agents", "adw:reviewer.md"), join(mp, "plugins", "adw", "agents", "reviewer.md"))
    expect(stateOf("command", "commit.md")).toBe("created")
    expect(stateOf("agent", "reviewer.md")).toBe("created")
  })
})

test("15. two marketplaces: each rendered body names its own root, and another marketplace's per-marketplace form is left alone", async () => {
  await withFakeHome(async (home) => {
    const mpA = join(home, "mp-a")
    const mpB = join(home, "mp-b")
    writeTree(mpA, { plugins: { alpha: { commands: { "work.md": "---\ndescription: work helper\n---\n\npython3 \"${OCM_PLUGIN_ROOT}/plugins/alpha/scripts/work.sh\"\n" } } } })
    writeTree(mpB, { plugins: { beta: { commands: { "lint.md": "---\ndescription: lint helper\n---\n\npython3 \"${OCM_PLUGIN_ROOT_MP_B}/plugins/beta/scripts/lint.sh\"\n\nAlso see ${OCM_PLUGIN_ROOT_MP_A}/plugins/alpha/scripts/work.sh.\n" } } } })
    materialize(home, [["mp-a", mpA, null], ["mp-b", mpB, null]])
    const rendered = (plugin, file) => {
      const dest = join(cfg(home), "commands", `${plugin}:${file}`)
      const stat = lstatSync(dest)
      if (stat.isSymbolicLink()) throw new Error(`expected a regular file at ${dest}, found a symlink`)
      return readFileSync(dest, "utf8")
    }
    const a = rendered("alpha", "work.md")
    expect(a).toContain(`${mpA}/plugins/alpha/scripts/work.sh`)
    expect(a).not.toContain(mpB)
    expect(a).not.toContain("${OCM_PLUGIN_ROOT}")
    const b = rendered("beta", "lint.md")
    expect(b).toContain(`${mpB}/plugins/beta/scripts/lint.sh`)
    expect(b).not.toContain("${OCM_PLUGIN_ROOT_MP_B}")
    // not this plugin's root to resolve: the other marketplace's form stays literal
    expect(b).toContain("${OCM_PLUGIN_ROOT_MP_A}")
    expect(b).not.toContain(mpA)
  })
})

test("16. an upstream edit to a rendered command regenerates the dest on the next materialization: current without the changed set, refreshed with it, never created", async () => {
  await withFakeHome(async (home) => {
    const mp = marketplace(home, { adw: { commands: { "deploy.md": ROOTED_COMMAND } } })
    const dest = join(cfg(home), "commands", "adw:deploy.md")
    const stateOf = (report) => {
      const outcome = outcomesOf(report).find((o) => o.type === "command")
      if (!outcome) throw new Error(`expected a command outcome: ${JSON.stringify(report.outcomes)}`)
      return outcome.state
    }
    const [first] = materialize(home, [["mp", mp, null]])
    expect(stateOf(first)).toBe("created")
    const stat = lstatSync(dest)
    if (stat.isSymbolicLink()) throw new Error(`expected a regular file at ${dest}, found a symlink`)
    writeFileSync(join(mp, "plugins", "adw", "commands", "deploy.md"), `---
description: deploy helper
---

\`\`\`!
python3 "\${OCM_PLUGIN_ROOT}/plugins/adw/scripts/deploy.sh" --verbose
\`\`\`

Edited body: relay every line of output.
`)
    const [withoutSet] = materialize(home, [["mp", mp, null]])
    expect(stateOf(withoutSet)).toBe("current")
    expect(readFileSync(dest, "utf8")).toContain(`${mp}/plugins/adw/scripts/deploy.sh" --verbose`)
    const [withSet] = materialize(home, [["mp", mp, null, ["plugins/adw/commands/deploy.md"]]])
    expect(stateOf(withSet)).toBe("refreshed")
    const regenerated = readFileSync(dest, "utf8")
    expect(regenerated).toContain("Edited body: relay every line of output.")
    expect(regenerated).not.toContain("${OCM_PLUGIN_ROOT}")
  })
})

// brief 41 §3/§4: the rendered-file lifecycle — teardown collects rendered
// commands and agents the way it collects symlinks, doctor sees no drift,
// ownership and --force behave as for a symlinked command, a user edit
// regenerates, and one marketplace's pass never touches another's rendered
// file (the commands/agents dirs are shared between marketplaces)

// spec 19: every installable plugin carries a plugin.json with a description
const PLUGIN_JSON = `${JSON.stringify({ description: "demo plugin" }, null, 2)}\n`

const ROOTED_AGENT = "---\ndescription: auditor\n---\n\nRead ${CLAUDE_PLUGIN_ROOT}/plugins/adw/notes/audit.md before reviewing.\n"

test("17. uninstalling a plugin removes its rendered command and rendered agent; a hand-written file in the plugin's namespace survives", async () => {
  await withFakeHome(async (home) => {
    const mp = marketplace(home, { adw: {
      "plugin.json": PLUGIN_JSON,
      commands: { "deploy.md": ROOTED_COMMAND },
      agents: { "auditor.md": ROOTED_AGENT },
    } })
    expect(ocm(home, "add", mp).status).toBe(0)
    const commandDest = join(cfg(home), "commands", "adw:deploy.md")
    const agentDest = join(cfg(home), "agents", "adw:auditor.md")
    for (const dest of [commandDest, agentDest]) {
      if (lstatSync(dest).isSymbolicLink()) throw new Error(`expected a regular file at ${dest}, found a symlink`)
      expect(readFileSync(dest, "utf8")).toContain("ocm: rendered from ")
    }
    // invariant: ownership — a hand-written file under the plugin's prefix is not ocm's to remove
    writeFileSync(join(cfg(home), "commands", "adw:custom.md"), "# my own command\n")
    expect(ocm(home, "uninstall", "adw").status).toBe(0)
    assertAbsent(commandDest)
    assertAbsent(agentDest)
    expect(readFileSync(join(cfg(home), "commands", "adw:custom.md"), "utf8")).toBe("# my own command\n")
  })
}, 120_000)

test("18. removing the marketplace removes its rendered command and rendered agent; a user's hand-written command survives", async () => {
  await withFakeHome(async (home) => {
    const mp = marketplace(home, { adw: {
      "plugin.json": PLUGIN_JSON,
      commands: { "deploy.md": ROOTED_COMMAND },
      agents: { "auditor.md": ROOTED_AGENT },
    } })
    expect(ocm(home, "add", mp).status).toBe(0)
    const commandDest = join(cfg(home), "commands", "adw:deploy.md")
    const agentDest = join(cfg(home), "agents", "adw:auditor.md")
    for (const dest of [commandDest, agentDest]) {
      if (lstatSync(dest).isSymbolicLink()) throw new Error(`expected a regular file at ${dest}, found a symlink`)
    }
    // invariant: ownership — the user's command survives every operation including remove
    writeFileSync(join(cfg(home), "commands", "mine.md"), "# my own command\n")
    expect(ocm(home, "remove", "mp").status).toBe(0)
    assertAbsent(commandDest)
    assertAbsent(agentDest)
    expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
  })
}, 120_000)

test("19. doctor reports neither a rendered command and agent nor their plugin as drift, before and after uninstall", async () => {
  await withFakeHome(async (home) => {
    const userConfig = { model: "claude-sonnet-4-6" }
    writeTree(cfg(home), { "opencode.json": `${JSON.stringify(userConfig, null, 2)}\n` })
    const mp = marketplace(home, { adw: {
      "plugin.json": PLUGIN_JSON,
      commands: { "deploy.md": ROOTED_COMMAND },
      agents: { "auditor.md": ROOTED_AGENT },
    } })
    expect(ocm(home, "add", mp).status).toBe(0)
    const commandDest = join(cfg(home), "commands", "adw:deploy.md")
    const agentDest = join(cfg(home), "agents", "adw:auditor.md")
    // doctor's probe shells opencode; the fake stub on PATH keeps it fast
    // (the file's local ocm() helper does not set it — see test/doctor.test.mjs)
    const clean = (label) => {
      const result = spawnSync(process.execPath, [OCM_BIN, "doctor"], {
        env: withFakeOpencode({ ...process.env, HOME: home }),
        encoding: "utf8",
        timeout: 120_000,
      })
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
      if (result.status !== 0) throw new Error(`ocm doctor exited ${result.status} ${label}:\n${output}`)
      for (const needle of [commandDest, agentDest, `plugin "adw"`]) {
        if (output.includes(needle)) throw new Error(`the doctor report names ${needle} ${label}:\n${output}`)
      }
    }
    clean("on an install with a rendered command and agent")
    expect(ocm(home, "uninstall", "adw").status).toBe(0)
    clean("after uninstall")
    // invariant: config safety — outside ocm's keys, exactly the user's
    expect(JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8"))).toEqual(userConfig)
  })
}, 300_000)

test("20. a hand-written file at a rendered command's dest is refused; --force displaces it under the displaced cache and the rendered file takes its place", async () => {
  await withFakeHome(async (home) => {
    const commandDest = join(cfg(home), "commands", "adw:deploy.md")
    mkdirSync(dirname(commandDest), { recursive: true })
    writeFileSync(commandDest, "# my own deploy command\n")
    const mp = marketplace(home, { adw: { "plugin.json": PLUGIN_JSON, commands: { "deploy.md": ROOTED_COMMAND } } })
    expect(ocm(home, "add", mp, "--explicit").status).toBe(0)
    // invariant: ownership — without --force, no ownership proof means no
    // touch; brief 45 §3 makes the withheld component a partial install, exit 1
    const plain = ocm(home, "install", "adw")
    expect(plain.status).toBe(1)
    expect(plain.stdout).toContain("installed adw@mp partially — 1 component withheld")
    expect(readFileSync(commandDest, "utf8")).toBe("# my own deploy command\n")
    expect(`${plain.stdout}\n${plain.stderr}`).toContain(commandDest)
    const forced = ocm(home, "install", "adw", "--force")
    expect(forced.status).toBe(0)
    const stat = lstatSync(commandDest)
    if (stat.isSymbolicLink()) throw new Error(`expected a regular file at ${commandDest}, found a symlink`)
    const content = readFileSync(commandDest, "utf8")
    // a local add stores its dir post-realpath (spec 17), so that is the root substituted
    expect(content).toContain(`${realpathSync(mp)}/plugins/adw/scripts/deploy.sh`)
    expect(content).not.toContain("${OCM_PLUGIN_ROOT}")
    // the original was moved, not deleted, and the path is printed
    const displacedRoot = join(rootCacheDir(home), "displaced")
    if (!existsSync(displacedRoot)) throw new Error(`expected the displaced original under ${displacedRoot}`)
    const copies = readdirSync(displacedRoot, { recursive: true })
      .map((rel) => join(displacedRoot, rel))
      .filter((path) => lstatSync(path).isFile())
    expect(copies.map((path) => readFileSync(path, "utf8"))).toEqual(["# my own deploy command\n"])
    expect(`${forced.stdout}\n${forced.stderr}`).toContain("displaced")
  })
}, 120_000)

test("21. a user edit to a rendered command's body is overwritten by the next materialization; the trailer is kept", async () => {
  await withFakeHome(async (home) => {
    const mp = marketplace(home, { adw: { commands: { "deploy.md": ROOTED_COMMAND } } })
    materialize(home, [["mp", mp, null]])
    const dest = join(cfg(home), "commands", "adw:deploy.md")
    const rendered = readFileSync(dest, "utf8")
    const at = rendered.lastIndexOf("<!-- ocm: rendered from ")
    if (at === -1) throw new Error(`expected the ownership marker in ${dest}`)
    // a user edit that keeps the trailer, as a normal edit would
    writeFileSync(dest, `---\ndescription: deploy helper\n---\n\nMy local edit.\n\n${rendered.slice(at)}`)
    materialize(home, [["mp", mp, null]])
    expect(readFileSync(dest, "utf8")).toBe(rendered)
  })
})

test("21b. dropping the variable from a body turns the rendered file back into a symlink, without displacing ocm's own artifact (review finding)", async () => {
  await withFakeHome(async (home) => {
    const mp = marketplace(home, { adw: { commands: { "deploy.md": ROOTED_COMMAND } } })
    materialize(home, [["mp", mp, null]])
    const dest = join(cfg(home), "commands", "adw:deploy.md")
    expect(lstatSync(dest).isSymbolicLink()).toBe(false)

    // the author removes the variable: this body needs no substitution, so the
    // dest goes back to being a symlink. link() proves ownership by "symlink
    // into a managed dir", so without the transition it would call ocm's own
    // rendered file unmanaged — skipping it forever, and under --force moving
    // it into the displaced cache as though it were the user's file
    const source = join(mp, "plugins", "adw", "commands", "deploy.md")
    writeFileSync(source, COMMAND)
    const [report] = materialize(home, [["mp", mp, null]])

    expect(lstatSync(dest).isSymbolicLink()).toBe(true)
    expect(realpathSync(dest)).toBe(realpathSync(source))
    const unmanaged = report.warnings.filter((w) => w.includes("not managed by ocm"))
    if (unmanaged.length) throw new Error(`ocm called its own rendered file unmanaged:\n${unmanaged.join("\n")}`)
    assertAbsent(join(home, ".cache", "ocm", "displaced"))
  })
})

test("22. re-materializing one marketplace leaves another marketplace's rendered command byte-identical: not removed, not re-created", async () => {
  await withFakeHome(async (home) => {
    const rooted = (plugin) => `---\ndescription: ${plugin} helper\n---\n\npython3 "\${OCM_PLUGIN_ROOT}/plugins/${plugin}/scripts/run.sh"\n`
    const mpA = join(home, "mp-a")
    const mpB = join(home, "mp-b")
    writeTree(mpA, { plugins: { alpha: { commands: { "work.md": rooted("alpha") } } } })
    writeTree(mpB, { plugins: { beta: { commands: { "lint.md": rooted("beta") } } } })
    materialize(home, [["mp-a", mpA, null], ["mp-b", mpB, null]])
    const dest = join(cfg(home), "commands", "beta:lint.md")
    const before = { content: readFileSync(dest, "utf8"), ino: lstatSync(dest).ino }
    expect(before.content).toContain(`${mpB}/plugins/beta/scripts/run.sh`)
    // mp-a's pass alone — the loader's startup sync materializes each marketplace in turn
    materialize(home, [["mp-a", mpA, null]])
    expect(lstatSync(dest).isFile()).toBe(true)
    expect(readFileSync(dest, "utf8")).toBe(before.content)
    expect(lstatSync(dest).ino).toBe(before.ino)
  })
})

// brief 41 §2/§4 test 5: the probe against the real binary. A rendered
// command's body is the template opencode sends to the model — with the
// substituted root AND the ownership trailer in it, so "a trailing HTML
// comment is inert" is checked against opencode, not assumed. The ! block is
// the inline backtick form (opencode's SHELL_REGEX = /!`([^`]+)`/g); it runs
// server-side during template render, before model resolution, so the marker
// is written even though the model call afterwards fails.
const MARKER_COMMAND = `---
description: marker probe
---

!\`sh "\${OCM_PLUGIN_ROOT}/plugins/adw/scripts/marker.sh"\`

Relay the output.
`

test("23. a rendered command resolves in opencode and its ! block runs the script at the substituted path", async () => {
  await withFakeHome(async (home) => {
    // the provider points at a dead local endpoint so the run can never
    // reach a real LLM: the model call fails fast and locally (observed:
    // "Anthropic API key is missing"), after the ! block has already run
    const userConfig = {
      model: "anthropic/claude-sonnet-4-6",
      provider: { anthropic: { options: { baseURL: "http://127.0.0.1:1" } } },
    }
    mkdirSync(cfg(home), { recursive: true })
    writeFileSync(join(cfg(home), "opencode.json"), `${JSON.stringify(userConfig, null, 2)}\n`)
    const mp = marketplace(home, { adw: {
      "plugin.json": PLUGIN_JSON,
      commands: { "marker.md": MARKER_COMMAND },
      scripts: { "marker.sh": 'echo executed > "$OCM_MARKER"\n' },
    } })
    const added = ocm(home, "add", mp)
    if (added.status !== 0) throw new Error(`ocm add exited ${added.status}: ${added.stderr}`)
    const dest = join(cfg(home), "commands", "adw:marker.md")
    const content = readFileSync(dest, "utf8")
    // what opencode is driven with below is the real rendered output
    expect(content).toContain(`${realpathSync(mp)}/plugins/adw/scripts/marker.sh`)
    expect(content).toContain("ocm: rendered from ")

    const probe = opencodeProbe(cfg(home), home)
    if (!probe.available) return console.log("skipped:", probe.optIn ? "OCM_PROBE not set" : "opencode is not on PATH")
    if (probe.unreliable) throw new Error("probe cannot trust itself: the canary broken plugin produced no error line")
    expect(probe.commands.join("\n")).toContain("adw:marker")
    // invariant: no plugin-load errors attributable to ocm-installed files
    expect(probe.pluginErrors).toEqual([])

    const marker = join(home, "rendered-command-ran")
    const project = join(home, "project")
    mkdirSync(project, { recursive: true })
    const run = spawnSync("opencode", ["run", "--command", "adw:marker", "go"], {
      env: { ...process.env, HOME: home, OPENCODE_CONFIG_DIR: cfg(home), OCM_MARKER: marker },
      cwd: project,
      encoding: "utf8",
      timeout: 120_000,
    })
    // the model call is expected to fail against the dead endpoint; the !
    // block has already run by then, so the marker is the assertion
    if (!existsSync(marker)) {
      throw new Error(`the ! block did not run: no marker at ${marker}; opencode run exited ${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`)
    }
    expect(readFileSync(marker, "utf8")).toBe("executed\n")
    // invariant: config safety — the user's provider keys survived the install
    const after = JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8"))
    expect(after.model).toBe(userConfig.model)
    expect(after.provider).toEqual(userConfig.provider)
  })
  // opencode spawns: canary + error scan + config resolution + one run (see harness.mjs)
}, 420_000)
