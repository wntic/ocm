// Updates: sync, pin, re-materialize and report — per marketplace,
// writing nothing when nothing changed.

import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, withFakeHome, withFakeOpencode } from "./harness.mjs"

// Helpers shared verbatim by the absorbed files below.

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

const readRegistry = (home) => JSON.parse(readFileSync(registryFile(home), "utf8"))

function editRegistry(home, edit) {
  const registry = readRegistry(home)
  edit(registry)
  writeFileSync(registryFile(home), `${JSON.stringify(registry, null, 2)}\n`)
}

const cloneDir = (home, name = "mp") => join(home, ".cache", "ocm", "marketplaces", name)

const commandLink = (home, plugin, file) => join(cfg(home), "commands", `${plugin}:${file}`)

const skillMirror = (home, plugin) => join(home, ".cache", "ocm", "links", "mp", "skills", `${plugin}--python-style`)

const mcpKeys = (home) => {
  try {
    return JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8")).mcp ?? {}
  } catch {
    return {}
  }
}

// the loader's startup sync, run the way ocm-loader.js runs it: a child on
// the fake $HOME, throttled (no force), carrying the startup reason
const SYNC_RUNNER = 'const mod = await import(process.argv[2]); await mod.syncAll({ reason: "startup" })\n'

function loaderSync(home, env = {}) {
  const runner = join(home, "sync-runner.mjs")
  writeFileSync(runner, SYNC_RUNNER)
  const result = spawnSync(process.execPath, [runner, CORE_MODULE], {
    env: { ...process.env, HOME: home, ...env }, encoding: "utf8", timeout: 120_000,
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

const COMMAND = "---\ndescription: commit helper\n---\n\nCommit body.\n"

const SKILL = "---\nname: python-style\ndescription: Python style guidance\n---\n\n# Python style\n\nUse ruff.\n"

const JS_PLUGIN = 'export default { id: "phase08-hello", server: async () => ({}) }\n'

const JS_PLUGIN_CHANGED = `// v2\n${JS_PLUGIN}`

const MCP = { db: { type: "local", command: ["npx", "-y", "@acme/db-mcp"], enabled: true } }

const mcpJson = (servers) => `${JSON.stringify(servers, null, 2)}\n`

const renames = (map) => `${JSON.stringify({ renames: map }, null, 2)}\n`

const README = fileURLToPath(new URL("../README.md", import.meta.url))

const json = (value) => `${JSON.stringify(value, null, 2)}\n`

const PLUGIN_JSON = json({ description: "demo plugin" }) // spec 19

// update: sync, pin, re-materialize and report per marketplace — absorbed from test/phase08-update.mjs
{
// realpath on both sides: macOS temp dirs sit behind /var -> /private/var
function assertResolves(dest, source) {
  if (!existsSync(dest) || !lstatSync(dest).isSymbolicLink()) throw new Error(`expected a symlink at ${dest}`)
  expect(realpathSync(dest)).toBe(realpathSync(source))
}

// spec 19: every installable plugin carries a plugin.json with a description
const PLUGIN_JSON = `${JSON.stringify({ description: "demo plugin" }, null, 2)}\n`

phase("1. two commits report the revision transition, the per-plugin version change and the + ~ - file list; a versionless plugin lists as @<short sha>", async (home) => {
  const remote = join(home, "remote")
  gitRepo(remote, {
    plugins: {
      "quality-review": {
        "plugin.json": `${JSON.stringify({ version: "1.2.0", description: "demo plugin" }, null, 2)}\n`,
        commands: { "base.md": COMMAND },
        skills: { "code-review": { "SKILL.md": SKILL } },
        agents: { "old-reviewer.md": "---\ndescription: old reviewer\n---\n\nReviews.\n" },
      },
      plain: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND }, plugin: { "hello.js": JS_PLUGIN } },
    },
  })
  expect(ocm(home, "add", `file://${remote}`, "--name", "mp", "--trust").status).toBe(0)
  const before = shortSha(remote)
  writeFileSync(join(remote, "plugins", "quality-review", "plugin.json"), `${JSON.stringify({ version: "1.3.0", description: "demo plugin" }, null, 2)}\n`)
  writeFileSync(join(remote, "plugins", "quality-review", "commands", "review.md"), COMMAND)
  writeFileSync(join(remote, "plugins", "quality-review", "skills", "code-review", "SKILL.md"), `${SKILL}<!-- v2 -->\n`)
  rmSync(join(remote, "plugins", "quality-review", "agents", "old-reviewer.md"))
  commitAll(remote, "advance")
  const after = shortSha(remote)

  const result = ocm(home, "update", "mp")
  if (result.status !== 0) throw new Error(`ocm update mp exited ${result.status}: ${result.stderr}`)
  const output = `${result.stdout}\n${result.stderr}`
  expect(output).toMatch(new RegExp(`${before}[^\\n]*→[^\\n]*${after}`))
  expect(output).toMatch(/quality-review[^\n]*1\.2\.0[^\n]*→[^\n]*1\.3\.0/)
  expect(output).toMatch(/\+\s*commands\/review\.md/)
  expect(output).toMatch(/~\s*skills\/code-review\/SKILL\.md/)
  expect(output).toMatch(/-\s*agents\/old-reviewer\.md/)

  const entry = readRegistry(home).marketplaces.mp
  if (!entry.revision?.includes(after)) {
    throw new Error(`expected mp.revision to contain ${after} in ${registryFile(home)}, got ${entry.revision}`)
  }
  expect(entry.plugins.plain.version).toBe(null)
  const listed = ocm(home, "list")
  expect(listed.stdout).toContain("1.3.0")
  expect(listed.stdout).toContain(`@${after}`) // the revision is the implicit version

  assertResolves(commandLink(home, "quality-review", "review.md"), join(cloneDir(home), "plugins", "quality-review", "commands", "review.md"))
  assertAbsent(join(cfg(home), "agents", "quality-review:old-reviewer.md"))
  assertResolves(commandLink(home, "plain", "work.md"), join(cloneDir(home), "plugins", "plain", "commands", "work.md"))
  assertResolves(join(cfg(home), "plugins", "ocm--plain--hello.js"), join(cloneDir(home), "plugins", "plain", "plugin", "hello.js"))
  // invariant: no plugin-load errors attributable to ocm-installed files
}, 420_000)

phase("2. one unreachable marketplace of three: the others update, its links survive, lastSync.ok is false, exit is non-zero", async (home) => {
  const PLUGINS = { "mp-a": "alpha", "mp-b": "beta", "mp-c": "gamma" }
  for (const [mp, plugin] of Object.entries(PLUGINS)) {
    gitRepo(join(home, `remote-${mp}`), { plugins: { [plugin]: { "plugin.json": PLUGIN_JSON, commands: { "one.md": COMMAND, "two.md": COMMAND } } } })
    expect(ocm(home, "add", `file://${join(home, `remote-${mp}`)}`, "--name", mp).status).toBe(0)
  }
  rmSync(join(home, "remote-mp-b"), { recursive: true, force: true })
  for (const mp of ["mp-a", "mp-c"]) {
    writeFileSync(join(home, `remote-${mp}`, "plugins", PLUGINS[mp], "commands", "new.md"), COMMAND)
    commitAll(join(home, `remote-${mp}`), `advance ${mp}`)
  }
  // alpha's deleted link must come back; beta's must stay missing: a failed
  // pull skips materialize entirely, so the previous links are left alone
  rmSync(commandLink(home, "alpha", "one.md"))
  rmSync(commandLink(home, "beta", "one.md"))

  const updated = ocm(home, "update")
  expect(updated.status).not.toBe(0)
  assertResolves(commandLink(home, "alpha", "one.md"), join(cloneDir(home, "mp-a"), "plugins", "alpha", "commands", "one.md"))
  assertResolves(commandLink(home, "alpha", "new.md"), join(cloneDir(home, "mp-a"), "plugins", "alpha", "commands", "new.md"))
  assertResolves(commandLink(home, "gamma", "new.md"), join(cloneDir(home, "mp-c"), "plugins", "gamma", "commands", "new.md"))
  assertAbsent(commandLink(home, "beta", "one.md"))
  assertResolves(commandLink(home, "beta", "two.md"), join(cloneDir(home, "mp-b"), "plugins", "beta", "commands", "two.md"))
  const lastSync = readRegistry(home).marketplaces["mp-b"].lastSync
  if (!lastSync || lastSync.ok !== false || !lastSync.error) {
    throw new Error(`expected lastSync.ok === false with an error for mp-b in ${registryFile(home)}, got ${JSON.stringify(lastSync)}`)
  }
})

phase("3. --ref add follows the pinned ref; pin and pin --clear move it; a nonexistent ref fails without saving; a deleted upstream ref leaves the revision unchanged", async (home) => {
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { tool: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } } } })
  git(remote, ["checkout", "-b", "feature"])
  writeFileSync(join(remote, "plugins", "tool", "commands", "feature.md"), COMMAND)
  commitAll(remote, "feature work")
  const featureSha = shortSha(remote, "feature")
  git(remote, ["checkout", "main"])
  writeFileSync(join(remote, "plugins", "tool", "commands", "main-only.md"), COMMAND)
  commitAll(remote, "main work")
  const mainSha = shortSha(remote, "main")

  expect(ocm(home, "add", `file://${remote}`, "--name", "mp", "--ref", "feature").status).toBe(0)
  expect(readRegistry(home).marketplaces.mp.ref).toBe("feature")
  expect(ocm(home, "update", "mp").status).toBe(0)
  let entry = readRegistry(home).marketplaces.mp
  if (!entry.revision?.includes(featureSha)) {
    throw new Error(`expected mp.revision to contain ${featureSha} after the pinned update, got ${entry.revision}`)
  }
  assertResolves(commandLink(home, "tool", "feature.md"), join(cloneDir(home), "plugins", "tool", "commands", "feature.md"))
  assertAbsent(commandLink(home, "tool", "main-only.md"))

  // a typoed ref fails immediately and saves nothing
  const bad = ocm(home, "pin", "mp", "nosuch-ref")
  expect(bad.status).not.toBe(0)
  expect(`${bad.stdout}\n${bad.stderr}`).toContain("nosuch-ref")
  expect(readRegistry(home).marketplaces.mp.ref).toBe("feature")

  expect(ocm(home, "pin", "mp", "main").status).toBe(0)
  expect(readRegistry(home).marketplaces.mp.ref).toBe("main")
  expect(ocm(home, "update", "mp").status).toBe(0)
  entry = readRegistry(home).marketplaces.mp
  if (!entry.revision?.includes(mainSha)) {
    throw new Error(`expected mp.revision to contain ${mainSha} after pinning main, got ${entry.revision}`)
  }
  assertResolves(commandLink(home, "tool", "main-only.md"), join(cloneDir(home), "plugins", "tool", "commands", "main-only.md"))
  assertAbsent(commandLink(home, "tool", "feature.md"))

  expect(ocm(home, "pin", "mp", "--clear").status).toBe(0)
  expect(readRegistry(home).marketplaces.mp.ref).toBe(null)
  expect(ocm(home, "update", "mp").status).toBe(0) // back on the default branch

  // a ref deleted upstream fails the pull with the ref named; the marketplace
  // keeps working at its current revision
  git(remote, ["branch", "temp"])
  expect(ocm(home, "pin", "mp", "temp").status).toBe(0)
  git(remote, ["branch", "-D", "temp"])
  const deleted = ocm(home, "update", "mp")
  expect(deleted.status).not.toBe(0)
  expect(`${deleted.stdout}\n${deleted.stderr}`).toContain("temp")
  entry = readRegistry(home).marketplaces.mp
  if (!entry.revision?.includes(mainSha)) {
    throw new Error(`expected mp.revision to still contain ${mainSha} after the deleted-ref failure, got ${entry.revision}`)
  }
  assertResolves(commandLink(home, "tool", "work.md"), join(cloneDir(home), "plugins", "tool", "commands", "work.md"))
}, 240_000)

// each rename/removal scenario gets its own throwaway $HOME: a local
// marketplace at <home>/mp (name "mp"), one add, one mutation, one update
async function renameCase({ tree, pre, setup, mutate, verify, flags = [] }) {
  await withFakeHome(async (home) => {
    if (pre) pre(home)
    const mp = join(home, "mp")
    writeTree(mp, tree)
    const added = ocm(home, "add", mp, ...flags)
    if (added.status !== 0) throw new Error(`ocm add mp exited ${added.status}: ${added.stderr}`)
    if (setup) setup(home)
    mutate(mp)
    const result = ocm(home, "update", "mp")
    if (result.status !== 0) throw new Error(`ocm update mp exited ${result.status}: ${result.stderr}`)
    verify(home, mp, `${result.stdout}\n${result.stderr}`)
  })
}

test("4. renames migrate state and rename links; removal drops record, links and MCP keys; a plugin absent from discovery is pruned; a chain converges; a cycle warns", async () => {
  // rename: the enabled plugin's links and skill mirror move; the disabled
  // one stays disabled through its rename instead of reinstalling
  await renameCase({
    tree: { plugins: {
      old: { "plugin.json": PLUGIN_JSON, commands: { "review.md": COMMAND }, skills: { "python-style": { "SKILL.md": SKILL } } },
      ancient: { "plugin.json": PLUGIN_JSON, commands: { "legacy.md": COMMAND } },
    } },
    setup: (home) => {
      if (ocm(home, "uninstall", "ancient").status !== 0) throw new Error("ocm uninstall ancient exited non-zero")
    },
    mutate: (mp) => {
      renameSync(join(mp, "plugins", "old"), join(mp, "plugins", "new"))
      renameSync(join(mp, "plugins", "ancient"), join(mp, "plugins", "modern"))
      writeFileSync(join(mp, "marketplace.json"), renames({ old: "new", ancient: "modern" }))
    },
    verify: (home, mp, output) => {
      const plugins = readRegistry(home).marketplaces.mp.plugins
      expect(plugins.new?.enabled).toBe(true)
      expect(plugins.new?.installedAt).toBeTruthy()
      expect(plugins.modern?.enabled).toBe(false)
      expect(plugins.modern?.installedAt).toBe(null)
      expect(plugins.old).toBeUndefined()
      expect(plugins.ancient).toBeUndefined()
      expect(output).toMatch(/renamed[^\n]*old[^\n]*new/)
      expect(output).toMatch(/renamed[^\n]*ancient[^\n]*modern/)
      assertResolves(commandLink(home, "new", "review.md"), join(mp, "plugins", "new", "commands", "review.md"))
      assertAbsent(commandLink(home, "old", "review.md"))
      expect(lstatSync(skillMirror(home, "new")).isDirectory()).toBe(true)
      assertAbsent(skillMirror(home, "old"))
      assertAbsent(commandLink(home, "modern", "legacy.md"))
      // invariant: idempotence — a second update renames nothing again
      const ino = lstatSync(commandLink(home, "new", "review.md")).ino
      const again = ocm(home, "update", "mp")
      if (again.status !== 0) throw new Error(`second ocm update mp exited ${again.status}: ${again.stderr}`)
      expect(`${again.stdout}\n${again.stderr}`).not.toContain("renamed")
      expect(lstatSync(commandLink(home, "new", "review.md")).ino).toBe(ino)
    },
  })
  // removal (old → null): the record, links and MCP keys go; the user's own
  // server key survives (invariant: config safety)
  await renameCase({
    tree: { plugins: {
      dead: { "plugin.json": PLUGIN_JSON, commands: { "gone.md": COMMAND }, "mcp.json": mcpJson(MCP) },
      stay: { "plugin.json": PLUGIN_JSON, commands: { "keep.md": COMMAND } },
    } },
    flags: ["--trust"],
    pre: (home) => writeTree(cfg(home), {
      "opencode.json": `${JSON.stringify({ mcp: { "user-server": { type: "local", command: ["echo"] } } }, null, 2)}\n`,
    }),
    mutate: (mp) => {
      rmSync(join(mp, "plugins", "dead"), { recursive: true, force: true })
      writeFileSync(join(mp, "marketplace.json"), renames({ dead: null }))
    },
    verify: (home, mp, output) => {
      const plugins = readRegistry(home).marketplaces.mp.plugins
      expect(plugins.dead).toBeUndefined()
      expect(plugins.stay?.enabled).toBe(true)
      assertAbsent(commandLink(home, "dead", "gone.md"))
      assertResolves(commandLink(home, "stay", "keep.md"), join(mp, "plugins", "stay", "commands", "keep.md"))
      expect(mcpKeys(home)["ocm--dead--db"]).toBeUndefined()
      expect(mcpKeys(home)["user-server"]).toEqual({ type: "local", command: ["echo"] })
      expect(output).toMatch(/removed[^\n]*dead/)
    },
  })
  // a plugin absent from discovery is pruned even though it was disabled
  await renameCase({
    tree: { plugins: {
      gone: { "plugin.json": PLUGIN_JSON, commands: { "x.md": COMMAND } },
      stay: { "plugin.json": PLUGIN_JSON, commands: { "y.md": COMMAND } },
    } },
    setup: (home) => {
      if (ocm(home, "uninstall", "gone").status !== 0) throw new Error("ocm uninstall gone exited non-zero")
    },
    mutate: (mp) => rmSync(join(mp, "plugins", "gone"), { recursive: true, force: true }),
    verify: (home, mp, output) => {
      const plugins = readRegistry(home).marketplaces.mp.plugins
      expect(plugins.gone).toBeUndefined()
      expect(plugins.stay?.enabled).toBe(true)
      assertAbsent(commandLink(home, "gone", "x.md"))
      assertResolves(commandLink(home, "stay", "y.md"), join(mp, "plugins", "stay", "commands", "y.md"))
      expect(output).toContain("no longer in the marketplace")
      expect(output).toContain("gone")
    },
  })
  // a chain a→b→c converges: the record lands on c with its state intact
  await renameCase({
    tree: { plugins: { a: { "plugin.json": PLUGIN_JSON, commands: { "x.md": COMMAND } } } },
    setup: (home) => {
      if (ocm(home, "uninstall", "a").status !== 0) throw new Error("ocm uninstall a exited non-zero")
    },
    mutate: (mp) => {
      renameSync(join(mp, "plugins", "a"), join(mp, "plugins", "c"))
      writeFileSync(join(mp, "marketplace.json"), renames({ a: "b", b: "c" }))
    },
    verify: (home, _mp, output) => {
      const plugins = readRegistry(home).marketplaces.mp.plugins
      expect(plugins.c?.enabled).toBe(false)
      expect(plugins.a).toBeUndefined()
      expect(plugins.b).toBeUndefined()
      expect(output).toContain("renamed")
    },
  })
  // a cycle is reported as a warning and ignored: nothing moves
  await renameCase({
    tree: { plugins: {
      x: { "plugin.json": PLUGIN_JSON, commands: { "x.md": COMMAND } },
      y: { "plugin.json": PLUGIN_JSON, commands: { "y.md": COMMAND } },
    } },
    mutate: (mp) => writeFileSync(join(mp, "marketplace.json"), renames({ x: "y", y: "x" })),
    verify: (home, mp, output) => {
      expect(output.toLowerCase()).toContain("warning")
      const plugins = readRegistry(home).marketplaces.mp.plugins
      expect(plugins.x?.enabled).toBe(true)
      expect(plugins.y?.enabled).toBe(true)
      assertResolves(commandLink(home, "x", "x.md"), join(mp, "plugins", "x", "commands", "x.md"))
      assertResolves(commandLink(home, "y", "y.md"), join(mp, "plugins", "y", "commands", "y.md"))
    },
  })
  // plugin.json renames are honoured, but the marketplace manifest wins
  await renameCase({
    tree: { plugins: { old: { "plugin.json": PLUGIN_JSON, commands: { "x.md": COMMAND } } } },
    setup: (home) => {
      if (ocm(home, "uninstall", "old").status !== 0) throw new Error("ocm uninstall old exited non-zero")
    },
    mutate: (mp) => {
      renameSync(join(mp, "plugins", "old"), join(mp, "plugins", "new"))
      writeFileSync(join(mp, "marketplace.json"), renames({ old: "new" }))
      writeFileSync(join(mp, "plugins", "new", "plugin.json"), `${JSON.stringify({ description: "demo plugin", renames: { old: "other" } }, null, 2)}\n`)
    },
    verify: (home, _mp, output) => {
      const plugins = readRegistry(home).marketplaces.mp.plugins
      expect(plugins.new?.enabled).toBe(false)
      expect(plugins.other).toBeUndefined()
      expect(output).toMatch(/renamed[^\n]*old[^\n]*new/)
    },
  })
}, 480_000)

phase("5. per-marketplace throttle: marketplace A syncing does not suppress B", async (home) => {
  for (const [mp, plugin] of [["mp-a", "alpha"], ["mp-b", "beta"]]) {
    gitRepo(join(home, `remote-${mp}`), { plugins: { [plugin]: { "plugin.json": PLUGIN_JSON, commands: { "one.md": COMMAND } } } })
    expect(ocm(home, "add", `file://${join(home, `remote-${mp}`)}`, "--name", mp).status).toBe(0)
  }
  const first = loaderSync(home)
  if (first.status !== 0) throw new Error(`loader sync exited ${first.status}: ${first.stderr}`)
  // A synced moments ago, B two hours ago: only B is due
  editRegistry(home, (registry) => {
    registry.marketplaces["mp-a"].lastSync = { at: new Date().toISOString(), ok: true, error: null }
    registry.marketplaces["mp-b"].lastSync = { at: new Date(Date.now() - 2 * 3_600_000).toISOString(), ok: true, error: null }
  })
  for (const [mp, plugin] of [["mp-a", "alpha"], ["mp-b", "beta"]]) {
    writeFileSync(join(home, `remote-${mp}`, "plugins", plugin, "commands", "new.md"), COMMAND)
    commitAll(join(home, `remote-${mp}`), `advance ${mp}`)
  }
  const second = loaderSync(home)
  if (second.status !== 0) throw new Error(`loader sync exited ${second.status}: ${second.stderr}`)
  assertAbsent(commandLink(home, "alpha", "new.md")) // A is throttled by its own lastSync
  assertResolves(commandLink(home, "beta", "new.md"), join(cloneDir(home, "mp-b"), "plugins", "beta", "commands", "new.md"))
}, 180_000)

phase("6. syncAll writes nothing when nothing changed", async (home) => {
  gitRepo(join(home, "remote"), { plugins: { tool: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND }, "mcp.json": mcpJson(MCP) } } })
  expect(ocm(home, "add", `file://${join(home, "remote")}`, "--name", "mp", "--trust").status).toBe(0)
  const first = loaderSync(home)
  if (first.status !== 0) throw new Error(`loader sync exited ${first.status}: ${first.stderr}`)
  // the global stamp file is gone: the throttle lives in lastSync.at per marketplace
  assertAbsent(join(home, ".cache", "ocm", "last-sync.json"))
  const link = commandLink(home, "tool", "work.md")
  const ino = lstatSync(link).ino
  const configBytes = readFileSync(join(cfg(home), "opencode.json"), "utf8")
  const registryBytes = readFileSync(registryFile(home), "utf8")
  const second = loaderSync(home) // within the interval: skipped entirely
  if (second.status !== 0) throw new Error(`loader sync exited ${second.status}: ${second.stderr}`)
  expect(readFileSync(registryFile(home), "utf8")).toBe(registryBytes)
  expect(readFileSync(join(cfg(home), "opencode.json"), "utf8")).toBe(configBytes)
  expect(lstatSync(link).ino).toBe(ino)
})

phase("7. a cleared cache directory is re-cloned; a missing local directory is reported and never re-created", async (home) => {
  gitRepo(join(home, "remote"), { plugins: { tool: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } } } })
  expect(ocm(home, "add", `file://${join(home, "remote")}`, "--name", "mp").status).toBe(0)
  writeTree(join(cfg(home), "commands"), { "mine.md": "# my own command\n" })
  rmSync(join(home, ".cache", "ocm"), { recursive: true, force: true })
  const result = ocm(home, "update", "mp")
  if (result.status !== 0) throw new Error(`ocm update mp exited ${result.status}: ${result.stderr}`)
  expect(`${result.stdout}\n${result.stderr}`).toMatch(/clone/i)
  assertResolves(commandLink(home, "tool", "work.md"), join(cloneDir(home), "plugins", "tool", "commands", "work.md"))
  // invariant: ownership — the user's command survived the re-clone
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")

  // a local marketplace whose directory is gone is reported and skipped
  writeTree(join(home, "mp-local"), { plugins: { loc: { "plugin.json": PLUGIN_JSON, commands: { "x.md": COMMAND } } } })
  expect(ocm(home, "add", join(home, "mp-local")).status).toBe(0)
  rmSync(join(home, "mp-local"), { recursive: true, force: true })
  const updated = ocm(home, "update")
  expect(`${updated.stdout}\n${updated.stderr}`).toContain("mp-local")
  assertAbsent(join(home, "mp-local"))
  expect(readRegistry(home).marketplaces["mp-local"]).toBeDefined()
})

phase("an update that changes an executable component blocks it pending ocm trust while the rest of the update applies", async (home) => {
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { "team-tools": { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND }, plugin: { "notify.js": JS_PLUGIN } } } })
  expect(ocm(home, "add", `file://${remote}`, "--name", "mp", "--trust").status).toBe(0)
  const notifyLink = join(cfg(home), "plugins", "ocm--team-tools--notify.js")
  assertResolves(notifyLink, join(cloneDir(home), "plugins", "team-tools", "plugin", "notify.js"))
  writeFileSync(join(remote, "plugins", "team-tools", "plugin", "notify.js"), JS_PLUGIN_CHANGED)
  writeFileSync(join(remote, "plugins", "team-tools", "commands", "extra.md"), COMMAND)
  commitAll(remote, "change the executable component")
  const result = ocm(home, "update", "mp")
  if (result.status !== 0) throw new Error(`ocm update mp exited ${result.status}: ${result.stderr}`)
  const output = `${result.stdout}\n${result.stderr}`
  assertAbsent(notifyLink) // never serve new content unapproved
  assertResolves(commandLink(home, "team-tools", "extra.md"), join(cloneDir(home), "plugins", "team-tools", "commands", "extra.md"))
  assertResolves(commandLink(home, "team-tools", "work.md"), join(cloneDir(home), "plugins", "team-tools", "commands", "work.md"))
  expect(output).toContain("blocked")
  expect(output).toContain("ocm trust") // the report names the remedy
})

phase("a dirty working tree is discarded with a warning naming the clone; an up-to-date update still repairs a hand-deleted link", async (home) => {
  gitRepo(join(home, "remote"), { plugins: { tool: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } } } })
  expect(ocm(home, "add", `file://${join(home, "remote")}`, "--name", "mp").status).toBe(0)
  // the user edited the cache and deleted a link; the remote did not move
  writeFileSync(join(cloneDir(home), "plugins", "tool", "commands", "work.md"), "# dirty edit\n")
  rmSync(commandLink(home, "tool", "work.md"))
  const result = ocm(home, "update", "mp")
  if (result.status !== 0) throw new Error(`ocm update mp exited ${result.status}: ${result.stderr}`)
  const output = `${result.stdout}\n${result.stderr}`
  expect(output).toContain("already up to date")
  expect(output.toLowerCase()).toContain("warning")
  expect(output).toContain(cloneDir(home)) // the cache is not an editing surface: say so
  expect(readFileSync(join(cloneDir(home), "plugins", "tool", "commands", "work.md"), "utf8")).toBe(COMMAND)
  assertResolves(commandLink(home, "tool", "work.md"), join(cloneDir(home), "plugins", "tool", "commands", "work.md"))
})

phase("a rename whose target collides with another marketplace's plugin name is refused; the old record stays", async (home) => {
  writeTree(join(home, "mp-a"), { plugins: { new: { "plugin.json": PLUGIN_JSON, commands: { "a.md": COMMAND } } } })
  writeTree(join(home, "mp-b"), { plugins: { old: { "plugin.json": PLUGIN_JSON, commands: { "b.md": COMMAND } } } })
  expect(ocm(home, "add", join(home, "mp-a")).status).toBe(0)
  expect(ocm(home, "add", join(home, "mp-b")).status).toBe(0)
  if (ocm(home, "uninstall", "old").status !== 0) throw new Error("ocm uninstall old exited non-zero")
  renameSync(join(home, "mp-b", "plugins", "old"), join(home, "mp-b", "plugins", "new"))
  writeFileSync(join(home, "mp-b", "marketplace.json"), renames({ old: "new" }))
  const result = ocm(home, "update", "mp-b")
  const output = `${result.stdout}\n${result.stderr}`
  expect(output).toContain("mp-a") // the refusal names the incumbent
  const plugins = readRegistry(home).marketplaces["mp-b"].plugins
  expect(plugins.old?.enabled).toBe(false) // the old record stays, migration refused
  expect(plugins.new).toBeUndefined()
  assertAbsent(commandLink(home, "new", "b.md"))
  // invariant: ownership — the incumbent's link is never displaced
  assertResolves(commandLink(home, "new", "a.md"), join(home, "mp-a", "plugins", "new", "commands", "a.md"))
})

phase("syncIntervalMs 0 syncs on every start; OCM_SYNC_DISABLE=1 turns startup sync off entirely", async (home) => {
  gitRepo(join(home, "remote"), { plugins: { tool: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } } } })
  expect(ocm(home, "add", `file://${join(home, "remote")}`, "--name", "mp").status).toBe(0)
  editRegistry(home, (registry) => {
    registry.marketplaces.mp.syncIntervalMs = 0
  })
  const first = loaderSync(home)
  if (first.status !== 0) throw new Error(`loader sync exited ${first.status}: ${first.stderr}`)
  writeFileSync(join(home, "remote", "plugins", "tool", "commands", "extra.md"), COMMAND)
  commitAll(join(home, "remote"), "advance")
  const registryBytes = readFileSync(registryFile(home), "utf8")
  const disabled = loaderSync(home, { OCM_SYNC_DISABLE: "1" })
  if (disabled.status !== 0) throw new Error(`loader sync exited ${disabled.status}: ${disabled.stderr}`)
  assertAbsent(commandLink(home, "tool", "extra.md"))
  expect(readFileSync(registryFile(home), "utf8")).toBe(registryBytes)
  const third = loaderSync(home) // syncIntervalMs 0: due on every start
  if (third.status !== 0) throw new Error(`loader sync exited ${third.status}: ${third.stderr}`)
  assertResolves(commandLink(home, "tool", "extra.md"), join(cloneDir(home), "plugins", "tool", "commands", "extra.md"))
}, 180_000)

// brief 28 §3: case-folded plugin directories. A pair appearing upstream in
// a git tree stops that marketplace's update at the fetched ref (F89); a
// local pair is skipped with a warning and the rest of the update proceeds.

// git hash-object -w --stdin: create a blob without touching the working
// tree, so the index can hold a path the checkout cannot represent
function gitBlob(dir, contents) {
  const result = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: dir, encoding: "utf8", input: contents })
  if (result.status !== 0) throw new Error(`git hash-object failed in ${dir}: ${result.stderr}`)
  return result.stdout.trim()
}

// commit a plugins/case-kit sibling beside the on-disk plugins/case-Kit:
// the tree ships both names even where a checkout cannot hold both (F66)
function commitFoldedSibling(dir) {
  for (const [path, contents] of [
    ["plugins/case-kit/plugin.json", PLUGIN_JSON],
    ["plugins/case-kit/commands/run.md", COMMAND],
  ]) {
    git(dir, ["update-index", "--add", "--cacheinfo", `100644,${gitBlob(dir, contents)},${path}`])
  }
  // the index is committed directly: git add -A would collapse the folded
  // entries back to the working tree's single directory on this host
  git(dir, ["-c", "user.email=ocm@test", "-c", "user.name=ocm", "commit", "-m", "folded sibling"])
  const listed = git(dir, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n")
  for (const path of ["plugins/case-Kit/plugin.json", "plugins/case-kit/plugin.json"]) {
    if (!listed.includes(path)) throw new Error(`fixture error: ${dir} HEAD does not ship ${path}: ${JSON.stringify(listed)}`)
  }
}

phase("a folded plugins pair appearing upstream stops that marketplace's update and leaves it at its previous revision; the other marketplace updates", async (home) => {
  // the folded marketplace is clean at add time; the pair appears upstream
  const foldRemote = join(home, "remote-fold")
  gitRepo(foldRemote, { plugins: { "case-Kit": { "plugin.json": PLUGIN_JSON, commands: { "run.md": COMMAND } } } })
  const firstSha = shortSha(foldRemote)
  expect(ocm(home, "add", `file://${foldRemote}`, "--name", "fold").status).toBe(0)
  const cleanRemote = join(home, "remote-clean")
  gitRepo(cleanRemote, { plugins: { tool: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } } } })
  expect(ocm(home, "add", `file://${cleanRemote}`, "--name", "clean").status).toBe(0)
  writeTree(join(cfg(home), "commands"), { "mine.md": "# my own command\n" }) // ownership probe file

  commitFoldedSibling(foldRemote)
  writeFileSync(join(cleanRemote, "plugins", "tool", "commands", "new.md"), COMMAND)
  commitAll(cleanRemote, "advance clean")
  const cleanSha = shortSha(cleanRemote)

  const updated = ocm(home, "update")
  if (updated.status === 0) {
    throw new Error(`ocm update must not exit 0 while a marketplace ships a folded plugins pair:\n${updated.stdout}\n${updated.stderr}`)
  }
  const output = `${updated.stdout}\n${updated.stderr}`
  for (const needle of ["differ only in case", "plugins/case-Kit and plugins/case-kit", "ask the author to rename one"]) {
    expect(output).toContain(needle)
  }
  // the folded marketplace keeps its previous revision and stays materialized
  const fold = readRegistry(home).marketplaces.fold
  if (!fold.revision?.includes(firstSha)) {
    throw new Error(`expected fold.revision to still contain ${firstSha} after the refused update, got ${JSON.stringify(fold.revision)} in ${registryFile(home)}`)
  }
  assertResolves(commandLink(home, "case-kit", "run.md"), join(cloneDir(home, "fold"), "plugins", "case-Kit", "commands", "run.md"))
  // the failure is isolated: the clean marketplace advanced in the same run
  const clean = readRegistry(home).marketplaces.clean
  if (!clean.revision?.includes(cleanSha)) {
    throw new Error(`expected clean.revision to contain ${cleanSha} after the update, got ${JSON.stringify(clean.revision)} in ${registryFile(home)}`)
  }
  assertResolves(commandLink(home, "tool", "new.md"), join(cloneDir(home, "clean"), "plugins", "tool", "commands", "new.md"))
  // the failure is recorded for the folded marketplace
  if (fold.lastSync?.ok !== false) {
    throw new Error(`expected fold.lastSync.ok === false in ${registryFile(home)}, got ${JSON.stringify(fold.lastSync)}`)
  }
  // invariant: ownership — the user's command survives the refused update
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
}, 240_000)

phase("a local marketplace gaining a folded plugins pair between add and update skips the pair with a warning and keeps the installed link", async (home) => {
  const mp = join(home, "mp-local")
  writeTree(mp, { plugins: { "case-Kit": { "plugin.json": PLUGIN_JSON, commands: { "run.md": COMMAND } } } })
  const added = ocm(home, "add", mp)
  if (added.status !== 0) throw new Error(`ocm add mp-local exited ${added.status}: ${added.stderr}`)
  assertResolves(commandLink(home, "case-kit", "run.md"), join(mp, "plugins", "case-Kit", "commands", "run.md"))
  // the sibling appears on disk between add and update
  writeTree(join(mp, "plugins"), { "case-kit": { "plugin.json": PLUGIN_JSON, commands: { "run.md": COMMAND } } })
  // a case-insensitive host folds the pair onto one directory; the skip is
  // only observable where both names really exist
  const shipped = readdirSync(join(mp, "plugins"))
  if (!shipped.includes("case-Kit") || !shipped.includes("case-kit")) return
  const updated = ocm(home, "update", "mp-local")
  if (updated.status !== 0) {
    throw new Error(`the local update must succeed with the folded pair skipped, got exit ${updated.status}:\n${updated.stdout}\n${updated.stderr}`)
  }
  const output = `${updated.stdout}\n${updated.stderr}`
  const skipped = output.split("\n").find((l) => l.includes("skipped"))
  if (!skipped) throw new Error(`expected a skipped warning naming the folded pair in:\n${output}`)
  for (const name of ["case-Kit", "case-kit"]) {
    if (!skipped.includes(name)) throw new Error(`the skipped warning must name plugins/${name}:\n${skipped}`)
  }
  // the previously-installed plugin's link survives the skip untouched
  assertResolves(commandLink(home, "case-kit", "run.md"), join(mp, "plugins", "case-Kit", "commands", "run.md"))
})
}

// update hygiene: an unchanged update writes nothing — absorbed from test/phase26-update-hygiene.mjs
{
function ocm(home, args, timeout = 120_000) {
  const r = spawnSync(process.execPath, [OCM_BIN, ...args], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout })
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` }
}

function git(dir, args) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: 120_000 })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${r.stderr}`)
}

const commitAll = (dir, msg) => { git(dir, ["add", "-A"]); git(dir, ["-c", "user.email=ocm@test", "-c", "user.name=ocm", "commit", "-m", msg]) }

const gitRepo = (dir, tree) => { writeTree(dir, tree); git(dir, ["init", "-b", "main"]); commitAll(dir, "fixture") }

// the hygiene warning, however worded, hinges on "discarded" — the word whose
// truth this spec fixes; counting lines is what makes "warns once" meaningful
const discardedLines = (output) => output.split("\n").filter((l) => l.includes("discarded"))

// one git-backed marketplace named "mp", the fixture behind every item
function addGitMp(home) {
  gitRepo(join(home, "remote"), { plugins: { tool: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } } } })
  const added = ocm(home, ["add", `file://${join(home, "remote")}`, "--name", "mp"])
  if (added.status !== 0) throw new Error(`ocm add exited ${added.status}: ${added.output}`)
}

phase("1. an untracked file in the cache clone: the first update warns once and the file is gone; the second update is silent", async (home) => {
  writeTree(join(cfg(home), "commands"), { "mine.md": "# my own command\n" }) // ownership probe file
  addGitMp(home)
  const untracked = join(cloneDir(home), "plugins", "tool", "scratch.txt")
  writeFileSync(untracked, "# not part of the marketplace\n")

  const first = ocm(home, ["update", "mp"])
  if (first.status !== 0) throw new Error(`ocm update mp exited ${first.status}: ${first.output}`)
  const warnings = discardedLines(first.output)
  if (warnings.length !== 1) throw new Error(`expected exactly one discarded-warning line, got ${warnings.length}:\n${first.output}`)
  assertAbsent(untracked) // "discarded" must be true: git clean -fd removed it
  if (!/warning/i.test(warnings[0])) throw new Error(`the discard notice must be a warning:\n${warnings[0]}`)
  if (!/1 untracked files?\b/.test(warnings[0])) {
    throw new Error(`the warning must name what was discarded (spec 26 §1: "discarded … 1 untracked file"):\n${warnings[0]}`)
  }

  const second = ocm(home, ["update", "mp"])
  if (second.status !== 0) throw new Error(`second ocm update mp exited ${second.status}: ${second.output}`)
  if (discardedLines(second.output).length !== 0) throw new Error(`the cache is clean now; the second update must not warn again:\n${second.output}`)
  expect(second.output).not.toContain("local changes")

  // invariants: ownership — the user's command survives; no plugin-load errors
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
}, 420_000)

phase("2. a tracked local modification: reset + clean restore the file, the warning fires once naming the count, and the second update is silent", async (home) => {
  addGitMp(home)
  const tracked = join(cloneDir(home), "plugins", "tool", "commands", "work.md")
  writeFileSync(tracked, "# dirty edit\n")

  const first = ocm(home, ["update", "mp"])
  if (first.status !== 0) throw new Error(`ocm update mp exited ${first.status}: ${first.output}`)
  const warnings = discardedLines(first.output)
  if (warnings.length !== 1) throw new Error(`expected exactly one discarded-warning line, got ${warnings.length}:\n${first.output}`)
  if (!/1 local changes?\b/.test(warnings[0])) {
    throw new Error(`the warning must name what was discarded (spec 26 §1: "discarded 1 local change …"):\n${warnings[0]}`)
  }
  expect(readFileSync(tracked, "utf8")).toBe(COMMAND) // reset --hard restored the tracked content

  // invariant: idempotence — the second update warns nothing and re-creates no link
  const link = commandLink(home, "tool", "work.md")
  const ino = lstatSync(link).ino
  const second = ocm(home, ["update", "mp"])
  if (second.status !== 0) throw new Error(`second ocm update mp exited ${second.status}: ${second.output}`)
  if (discardedLines(second.output).length !== 0) throw new Error(`the cache is clean now; the second update must not warn again:\n${second.output}`)
  expect(lstatSync(link).ino).toBe(ino)
})

phase("3. a clean clone: the update output contains no local-changes line", async (home) => {
  // invariants: config safety and ownership — the user's config and command
  // predate the update and must survive it outside ocm's owned keys
  const userConfig = {
    model: "claude-sonnet-4-6",
    permission: { edit: "allow" },
    skills: { paths: ["/users/me/my-skills"] },
    mcp: { "user-server": { type: "local", command: ["echo"] } },
  }
  writeTree(cfg(home), { "opencode.json": json(userConfig), commands: { "mine.md": "# my own command\n" } })
  addGitMp(home)

  const result = ocm(home, ["update", "mp"])
  if (result.status !== 0) throw new Error(`ocm update mp exited ${result.status}: ${result.output}`)
  expect(result.output).not.toContain("local changes") // the spec item's own wording
  expect(discardedLines(result.output)).toEqual([]) // nothing was dirty, nothing was discarded

  const config = JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8"))
  for (const key of Object.keys(config.mcp ?? {})) if (key.startsWith("ocm--")) delete config.mcp[key]
  expect(config).toEqual(userConfig)
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
})

phase("4. a no-op update still writes the registry: lastSync.at advances (the rejected F41 stays rejected)", async (home) => {
  addGitMp(home)
  const first = ocm(home, ["update", "mp"])
  if (first.status !== 0) throw new Error(`ocm update mp exited ${first.status}: ${first.output}`)
  const atFirst = readRegistry(home).marketplaces.mp.lastSync?.at
  if (typeof atFirst !== "string") throw new Error(`expected lastSync.at recorded in ${registryFile(home)}, got ${JSON.stringify(atFirst)}`)
  const second = ocm(home, ["update", "mp"]) // the remote did not move
  if (second.status !== 0) throw new Error(`second ocm update mp exited ${second.status}: ${second.output}`)
  const lastSync = readRegistry(home).marketplaces.mp.lastSync
  if (lastSync?.at !== atFirst) return // advanced: the manual update is recorded even when nothing changed
  throw new Error(`the no-op update must still advance lastSync.at (spec 26 §3, F41 rejected) — ${registryFile(home)} still says ${atFirst}`)
})

phase("5. the README's auto-sync section documents the fire-and-forget sync (F40)", async () => {
  const readme = readFileSync(README, "utf8")
  const start = readme.indexOf("## Loader (auto-sync)")
  if (start === -1) throw new Error(`expected a "## Loader (auto-sync)" section in ${README}`)
  const end = readme.indexOf("\n## ", start + 1)
  const section = readme.slice(start, end === -1 ? undefined : end)
  // prose-compatible fragments of spec 26 §2's three claims: background sync
  // serves long-lived sessions; a short-lived `opencode run`/`debug` invocation
  // may exit before it completes; `ocm update` is the deterministic path
  const needles = [
    ["long-lived", "background sync serves long-lived sessions"],
    ["short-lived", "a short-lived invocation may exit before the sync completes"],
    ["opencode run", "the short-lived invocation is named"],
    ["exit before", "it may exit before the sync completes"],
    ["deterministic", "ocm update is the deterministic path"],
    ["ocm update", "the deterministic path is named"],
  ]
  const missing = needles.filter(([needle]) => !section.includes(needle))
  if (missing.length) {
    throw new Error(
      `${README} "## Loader (auto-sync)" does not state the background-sync contract — spec 26 §2:\n` +
        missing.map(([needle, claim]) => `  "${needle}" — ${claim}`).join("\n"),
    )
  }
})
}

// brief 29 §3: the grandfather's end is an event, not a warning — a plugin
// installed before the manifest requirement is uninstalled and reported when
// it changes upstream and fails the gate; unchanged, it keeps working
{
// realpath on both sides: macOS temp dirs sit behind /var -> /private/var
function assertResolves(dest, source) {
  if (!existsSync(dest) || !lstatSync(dest).isSymbolicLink()) throw new Error(`expected a symlink at ${dest}`)
  expect(realpathSync(dest)).toBe(realpathSync(source))
}

// the gate's description-empty finding, pinned verbatim (manifest-gate.js)
const emptyDescFinding = (plugin) =>
  `plugins/${plugin}/plugin.json: "description" is required and must be non-empty — add one line about the plugin and re-run ocm add`

// a home from before the gate, git-flavoured: the registry was written while
// plugin.json was optional, so legacy-tool is legitimately installed without
// one, and the cache clone's origin is the remote the update pulls from —
// only a git-backed marketplace can end the grandfather (the changed set is
// the diff between revisions)
function preGateGitHome(home) {
  const remote = join(home, "remote")
  gitRepo(remote, {
    plugins: {
      "legacy-tool": { commands: { "tool.md": COMMAND } },
      "fresh-tool": { "plugin.json": PLUGIN_JSON, commands: { "fresh.md": COMMAND } },
    },
  })
  const dir = cloneDir(home)
  mkdirSync(join(home, ".cache", "ocm", "marketplaces"), { recursive: true })
  git(home, ["clone", `file://${remote}`, dir])
  const at = "2026-01-01T00:00:00.000Z"
  mkdirSync(join(cfg(home), "ocm"), { recursive: true })
  writeFileSync(registryFile(home), json({
    version: 2,
    marketplaces: {
      mp: {
        url: `file://${remote}`, dir, local: false, addedAt: at, mode: "auto", ref: null,
        subdir: null, revision: git(dir, ["rev-parse", "HEAD"]), syncIntervalMs: null,
        trust: { code: "none" }, lastSync: null,
        plugins: {
          "legacy-tool": { source: "plugins/legacy-tool", components: { command: ["tool.md"] }, enabled: true, installedAt: at, version: null, manifest: {} },
          "fresh-tool": { source: "plugins/fresh-tool", components: { command: ["fresh.md"] }, enabled: true, installedAt: at, version: null, manifest: { description: "demo plugin" } },
        },
      },
    },
  }))
  // the links a real install would have left behind
  mkdirSync(join(cfg(home), "commands"), { recursive: true })
  symlinkSync(join(dir, "plugins", "legacy-tool", "commands", "tool.md"), commandLink(home, "legacy-tool", "tool.md"))
  symlinkSync(join(dir, "plugins", "fresh-tool", "commands", "fresh.md"), commandLink(home, "fresh-tool", "fresh.md"))
  return remote
}

// doctor probes opencode; the fake on test/fixtures answers in milliseconds
function doctorRun(home) {
  const result = spawnSync(process.execPath, [OCM_BIN, "doctor"], {
    env: withFakeOpencode({ ...process.env, HOME: home }), encoding: "utf8", timeout: 300_000,
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

phase("1. never-installed plugins whose plugin.json fails the gate are refused at update with one warning each and no record, while the good sibling updates", async (home) => {
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { good: { "plugin.json": PLUGIN_JSON, commands: { "base.md": COMMAND } } } })
  const added = ocm(home, "add", `file://${remote}`, "--name", "mp")
  if (added.status !== 0) throw new Error(`ocm add exited ${added.status}: ${added.stderr}`)
  writeTree(join(cfg(home), "commands"), { "mine.md": "# my own command\n" }) // ownership probe file
  const refused = [
    ["empty-kit", json({ description: "" }), emptyDescFinding("empty-kit")],
    ["blank-kit", json({ description: "   " }), emptyDescFinding("blank-kit")],
    ["long-kit", json({ description: "d".repeat(201) }), 'plugins/long-kit/plugin.json: "description" is longer than 200 characters (201) — shorten it'],
  ]
  const broken = {}
  for (const [name, manifest] of refused) broken[name] = { "plugin.json": manifest, commands: { "work.md": COMMAND } }
  writeTree(join(remote, "plugins"), broken)
  writeFileSync(join(remote, "plugins", "good", "commands", "extra.md"), COMMAND)
  commitAll(remote, "add broken kits upstream")

  const result = ocm(home, "update", "mp")
  if (result.status !== 0) throw new Error(`ocm update mp exited ${result.status} — the refusals must not fail the update:\n${result.stderr}`)
  for (const [name, , message] of refused) {
    const lines = result.stderr.split("\n").filter((l) => l.includes(`plugin "${name}"`))
    if (lines.length !== 1) {
      throw new Error(`expected exactly one stderr warning for ${name}, got ${lines.length}:\n${result.stdout}\n--- stderr ---\n${result.stderr}`)
    }
    for (const needle of [message, "not installed"]) {
      if (!lines[0].includes(needle)) throw new Error(`the ${name} warning must contain ${JSON.stringify(needle)}:\n${lines[0]}`)
    }
  }
  expect(result.stdout).not.toContain("uninstalled") // never installed: no report line
  const plugins = readRegistry(home).marketplaces.mp.plugins
  for (const [name] of refused) {
    if (plugins[name]) throw new Error(`expected no record for ${name} in ${registryFile(home)} — a gate-refused plugin is not registered`)
  }
  if (!plugins.good) throw new Error(`expected the good plugin to keep its record in ${registryFile(home)}`)
  assertResolves(commandLink(home, "good", "extra.md"), join(cloneDir(home), "plugins", "good", "commands", "extra.md"))
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n") // invariant: ownership

  // invariant: idempotence — a second update records nothing further and uninstalls nothing
  const pluginsBefore = readRegistry(home).marketplaces.mp.plugins
  const again = ocm(home, "update", "mp")
  if (again.status !== 0) throw new Error(`second ocm update mp exited ${again.status}: ${again.stderr}`)
  expect(readRegistry(home).marketplaces.mp.plugins).toEqual(pluginsBefore)
  expect(again.stdout).not.toContain("uninstalled")
}, 240_000)

phase("2. an installed plugin whose manifest breaks the gate on an upstream change is uninstalled and reported; --quiet does not swallow the report line", async (home) => {
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { tool: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } } } })
  expect(ocm(home, "add", `file://${remote}`, "--name", "mp").status).toBe(0)
  const quietRemote = join(home, "remote-quiet")
  gitRepo(quietRemote, { plugins: { "quiet-tool": { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } } } })
  expect(ocm(home, "add", `file://${quietRemote}`, "--name", "quiet").status).toBe(0)
  // invariants: config safety and ownership — the user's config and command
  // predate the uninstall and survive it outside ocm's owned keys
  const userConfig = {
    model: "claude-sonnet-4-6",
    permission: { edit: "allow" },
    skills: { paths: ["/users/me/my-skills"] },
    mcp: { "user-server": { type: "local", command: ["echo"] } },
  }
  writeTree(cfg(home), { "opencode.json": json(userConfig), commands: { "mine.md": "# my own command\n" } })

  writeFileSync(join(remote, "plugins", "tool", "plugin.json"), json({ description: "" }))
  commitAll(remote, "break the manifest")
  const result = ocm(home, "update", "mp")
  if (result.status !== 0) throw new Error(`ocm update mp exited ${result.status}: ${result.stderr}`)
  for (const needle of [
    'plugin "tool": changed upstream and no longer passes the manifest gate — uninstalled',
    emptyDescFinding("tool"),
    "fix it and run ocm update to reinstall it",
  ]) {
    if (!result.stderr.includes(needle)) {
      throw new Error(`stderr must contain ${JSON.stringify(needle)}:\n${result.stdout}\n--- stderr ---\n${result.stderr}`)
    }
  }
  const uninstalled = result.stdout.split("\n").filter((l) => l.includes("uninstalled"))
  if (uninstalled.length !== 1) throw new Error(`expected exactly one uninstalled report line on stdout, got ${uninstalled.length}:\n${result.stdout}`)
  if (!uninstalled[0].includes(`tool   uninstalled — ${emptyDescFinding("tool")}`)) {
    throw new Error(`the report line must read "tool   uninstalled — ${emptyDescFinding("tool")}":\n${uninstalled[0]}`)
  }
  if (readRegistry(home).marketplaces.mp.plugins.tool) {
    throw new Error(`expected tool's record gone from ${registryFile(home)} — a plugin the gate dropped leaves the registry`)
  }
  assertAbsent(commandLink(home, "tool", "work.md"))
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n") // invariant: ownership
  expect(JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8"))).toEqual(userConfig) // invariant: config safety

  // invariant: idempotence — the uninstall cannot happen twice
  const pluginsBefore = readRegistry(home).marketplaces.mp.plugins
  const again = ocm(home, "update", "mp")
  if (again.status !== 0) throw new Error(`second ocm update mp exited ${again.status}: ${again.stderr}`)
  expect(readRegistry(home).marketplaces.mp.plugins).toEqual(pluginsBefore)
  expect(again.stdout).not.toContain("uninstalled")

  // the dropped plugin counts into report.changed, so --quiet shows it too
  writeFileSync(join(quietRemote, "plugins", "quiet-tool", "plugin.json"), json({ description: "" }))
  commitAll(quietRemote, "break the quiet one")
  const quiet = ocm(home, "update", "quiet", "--quiet")
  if (quiet.status !== 0) throw new Error(`ocm update quiet --quiet exited ${quiet.status}: ${quiet.stderr}`)
  if (!quiet.stdout.includes(`quiet-tool   uninstalled — ${emptyDescFinding("quiet-tool")}`)) {
    throw new Error(`--quiet must not swallow the uninstalled report line:\n${quiet.stdout}\n${quiet.stderr}`)
  }
}, 300_000)

phase("3. the grandfather ends: a changed upstream plugin with no plugin.json is uninstalled with the three-line warning and one report line; its sibling updates", async (home) => {
  const remote = preGateGitHome(home)
  writeTree(join(cfg(home), "commands"), { "mine.md": "# my own command\n" }) // ownership probe file
  writeFileSync(join(remote, "plugins", "legacy-tool", "commands", "tool.md"), `${COMMAND}<!-- v2 -->\n`)
  writeFileSync(join(remote, "plugins", "fresh-tool", "commands", "new.md"), COMMAND)
  commitAll(remote, "advance")
  const result = ocm(home, "update", "mp")
  if (result.status !== 0) throw new Error(`ocm update mp exited ${result.status}: ${result.stderr}`)
  for (const needle of [
    'plugin "legacy-tool": changed upstream and still has no plugin.json — uninstalled',
    "it predates the plugin.json requirement and kept working until it changed",
    'add plugins/legacy-tool/plugin.json ({ "description": "…" }) and run ocm update to reinstall it',
  ]) {
    if (!result.stderr.includes(needle)) throw new Error(`stderr must contain the grandfather-end line ${JSON.stringify(needle)}:\n${result.stderr}`)
  }
  const uninstalled = result.stdout.split("\n").filter((l) => l.includes("uninstalled"))
  if (uninstalled.length !== 1) throw new Error(`expected exactly one uninstalled report line on stdout, got ${uninstalled.length}:\n${result.stdout}`)
  if (!uninstalled[0].includes("legacy-tool   uninstalled — plugin.json required now that it changed")) {
    throw new Error(`the report line must read "legacy-tool   uninstalled — plugin.json required now that it changed":\n${uninstalled[0]}`)
  }
  const plugins = readRegistry(home).marketplaces.mp.plugins
  if (plugins["legacy-tool"]) throw new Error(`expected legacy-tool's record gone from ${registryFile(home)}`)
  assertAbsent(commandLink(home, "legacy-tool", "tool.md"))
  // failure isolation: the manifest-bearing sibling updates normally
  if (!plugins["fresh-tool"] || plugins["fresh-tool"].enabled !== true) {
    throw new Error(`expected fresh-tool to stay enabled in ${registryFile(home)}, got ${JSON.stringify(plugins["fresh-tool"])}`)
  }
  assertResolves(commandLink(home, "fresh-tool", "new.md"), join(cloneDir(home), "plugins", "fresh-tool", "commands", "new.md"))
  assertResolves(commandLink(home, "fresh-tool", "fresh.md"), join(cloneDir(home), "plugins", "fresh-tool", "commands", "fresh.md"))
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n") // invariant: ownership

  // invariant: idempotence — the grandfather ends exactly once
  const pluginsBefore = readRegistry(home).marketplaces.mp.plugins
  const again = ocm(home, "update", "mp")
  if (again.status !== 0) throw new Error(`second ocm update mp exited ${again.status}: ${again.stderr}`)
  expect(readRegistry(home).marketplaces.mp.plugins).toEqual(pluginsBefore)
  expect(again.stdout).not.toContain("uninstalled")
}, 240_000)

phase("4. the grandfather holds without an upstream change: still enabled, still listed, no uninstalled line, and doctor's legacy warning stays exactly once", async (home) => {
  preGateGitHome(home)
  const result = ocm(home, "update", "mp")
  if (result.status !== 0) throw new Error(`ocm update mp exited ${result.status}: ${result.stderr}`)
  if (`${result.stdout}\n${result.stderr}`.includes("uninstalled")) {
    throw new Error(`an unchanged grandfathered plugin must not be uninstalled:\n${result.stdout}\n${result.stderr}`)
  }
  const record = readRegistry(home).marketplaces.mp.plugins["legacy-tool"]
  if (!record || record.enabled !== true) {
    throw new Error(`expected legacy-tool to stay enabled across the update in ${registryFile(home)}, got ${JSON.stringify(record)}`)
  }
  const listed = ocm(home, "list")
  if (listed.status !== 0) throw new Error(`ocm list exited ${listed.status}: ${listed.stderr}`)
  if (!listed.stdout.includes("legacy-tool")) throw new Error(`expected legacy-tool in ocm list output:\n${listed.stdout}`)
  assertResolves(commandLink(home, "legacy-tool", "tool.md"), join(cloneDir(home), "plugins", "legacy-tool", "commands", "tool.md"))

  // invariant: idempotence — a second unchanged update writes nothing and uninstalls nothing
  const pluginsBefore = readRegistry(home).marketplaces.mp.plugins
  const again = ocm(home, "update", "mp")
  if (again.status !== 0) throw new Error(`second ocm update mp exited ${again.status}: ${again.stderr}`)
  expect(readRegistry(home).marketplaces.mp.plugins).toEqual(pluginsBefore)
  assertResolves(commandLink(home, "legacy-tool", "tool.md"), join(cloneDir(home), "plugins", "legacy-tool", "commands", "tool.md"))

  const diagnosed = doctorRun(home)
  if (diagnosed.status !== 0) throw new Error(`the legacy warning is exit-code-neutral, but doctor exited ${diagnosed.status}:\n${diagnosed.stdout}\n${diagnosed.stderr}`)
  const warnings = `${diagnosed.stdout}\n${diagnosed.stderr}`.split("\n").filter((l) => l.includes("legacy-tool") && l.includes("plugin.json"))
  if (warnings.length !== 1) {
    throw new Error(`expected exactly one legacy warning for legacy-tool from ocm doctor, got ${warnings.length}:\n${diagnosed.stdout}\n${diagnosed.stderr}`)
  }
}, 420_000)
}
