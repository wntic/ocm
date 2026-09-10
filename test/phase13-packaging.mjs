// Phase 13 — docs/specs/13-packaging.md: one test per numbered item. The
// migration is "run automatically by any `ocm` command and by `ocm doctor`",
// so the tests drive bin/ocm.ts (`ocm list`) against a fake home built in the
// pre-spec-01/02/03/08 layout and assert the on-disk end state — the expected
// interface is the migration hook src/index.ts already calls before dispatch,
// extended to cover the whole spec 13 table. Invariants: config safety and
// ownership in 1, idempotence in 2, no plugin-load errors in 1.
import { spawnSync } from "node:child_process"
import { lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, assertFileExists, opencodeProbe, withFakeHome } from "./harness.mjs"

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

const cfg = (home) => join(home, ".config", "opencode")
const registryFile = (home) => join(cfg(home), "ocm", "registry.json")
const MP = "mp--one"
const ADDED_AT = "2026-09-01T10:00:00.000Z"
// the pre-08 global stamp: one throttle timestamp shared by all marketplaces
const STAMP_AT = "2026-09-08T09:00:00.000Z"
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

  // skills relinked: one mirror per skill with a rendered, namespaced SKILL.md
  assertAbsent(join(skillsDir, "adw")) // the old whole-skills-dir symlink
  for (const skill of ["python-style", "code-review"]) {
    const rendered = join(skillsDir, `adw--${skill}`, "SKILL.md")
    assertFileExists(rendered)
    if (lstatSync(rendered).isSymbolicLink()) throw new Error(`expected a rendered regular file at ${rendered}, found a symlink`)
    const content = readFileSync(rendered, "utf8")
    expect(content).toContain(`name: "adw:${skill}"`)
    expect(content).toContain("ocm: rendered from")
  }

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
  expect(config.skills.paths).toContain(skillsDir)

  // the old → new skill mapping is printed: one line naming both forms
  for (const skill of ["python-style", "code-review"]) {
    const mapped = output.split("\n").find((line) => line.includes(`adw:${skill}`) && line.split(`adw:${skill}`).join("").includes(skill))
    if (!mapped) throw new Error(`expected a line mapping ${skill} -> adw:${skill} in the output:\n${output}`)
  }

  // no plugin-load errors attributable to ocm files
  const probe = opencodeProbe(cfg(home), home)
  if (!probe.available) console.log("skipped: opencode is not on PATH")
  else {
    if (probe.unreliable) throw new Error("probe cannot trust itself: the canary broken plugin produced no error line")
    expect(probe.pluginErrors).toEqual([])
  }
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
    const skillsDir = buildLegacyHome(home)
    const first = ocm(home, "list")
    if (first.status !== 0) throw new Error(`ocm list exited ${first.status}:\n${first.stdout}\n${first.stderr}`)
    // precondition: the first run did migrate — idempotence of a no-op is vacuous
    expect(JSON.parse(readFileSync(registryFile(home), "utf8")).version).toBe(2)
    const before = migratedState(home, skillsDir)
    const second = ocm(home, "list")
    if (second.status !== 0) throw new Error(`second ocm list exited ${second.status}:\n${second.stdout}\n${second.stderr}`)
    expect(migratedState(home, skillsDir)).toEqual(before)
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
  return { listings, files: files.map((p) => [readFileSync(p, "utf8"), statSync(p).mtimeMs]) }
}

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
