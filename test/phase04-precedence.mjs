// Phase 04 — docs/specs/04-precedence.md: one test per numbered item in its
// Tests section, with the spec 00 invariants where they apply (ownership in 1,
// idempotence in 2, config safety and ownership in 3, no plugin errors in 4).
// The CLI runs as a spawned child (bun bin/ocm.ts) under the fake $HOME so
// registry writes and materialization land there. Git marketplaces come from
// file:// URLs to local fixture repos — no network.
import { spawnSync } from "node:child_process"
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, opencodeProbe, withFakeHome } from "./harness.mjs"

const OCM_BIN = fileURLToPath(new URL("../bin/ocm.ts", import.meta.url))

function ocm(home, ...args) {
  const result = spawnSync(process.execPath, [OCM_BIN, ...args], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
    timeout: 120_000,
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

function writeTree(dir, tree) {
  mkdirSync(dir, { recursive: true })
  for (const [name, value] of Object.entries(tree)) {
    if (typeof value === "string") writeFileSync(join(dir, name), value)
    else writeTree(join(dir, name), value)
  }
}

// A local git remote for the file:// add path (tests 1 and 5).
function gitRepo(dir, tree) {
  writeTree(dir, tree)
  const run = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" })
  run(["init"])
  run(["add", "-A"])
  const commit = run(["-c", "user.email=ocm@test", "-c", "user.name=ocm", "commit", "-m", "fixture"])
  if (commit.status !== 0) throw new Error(`git commit failed in ${dir}: ${commit.stderr}`)
}

const cfg = (home) => join(home, ".config", "opencode")
const registryFile = (home) => join(cfg(home), "ocm", "registry.json")
const readRegistry = (home) => JSON.parse(readFileSync(registryFile(home), "utf8"))
const cloneDir = (home, name) => join(home, ".cache", "ocm", "marketplaces", name)

const COMMAND = "---\ndescription: commit helper\n---\n\nCommit body.\n"
const SKILL = "---\nname: python-style\ndescription: Python style guidance\n---\n\n# Python style\n\nUse ruff.\n"

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
    writeTree(incumbent, { plugins: { adw: { commands: { "commit.md": COMMAND } } } })
    expect(ocm(home, "add", incumbent).status).toBe(0)

    const remote = join(home, "remote", "other-mp")
    gitRepo(remote, { plugins: { adw: { commands: { "deploy.md": COMMAND } } } })
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
    writeTree(mpA, { plugins: { adw: { commands: { "commit.md": COMMAND } } } })
    writeTree(mpB, { plugins: { beta: { commands: { "lint.md": COMMAND } } } })
    expect(ocm(home, "add", mpA).status).toBe(0)
    expect(ocm(home, "add", mpB).status).toBe(0)

    // upstream change: B starts shipping a plugin name A already provides
    writeTree(mpB, { plugins: { adw: { commands: { "deploy.md": COMMAND } } } })
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
          commands: { "commit.md": COMMAND },
          skills: { "python-style": { "SKILL.md": SKILL } },
        },
      },
    })
    writeTree(mpB, { plugins: { beta: { commands: { "lint.md": COMMAND } } } })
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
      plugins: { adw: { commands: { "commit.md": "---\ndescription: global commit helper\n---\n\nGlobal body.\n" } } },
    })
    expect(ocm(home, "add", mp).status).toBe(0)
    assertResolves(join(cfg(home), "commands", "adw:commit.md"), join(mp, "plugins", "adw", "commands", "commit.md"))

    const project = join(home, "project")
    writeTree(project, {
      ".opencode": { commands: { "adw:commit.md": "---\ndescription: project commit helper\n---\n\nProject body.\n" } },
    })

    const probe = opencodeProbe(cfg(home), home, project)
    if (!probe.available) return console.log("skipped: opencode is not on PATH")
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
      gitRepo(join(home, "remote", mp), { plugins: { [plugin]: { commands: { "commit.md": COMMAND } } } })
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
