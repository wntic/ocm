// Phase 08 — docs/specs/08-update.md: one test per numbered item, plus the
// body behaviours the items lean on (the trust-blocked report line in 8, the
// edge cases in 9, rename collisions in 10, the auto-sync knobs in 11). The
// four invariants: no plugin-load errors in 1, idempotence in 4, config
// safety in 4 and 6, ownership in 7 and 10. Git marketplaces come from
// file:// URLs to local fixture repos — no network.
import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, opencodeProbe, withFakeHome } from "./harness.mjs"

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

// realpath on both sides: macOS temp dirs sit behind /var -> /private/var
function assertResolves(dest, source) {
  if (!existsSync(dest) || !lstatSync(dest).isSymbolicLink()) throw new Error(`expected a symlink at ${dest}`)
  expect(realpathSync(dest)).toBe(realpathSync(source))
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

phase("1. two commits report the revision transition, the per-plugin version change and the + ~ - file list; a versionless plugin lists as @<short sha>", async (home) => {
  const remote = join(home, "remote")
  gitRepo(remote, {
    plugins: {
      "quality-review": {
        "plugin.json": `${JSON.stringify({ version: "1.2.0" }, null, 2)}\n`,
        commands: { "base.md": COMMAND },
        skills: { "code-review": { "SKILL.md": SKILL } },
        agents: { "old-reviewer.md": "---\ndescription: old reviewer\n---\n\nReviews.\n" },
      },
      plain: { commands: { "work.md": COMMAND }, plugin: { "hello.js": JS_PLUGIN } },
    },
  })
  expect(ocm(home, "add", `file://${remote}`, "--name", "mp", "--trust").status).toBe(0)
  const before = shortSha(remote)
  writeFileSync(join(remote, "plugins", "quality-review", "plugin.json"), `${JSON.stringify({ version: "1.3.0" }, null, 2)}\n`)
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
  const probe = opencodeProbe(cfg(home), home)
  if (!probe.available) console.log("skipped: opencode is not on PATH")
  else {
    if (probe.unreliable) throw new Error("probe cannot trust itself: the canary broken plugin produced no error line")
    expect(probe.pluginErrors).toEqual([])
  }
}, 420_000)

phase("2. one unreachable marketplace of three: the others update, its links survive, lastSync.ok is false, exit is non-zero", async (home) => {
  const PLUGINS = { "mp-a": "alpha", "mp-b": "beta", "mp-c": "gamma" }
  for (const [mp, plugin] of Object.entries(PLUGINS)) {
    gitRepo(join(home, `remote-${mp}`), { plugins: { [plugin]: { commands: { "one.md": COMMAND, "two.md": COMMAND } } } })
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
  gitRepo(remote, { plugins: { tool: { commands: { "work.md": COMMAND } } } })
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
      old: { commands: { "review.md": COMMAND }, skills: { "python-style": { "SKILL.md": SKILL } } },
      ancient: { commands: { "legacy.md": COMMAND } },
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
      dead: { commands: { "gone.md": COMMAND }, "mcp.json": mcpJson(MCP) },
      stay: { commands: { "keep.md": COMMAND } },
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
      gone: { commands: { "x.md": COMMAND } },
      stay: { commands: { "y.md": COMMAND } },
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
    tree: { plugins: { a: { commands: { "x.md": COMMAND } } } },
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
      x: { commands: { "x.md": COMMAND } },
      y: { commands: { "y.md": COMMAND } },
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
    tree: { plugins: { old: { commands: { "x.md": COMMAND } } } },
    setup: (home) => {
      if (ocm(home, "uninstall", "old").status !== 0) throw new Error("ocm uninstall old exited non-zero")
    },
    mutate: (mp) => {
      renameSync(join(mp, "plugins", "old"), join(mp, "plugins", "new"))
      writeFileSync(join(mp, "marketplace.json"), renames({ old: "new" }))
      writeFileSync(join(mp, "plugins", "new", "plugin.json"), renames({ old: "other" }))
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
    gitRepo(join(home, `remote-${mp}`), { plugins: { [plugin]: { commands: { "one.md": COMMAND } } } })
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
  gitRepo(join(home, "remote"), { plugins: { tool: { commands: { "work.md": COMMAND }, "mcp.json": mcpJson(MCP) } } })
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
  gitRepo(join(home, "remote"), { plugins: { tool: { commands: { "work.md": COMMAND } } } })
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
  writeTree(join(home, "mp-local"), { plugins: { loc: { commands: { "x.md": COMMAND } } } })
  expect(ocm(home, "add", join(home, "mp-local")).status).toBe(0)
  rmSync(join(home, "mp-local"), { recursive: true, force: true })
  const updated = ocm(home, "update")
  expect(`${updated.stdout}\n${updated.stderr}`).toContain("mp-local")
  assertAbsent(join(home, "mp-local"))
  expect(readRegistry(home).marketplaces["mp-local"]).toBeDefined()
})

phase("an update that changes an executable component blocks it pending ocm trust while the rest of the update applies", async (home) => {
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { "team-tools": { commands: { "work.md": COMMAND }, plugin: { "notify.js": JS_PLUGIN } } } })
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
  gitRepo(join(home, "remote"), { plugins: { tool: { commands: { "work.md": COMMAND } } } })
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
  writeTree(join(home, "mp-a"), { plugins: { new: { commands: { "a.md": COMMAND } } } })
  writeTree(join(home, "mp-b"), { plugins: { old: { commands: { "b.md": COMMAND } } } })
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
  gitRepo(join(home, "remote"), { plugins: { tool: { commands: { "work.md": COMMAND } } } })
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
