// Phase 17 — docs/specs/17-add-integrity.md: one test per numbered item, plus
// the four invariants (idempotence and no plugin-load errors in 1, config
// safety and ownership in 4). The private-repo case runs ocm under the pty
// fixture ocm-pty.py against a loopback 401 server — git's credential prompt
// is the only way forward there and, in a tty, hangs forever; no real network
// is involved. Test 2 normalises the wall-clock addedAt/installedAt stamps
// before comparing registry bytes: those are the only fields two adds at two
// moments cannot share.
import { spawn, spawnSync } from "node:child_process"
import http from "node:http"
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, rmSync, writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, assertFileExists, opencodeProbe, withFakeHome } from "./harness.mjs"

const OCM_BIN = fileURLToPath(new URL("../bin/ocm.ts", import.meta.url))
const PTY_SCRIPT = fileURLToPath(new URL("./ocm-pty.py", import.meta.url))

function ocm(home, args, options = {}) {
  const result = spawnSync(process.execPath, [OCM_BIN, ...args], {
    env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 120_000, cwd: options.cwd,
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` }
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
const gitRepo = (dir, tree) => { writeTree(dir, tree); git(dir, ["init", "-b", "main"]); commitAll(dir, "fixture") }

const cfg = (home) => join(home, ".config", "opencode")
const registryFile = (home) => join(cfg(home), "ocm", "registry.json")
const readRegistry = (home) => JSON.parse(readFileSync(registryFile(home), "utf8"))
const commandLink = (home, plugin = "adw", file = "commit.md") => join(cfg(home), "commands", `${plugin}:${file}`)

// realpath on both sides: macOS temp dirs sit behind /var -> /private/var
function assertResolves(dest, source) {
  if (!existsSync(dest) || !lstatSync(dest).isSymbolicLink()) throw new Error(`expected a symlink at ${dest}`)
  expect(realpathSync(dest)).toBe(realpathSync(source))
}

// every directory ocm writes links into, as one comparable string of names
// and symlink targets
function snapTree(dir) {
  if (!existsSync(dir)) return ""
  let out = ""
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(dir, entry.name)
    out += `${entry.name}${entry.isSymbolicLink() ? ` -> ${readlinkSync(path)}` : ""}\n`
    if (entry.isDirectory()) out += snapTree(path)
  }
  return out
}
const snapOutput = (home) => [join(home, ".cache", "ocm", "links"), join(cfg(home), "commands"), join(cfg(home), "agents"), join(cfg(home), "plugins")].map(snapTree).join("--\n")

const COMMAND = "---\ndescription: commit helper\n---\n\nCommit body.\n"
const SKILL = "---\nname: python-style\ndescription: Python style guidance\n---\n\n# Python style\n\nUse ruff.\n"
// spec 19: every installable plugin carries a plugin.json with a description
const PLUGIN_JSON = `${JSON.stringify({ description: "demo plugin" }, null, 2)}\n`

phase("1. a relative path from $HOME installs live links and survives ocm update from an unrelated cwd", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND }, skills: { "python-style": { "SKILL.md": SKILL } } } } })
  const added = ocm(home, ["add", "mp"], { cwd: home })
  if (added.status !== 0) throw new Error(`ocm add mp (relative, cwd $HOME) exited ${added.status}: ${added.output}`)
  const real = realpathSync(mp)
  const entry = readRegistry(home).marketplaces.mp
  if (entry.dir !== real) throw new Error(`expected mp.dir to hold the absolute real path ${real} in ${registryFile(home)}, got ${entry.dir}`)
  assertResolves(commandLink(home), join(mp, "plugins", "adw", "commands", "commit.md"))
  assertFileExists(join(home, ".cache", "ocm", "links", "mp", "skills", "adw--python-style", "SKILL.md"))
  const updated = ocm(home, ["update"], { cwd: tmpdir() })
  if (updated.status !== 0) throw new Error(`ocm update from ${tmpdir()} exited ${updated.status}: ${updated.output}`)
  expect(updated.output).not.toContain("directory missing")
  // invariant: idempotence — a second update from the same unrelated cwd re-creates nothing
  const ino = lstatSync(commandLink(home)).ino
  const again = ocm(home, ["update"], { cwd: tmpdir() })
  if (again.status !== 0) throw new Error(`second ocm update exited ${again.status}: ${again.output}`)
  expect(lstatSync(commandLink(home)).ino).toBe(ino)
  expect(Object.keys(readRegistry(home).marketplaces)).toEqual(["mp"])
  // invariant: no plugin-load errors attributable to ocm-installed files
  const probe = opencodeProbe(cfg(home), home)
  if (!probe.available) console.log("skipped: opencode is not on PATH")
  else if (probe.unreliable) throw new Error("probe cannot trust itself: the canary broken plugin produced no error line")
  else expect(probe.pluginErrors).toEqual([])
}, 420_000)

test("2. the relative and absolute spellings of one marketplace produce identical registry bytes", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "ocm-shared-"))
  const mp = join(scratch, "mp")
  writeTree(mp, { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
  const bytes = []
  for (const [arg, cwd] of [["mp", scratch], [mp, tmpdir()]]) {
    await withFakeHome(async (home) => {
      const added = ocm(home, ["add", arg], { cwd })
      if (added.status !== 0) throw new Error(`ocm add ${arg} (cwd ${cwd}) exited ${added.status}: ${added.output}`)
      bytes.push(readFileSync(registryFile(home), "utf8"))
    })
  }
  rmSync(scratch, { recursive: true, force: true })
  const normalise = (text) => {
    const registry = JSON.parse(text)
    registry.marketplaces.mp.addedAt = "T"
    for (const plugin of Object.values(registry.marketplaces.mp.plugins)) plugin.installedAt = "T"
    return `${JSON.stringify(registry, null, 2)}\n`
  }
  expect(normalise(bytes[1])).toBe(normalise(bytes[0]))
}, 240_000)

phase("3. a nonexistent path is refused before any write: no registry file, no links", async (home) => {
  const result = ocm(home, ["add", "ocm-no-such-marketplace"], { cwd: tmpdir() })
  expect(result.status).toBe(1)
  expect(result.output).toContain("path does not exist")
  assertAbsent(registryFile(home))
  assertAbsent(join(home, ".cache", "ocm", "links"))
})

phase("4. a 200-char plugin name is refused whole before any write: one error naming the limit, exit 1, zero writes", async (home) => {
  // the user's config and file predate the refused add (invariants: config safety, ownership)
  writeTree(cfg(home), {
    "opencode.json": `${JSON.stringify({ model: "claude-sonnet-4-6", mcp: { "user-server": { type: "local", command: ["echo"] } } }, null, 2)}\n`,
    commands: { "mine.md": "# my own command\n" },
  })
  const good = join(home, "good")
  writeTree(good, { plugins: { keep: { "plugin.json": PLUGIN_JSON, commands: { "keep.md": COMMAND }, skills: { "python-style": { "SKILL.md": SKILL } } } } })
  expect(ocm(home, ["add", good]).status).toBe(0)
  const longName = "a".repeat(200)
  const bad = join(home, "bad")
  writeTree(bad, { plugins: { [longName]: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } }, fine: { "plugin.json": PLUGIN_JSON, commands: { "fine.md": COMMAND } } } })
  const registryBytes = readFileSync(registryFile(home), "utf8")
  const configBytes = readFileSync(join(cfg(home), "opencode.json"), "utf8")
  const links = snapOutput(home)

  const result = ocm(home, ["add", bad])
  expect(result.status).toBe(1)
  const offenders = result.output.split("\n").filter((line) => line.includes("exceeds"))
  if (offenders.length !== 1) throw new Error(`expected exactly one limit error, got ${offenders.length}:\n${result.output}`)
  expect(offenders[0]).toContain("64") // the plugin-name limit the 200-char name breaks
  expect(result.output).not.toContain("ENAMETOOLONG") // never a raw syscall message
  // zero writes: registry, config and every link surface are byte-identical
  expect(readFileSync(registryFile(home), "utf8")).toBe(registryBytes)
  expect(readFileSync(join(cfg(home), "opencode.json"), "utf8")).toBe(configBytes)
  expect(snapOutput(home)).toBe(links)
  expect(readRegistry(home).marketplaces.bad).toBeUndefined() // refused whole, the fine plugin included
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
})

phase("5. an unreachable repo under a tty fails fast with the ocm error instead of hanging at git's prompt", async (home) => {
  // a loopback server answering 401 to everything: git's only way forward is
  // a credential prompt, which in a tty hangs forever (F31)
  const server = http.createServer((req, res) => {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="ocm"' })
    res.end("auth required")
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${server.address().port}/ocm-test/private-repo.git`
  // git config and askpass helpers are neutralised so the terminal is the
  // only credential source; GIT_TERMINAL_PROMPT stays unset — setting it on
  // ocm's own git spawns is the implementation's job
  const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }
  delete env.GIT_TERMINAL_PROMPT
  delete env.GIT_ASKPASS
  delete env.SSH_ASKPASS
  try {
    const started = Date.now()
    // an async spawn (the 401 server lives in this process and must answer
    // while ocm runs); python's own stderr goes to ours
    const child = spawn("python3", [PTY_SCRIPT, "n\r", process.execPath, OCM_BIN, "add", url], {
      env, stdio: ["ignore", "pipe", "inherit"],
    })
    let stdout = ""
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 70_000)
      child.stdout.setEncoding("utf8")
      child.stdout.on("data", (chunk) => (stdout += chunk))
      child.on("error", (err) => { clearTimeout(timer); resolve({ error: err }) })
      child.on("close", () => { clearTimeout(timer); resolve({ stdout }) })
    })
    let run
    try {
      run = JSON.parse(result.stdout ?? "")
    } catch {
      throw new Error(`the pty helper printed no JSON: ${JSON.stringify(result)}`)
    }
    const elapsed = Date.now() - started
    if (run.timed_out) throw new Error(`ocm never exited under the tty (hung at git's credential prompt?), after ${elapsed}ms:\n${run.stderr}`)
    if (run.status === 0) throw new Error(`ocm add of an unreachable repo exited 0:\n${run.stderr}`)
    if (elapsed >= 2000) throw new Error(`expected the failure within 2s, took ${elapsed}ms:\n${run.stderr}`)
    expect(run.stderr).toContain("cannot access")
    expect(run.stderr).toContain(url)
    assertAbsent(join(home, ".cache", "ocm", "marketplaces", "ocm-test--private-repo")) // no clone left behind
  } finally {
    server.closeAllConnections?.()
    server.close()
  }
}, 120_000)

phase("6. add --ref records the cloned revision and a successful lastSync at add time", async (home) => {
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { tool: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } } } })
  git(remote, ["checkout", "-b", "feature"])
  writeFileSync(join(remote, "plugins", "tool", "commands", "feature.md"), COMMAND)
  commitAll(remote, "feature work")
  const featureSha = git(remote, ["rev-parse", "--short", "feature"])
  const added = ocm(home, ["add", `file://${remote}`, "--name", "mp", "--ref", "feature"])
  if (added.status !== 0) throw new Error(`ocm add --ref feature exited ${added.status}: ${added.output}`)
  const entry = readRegistry(home).marketplaces.mp
  if (!entry.revision?.includes(featureSha)) {
    throw new Error(`expected mp.revision to contain ${featureSha} right after the add, got ${JSON.stringify(entry.revision)} in ${registryFile(home)}`)
  }
  if (entry.lastSync?.ok !== true || !entry.lastSync.at) {
    throw new Error(`expected mp.lastSync.ok === true with a timestamp right after the add, got ${JSON.stringify(entry.lastSync)}`)
  }
})

phase("7. a no-match search on a local marketplace does not hint at a stale sync", async (home) => {
  writeTree(join(home, "mp"), { plugins: { solo: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } } } })
  expect(ocm(home, ["add", join(home, "mp")]).status).toBe(0)
  const result = ocm(home, ["search", "zzz-nothing"])
  expect(result.status).toBe(1)
  expect(result.output).toContain('no matches for "zzz-nothing"')
  expect(result.output).not.toContain("ocm update")
  expect(result.output).not.toContain("stale")
})

test("8. a quoted ~/ argument is expanded by ocm itself, and a bare owner/repo gains the repository-shorthand hint", async () => {
  await withFakeHome(async (home) => {
    writeTree(join(home, "mp"), { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
    // the shell passed the tilde through unexpanded; the cwd is unrelated,
    // so only ocm's own expansion can find the directory
    const result = ocm(home, ["add", "~/mp"], { cwd: tmpdir() })
    if (result.status !== 0) throw new Error(`ocm add "~/mp" exited ${result.status}: ${result.output}`)
    const real = realpathSync(join(home, "mp"))
    const entry = readRegistry(home).marketplaces.mp
    if (entry.dir !== real) throw new Error(`expected mp.dir to hold ${real} in ${registryFile(home)}, got ${entry.dir}`)
    assertResolves(commandLink(home), join(home, "mp", "plugins", "adw", "commands", "commit.md"))
  })
  await withFakeHome(async (home) => {
    const result = ocm(home, ["add", "wntic/some-repo"], { cwd: tmpdir() })
    expect(result.status).toBe(1)
    expect(result.output).toContain("path does not exist")
    expect(result.output).toContain("shorthand")
    expect(result.output).toContain("https://github.com")
    assertAbsent(registryFile(home))
  })
}, 240_000)
