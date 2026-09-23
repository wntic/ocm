// Truthful reports: command output matches the registry and the disk,
// never claiming work that did not happen.

import { spawnSync } from "node:child_process"
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, assertFileExists, rootCacheDir, withFakeHome } from "./harness.mjs"

// Helpers shared verbatim by the absorbed files below.

const OCM_BIN = fileURLToPath(new URL("../bin/ocm.ts", import.meta.url))

const VERSION = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version

function ocm(home, args, timeout = 120_000) {
  const r = spawnSync(process.execPath, [OCM_BIN, ...args], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout })
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` }
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
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: 120_000 })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${r.stderr}`)
}

const commitAll = (dir, msg) => { git(dir, ["add", "-A"]); git(dir, ["-c", "user.email=ocm@test", "-c", "user.name=ocm", "commit", "-m", msg]) }

const gitRepo = (dir, tree) => { writeTree(dir, tree); git(dir, ["init", "-b", "main"]); commitAll(dir, "fixture") }

const cfg = (home) => join(home, ".config", "opencode")

const readRegistry = (home) => JSON.parse(readFileSync(join(cfg(home), "ocm", "registry.json"), "utf8"))

const cloneDir = (home, name = "mp") => join(rootCacheDir(home), "marketplaces", name)

const commandLink = (home, plugin, file) => join(cfg(home), "commands", `${plugin}:${file}`)

const json = (value) => `${JSON.stringify(value, null, 2)}\n`

const COMMAND = "---\ndescription: commit helper\n---\n\nCommit body.\n"

const SKILL = "---\nname: style\ndescription: style guidance\n---\n\n# Style\n\nBody.\n"

const PLUGIN_JSON = json({ description: "demo plugin" }) // spec 19

const JS_PLUGIN = 'export default { id: "phase23-notify", server: async () => ({}) }\n'

const JS_PLUGIN_CHANGED = `// v2\n${JS_PLUGIN}`

const MCP = { db: { type: "local", command: ["npx", "-y", "@acme/db-mcp"], enabled: true } }

const USER_PLUGIN = 'export default { id: "mine", server: async () => ({}) }\n'

// truthful reports — absorbed from test/phase23-truthful-reports.mjs
{
// the restart notice is a standalone line; the TUI plugin's own text embeds
// the phrase, so a substring count would lie
const noticeCount = (output) => output.split("\n").filter((l) => l.trim() === "restart opencode to activate").length

phase("1. ocm init prints its success lines on stdout, and neither stream carries a red-classified escape", async (home) => {
  const result = ocm(home, ["init"])
  expect(result.status).toBe(0)
  assertFileExists(join(cfg(home), "plugins", "ocm-loader.js")) // the claim matches the disk
  for (const needle of ["installed auto-sync loader", "installed TUI plugin"]) {
    expect(result.stdout).toContain(needle)
  }
  expect(result.stderr).not.toContain("installed auto-sync loader") // F2: these lived on stderr
  for (const stream of [result.stdout, result.stderr]) {
    expect(stream).not.toMatch(/\x1b\[[0-9;]*31m/) // nothing red-classified, either stream
  }
})

phase("2. re-install, re-uninstall and re-init report the no-op: exit 0, no restart notice, no false claim", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
  expect(ocm(home, ["add", mp]).status).toBe(0)
  expect(ocm(home, ["install", "adw"]).status).toBe(0)
  const reInstall = ocm(home, ["install", "adw"])
  expect(reInstall.status).toBe(0)
  const already = reInstall.output.split("\n").find((l) => l.includes("already installed"))
  if (!already) throw new Error(`expected "already installed" wording on the no-op install:\n${reInstall.output}`)
  expect(already.includes("(")).toBe(false) // no file list: nothing was created
  expect(noticeCount(reInstall.output)).toBe(0)
  expect(ocm(home, ["uninstall", "adw"]).status).toBe(0)
  const reUninstall = ocm(home, ["uninstall", "adw"])
  expect(reUninstall.status).toBe(0)
  expect(reUninstall.output).toMatch(/not installed/)
  expect(reUninstall.output).not.toMatch(/uninstalled adw/)
  expect(noticeCount(reUninstall.output)).toBe(0)
  const reInit = ocm(home, ["init"])
  expect(reInit.status).toBe(0)
  expect(reInit.stdout).toContain("already current") // "auto-sync loader already current"
  expect(reInit.stdout).not.toContain("installed auto-sync loader")
  expect(noticeCount(reInit.output)).toBe(0)
})

phase("3. an explicit-mode update labels a new upstream plugin available with no file list, and registers it disabled", async (home) => {
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { tool: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } } } })
  expect(ocm(home, ["add", `file://${remote}`, "--name", "mp", "--explicit"]).status).toBe(0)
  writeTree(join(remote, "plugins", "fresh"), { "plugin.json": PLUGIN_JSON, commands: { "new.md": COMMAND } })
  commitAll(remote, "ship a new upstream plugin")
  const result = ocm(home, ["update", "mp"])
  expect(result.status).toBe(0)
  const line = result.output.split("\n").find((l) => /^\s+fresh\b/.test(l))
  if (!line) throw new Error(`expected a report line for plugin "fresh":\n${result.output}`)
  expect(line).toContain("available")
  expect(line).toContain("ocm install fresh to activate")
  expect(line).not.toContain("installed (auto)")
  expect(result.output).not.toMatch(/^\s*\+\s/m) // no file list: nothing was created
  expect(readRegistry(home).marketplaces.mp.plugins.fresh.enabled).toBe(false)
  assertAbsent(commandLink(home, "fresh", "new.md"))
})

phase("4. the restart notice follows actual changes: skill-only install and removal-only update print it, a no-op update does not", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: {
    adw: { "plugin.json": PLUGIN_JSON, commands: { "a.md": COMMAND, "b.md": COMMAND } },
    skillkit: { "plugin.json": PLUGIN_JSON, skills: { style: { "SKILL.md": SKILL } } },
  } })
  expect(ocm(home, ["add", mp, "--explicit"]).status).toBe(0)
  const skilled = ocm(home, ["install", "skillkit"]) // skill-only: the mirror counts as created
  expect(skilled.status).toBe(0)
  expect(lstatSync(join(rootCacheDir(home), "links", "mp", "skills", "skillkit--style")).isDirectory()).toBe(true)
  if (noticeCount(skilled.output) !== 1) throw new Error(`expected the restart notice on the skill-only install:\n${skilled.output}`)
  expect(ocm(home, ["install", "adw"]).status).toBe(0)
  rmSync(join(mp, "plugins", "adw", "commands", "b.md"))
  const removal = ocm(home, ["update", "mp"]) // removal-only: the stale command lives until restart
  expect(removal.status).toBe(0)
  if (noticeCount(removal.output) !== 1) throw new Error(`expected the restart notice on the removal-only update:\n${removal.output}`)
  assertAbsent(commandLink(home, "adw", "b.md"))
  const link = commandLink(home, "adw", "a.md")
  const ino = lstatSync(link).ino
  const noop = ocm(home, ["update", "mp"])
  expect(noop.status).toBe(0)
  expect(noticeCount(noop.output)).toBe(0)
  expect(noop.output).not.toContain("installed auto-sync loader") // a no-op update reports nothing for the loader
  expect(lstatSync(link).ino).toBe(ino) // invariant: idempotence — no link re-created
})

phase("5. add and uninstall print their headline before the restart notice; the user's config and files survive", async (home) => {
  const userConfig = { model: "claude-sonnet-4-6", skills: { paths: ["/users/me/my-skills"] }, mcp: { "user-server": { type: "local", command: ["echo"] } } }
  writeTree(cfg(home), {
    "opencode.json": json(userConfig), "tui.json": json({ plugin: ["my-own-tui-plugin"] }),
    commands: { "mine.md": "# my own command\n" }, plugins: { "my-own.js": USER_PLUGIN },
  })
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
  const added = ocm(home, ["add", mp])
  expect(added.status).toBe(0)
  expect(added.stdout).toContain('added marketplace "mp"')
  expect(added.stdout).toContain("restart opencode to activate")
  expect(added.stdout.indexOf('added marketplace "mp"')).toBeLessThan(added.stdout.indexOf("restart opencode to activate"))
  const removed = ocm(home, ["uninstall", "adw"])
  expect(removed.status).toBe(0)
  expect(removed.stdout.indexOf("uninstalled adw@mp")).toBeGreaterThanOrEqual(0)
  expect(removed.stdout.indexOf("uninstalled adw@mp")).toBeLessThan(removed.stdout.indexOf("restart opencode to activate"))
  // invariants: config safety and ownership — outside ocm's keys, exactly the user's
  const config = JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8"))
  for (const key of Object.keys(config.mcp ?? {})) if (key.startsWith("ocm--")) delete config.mcp[key]
  expect(config).toEqual(userConfig)
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
  expect(readFileSync(join(cfg(home), "plugins", "my-own.js"), "utf8")).toBe(USER_PLUGIN)
  expect(JSON.parse(readFileSync(join(cfg(home), "tui.json"), "utf8")).plugin).toContain("my-own-tui-plugin")
  // invariant: no plugin-load errors attributable to ocm-installed files
}, 420_000)

phase("6. the trust block renders after the updating header, not before it", async (home) => {
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { kit: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND }, plugin: { "hook.js": JS_PLUGIN } } } })
  expect(ocm(home, ["add", `file://${remote}`, "--name", "mp", "--trust"]).status).toBe(0)
  writeFileSync(join(remote, "plugins", "kit", "plugin", "hook.js"), JS_PLUGIN_CHANGED)
  commitAll(remote, "change the executable component")
  // stdout and stderr share one fd: sequential writes land in order, so the
  // log is the true interleaving — the cross-stream assert without a pty
  const log = join(home, "merged.log")
  const fd = openSync(log, "w")
  const run = spawnSync(process.execPath, [OCM_BIN, "update", "mp"], { env: { ...process.env, HOME: home }, stdio: ["ignore", fd, fd], timeout: 120_000 })
  closeSync(fd)
  expect(run.status).toBe(0)
  const combined = readFileSync(log, "utf8")
  const header = combined.indexOf("updating mp...")
  const diff = combined.indexOf("shipped code that changed")
  if (header === -1) throw new Error(`expected the "updating mp..." header in the merged output:\n${combined}`)
  if (diff === -1) throw new Error(`expected the trust diff in the merged output:\n${combined}`)
  expect(header).toBeLessThan(diff) // the block renders inside its marketplace's section
})

phase("7. noise budget: one blocked line per run, zero-count lines dropped, re-clone events on stdout", async (home) => {
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: {
    "exec-kit": { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND }, plugin: { "hook.js": JS_PLUGIN }, "mcp.json": json(MCP) },
    "doc-kit": { "plugin.json": PLUGIN_JSON, commands: { "doc.md": COMMAND } },
  } })
  expect(ocm(home, ["add", `file://${remote}`, "--name", "mp"]).status).toBe(0) // non-TTY: undecided, executables blocked
  const unrelated = ocm(home, ["uninstall", "doc-kit"]) // a mutation that touches nothing of exec-kit
  expect(unrelated.status).toBe(0)
  expect(unrelated.output).toContain("uninstalled doc-kit@mp") // the actual result survives the noise cut
  const blocked = unrelated.output.split("\n").filter((l) => /blocked/i.test(l))
  if (blocked.length !== 1) throw new Error(`expected exactly one blocked line, got ${blocked.length}:\n${unrelated.output}`)
  expect(blocked[0]).toContain("2 components")
  expect(blocked[0]).toContain("ocm trust mp")
  rmSync(cloneDir(home), { recursive: true, force: true })
  const recloned = ocm(home, ["update", "mp"])
  expect(recloned.status).toBe(0)
  expect(recloned.stdout).toMatch(/re-clone/i) // an event of the report, not a warning
  const local = join(home, "local-mp")
  writeTree(local, { plugins: { tool: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } } } })
  expect(ocm(home, ["add", local]).status).toBe(0)
  const noop = ocm(home, ["update", "local-mp"])
  expect(noop.status).toBe(0)
  expect(noop.output).not.toMatch(/0 created, 0 removed, 0 skipped/) // zero counts are dropped
})

phase("8. ocm --version and ocm -v print the package version and exit 0", async (home) => {
  for (const flag of ["--version", "-v"]) {
    const result = ocm(home, [flag])
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/) // a semver, not an arbitrary string
    expect(result.stdout.trim()).toBe(VERSION) // the package.json version, resolved relative to the module
  }
})

phase("9. help leads with ocm add in usage and examples, and mentions --version", async (home) => {
  const result = ocm(home, ["help"])
  expect(result.status).toBe(0)
  const lines = result.stdout.split("\n")
  const firstAfter = (header) => lines.slice(lines.indexOf(header) + 1).find((l) => l.trim().startsWith("ocm "))
  const firstUsage = firstAfter("usage:")
  if (!firstUsage) throw new Error(`expected command lines under "usage:" in the help output:\n${result.stdout}`)
  expect(firstUsage.trim().startsWith("ocm add")).toBe(true) // add is step one for every new user
  expect(result.stdout.indexOf("ocm add")).toBeLessThan(result.stdout.indexOf("ocm init")) // init follows
  const firstExample = firstAfter("examples:")
  if (!firstExample) throw new Error(`expected example lines under "examples:" in the help output:\n${result.stdout}`)
  expect(firstExample.trim().startsWith("ocm add")).toBe(true)
  expect(result.stdout).toContain("--version") // a user reporting a bug can find the flag
})

phase("10. ocm remove prints the restart notice once, after its headline, when it removed components", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
  expect(ocm(home, ["add", mp]).status).toBe(0)
  assertFileExists(commandLink(home, "adw", "commit.md")) // the marketplace had links to remove
  const removed = ocm(home, ["remove", "mp"])
  expect(removed.status).toBe(0)
  assertAbsent(commandLink(home, "adw", "commit.md")) // the removal happened; only the notice is in question
  if (noticeCount(removed.output) !== 1) throw new Error(`expected exactly one restart notice on ocm remove:\n${removed.output}`)
  expect(removed.stdout.indexOf('removed marketplace "mp"')).toBeGreaterThanOrEqual(0)
  expect(removed.stdout.indexOf('removed marketplace "mp"')).toBeLessThan(removed.stdout.indexOf("restart opencode to activate"))
})

// brief 31 §7 (F114): the loader still installs before the trust decision,
// but its lines are queued and flushed after the headline; the TUI line
// drops its own trailing notice, which prints once
phase("11. ocm add on a fresh home: the headline precedes the loader and TUI lines, and the restart notice appears exactly once", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
  const added = ocm(home, ["add", mp])
  expect(added.status).toBe(0)
  assertFileExists(commandLink(home, "adw", "commit.md")) // the add worked; only the reporting is in question
  const lines = added.output.split("\n")
  const headline = lines.findIndex((line) => line.includes('added marketplace "mp"'))
  if (headline === -1) throw new Error(`expected the headline in the add output:\n${added.output}`)
  const loaderOrTui = lines.findIndex((line) => /installed auto-sync loader|installed TUI plugin/.test(line))
  if (loaderOrTui === -1) throw new Error(`expected a loader or TUI line in the add output:\n${added.output}`)
  expect(headline).toBeLessThan(loaderOrTui)
  // a substring count, not a standalone-line count: the TUI line embeds the
  // phrase today, so noticeCount would pass and lie
  const occurrences = added.output.split("restart opencode to activate").length - 1
  if (occurrences !== 1) throw new Error(`expected exactly one "restart opencode to activate" in the add output, got ${occurrences}:\n${added.output}`)
})
}

// brief 42 §1 (F246, F256): the version and help cases dispatch before the
// migration block, the old-cache report and the stale-loader refresh
{
const OLD_MP = "mp--one"

// a home where every pre-dispatch write would fire: the registry names an
// old-layout cache (brief 38's pre-migration shape) and the installed loader
// carries a stale stamp, so the migration block and the refresh both trigger
// for any command that reaches them
function buildMigratingHome(home) {
  const init = ocm(home, ["init"])
  if (init.status !== 0) throw new Error(`ocm init exited ${init.status} on the fixture home:\n${init.output}`)
  const core = join(cfg(home), "ocm", "core.js")
  writeFileSync(core, readFileSync(core, "utf8").replace(/\/\/ ocm-version: [^\n]*/, "// ocm-version: 0.0.1 deadbeef"))
  writeTree(join(home, ".cache", "ocm", "marketplaces", OLD_MP), {
    plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } },
  })
  writeTree(cfg(home), {
    ocm: { "registry.json": json({ version: 2, marketplaces: { [OLD_MP]: {
      url: "https://github.com/example/mp",
      dir: join(home, ".cache", "ocm", "marketplaces", OLD_MP),
      local: false, addedAt: "2026-09-01T00:00:00.000Z", mode: "auto",
      ref: null, revision: null, syncIntervalMs: null,
      trust: { code: "none" }, lastSync: null, plugins: {},
    } } }) },
  })
}

// the disk facts a read-only query must leave untouched: the cache layout,
// every loader file's mtime, and the registry's exact bytes
function diskSnapshot(home) {
  const layout = []
  const mtimes = {}
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      layout.push(`${entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "link" : "file"} ${path}`)
      if (entry.isDirectory()) walk(path)
      else mtimes[path] = statSync(path).mtimeMs
    }
  }
  walk(join(home, ".cache", "ocm"))
  walk(join(cfg(home), "plugins"))
  walk(join(cfg(home), "ocm"))
  return { layout: layout.sort(), mtimes, registry: readFileSync(join(cfg(home), "ocm", "registry.json"), "utf8") }
}

// piecewise, so a failure names the path that changed rather than "objects differ"
function assertDiskUntouched(home, before) {
  const after = diskSnapshot(home)
  if (after.registry !== before.registry) {
    throw new Error(`${join(cfg(home), "ocm", "registry.json")} was rewritten:\n${after.registry}`)
  }
  for (let i = 0; i < Math.max(before.layout.length, after.layout.length); i++) {
    if (before.layout[i] !== after.layout[i]) {
      throw new Error(`expected ${before.layout[i] ?? "(no more entries)"}, found ${after.layout[i] ?? "(nothing)"} — the disk changed under a read-only query`)
    }
  }
  for (const [path, mtime] of Object.entries(before.mtimes)) {
    if (after.mtimes[path] !== mtime) throw new Error(`${path} was rewritten (mtime ${mtime} -> ${after.mtimes[path]})`)
  }
}

phase("12. ocm --version and ocm -v on a home needing migration with a stale loader print the version and write nothing", async (home) => {
  buildMigratingHome(home)
  for (const flag of ["--version", "-v"]) {
    const before = diskSnapshot(home)
    const result = ocm(home, [flag])
    assertDiskUntouched(home, before)
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(VERSION)
  }
})

phase("13. ocm help, --help, -h and bare ocm on the same home print usage and write nothing", async (home) => {
  buildMigratingHome(home)
  for (const args of [["help"], ["--help"], ["-h"], []]) {
    const before = diskSnapshot(home)
    const result = ocm(home, args)
    assertDiskUntouched(home, before)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("usage:")
  }
})

// the control: a read-only command outside the six moved cases still runs
// the migrations and the refresh — the fixture must genuinely trigger both
phase("14. ocm list on that home still migrates the old-layout cache into the namespace and refreshes the stale loader", async (home) => {
  buildMigratingHome(home)
  const result = ocm(home, ["list"])
  expect(result.status).toBe(0)
  assertAbsent(join(home, ".cache", "ocm", "marketplaces", OLD_MP))
  assertFileExists(join(rootCacheDir(home), "marketplaces", OLD_MP, "plugins", "adw", "plugin.json"))
  expect(readRegistry(home).marketplaces[OLD_MP].dir).toBe(join(rootCacheDir(home), "marketplaces", OLD_MP))
  expect(readFileSync(join(cfg(home), "ocm", "core.js"), "utf8")).not.toContain("ocm-version: 0.0.1")
})
}
