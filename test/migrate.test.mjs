// Migration and packaging: the legacy home layout migrates
// automatically, and the published bin resolves.

import { spawnSync } from "node:child_process"
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, assertFileExists, opencodeProbe, rootCacheDir, withFakeHome } from "./harness.mjs"

// Helpers shared verbatim by the absorbed files below.

const OCM_BIN = fileURLToPath(new URL("../bin/ocm.ts", import.meta.url))

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url))

const LOADER_DIR = join(REPO_ROOT, "loader")

const PACKAGE = join(REPO_ROOT, "package.json")

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
  return result.stdout.trim()
}

const commitAll = (dir, message) => {
  git(dir, ["add", "-A"])
  git(dir, ["-c", "user.email=ocm@test", "-c", "user.name=ocm", "commit", "-m", message])
}

function gitRepo(dir, tree) {
  writeTree(dir, tree)
  git(dir, ["init", "-b", "main"])
  commitAll(dir, "fixture")
}

const shortSha = (dir, ref = "HEAD") => git(dir, ["rev-parse", "--short", ref])

const cfg = (home) => join(home, ".config", "opencode")

const registryFile = (home) => join(cfg(home), "ocm", "registry.json")

const MP = "mp--one"

const ADDED_AT = "2026-09-01T10:00:00.000Z"

const SKILL = (name) => `---\nname: ${name}\ndescription: ${name} guidance\n---\n\n# ${name}\n\nUse the house style.\n`

function v1Registry(home) {
  const dir = join(home, ".cache", "ocm", "marketplaces", MP)
  return {
    version: 1,
    marketplaces: {
      [MP]: {
        url: "https://github.com/example/mp",
        path: "https://github.com/example/mp",
        dir, addedAt: ADDED_AT,
        plugins: {
          adw: {
            source: join(dir, "plugins", "adw"),
            components: { command: ["commit.md"], skill: ["python-style", "code-review"] },
          },
        },
      },
    },
  }
}

// migration and packaging — absorbed from test/phase13-packaging.mjs
{
// the pre-08 global stamp: one throttle timestamp shared by all marketplaces
const STAMP_AT = "2026-09-08T09:00:00.000Z"

// A home in the layout the migration starts from: legacy loader files in
// plugins/, a v1 registry with absolute sources, the global sync stamp, one
// symlink per plugin to its whole skills/ dir, and ocm--<mp> containers.
function buildLegacyHome(home) {
  const mpDir = join(home, ".cache", "ocm", "marketplaces", MP)
  writeTree(mpDir, { plugins: { adw: {
    commands: { "commit.md": "---\ndescription: commit helper\n---\n\nBody.\n" },
    skills: { "python-style": { "SKILL.md": SKILL("python-style") }, "code-review": { "SKILL.md": SKILL("code-review") } },
  } } })
  const skillsDir = join(home, ".cache", "ocm", "links", MP, "skills")
  mkdirSync(skillsDir, { recursive: true })
  symlinkSync(join(mpDir, "plugins", "adw", "skills"), join(skillsDir, "adw"))
  writeTree(join(home, ".cache", "ocm"), { "last-sync.json": `${JSON.stringify({ at: STAMP_AT }, null, 2)}\n` })
  writeTree(cfg(home), {
    plugins: {
      "ocm-core.js": "// old ocm core\n",
      "ocm-ui.js": "// old ocm ui\n",
      "ocm-registry.json": `${JSON.stringify(v1Registry(home), null, 2)}\n`,
      "user-plugin.js": 'export default { id: "mine", server: async () => ({}) }\n',
    },
    "tui.json": `${JSON.stringify({ theme: { primary: "#ff0000" }, plugin: ["./plugins/ocm-ui.js", "./user-tui.js"] }, null, 2)}\n`,
    "opencode.json": `${JSON.stringify({ model: "claude-sonnet-4-6", skills: { paths: [skillsDir, join(home, "my-skills")] } }, null, 2)}\n`,
    commands: { "mine.md": "# user command\n", [`ocm--${MP}`]: { "commit.md": "# legacy container\n" } },
    agents: { "mine.md": "# user agent\n", [`ocm--${MP}`]: { "reviewer.md": "# legacy container\n" } },
  })
  return skillsDir
}

phase("1. a pre-migration home ends fully migrated: files moved, registry upgraded, tui.json rewritten, skills relinked, mapping printed", async (home) => {
  const skillsDir = buildLegacyHome(home)
  const result = ocm(home, "list")
  const output = `${result.stdout}\n${result.stderr}`
  if (result.status !== 0) throw new Error(`ocm list exited ${result.status} on the pre-migration home:\n${output}`)

  // files moved: the runtime modules live in ocm/, plugins/ holds only the
  // loader and the user's own plugin
  assertFileExists(join(cfg(home), "ocm", "core.js"))
  assertFileExists(join(cfg(home), "ocm", "ui.js"))
  expect(readdirSync(join(cfg(home), "plugins")).sort()).toEqual(["ocm-loader.js", "user-plugin.js"])

  // registry upgraded on disk: v2, marketplace-relative source, stamp folded
  const registry = JSON.parse(readFileSync(registryFile(home), "utf8"))
  expect(registry.version).toBe(2)
  const entry = registry.marketplaces[MP]
  expect(entry.plugins.adw.source).toBe("plugins/adw")
  expect(entry.lastSync).toEqual({ at: STAMP_AT, ok: true, error: null })
  assertAbsent(join(home, ".cache", "ocm", "last-sync.json"))

  // tui.json entry rewritten; the user's key and entry survive
  const tui = JSON.parse(readFileSync(join(cfg(home), "tui.json"), "utf8"))
  expect(tui.plugin).toContain("./ocm/ui.js")
  expect(tui.plugin).not.toContain("./plugins/ocm-ui.js")
  expect(tui.plugin).toContain("./user-tui.js")
  expect(tui.theme).toEqual({ primary: "#ff0000" })

  // skills relinked into the per-root cache namespace: one mirror per skill
  // with a rendered, namespaced SKILL.md
  const namespaced = join(rootCacheDir(home), "links", MP, "skills")
  for (const skill of ["python-style", "code-review"]) {
    const rendered = join(namespaced, `adw--${skill}`, "SKILL.md")
    assertFileExists(rendered)
    if (lstatSync(rendered).isSymbolicLink()) throw new Error(`expected a rendered regular file at ${rendered}, found a symlink`)
    const content = readFileSync(rendered, "utf8")
    expect(content).toContain(`name: "adw:${skill}"`)
    expect(content).toContain("ocm: rendered from")
  }
  // brief 38: the pre-spec-03 whole-dir symlink is taken down, not moved —
  // the same run's relink already printed its mapping and rendered the
  // mirrors, and a symlink moved into the namespace would re-trigger the
  // relink migration on every later run forever
  assertAbsent(join(skillsDir, "adw"))
  assertAbsent(join(namespaced, "adw"))

  // legacy ocm--<mp> containers cleaned up; the user's files survive (ownership)
  assertAbsent(join(cfg(home), "commands", `ocm--${MP}`))
  assertAbsent(join(cfg(home), "agents", `ocm--${MP}`))
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# user command\n")
  expect(readFileSync(join(cfg(home), "agents", "mine.md"), "utf8")).toBe("# user agent\n")
  expect(readFileSync(join(cfg(home), "plugins", "user-plugin.js"), "utf8")).toBe('export default { id: "mine", server: async () => ({}) }\n')

  // config safety: the user's keys and skills path survive outside ocm's entry
  const config = JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8"))
  expect(config.model).toBe("claude-sonnet-4-6")
  expect(config.skills.paths).toContain(join(home, "my-skills"))
  expect(config.skills.paths).toContain(namespaced)
  // the cache migration rewrote the old links path to the namespace one,
  // deduped against the entry the relink had already added
  expect(config.skills.paths.includes(skillsDir)).toBe(false)
  expect(config.skills.paths.filter((p) => p === namespaced).length).toBe(1)
  // brief 38: the old-layout cache moved into the namespace — the clone lives
  // there, the registry dir points at it, and the command link the relink
  // created (against the still-old clone) was re-pointed with it
  const ns = rootCacheDir(home)
  assertAbsent(join(home, ".cache", "ocm", "marketplaces"))
  assertAbsent(join(home, ".cache", "ocm", "links"))
  expect(registry.marketplaces[MP].dir).toBe(join(ns, "marketplaces", MP))
  assertFileExists(join(ns, "marketplaces", MP, "plugins", "adw", "skills", "python-style", "SKILL.md"))
  expect(realpathSync(join(cfg(home), "commands", "adw:commit.md"))).toBe(
    realpathSync(join(ns, "marketplaces", MP, "plugins", "adw", "commands", "commit.md")),
  )

  // the old → new skill mapping is printed: one line naming both forms
  for (const skill of ["python-style", "code-review"]) {
    const mapped = output.split("\n").find((line) => line.includes(`adw:${skill}`) && line.split(`adw:${skill}`).join("").includes(skill))
    if (!mapped) throw new Error(`expected a line mapping ${skill} -> adw:${skill} in the output:\n${output}`)
  }

  // no plugin-load errors attributable to ocm files
}, 600_000)

test("2. migration on a fresh home is a no-op; a second run on a migrated home changes nothing", async () => {
  await withFakeHome(async (home) => {
    writeTree(cfg(home), {
      "opencode.json": `${JSON.stringify({ model: "claude-sonnet-4-6" }, null, 2)}\n`,
      "tui.json": `${JSON.stringify({ theme: { primary: "#ff0000" }, plugin: ["./user-tui.js"] }, null, 2)}\n`,
      commands: { "mine.md": "# user command\n" },
    })
    const configBytes = readFileSync(join(cfg(home), "opencode.json"), "utf8")
    const tuiBytes = readFileSync(join(cfg(home), "tui.json"), "utf8")
    const fresh = ocm(home, "list")
    if (fresh.status !== 0) throw new Error(`ocm list exited ${fresh.status} on a fresh home:\n${fresh.stdout}\n${fresh.stderr}`)
    assertAbsent(join(cfg(home), "ocm"))
    assertAbsent(join(home, ".cache", "ocm"))
    expect(readFileSync(join(cfg(home), "opencode.json"), "utf8")).toBe(configBytes)
    expect(readFileSync(join(cfg(home), "tui.json"), "utf8")).toBe(tuiBytes)
  })
  await withFakeHome(async (home) => {
    buildLegacyHome(home)
    const first = ocm(home, "list")
    if (first.status !== 0) throw new Error(`ocm list exited ${first.status}:\n${first.stdout}\n${first.stderr}`)
    // precondition: the first run did migrate — idempotence of a no-op is vacuous
    expect(JSON.parse(readFileSync(registryFile(home), "utf8")).version).toBe(2)
    // brief 38 precondition: the first run also moved the old-layout cache
    // away — a no-op check against an unmigrated cache is vacuous
    assertAbsent(join(home, ".cache", "ocm", "marketplaces"))
    // the migrated state is the namespaced one: mirrors, not the old layout
    const namespaced = join(rootCacheDir(home), "links", MP, "skills")
    const before = migratedState(home, namespaced)
    const second = ocm(home, "list")
    if (second.status !== 0) throw new Error(`second ocm list exited ${second.status}:\n${second.stdout}\n${second.stderr}`)
    expect(migratedState(home, namespaced)).toEqual(before)
    const output = `${second.stdout}\n${second.stderr}`
    if (/migrat|moved|relink/i.test(output)) throw new Error(`the second run reported migration work:\n${output}`)
  })
}, 240_000)

// bytes, mtimes and directory listings of everything the migration owns
function migratedState(home, skillsDir) {
  const listings = ["ocm", "plugins", "commands", "agents"].map((d) => readdirSync(join(cfg(home), d)).sort())
  const files = [
    registryFile(home), join(cfg(home), "tui.json"), join(cfg(home), "opencode.json"),
    ...readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(skillsDir, e.name, "SKILL.md")),
  ]
  // brief 38: the namespaced cache — the clone and the whole links tree,
  // symlinks by target
  const cache = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isSymbolicLink()) cache.push([path, readlinkSync(path)])
      else cache.push([path, readFileSync(path, "utf8"), statSync(path).mtimeMs])
    }
  }
  for (const part of ["marketplaces", "links"]) walk(join(rootCacheDir(home), part))
  cache.push(readlinkSync(join(cfg(home), "commands", "adw:commit.md")))
  return { listings, files: files.map((p) => [readFileSync(p, "utf8"), statSync(p).mtimeMs]), cache }
}

// brief 38: the old-layout cache migrates into the per-root namespace —
// detect-first under the lock, before dispatch, on any command including a
// read-only one

// A post-spec-08, post-spec-03, pre-38 home: the cache sits at the old layout
// with a v2 registry referencing it, so only the cache migration can fire (no
// legacy plugins, no v1 registry, no ocm-- containers, no legacy whole-dir
// symlinks). The stamp is invalid JSON, so foldSyncStamp cannot consume it —
// moving it is its only way out of the old layout.
const TS = "2026-09-01T00-00-00-000Z"

function v2Registry(dir) {
  return {
    version: 2,
    marketplaces: {
      [MP]: {
        url: "https://github.com/example/mp",
        dir,
        local: false, addedAt: ADDED_AT, mode: "auto",
        ref: null, revision: null, syncIntervalMs: null,
        trust: { code: "granted" }, lastSync: null,
        plugins: {
          adw: {
            source: "plugins/adw",
            components: { command: ["commit.md"], skill: ["python-style"] },
            enabled: true, installedAt: ADDED_AT, version: null, manifest: {},
          },
        },
      },
    },
  }
}

function buildOldCacheHome(home) {
  const oldCache = join(home, ".cache", "ocm")
  const oldClone = join(oldCache, "marketplaces", MP)
  gitRepo(oldClone, { plugins: { adw: {
    commands: { "commit.md": "---\ndescription: commit helper\n---\n\nBody.\n" },
    skills: { "python-style": { "SKILL.md": SKILL("python-style"), "reference.md": "# house references\n" } } },
  } })
  const oldSkills = join(oldCache, "links", MP, "skills")
  const mirror = join(oldSkills, "adw--python-style")
  writeTree(mirror, {
    "SKILL.md": `---\nname: "adw:python-style"\ndescription: python-style guidance\n---\n\n# python-style\n\nUse the house style.\n<!-- ocm: rendered from plugins/adw/skills/python-style/SKILL.md @ ${shortSha(oldClone)} -->\n`,
  })
  // a mirror's non-SKILL entries are symlinks into the clone (spec 03)
  symlinkSync(join(oldClone, "plugins", "adw", "skills", "python-style", "reference.md"), join(mirror, "reference.md"))
  writeFileSync(join(mirror, "my-notes.md"), "# dropped into the mirror by the user\n")
  const oldDisplaced = join(oldCache, "displaced", TS)
  const dest = join(cfg(home), "agents", "adw:reviewer.md")
  const displacedCopy = join(oldDisplaced, dest)
  mkdirSync(dirname(displacedCopy), { recursive: true })
  writeFileSync(displacedCopy, "# my own reviewer\n")
  writeTree(oldCache, {
    "displaced-records.json": `${JSON.stringify([{ marketplace: MP, plugin: "adw", dest, dir: oldDisplaced }], null, 2)}\n`,
    "last-sync.json": "not json\n",
    "user-notes.txt": "# a user file at the cache root, outside every moved item\n",
  })
  writeTree(cfg(home), {
    ocm: { "registry.json": `${JSON.stringify(v2Registry(oldClone), null, 2)}\n` },
    "opencode.json": `${JSON.stringify({ model: "claude-sonnet-4-6", skills: { paths: [oldSkills, join(home, "my-skills")] } }, null, 2)}\n`,
    "tui.json": `${JSON.stringify({ theme: { primary: "#ff0000" }, plugin: ["./user-tui.js"] }, null, 2)}\n`,
    commands: { "mine.md": "# user command\n" },
    agents: { "mine.md": "# user agent\n" },
  })
  symlinkSync(join(oldClone, "plugins", "adw", "commands", "commit.md"), join(cfg(home), "commands", "adw:commit.md"))
  return { oldCache, oldClone, oldSkills, oldDisplaced, dest }
}

phase("5. an old-layout cache referenced by the registry migrates into the namespace: moved, rewritten, links still resolve, each move reported", async (home) => {
  const { oldCache, oldSkills, dest } = buildOldCacheHome(home)
  const ns = rootCacheDir(home)
  const result = ocm(home, "list")
  const output = `${result.stdout}\n${result.stderr}`
  if (result.status !== 0) throw new Error(`ocm list exited ${result.status} on the old-layout cache:\n${output}`)

  // every old-layout item left ~/.cache/ocm/ and lives in the namespace: the
  // clone with its history, the links tree, the displaced copy, the records
  // file and the unconsumable stamp
  const items = ["marketplaces", "links", "displaced", "displaced-records.json", "last-sync.json"]
  for (const item of items) assertAbsent(join(oldCache, item))
  const nsClone = join(ns, "marketplaces", MP)
  git(nsClone, ["rev-parse", "HEAD"]) // throws if the clone's history did not survive the move
  assertFileExists(join(ns, "links", MP, "skills", "adw--python-style", "SKILL.md"))
  assertFileExists(join(join(ns, "displaced", TS), dest))
  assertFileExists(join(ns, "displaced-records.json"))
  assertFileExists(join(ns, "last-sync.json"))

  // recorded absolute paths rewritten: the registry dir, the displaced
  // record's dir (its dest points into the config dir and stays), and
  // skills.paths — old entry gone, namespace entry present exactly once
  const registry = JSON.parse(readFileSync(registryFile(home), "utf8"))
  expect(registry.marketplaces[MP].dir).toBe(nsClone)
  expect(JSON.parse(readFileSync(join(ns, "displaced-records.json"), "utf8"))).toEqual([
    { marketplace: MP, plugin: "adw", dest, dir: join(ns, "displaced", TS) },
  ])
  const config = JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8"))
  const nsSkills = join(ns, "links", MP, "skills")
  if (config.skills.paths.includes(oldSkills)) throw new Error(`skills.paths still holds the old-layout path ${oldSkills}: ${JSON.stringify(config.skills.paths)}`)
  if (config.skills.paths.filter((p) => p === nsSkills).length !== 1) {
    throw new Error(`expected skills.paths to hold ${nsSkills} exactly once: ${JSON.stringify(config.skills.paths)}`)
  }
  expect(config.model).toBe("claude-sonnet-4-6")
  expect(config.skills.paths).toContain(join(home, "my-skills"))

  // links still resolve, re-pointed at the namespace clone: the config-dir
  // command link and the mirror-internal reference.md symlink
  for (const [link, source] of [
    [join(cfg(home), "commands", "adw:commit.md"), join(nsClone, "plugins", "adw", "commands", "commit.md")],
    [join(ns, "links", MP, "skills", "adw--python-style", "reference.md"), join(nsClone, "plugins", "adw", "skills", "python-style", "reference.md")],
  ]) {
    const target = readlinkSync(link)
    if (!target.startsWith(`${nsClone}/`)) throw new Error(`expected ${link} -> somewhere under ${nsClone}, found ${target}`)
    expect(realpathSync(link)).toBe(realpathSync(source))
  }

  // one moved line per item, on stdout, naming both paths
  const moved = result.stdout.split("\n").filter((line) => line.startsWith("moved "))
  for (const item of items) {
    const line = `moved ${join(oldCache, item)} -> ${join(ns, item)}`
    if (!moved.includes(line)) throw new Error(`expected "${line}" in stdout:\n${result.stdout}`)
  }
  if (moved.length !== items.length) throw new Error(`expected ${items.length} moved lines, got:\n${moved.join("\n")}`)

  // invariants: user keys and files survive (config safety, ownership); a
  // user file at the cache root stays at its exact old path; one inside the
  // moved links tree rides along
  expect(readFileSync(join(cfg(home), "tui.json"), "utf8")).toBe(`${JSON.stringify({ theme: { primary: "#ff0000" }, plugin: ["./user-tui.js"] }, null, 2)}\n`)
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# user command\n")
  expect(readFileSync(join(cfg(home), "agents", "mine.md"), "utf8")).toBe("# user agent\n")
  expect(readFileSync(join(oldCache, "user-notes.txt"), "utf8")).toBe("# a user file at the cache root, outside every moved item\n")
  expect(readFileSync(join(ns, "links", MP, "skills", "adw--python-style", "my-notes.md"), "utf8")).toBe("# dropped into the mirror by the user\n")

  // no plugin-load errors, and the components still resolve in opencode
  const probe = opencodeProbe(cfg(home), home)
  if (probe.available && !probe.unreliable) {
    expect(probe.skills.join("\n")).toContain("adw:python-style")
    expect(probe.commands.join("\n")).toContain("adw:commit")
    expect(probe.pluginErrors).toEqual([])
  }
}, 600_000)

// bytes, mtimes and symlink targets of everything the cache migration owns
// or re-pointed, plus the user file left at the cache root
function cacheState(home) {
  const ns = rootCacheDir(home)
  const entries = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isSymbolicLink()) entries.push([path, readlinkSync(path)])
      else entries.push([path, readFileSync(path, "utf8"), statSync(path).mtimeMs])
    }
  }
  for (const part of ["marketplaces", "links", "displaced"]) walk(join(ns, part))
  for (const path of [
    join(ns, "displaced-records.json"), join(ns, "last-sync.json"),
    registryFile(home), join(cfg(home), "opencode.json"), join(cfg(home), "tui.json"),
    join(home, ".cache", "ocm", "user-notes.txt"),
  ]) entries.push([path, readFileSync(path, "utf8"), statSync(path).mtimeMs])
  entries.push([join(cfg(home), "commands", "adw:commit.md"), readlinkSync(join(cfg(home), "commands", "adw:commit.md"))])
  return entries
}

test("6. a second run on the migrated cache is a no-op: no migration words, byte- and mtime-identical state", async () => {
  await withFakeHome(async (home) => {
    buildOldCacheHome(home)
    const first = ocm(home, "list")
    if (first.status !== 0) throw new Error(`ocm list exited ${first.status}:\n${first.stdout}\n${first.stderr}`)
    // precondition: the first run moved the old layout away — a no-op check
    // against an unmigrated cache is vacuous
    assertAbsent(join(home, ".cache", "ocm", "marketplaces"))
    const before = cacheState(home)
    const second = ocm(home, "list")
    if (second.status !== 0) throw new Error(`second ocm list exited ${second.status}:\n${second.stdout}\n${second.stderr}`)
    expect(cacheState(home)).toEqual(before)
    const output = `${second.stdout}\n${second.stderr}`
    if (/migrat|moved|relink/i.test(output)) throw new Error(`the second run reported migration work:\n${output}`)
  })
}, 240_000)

phase("7b. a cache migration interrupted between the move and the rewrite finishes on the next command (review finding)", async (home) => {
  // The moves happen before the registry rewrite. A crash in that window
  // leaves the old directories gone and the registry still naming them, and a
  // predicate requiring *both* halves to be incomplete would call that state
  // finished — the clone unreachable for good, with a local marketplace not
  // even recoverable by re-cloning.
  const remote = join(home, "remote-mp")
  gitRepo(remote, { plugins: { adw: {
    "plugin.json": `${JSON.stringify({ description: "a demo plugin" }, null, 2)}\n`,
    commands: { "commit.md": "---\ndescription: commit\n---\n\nbody\n" },
  } } })
  expect(ocm(home, "add", `file://${remote}`).status).toBe(0)

  const oldPrefix = join(home, ".cache", "ocm", "marketplaces")
  const registry = JSON.parse(readFileSync(registryFile(home), "utf8"))
  const [name, entry] = Object.entries(registry.marketplaces)[0]
  const clone = entry.dir
  if (!clone.includes(join(".cache", "ocm", "roots"))) throw new Error(`expected a namespaced clone, got ${clone}`)
  // rewind only the registry: the clone stays where the move already put it
  entry.dir = join(oldPrefix, name)
  writeFileSync(registryFile(home), `${JSON.stringify(registry, null, 2)}\n`)
  assertAbsent(entry.dir)

  const healed = ocm(home, "list")
  if (healed.status !== 0) throw new Error(`ocm list exited ${healed.status}:\n${healed.stdout}\n${healed.stderr}`)
  const after = JSON.parse(readFileSync(registryFile(home), "utf8")).marketplaces[name]
  if (after.dir.startsWith(`${oldPrefix}/`)) {
    throw new Error(`the registry still names the old-layout path after a later command: ${after.dir}`)
  }
  expect(after.dir).toBe(clone)
}, 300_000)

phase("7. an old-layout cache no registry references is reported and left alone", async (home) => {
  const oldCache = join(home, ".cache", "ocm")
  writeTree(join(oldCache, "marketplaces", "stray-mp"), { "README.md": "# a stray clone\n" })
  writeTree(join(oldCache, "links", "stray-mp", "skills"), { "notes.md": "# a stray links tree\n" })
  const configBytes = `${JSON.stringify({ model: "claude-sonnet-4-6" }, null, 2)}\n`
  writeTree(cfg(home), {
    "opencode.json": configBytes,
    commands: { "mine.md": "# user command\n" },
  })
  const result = ocm(home, "list")
  const output = `${result.stdout}\n${result.stderr}`
  if (result.status !== 0) throw new Error(`ocm list exited ${result.status}:\n${output}`)
  // nothing moved, nothing deleted: both items byte-identical at their old
  // paths, and no namespace was created for them
  expect(readFileSync(join(oldCache, "marketplaces", "stray-mp", "README.md"), "utf8")).toBe("# a stray clone\n")
  expect(readFileSync(join(oldCache, "links", "stray-mp", "skills", "notes.md"), "utf8")).toBe("# a stray links tree\n")
  assertAbsent(rootCacheDir(home))
  // one stderr line per item, naming the path and the reasoning: it was left
  // alone because it may belong to another config root
  const reported = result.stderr.split("\n").filter((line) => line.includes(oldCache))
  for (const item of [join(oldCache, "marketplaces"), join(oldCache, "links")]) {
    const line = reported.find((l) => l.includes(item))
    if (!line) throw new Error(`expected a stderr line naming ${item}:\n${result.stderr}`)
    if (!/left (?:alone|in place)|another config root/i.test(line)) {
      throw new Error(`the line for ${item} does not say it was left alone / may belong to another config root:\n${line}`)
    }
  }
  if (reported.length !== 2) throw new Error(`expected one stderr line per old-layout item, got:\n${reported.join("\n")}`)
  // the report is read-only: no lock was taken, so the config root's ocm/
  // dir was never even created
  assertAbsent(join(cfg(home), "ocm"))
  // invariants: the user's keys and files survive untouched
  expect(readFileSync(join(cfg(home), "opencode.json"), "utf8")).toBe(configBytes)
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# user command\n")
})

test("3. ocm/core.js imports nothing outside node:* (static check)", () => {
  // walk every module ocm/core.js pulls in: a bare specifier must be a node:*
  // builtin, a relative one must stay inside loader/ (no src/ imports)
  const seen = new Set()
  const queue = [join(LOADER_DIR, "core.js")]
  while (queue.length) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
      if (spec.startsWith(".")) {
        const resolved = resolve(dirname(file), spec)
        if (!resolved.startsWith(`${LOADER_DIR}/`)) {
          throw new Error(`${file} imports "${spec}" outside loader/ — the runtime core must not depend on src/`)
        }
        queue.push(resolved)
      } else if (!spec.startsWith("node:")) {
        throw new Error(`${file} imports "${spec}" — ocm/core.js may only use node:* builtins (it runs inside opencode's runtime)`)
      }
    }
  }
})

// every import/require specifier in a source file; real specifiers contain no
// whitespace or quotes, which keeps string literals out of the match
function importSpecifiers(source) {
  const specs = []
  const patterns = [/\bfrom\s*["']([^"'\s]+)["']/g, /\b(?:import|require)\s*\(?\s*["']([^"'\s]+)["']/g]
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) specs.push(match[1])
  return specs
}

phase("4. the published package's bin resolves to a working ocm on a clean install", async (home) => {
  const pkg = JSON.parse(readFileSync(PACKAGE, "utf8"))
  expect(pkg.name).toBe("@wntic/ocm")
  expect(pkg.publishConfig?.access).toBe("public")
  const bin = pkg.bin?.ocm
  if (typeof bin !== "string" || !bin) throw new Error(`expected "bin"."ocm" to name the entry file in ${PACKAGE}`)
  const binPath = join(REPO_ROOT, bin)
  assertFileExists(binPath)
  const result = spawnSync(process.execPath, [binPath, "--help"], {
    env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 60_000,
  })
  if (result.status !== 0) throw new Error(`the bin entry ${binPath} exited ${result.status} under a clean home:\n${result.stderr}`)
  if (!result.stdout.includes("ocm")) throw new Error(`expected the ocm help text from ${binPath}:\n${result.stdout}`)
})
}
