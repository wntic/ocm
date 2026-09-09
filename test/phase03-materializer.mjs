// Phase 03 — docs/specs/03-materializer.md: one test per numbered item in its
// Tests section, with the spec 00 invariants where they apply (idempotence in
// 3, ownership in 5, config safety in 7, no plugin errors in 9). The engine
// runs in a spawned child under the fake $HOME because loader/core.js reads
// its path constants at module load.
import { spawnSync } from "node:child_process"
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, opencodeProbe, withFakeHome } from "./harness.mjs"

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

test("9. opencodeProbe sees the expected command, agent and skill names", async () => {
  await withFakeHome(async (home) => {
    const mp = marketplace(home, { adw: ADW })
    materialize(home, [["mp", mp, null]])
    const probe = opencodeProbe(cfg(home), home)
    if (!probe.available) return console.log("skipped: opencode is not on PATH")
    if (probe.unreliable) throw new Error("probe cannot trust itself: the canary broken plugin produced no error line")
    expect(probe.commands.join("\n")).toContain("adw:commit")
    expect(probe.agents.join("\n")).toContain("adw:reviewer")
    expect(probe.skills.join("\n")).toContain("adw:python-style")
    // invariant: no plugin-load errors attributable to ocm-installed files
    expect(probe.pluginErrors).toEqual([])
  })
  // opencode spawns: canary + error scan + name resolution (see harness.mjs)
}, 420_000)
