// Migration and packaging: the legacy home layout migrates
// automatically, and the published bin resolves.

import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, symlinkSync, writeFileSync } from "node:fs"
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
  // brief 43 §1: the migration state file, when a migration wrote one
  const stateFile = join(rootCacheDir(home), "cache-migration.json")
  if (existsSync(stateFile)) files.push(stateFile)
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

  // every old-layout item this root owns left ~/.cache/ocm/ and lives in the
  // namespace: the clone with its history, the links tree, the displaced
  // copy and the records file. The sync stamp is a throttle shared by every
  // root: it is copied into the namespace and the original stays at the old
  // path — observable here because the fixture's stamp is invalid JSON, so
  // foldSyncStamp cannot have consumed it before the cache migration ran
  const items = ["marketplaces", "links", "displaced", "displaced-records.json"]
  for (const item of items) assertAbsent(join(oldCache, item))
  const nsClone = join(ns, "marketplaces", MP)
  git(nsClone, ["rev-parse", "HEAD"]) // throws if the clone's history did not survive the move
  assertFileExists(join(ns, "links", MP, "skills", "adw--python-style", "SKILL.md"))
  assertFileExists(join(join(ns, "displaced", TS), dest))
  assertFileExists(join(ns, "displaced-records.json"))
  assertFileExists(join(ns, "last-sync.json"))
  assertFileExists(join(oldCache, "last-sync.json"))
  expect(readFileSync(join(oldCache, "last-sync.json"), "utf8")).toBe("not json\n")

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

  // one moved line per owned item, on stdout, naming both paths: the clone
  // and the links mirror move per marketplace, not as whole top-level
  // directories. The displaced copy's line is not exact-line-asserted — its
  // move is proven by the path assertions above
  const moved = result.stdout.split("\n").filter((line) => line.startsWith("moved "))
  for (const [from, to] of [
    [join(oldCache, "marketplaces", MP), join(ns, "marketplaces", MP)],
    [join(oldCache, "links", MP), join(ns, "links", MP)],
  ]) {
    const line = `moved ${from} -> ${to}`
    if (!moved.includes(line)) throw new Error(`expected "${line}" in stdout:\n${result.stdout}`)
  }
  // the stamp is copied, never moved: no moved line names it
  for (const line of moved) {
    if (line.includes("last-sync.json")) throw new Error(`the shared sync stamp must not be reported moved:\n${line}`)
  }
  // everything at the old layout was this root's, so nothing warns about
  // leftovers (the convergence property)
  for (const line of result.stderr.split("\n")) {
    if (/left (?:alone|in place)|another config root/i.test(line)) {
      throw new Error(`everything in this single-root home was ours, but a warning names leftovers:\n${line}`)
    }
  }

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
  // brief 43 §1: the migration state file, when a migration wrote one
  const stateFile = join(ns, "cache-migration.json")
  if (existsSync(stateFile)) entries.push([stateFile, readFileSync(stateFile, "utf8"), statSync(stateFile).mtimeMs])
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

// brief 39 §6: a home whose marketplaces are all local. Every registry dir is
// the user's own source directory, outside the cache, so the dir-prefix
// predicate never fired — the old-layout links and displaced trees stayed put
// forever while reportUnreferencedOldCache wrongly called them another root's.
// Migration is needed when the registry holds a name with an old-layout links
// tree or a displaced record; the same machinery moves them and the warning
// stops. A tree no registry holds keeps warning.

// An all-local home: one local marketplace whose source directory sits
// outside the cache, plus this root's old-layout trees. `skill` false builds
// the commands-only shape with no links tree; `displaced` false leaves the
// old layout empty entirely.
function buildLocalHome(home, { skill = true, displaced = true } = {}) {
  const source = join(home, "src-mp")
  const adw = { commands: { "commit.md": "---\ndescription: commit helper\n---\n\nBody.\n" } }
  if (skill) adw.skills = { "python-style": { "SKILL.md": SKILL("python-style") } }
  writeTree(source, { plugins: { adw } })
  const dir = realpathSync(source)
  const components = skill ? { command: ["commit.md"], skill: ["python-style"] } : { command: ["commit.md"] }
  const oldCache = join(home, ".cache", "ocm")
  const oldSkills = join(oldCache, "links", MP, "skills")
  const paths = [join(home, "my-skills")]
  if (skill) {
    writeTree(join(oldSkills, "adw--python-style"), {
      "SKILL.md": `---\nname: "adw:python-style"\ndescription: python-style guidance\n---\n\n# python-style\n\nUse the house style.\n<!-- ocm: rendered from plugins/adw/skills/python-style/SKILL.md @ 0000000 -->\n`,
    })
    paths.unshift(oldSkills)
  }
  const dest = join(cfg(home), "agents", "adw:reviewer.md")
  if (displaced) {
    const oldDisplaced = join(oldCache, "displaced", TS)
    mkdirSync(dirname(join(oldDisplaced, dest)), { recursive: true })
    writeFileSync(join(oldDisplaced, dest), "# my own reviewer\n")
    writeTree(oldCache, {
      "displaced-records.json": `${JSON.stringify([{ marketplace: MP, plugin: "adw", dest, dir: oldDisplaced }], null, 2)}\n`,
    })
  }
  writeTree(cfg(home), {
    ocm: { "registry.json": `${JSON.stringify(localRegistry(dir, components), null, 2)}\n` },
    "opencode.json": `${JSON.stringify({ model: "claude-sonnet-4-6", skills: { paths } }, null, 2)}\n`,
    commands: { "mine.md": "# user command\n" },
  })
  symlinkSync(join(dir, "plugins", "adw", "commands", "commit.md"), join(cfg(home), "commands", "adw:commit.md"))
  return { dir, oldCache, oldSkills, dest }
}

// the v2 registry shape with a local marketplace: url and dir are the user's
// source directory, stored post-realpath the way a real add stores them
function localRegistry(dir, components) {
  return {
    version: 2,
    marketplaces: {
      [MP]: {
        url: dir, dir, local: true, addedAt: ADDED_AT, mode: "auto",
        ref: null, revision: null, syncIntervalMs: null,
        trust: { code: "granted" }, lastSync: null,
        plugins: {
          adw: {
            source: "plugins/adw", components,
            enabled: true, installedAt: ADDED_AT, version: null, manifest: {},
          },
        },
      },
    },
  }
}

phase("8. an all-local home's old-layout links and displaced trees migrate into the namespace, and the cross-root warning stops", async (home) => {
  const { dir, oldCache, oldSkills, dest } = buildLocalHome(home)
  const ns = rootCacheDir(home)
  const result = ocm(home, "list")
  const output = `${result.stdout}\n${result.stderr}`
  if (result.status !== 0) throw new Error(`ocm list exited ${result.status} on the all-local home:\n${output}`)

  // the old layout left ~/.cache/ocm/ and lives in the namespace: the links
  // mirror, the displaced copy and the records file
  for (const item of ["links", "displaced", "displaced-records.json"]) assertAbsent(join(oldCache, item))
  const mirror = join(ns, "links", MP, "skills", "adw--python-style", "SKILL.md")
  assertFileExists(mirror)
  expect(readFileSync(mirror, "utf8")).toContain('name: "adw:python-style"')
  assertFileExists(join(ns, "displaced", TS, dest))
  expect(readFileSync(join(ns, "displaced", TS, dest), "utf8")).toBe("# my own reviewer\n")
  expect(JSON.parse(readFileSync(join(ns, "displaced-records.json"), "utf8"))).toEqual([
    { marketplace: MP, plugin: "adw", dest, dir: join(ns, "displaced", TS) },
  ])

  // skills.paths rewritten to the namespace entry; the user's key and path survive
  const config = JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8"))
  const nsSkills = join(ns, "links", MP, "skills")
  if (config.skills.paths.includes(oldSkills)) throw new Error(`skills.paths still holds the old-layout path ${oldSkills}: ${JSON.stringify(config.skills.paths)}`)
  if (config.skills.paths.filter((p) => p === nsSkills).length !== 1) {
    throw new Error(`expected skills.paths to hold ${nsSkills} exactly once: ${JSON.stringify(config.skills.paths)}`)
  }
  expect(config.skills.paths).toContain(join(home, "my-skills"))
  expect(config.model).toBe("claude-sonnet-4-6")

  // the local marketplace is not rewritten: its dir stays the user's source
  const registry = JSON.parse(readFileSync(registryFile(home), "utf8"))
  expect(registry.marketplaces[MP].dir).toBe(dir)
  expect(registry.marketplaces[MP].local).toBe(true)

  // the command link still points into the source directory and resolves
  expect(realpathSync(join(cfg(home), "commands", "adw:commit.md"))).toBe(
    realpathSync(join(dir, "plugins", "adw", "commands", "commit.md")),
  )

  // no unreferenced-old-cache warning: these trees were this root's
  if (/another config root/.test(output)) throw new Error(`the migrated trees were reported as another root's:\n${output}`)
  for (const line of result.stderr.split("\n")) {
    if (line.includes(join(oldCache, "links")) || line.includes(join(oldCache, "displaced"))) {
      throw new Error(`a warning still names an old-layout path as left in place:\n${line}`)
    }
  }

  // ownership: the user's hand-written command survives byte-identical
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# user command\n")
})

phase("9. an all-local home with only displaced trees at the old layout still migrates them", async (home) => {
  const { oldCache, dest } = buildLocalHome(home, { skill: false })
  const ns = rootCacheDir(home)
  const result = ocm(home, "list")
  const output = `${result.stdout}\n${result.stderr}`
  if (result.status !== 0) throw new Error(`ocm list exited ${result.status} on the displaced-only home:\n${output}`)

  // the displaced copy and the records file moved into the namespace, with
  // the record's dir rewritten (its dest points into the config dir and stays)
  for (const item of ["displaced", "displaced-records.json"]) assertAbsent(join(oldCache, item))
  assertFileExists(join(ns, "displaced", TS, dest))
  expect(JSON.parse(readFileSync(join(ns, "displaced-records.json"), "utf8"))).toEqual([
    { marketplace: MP, plugin: "adw", dest, dir: join(ns, "displaced", TS) },
  ])

  // the warning does not fire: the displaced trees were this root's
  if (/another config root/.test(output)) throw new Error(`the migrated displaced trees were reported as another root's:\n${output}`)

  // ownership: the user's hand-written command survives byte-identical
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# user command\n")
})

phase("10. an old-layout links tree the registry does not hold is left in place and still warns", async (home) => {
  buildLocalHome(home, { skill: false, displaced: false })
  const oldCache = join(home, ".cache", "ocm")
  const strangerLinks = join(oldCache, "links", "stranger-mp", "skills")
  writeTree(strangerLinks, { "notes.md": "# a stranger's links tree\n" })
  const result = ocm(home, "list")
  const output = `${result.stdout}\n${result.stderr}`
  if (result.status !== 0) throw new Error(`ocm list exited ${result.status}:\n${output}`)
  // nothing moved, nothing deleted: the stranger tree byte-identical at its
  // old path, and no namespace was created for it
  expect(readFileSync(join(strangerLinks, "notes.md"), "utf8")).toBe("# a stranger's links tree\n")
  assertAbsent(rootCacheDir(home))
  // the warning still fires, naming the old-layout links path and the
  // reasoning: it may belong to a root this invocation cannot see
  const line = result.stderr.split("\n").find((l) => l.includes(join(oldCache, "links")))
  if (!line) throw new Error(`expected a stderr line naming ${join(oldCache, "links")}:\n${result.stderr}`)
  if (!/left (?:alone|in place)|another config root/i.test(line)) {
    throw new Error(`the line does not say the tree was left alone / may belong to another config root:\n${line}`)
  }
  // ownership: the user's hand-written command survives byte-identical
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# user command\n")
})

// brief 43 §2 (F247): the cache migration moves marketplaces, not
// directories. Two config roots can share one old-layout cache, each
// registry naming a different marketplace — each root's migration must move
// only its own clone and mirror, and what remains at the old path is
// unattributable: reported, never touched.

// the file-level ocm() cannot set the child's XDG_CONFIG_HOME, and the
// dual-root phases need exactly that. withFakeHome deletes the variable from
// the environment, so every XDG-root spawn must set it explicitly
function ocmEnv(home, args, env = {}, timeout = 120_000) {
  const r = spawnSync(process.execPath, [OCM_BIN, ...args], {
    env: { ...process.env, HOME: home, ...env }, encoding: "utf8", timeout,
  })
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

// bytes and symlink targets of everything under one or more trees, base64 so
// binary git internals compare exactly — used to prove a tree neither moved,
// changed nor grew
function snapTree(...dirs) {
  const entries = new Map()
  const walk = (dir) => {
    entries.set(dir, "dir")
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isSymbolicLink()) entries.set(path, `link:${readlinkSync(path)}`)
      else entries.set(path, readFileSync(path).toString("base64"))
    }
  }
  for (const dir of dirs) walk(dir)
  return entries
}

// compares a before-snapshot against the trees' current state; a root dir
// that no longer exists reads as an empty tree, so a swallowed marketplace
// fails as "deleted or moved" rather than an ENOENT
function assertTreeUnchanged(before, dirs, what) {
  const after = dirs.every((dir) => existsSync(dir)) ? snapTree(...dirs) : new Map()
  for (const [path, value] of before) {
    if (!after.has(path)) throw new Error(`${what}: ${path} was deleted or moved by the cache migration`)
    if (after.get(path) !== value) throw new Error(`${what}: ${path} was modified by the cache migration`)
  }
  for (const path of after.keys()) {
    if (!before.has(path)) throw new Error(`${what}: unexpected new entry at ${path}`)
  }
}

const MP_A = "mp--alpha"
const MP_B = "mp--beta"

// one marketplace's half of the shared cache: a git clone plus its mirror
function sharedMarketplace(oldCache, mp, plugin, skill) {
  const clone = join(oldCache, "marketplaces", mp)
  gitRepo(clone, { plugins: { [plugin]: {
    commands: { "commit.md": `---\ndescription: ${plugin} commit helper\n---\n\nBody.\n` },
    skills: { [skill]: { "SKILL.md": SKILL(skill) } },
  } } })
  writeTree(join(oldCache, "links", mp, "skills", `${plugin}--${skill}`), {
    "SKILL.md": `---\nname: "${plugin}:${skill}"\ndescription: ${skill} guidance\n---\n\n# ${skill}\n\nUse the house style.\n<!-- ocm: rendered from plugins/${plugin}/skills/${skill}/SKILL.md @ ${shortSha(clone)} -->\n`,
  })
  return { mp, plugin, skill, clone, sha: git(clone, ["rev-parse", "HEAD"]) }
}

// the v2 registry shape for one marketplace of the shared cache, its dir
// pointing at the old-layout clone
function sharedRegistry(market) {
  return {
    version: 2,
    marketplaces: {
      [market.mp]: {
        url: `https://github.com/example/${market.mp}`,
        dir: market.clone, local: false, addedAt: ADDED_AT, mode: "auto",
        ref: null, revision: null, syncIntervalMs: null,
        trust: { code: "granted" }, lastSync: null,
        plugins: {
          [market.plugin]: {
            source: `plugins/${market.plugin}`,
            components: { command: ["commit.md"], skill: [market.skill] },
            enabled: true, installedAt: ADDED_AT, version: null, manifest: {},
          },
        },
      },
    },
  }
}

// one config root: a registry naming only its marketplace, a skills.paths
// entry for its old mirror, and a command link into the old clone
function sharedRoot(rootDir, market, oldSkills) {
  writeTree(rootDir, {
    ocm: { "registry.json": `${JSON.stringify(sharedRegistry(market), null, 2)}\n` },
    "opencode.json": `${JSON.stringify({ model: "claude-sonnet-4-6", skills: { paths: [oldSkills] } }, null, 2)}\n`,
    commands: { "mine.md": "# user command\n" },
  })
  const commandLink = join(rootDir, "commands", `${market.plugin}:commit.md`)
  symlinkSync(join(market.clone, "plugins", market.plugin, "commands", "commit.md"), commandLink)
  return { dir: rootDir, oldSkills, commandLink }
}

function buildDualRootHome(home) {
  const oldCache = join(home, ".cache", "ocm")
  const xdg = join(home, "xdg")
  const alpha = sharedMarketplace(oldCache, MP_A, "adw", "python-style")
  const beta = sharedMarketplace(oldCache, MP_B, "beta", "lint-style")
  const defaultRoot = sharedRoot(cfg(home), alpha, join(oldCache, "links", MP_A, "skills"))
  const xdgRoot = sharedRoot(join(xdg, "opencode"), beta, join(oldCache, "links", MP_B, "skills"))
  return { oldCache, xdg, alpha, beta, defaultRoot, xdgRoot }
}

// one root's post-migration state: clone with git history, mirror, registry
// dir repointed, command link resolving into the namespace, skills.paths
// rewritten. Config safety and ownership: the user's model key and
// hand-written command survive byte-identical
function assertRootMigrated(home, xdg, market, root) {
  const ns = rootCacheDir(home, xdg)
  const nsClone = join(ns, "marketplaces", market.mp)
  const head = git(nsClone, ["rev-parse", "HEAD"])
  if (head !== market.sha) throw new Error(`expected ${market.mp}'s git history at ${nsClone} (HEAD ${market.sha}), got ${head}`)
  assertFileExists(join(ns, "links", market.mp, "skills", `${market.plugin}--${market.skill}`, "SKILL.md"))
  const registry = JSON.parse(readFileSync(join(root.dir, "ocm", "registry.json"), "utf8"))
  if (registry.marketplaces[market.mp].dir !== nsClone) {
    throw new Error(`expected the registry dir for ${market.mp} to be repointed to ${nsClone}, got ${registry.marketplaces[market.mp].dir}`)
  }
  const resolved = realpathSync(root.commandLink)
  const expected = realpathSync(join(nsClone, "plugins", market.plugin, "commands", "commit.md"))
  if (resolved !== expected) throw new Error(`expected ${root.commandLink} to resolve to ${expected}, got ${resolved}`)
  const config = JSON.parse(readFileSync(join(root.dir, "opencode.json"), "utf8"))
  const nsSkills = join(ns, "links", market.mp, "skills")
  if (config.skills.paths.includes(root.oldSkills)) {
    throw new Error(`skills.paths still holds the old-layout path ${root.oldSkills}: ${JSON.stringify(config.skills.paths)}`)
  }
  if (config.skills.paths.filter((p) => p === nsSkills).length !== 1) {
    throw new Error(`expected skills.paths to hold ${nsSkills} exactly once: ${JSON.stringify(config.skills.paths)}`)
  }
  expect(config.model).toBe("claude-sonnet-4-6")
  expect(readFileSync(join(root.dir, "commands", "mine.md"), "utf8")).toBe("# user command\n")
}

// scoped to the old-layout item paths: the stranded-install notice names
// config roots, not the cache, and must not trip this check
const assertNoOldCacheWarning = (stderr, oldCache, when) => {
  const line = stderr.split("\n").find((l) =>
    ["marketplaces", "links", "displaced", "displaced-records.json"].some((item) => l.includes(join(oldCache, item))),
  )
  if (line) throw new Error(`${when}: a warning still names an old-layout path:\n${line}`)
}

phase("11. dual roots sharing one old-layout cache: the default root's migration moves only its own marketplace, and the XDG root's follows intact", async (home) => {
  const d = buildDualRootHome(home)
  const theirs = snapTree(join(d.oldCache, "marketplaces", MP_B), join(d.oldCache, "links", MP_B))
  const first = ocm(home, "list")
  if (first.status !== 0) throw new Error(`ocm list exited ${first.status} on the default root:\n${first.stdout}\n${first.stderr}`)
  assertRootMigrated(home, undefined, d.alpha, d.defaultRoot)
  assertTreeUnchanged(theirs, [join(d.oldCache, "marketplaces", MP_B), join(d.oldCache, "links", MP_B)], `the XDG root's marketplace ${MP_B}`)
  const second = ocmEnv(home, ["list"], { XDG_CONFIG_HOME: d.xdg })
  if (second.status !== 0) throw new Error(`ocm list exited ${second.status} on the XDG root:\n${second.stdout}\n${second.stderr}`)
  assertRootMigrated(home, d.xdg, d.beta, d.xdgRoot)
  // convergence: everything either root owned has moved, so the second run
  // warns about nothing left at the old path
  assertNoOldCacheWarning(second.stderr, d.oldCache, "after both roots migrated")
}, 600_000)

phase("12. dual roots sharing one old-layout cache: the XDG root's migration moves only its own marketplace, and the default root's follows intact", async (home) => {
  const d = buildDualRootHome(home)
  const theirs = snapTree(join(d.oldCache, "marketplaces", MP_A), join(d.oldCache, "links", MP_A))
  const first = ocmEnv(home, ["list"], { XDG_CONFIG_HOME: d.xdg })
  if (first.status !== 0) throw new Error(`ocm list exited ${first.status} on the XDG root:\n${first.stdout}\n${first.stderr}`)
  assertRootMigrated(home, d.xdg, d.beta, d.xdgRoot)
  assertTreeUnchanged(theirs, [join(d.oldCache, "marketplaces", MP_A), join(d.oldCache, "links", MP_A)], `the default root's marketplace ${MP_A}`)
  const second = ocm(home, "list")
  if (second.status !== 0) throw new Error(`ocm list exited ${second.status} on the default root:\n${second.stdout}\n${second.stderr}`)
  assertRootMigrated(home, undefined, d.alpha, d.defaultRoot)
  assertNoOldCacheWarning(second.stderr, d.oldCache, "after both roots migrated")
}, 600_000)

// brief 43 §2: a displaced record belongs to this root only when its
// marketplace is one of this root's. The other root's record — and the copy
// it names — stay in the old records file at the old path.
phase("13. a displaced record for another root's marketplace is not moved: our record and copy migrate, theirs stay in the old records file at the old path", async (home) => {
  const { oldCache, dest } = buildOldCacheHome(home)
  const ns = rootCacheDir(home)
  const theirMp = "mp--theirs"
  const theirDest = join(cfg(home), "agents", "beta:reviewer.md")
  const theirCopy = join(oldCache, "displaced", TS, theirDest)
  mkdirSync(dirname(theirCopy), { recursive: true })
  writeFileSync(theirCopy, "# another root's reviewer\n")
  const oldRecords = join(oldCache, "displaced-records.json")
  const records = JSON.parse(readFileSync(oldRecords, "utf8"))
  records.push({ marketplace: theirMp, plugin: "beta", dest: theirDest, dir: join(oldCache, "displaced", TS) })
  writeFileSync(oldRecords, `${JSON.stringify(records, null, 2)}\n`)

  const result = ocm(home, "list")
  if (result.status !== 0) throw new Error(`ocm list exited ${result.status}:\n${result.stdout}\n${result.stderr}`)

  // ours moved: the copy under the namespace displaced dir, the record in
  // the namespace records file with dir rewritten to the namespace path
  assertFileExists(join(ns, "displaced", TS, dest))
  expect(JSON.parse(readFileSync(join(ns, "displaced-records.json"), "utf8"))).toEqual([
    { marketplace: MP, plugin: "adw", dest, dir: join(ns, "displaced", TS) },
  ])
  // theirs did not: the copy byte-identical at the old path, the record
  // still in the old records file — which no longer names ours, or the
  // migration would re-fire forever
  assertFileExists(theirCopy)
  expect(readFileSync(theirCopy, "utf8")).toBe("# another root's reviewer\n")
  expect(JSON.parse(readFileSync(oldRecords, "utf8"))).toEqual([
    { marketplace: theirMp, plugin: "beta", dest: theirDest, dir: join(oldCache, "displaced", TS) },
  ])
  // config safety and ownership: the user's keys and hand-written command
  // survive the rewrites byte-identical
  const config = JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8"))
  expect(config.model).toBe("claude-sonnet-4-6")
  expect(config.skills.paths).toContain(join(home, "my-skills"))
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# user command\n")
  // the old file no longer naming our record is what stops the migration
  // re-firing: a second run reports no migration work (the unreferenced
  // warning about their leftovers is expected, and is not migration work)
  const second = ocm(home, "list")
  if (second.status !== 0) throw new Error(`second ocm list exited ${second.status}:\n${second.stdout}\n${second.stderr}`)
  const secondOutput = `${second.stdout}\n${second.stderr}`
  if (/migrat|moved|relink/i.test(secondOutput)) throw new Error(`the second run reported migration work:\n${secondOutput}`)
}, 300_000)

// brief 43 §2: what remains at the old path is by definition unattributable
// — reportUnreferencedOldCache says so without touching it. Nothing under
// old-path marketplaces/ or displaced/ is ever deleted or moved except the
// items this root's registry and records name.
phase("14. unattributable leftovers warn and survive: the stranger clone and the stray displaced copy stay byte-identical at their old paths", async (home) => {
  const { oldCache } = buildOldCacheHome(home)
  writeTree(join(oldCache, "marketplaces", "stranger-mp"), { "README.md": "# a stranger's clone\n" })
  const strayCopy = join(oldCache, "displaced", "2026-09-02T00-00-00-000Z", join(cfg(home), "agents", "stranger:reviewer.md"))
  mkdirSync(dirname(strayCopy), { recursive: true })
  writeFileSync(strayCopy, "# a stranger's displaced original\n")

  const before = {
    marketplaces: snapTree(join(oldCache, "marketplaces")),
    displaced: snapTree(join(oldCache, "displaced")),
  }
  const result = ocm(home, "list")
  const output = `${result.stdout}\n${result.stderr}`
  if (result.status !== 0) throw new Error(`ocm list exited ${result.status}:\n${output}`)

  // the strangers survive byte-identical at their exact old paths
  assertFileExists(join(oldCache, "marketplaces", "stranger-mp", "README.md"))
  expect(readFileSync(join(oldCache, "marketplaces", "stranger-mp", "README.md"), "utf8")).toBe("# a stranger's clone\n")
  assertFileExists(strayCopy)
  expect(readFileSync(strayCopy, "utf8")).toBe("# a stranger's displaced original\n")
  // the negative, explicitly: apart from this root's own clone and displaced
  // copy, nothing under the old marketplaces/ or displaced/ trees was
  // deleted, moved or modified
  const owned = (path) => [join(oldCache, "marketplaces", MP), join(oldCache, "displaced", TS)].some(
    (root) => path === root || path.startsWith(`${root}/`),
  )
  for (const item of ["marketplaces", "displaced"]) {
    const after = snapTree(join(oldCache, item))
    for (const [path, value] of after) {
      if (!before[item].has(path)) throw new Error(`a new entry appeared under the old ${item} tree: ${path}`)
      if (before[item].get(path) !== value) throw new Error(`${path} was modified by the cache migration`)
    }
    for (const path of before[item].keys()) {
      if (!after.has(path) && !owned(path)) {
        throw new Error(`${path} was deleted or moved by the cache migration — only ${MP}'s clone and this root's own displaced copy were ours to move`)
      }
    }
  }
  // and the leftovers are reported, not silently kept
  for (const item of ["marketplaces", "displaced"]) {
    const path = join(oldCache, item)
    const line = result.stderr.split("\n").find((l) => l.includes(path))
    if (!line) throw new Error(`expected a stderr line naming ${path}:\n${result.stderr}`)
    if (!/left (?:alone|in place)|another config root/i.test(line)) {
      throw new Error(`the line for ${path} does not say it was left alone / may belong to another config root:\n${line}`)
    }
  }
  // config safety and ownership: the user's keys and hand-written command
  // survive the rewrites byte-identical
  const config = JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8"))
  expect(config.model).toBe("claude-sonnet-4-6")
  expect(config.skills.paths).toContain(join(home, "my-skills"))
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# user command\n")
}, 300_000)

// brief 43 §1 (F244/F245): cacheMigrationNeeded() read the rewrites' end
// state, so a process killed after the moves and the registry-dir rewrite
// read as finished forever, and a 0.6.1 loader re-creating links/<name> at
// the old path read as never-started forever. The migration now writes a
// state file under the namespace cache root: absent → the old-layout
// condition decides; in-progress → resume; done → never again.

phase("15. a migration interrupted after the registry-dir rewrite resumes on the next command and finishes, marking the state done", async (home) => {
  const { oldCache, oldSkills, dest } = buildOldCacheHome(home)
  const ns = rootCacheDir(home)
  // the interrupted window, built by hand (a kill -9 race does not belong in
  // the suite): the four renames, the stamp copy and the registry-dir rewrite
  // ran; the other three rewrites never did
  for (const [from, to] of [
    [join(oldCache, "marketplaces", MP), join(ns, "marketplaces", MP)],
    [join(oldCache, "links", MP), join(ns, "links", MP)],
    [join(oldCache, "displaced"), join(ns, "displaced")],
    [join(oldCache, "displaced-records.json"), join(ns, "displaced-records.json")],
  ]) {
    mkdirSync(dirname(to), { recursive: true })
    renameSync(from, to)
  }
  copyFileSync(join(oldCache, "last-sync.json"), join(ns, "last-sync.json"))
  // the displaced tree moved wholesale, so only marketplaces/ and links/ keep
  // an emptied parent to prune
  for (const part of ["marketplaces", "links"]) rmdirSync(join(oldCache, part))
  const registry = JSON.parse(readFileSync(registryFile(home), "utf8"))
  registry.marketplaces[MP].dir = join(ns, "marketplaces", MP)
  writeFileSync(registryFile(home), `${JSON.stringify(registry, null, 2)}\n`)
  const stateFile = join(ns, "cache-migration.json")
  writeFileSync(stateFile, `${JSON.stringify({ state: "in-progress", marketplaces: [MP] }, null, 2)}\n`)

  const result = ocm(home, "list")
  const output = `${result.stdout}\n${result.stderr}`
  if (result.status !== 0) throw new Error(`ocm list exited ${result.status} on the interrupted home:\n${output}`)

  // skills.paths finished: no dead old-layout entry, the namespace one present
  const config = JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8"))
  const nsSkills = join(ns, "links", MP, "skills")
  if (config.skills.paths.includes(oldSkills)) {
    throw new Error(`skills.paths still holds the dead old-layout path ${oldSkills}: ${JSON.stringify(config.skills.paths)}`)
  }
  if (config.skills.paths.filter((p) => p === nsSkills).length !== 1) {
    throw new Error(`expected skills.paths to hold ${nsSkills} exactly once: ${JSON.stringify(config.skills.paths)}`)
  }
  expect(config.model).toBe("claude-sonnet-4-6")
  expect(config.skills.paths).toContain(join(home, "my-skills"))

  // the displaced record's dir finished: it names the namespace displaced path
  expect(JSON.parse(readFileSync(join(ns, "displaced-records.json"), "utf8"))).toEqual([
    { marketplace: MP, plugin: "adw", dest, dir: join(ns, "displaced", TS) },
  ])

  // links still resolve into the namespace clone: the config-dir command
  // link and the mirror-internal reference.md symlink
  const nsClone = join(ns, "marketplaces", MP)
  for (const [link, source] of [
    [join(cfg(home), "commands", "adw:commit.md"), join(nsClone, "plugins", "adw", "commands", "commit.md")],
    [join(nsSkills, "adw--python-style", "reference.md"), join(nsClone, "plugins", "adw", "skills", "python-style", "reference.md")],
  ]) {
    const target = readlinkSync(link)
    if (!target.startsWith(`${nsClone}/`)) throw new Error(`expected ${link} -> somewhere under ${nsClone}, found ${target}`)
    expect(realpathSync(link)).toBe(realpathSync(source))
  }

  // the state file now reads done, and the resume warned about no hand moves
  const state = JSON.parse(readFileSync(stateFile, "utf8"))
  if (state.state !== "done") {
    throw new Error(`expected the state file at ${stateFile} to read done after the resume:\n${readFileSync(stateFile, "utf8")}`)
  }
  if (output.includes("move it by hand")) throw new Error(`the resume reported a collision to move by hand:\n${output}`)

  // ownership: the user's hand-written command survives the resume
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# user command\n")
}, 300_000)

phase("16. done means done: a 0.6.1 loader re-creating links/<mp> at the old path does not re-trigger the migration", async (home) => {
  const { oldCache } = buildOldCacheHome(home)
  const first = ocm(home, "list")
  if (first.status !== 0) throw new Error(`ocm list exited ${first.status}:\n${first.stdout}\n${first.stderr}`)
  const stateFile = join(rootCacheDir(home), "cache-migration.json")
  assertFileExists(stateFile)
  const done = JSON.parse(readFileSync(stateFile, "utf8"))
  if (done.state !== "done") throw new Error(`expected the state file at ${stateFile} to read done after the migration, got ${done.state}`)

  // the 0.6.1-loader scenario: the mirror re-appears at the old path in the
  // shape 0.6.1 writes it — a rendered SKILL.md carrying ocm's marker
  writeTree(join(oldCache, "links", MP, "skills", "adw--python-style"), {
    "SKILL.md": `---\nname: "adw:python-style"\ndescription: python-style guidance\n---\n\n# python-style\n<!-- ocm: rendered from plugins/adw/skills/python-style/SKILL.md @ 0000000 -->\n`,
  })
  const stateBytes = readFileSync(stateFile, "utf8")
  const stateMtime = statSync(stateFile).mtimeMs
  const registryBytes = readFileSync(registryFile(home), "utf8")

  const second = ocm(home, "list")
  const output = `${second.stdout}\n${second.stderr}`
  if (second.status !== 0) throw new Error(`second ocm list exited ${second.status}:\n${output}`)
  if (second.stdout.split("\n").some((line) => line.startsWith("moved "))) {
    throw new Error(`done must mean done, but the second run moved something:\n${second.stdout}`)
  }
  if (output.includes("move it by hand")) {
    throw new Error(`the re-created old-path links tree was treated as a migration collision:\n${output}`)
  }
  expect(readFileSync(stateFile, "utf8")).toBe(stateBytes)
  expect(statSync(stateFile).mtimeMs).toBe(stateMtime)
  expect(readFileSync(registryFile(home), "utf8")).toBe(registryBytes)
  // §3 converges it: the re-created mirror is provably ours and goes, so
  // the unreferenced-old-cache warning stops instead of repeating forever
  assertAbsent(join(oldCache, "links", MP))
  if (second.stderr.includes(join(oldCache, "links"))) {
    throw new Error(`the old-path links tree still warns after its only mirror was removed:\n${second.stderr}`)
  }
}, 300_000)

phase("17. an already-migrated 0.7.0 home (no state file, old layout gone) is a no-op and grows no state file", async (home) => {
  buildOldCacheHome(home)
  const first = ocm(home, "list")
  if (first.status !== 0) throw new Error(`ocm list exited ${first.status}:\n${first.stdout}\n${first.stderr}`)
  // precondition: the first run moved the old layout away — a no-op check
  // against an unmigrated cache is vacuous
  assertAbsent(join(home, ".cache", "ocm", "marketplaces"))
  // 0.7.0 wrote no state file — removing one matches that home exactly
  const stateFile = join(rootCacheDir(home), "cache-migration.json")
  rmSync(stateFile, { force: true })
  const before = cacheState(home)
  const second = ocm(home, "list")
  if (second.status !== 0) throw new Error(`second ocm list exited ${second.status}:\n${second.stdout}\n${second.stderr}`)
  const output = `${second.stdout}\n${second.stderr}`
  if (/migrat|moved|relink/i.test(output)) throw new Error(`the second run reported migration work:\n${output}`)
  expect(cacheState(home)).toEqual(before)
  assertAbsent(stateFile)
}, 300_000)

// brief 43 §3 (F245's residue): once the state file says done the migration
// never runs again, but a 0.6.1 loader's re-created links/<name> tree still
// sits at the old path and reportUnreferencedOldCache warns about it on every
// command. A completed migration may remove such a tree only when it can
// prove the tree is its own: every leaf a live symlink resolving into a
// clone this root's registry names. Anything that fails the proof stays and
// keeps warning; old-path marketplaces/ and displaced/ are never touched.
phase("18. a post-migration old-path mirror into this root's own clones is removed; one into a clone this root does not own is kept", async (home) => {
  const { oldCache } = buildOldCacheHome(home)
  const first = ocm(home, "list")
  if (first.status !== 0) throw new Error(`ocm list exited ${first.status}:\n${first.stdout}\n${first.stderr}`)
  const ns = rootCacheDir(home)
  const stateFile = join(ns, "cache-migration.json")
  const done = JSON.parse(readFileSync(stateFile, "utf8"))
  if (done.state !== "done") throw new Error(`expected the state file at ${stateFile} to read done, got ${done.state}`)

  // ours: a 0.6.1-style mirror at the old path, its one leaf a live symlink
  // into this root's namespace clone
  const nsReference = join(ns, "marketplaces", MP, "plugins", "adw", "skills", "python-style", "reference.md")
  assertFileExists(nsReference)
  const ours = join(oldCache, "links", MP, "skills", "adw--python-style", "reference.md")
  mkdirSync(dirname(ours), { recursive: true })
  symlinkSync(nsReference, ours)
  // theirs: a stranger's clone at the old path, and a mirror pointing into it
  const theirClone = join(oldCache, "marketplaces", "mp--theirs")
  writeTree(theirClone, { plugins: { beta: { skills: { "lint-style": { "reference.md": "# their references\n" } } } } })
  const theirs = join(oldCache, "links", "mp--theirs", "skills", "beta--lint-style", "reference.md")
  mkdirSync(dirname(theirs), { recursive: true })
  const theirTarget = join(theirClone, "plugins", "beta", "skills", "lint-style", "reference.md")
  symlinkSync(theirTarget, theirs)
  // a stray displaced copy, so the displaced negative below is real
  const strayCopy = join(oldCache, "displaced", "2026-09-02T00-00-00-000Z", join(cfg(home), "agents", "stranger:reviewer.md"))
  mkdirSync(dirname(strayCopy), { recursive: true })
  writeFileSync(strayCopy, "# a stranger's displaced original\n")

  const stateBytes = readFileSync(stateFile, "utf8")
  const before = {
    marketplaces: snapTree(join(oldCache, "marketplaces")),
    displaced: snapTree(join(oldCache, "displaced")),
  }
  const second = ocm(home, "list")
  const output = `${second.stdout}\n${second.stderr}`
  if (second.status !== 0) throw new Error(`second ocm list exited ${second.status}:\n${output}`)

  // ours removed, one stdout line naming the tree; theirs kept at its exact
  // old path with an identical symlink target
  assertAbsent(join(oldCache, "links", MP))
  if (!second.stdout.split("\n").some((line) => line.startsWith("removed ") && line.includes(join(oldCache, "links", MP)))) {
    throw new Error(`expected a "removed " line naming ${join(oldCache, "links", MP)} in stdout:\n${second.stdout}`)
  }
  assertFileExists(theirs)
  expect(readlinkSync(theirs)).toBe(theirTarget)
  // the old links dir survives (theirs remains) and the warning still fires
  assertFileExists(join(oldCache, "links"))
  const line = second.stderr.split("\n").find((l) => l.includes(join(oldCache, "links")))
  if (!line) throw new Error(`expected a stderr line naming ${join(oldCache, "links")}:\n${second.stderr}`)
  if (!/left (?:alone|in place)|another config root/i.test(line)) {
    throw new Error(`the line does not say the tree was left alone / may belong to another config root:\n${line}`)
  }
  // the cleanup does not rewrite the state file
  expect(readFileSync(stateFile, "utf8")).toBe(stateBytes)
  // the cleanup is links-only: nothing under old-path marketplaces/ or
  // displaced/ was deleted, moved or modified
  assertTreeUnchanged(before.marketplaces, [join(oldCache, "marketplaces")], "the old-path marketplaces tree")
  assertTreeUnchanged(before.displaced, [join(oldCache, "displaced")], "the old-path displaced tree")
  // config safety and ownership: the user's keys and hand-written command
  // survive byte-identical
  const config = JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8"))
  expect(config.model).toBe("claude-sonnet-4-6")
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# user command\n")
}, 300_000)

// §3's other half: a rendered file proves nothing about *whose* mirror it
// is, so the name must be one this root's registry holds — and a regular
// file without the marker is something a person put there
phase("18b. an old-path tree is kept when it holds an unmarked file, or when its name is not in this root's registry", async (home) => {
  const { oldCache } = buildOldCacheHome(home)
  const first = ocm(home, "list")
  if (first.status !== 0) throw new Error(`ocm list exited ${first.status}:\n${first.stdout}\n${first.stderr}`)
  const marker = "<!-- ocm: rendered from plugins/x/skills/y/SKILL.md @ 0000000 -->\n"
  writeTree(join(oldCache, "links", MP, "skills", "adw--python-style"), { "SKILL.md": `# rendered\n${marker}` })
  writeTree(join(oldCache, "links", MP, "skills", "adw--notes"), { "SKILL.md": "# my own notes\n" })
  writeTree(join(oldCache, "links", "mp--stranger", "skills", "x--y"), { "SKILL.md": `# theirs\n${marker}` })
  const before = snapTree(join(oldCache, "links"))
  const second = ocm(home, "list")
  if (second.status !== 0) throw new Error(`second ocm list exited ${second.status}:\n${second.stdout}\n${second.stderr}`)
  if (second.stdout.split("\n").some((line) => line.startsWith("removed "))) {
    throw new Error(`neither tree is provably ours, but something was removed:\n${second.stdout}`)
  }
  assertTreeUnchanged(before, [join(oldCache, "links")], "the old-path links tree")
}, 300_000)

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
