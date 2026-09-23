// Git failure classification: a failed fetch or clone names its cause —
// the pure classifier, and the CLI and loader paths that render its message.

import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { rootCacheDir, withFakeHome } from "./harness.mjs"

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

function gitRepo(dir, tree) {
  writeTree(dir, tree)
  git(dir, ["init", "-b", "main"])
  git(dir, ["add", "-A"])
  git(dir, ["-c", "user.email=ocm@test", "-c", "user.name=ocm", "commit", "-m", "fixture"])
}

const cfg = (home) => join(home, ".config", "opencode")

const registryFile = (home) => join(cfg(home), "ocm", "registry.json")

const readRegistry = (home) => JSON.parse(readFileSync(registryFile(home), "utf8"))

const cloneDir = (home, name = "mp") => join(rootCacheDir(home), "marketplaces", name)

const commandLink = (home, plugin, file) => join(cfg(home), "commands", `${plugin}:${file}`)

// realpath on both sides: macOS temp dirs sit behind /var -> /private/var
function assertResolves(dest, source) {
  if (!existsSync(dest) || !lstatSync(dest).isSymbolicLink()) throw new Error(`expected a symlink at ${dest}`)
  expect(realpathSync(dest)).toBe(realpathSync(source))
}

// the loader's startup sync, run the way ocm-loader.js runs it: a child on
// the fake $HOME, throttled to due-now, carrying the startup reason
function loaderSync(home, env = {}) {
  const runner = join(home, "sync-runner.mjs")
  writeFileSync(runner, 'const mod = await import(process.argv[2]); await mod.syncAll({ reason: "startup" })\n')
  const result = spawnSync(process.execPath, [runner, CORE_MODULE], {
    env: { ...process.env, HOME: home, ...env }, encoding: "utf8", timeout: 120_000,
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

const COMMAND = "---\ndescription: demo\n---\n\nDemo body.\n"

const SKILL = "---\nname: demo-skill\ndescription: Demo skill\n---\n\n# Demo\n\nBody.\n"

const PLUGIN_JSON = `${JSON.stringify({ description: "demo plugin" }, null, 2)}\n`

test("1. classifyGitFailure maps each git failure to a code and a message that names the cause", async () => {
  const { classifyGitFailure } = await import("../loader/git-errors.js")
  // REMOTE, not URL: a local named URL shadows the global constructor the
  // local-missing assertion below needs
  const REMOTE = "https://example.com/x.git"
  const DIR = "/cache/ocm/roots/default-9f2c1/marketplaces/mp"
  // [case, operation, stderr, ref, code, message]
  const ROWS = [
    ["a spawn error's text (git off PATH)", "clone", "Error: spawn git ENOENT", null, "git-missing",
      "git is not on PATH — ocm needs git to clone and update marketplaces\n  install git, then re-run"],
    ["stderr: not a git repository", "clone", "fatal: 'file:///tmp/not-a-repo' does not appear to be a git repository", null, "local-not-a-repo",
      `${REMOTE} is a directory, not a git repository\n  add a local directory by path: ocm add ${REMOTE}`],
    ["remote ref not found", "fetch", "error: couldn't find remote ref refs/heads/temp", "temp", "ref-missing",
      `${REMOTE} has no ref "temp" — it may have been deleted or renamed upstream\n  ocm pin mp temp to follow another, or ocm pin mp to follow the default branch`],
    ["remote ref not found, no ref given (defaults to HEAD)", "fetch", "error: couldn't find remote ref refs/heads/main", null, "ref-missing",
      `${REMOTE} has no ref "HEAD" — it may have been deleted or renamed upstream\n  ocm pin mp HEAD to follow another, or ocm pin mp to follow the default branch`],
    ["a leftover lock file", "fetch", "fatal: Unable to create '/tmp/x/.git/shallow.lock': File exists.", null, "stale-lock",
      `${DIR} holds a git lock left by an interrupted git process (/tmp/x/.git/shallow.lock)\n  remove that file, then re-run`],
    ["clone target already exists", "clone", "fatal: destination path 'mp' already exists and is not an empty directory.", null, "clone-target-exists",
      `${DIR} already exists and is not an empty directory\n  remove it, then re-run`],
    ["host unreachable", "fetch", "fatal: unable to access 'https://example.com/x.git/': Could not resolve host: example.com", null, "network",
      `cannot reach ${REMOTE} — fatal: unable to access 'https://example.com/x.git/': Could not resolve host: example.com`],
    ["the loader's timeout sentinel", "fetch", "git timed out", null, "timed-out",
      `git timed out after 120s on ${REMOTE}`],
    ["repository not found, with a ref", "fetch", "remote: Repository not found.", "v1.0.0", "auth-or-missing",
      `cannot access ${REMOTE} (ref "v1.0.0") — the repository is private, unreachable, or the URL is wrong`],
    ["authentication failed, no ref", "fetch", "fatal: Authentication failed for 'https://example.com/x.git/'", null, "auth-or-missing",
      `cannot access ${REMOTE} — the repository is private, unreachable, or the URL is wrong`],
  ]
  for (const [name, operation, stderr, ref, code, message] of ROWS) {
    const out = classifyGitFailure({ operation, result: { ok: false, stdout: "", stderr }, url: REMOTE, ref, dir: DIR })
    if (out?.code !== code || out?.message !== message) {
      throw new Error(`${name}: expected code "${code}" and message\n${message}\ngot code "${out?.code}" and message\n${out?.message}`)
    }
  }
  // file:// local facts are classified from the url alone, before stderr is read
  const missing = join(tmpdir(), `ocm-no-such-${process.pid}`)
  const local = classifyGitFailure({ operation: "clone", result: { ok: false, stdout: "", stderr: "" }, url: `file://${missing}`, ref: null, dir: DIR })
  expect(local.code).toBe("local-missing")
  expect(local.message).toBe(`${fileURLToPath(new URL(`file://${missing}`))} does not exist`)
}, 120_000)

test("2. an unrecognised failure keeps the sentence and carries git's first two stderr lines; empty stderr gets the bare sentence", async () => {
  const { classifyGitFailure } = await import("../loader/git-errors.js")
  const URL = "https://example.com/x.git"
  const DIR = "/cache/ocm/roots/default-9f2c1/marketplaces/mp"
  const out = classifyGitFailure({
    operation: "fetch",
    result: { ok: false, stdout: "", stderr: "fatal: something unexpected\n\nfatal: line two\nfatal: line three" },
    url: URL, ref: null, dir: DIR,
  })
  expect(out.code).toBe("unknown")
  expect(out.message).toBe(
    `cannot access ${URL} — the repository is private, unreachable, or the URL is wrong\n` +
      `  git: fatal: something unexpected\n  git: fatal: line two`,
  )
  const bare = classifyGitFailure({ operation: "fetch", result: { ok: false, stdout: "", stderr: " \n" }, url: URL, ref: null, dir: DIR })
  expect(bare.code).toBe("unknown")
  expect(bare.message).toBe(`cannot access ${URL} — the repository is private, unreachable, or the URL is wrong`)
}, 120_000)

phase("3. a stale .git/shallow.lock fails ocm update naming the lock file and the interrupted git process", async (home) => {
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { demo: { "plugin.json": PLUGIN_JSON, commands: { "run.md": COMMAND } } } })
  expect(ocm(home, "add", `file://${remote}`, "--name", "mp").status).toBe(0)
  writeFileSync(join(cloneDir(home), ".git", "shallow.lock"), "")
  const updated = ocm(home, "update", "mp")
  expect(updated.status).not.toBe(0)
  const output = `${updated.stdout}\n${updated.stderr}`
  expect(output).toContain("holds a git lock left by an interrupted git process")
  expect(output).toContain("shallow.lock")
  expect(output).not.toContain("another ocm")
  // invariant: ownership — a failed pull leaves the installed link alone
  assertResolves(commandLink(home, "demo", "run.md"), join(cloneDir(home), "plugins", "demo", "commands", "run.md"))
})

phase("4. ocm add file://<non-repo directory> is refused with the path form suggested; the plain-path add of the same directory works", async (home) => {
  const dir = join(home, "plain")
  writeTree(dir, { plugins: { demo: { "plugin.json": PLUGIN_JSON, commands: { "run.md": COMMAND }, skills: { "demo-skill": { "SKILL.md": SKILL } } } } })
  // invariant: config safety + ownership — a user key and a user command both
  // predate every ocm write this test makes
  mkdirSync(join(cfg(home), "commands"), { recursive: true })
  writeFileSync(join(cfg(home), "opencode.json"), `${JSON.stringify({ model: "user-model" }, null, 2)}\n`)
  writeFileSync(join(cfg(home), "commands", "mine.md"), "# my own command\n")
  const refused = ocm(home, "add", `file://${dir}`)
  expect(refused.status).not.toBe(0)
  expect(refused.stderr).toContain("is a directory, not a git repository")
  expect(refused.stderr).toContain(`ocm add ${dir}`)
  // nothing cloned, nothing registered (a failed add leaves no clone behind)
  const marketplaces = join(rootCacheDir(home), "marketplaces")
  expect(existsSync(marketplaces) ? readdirSync(marketplaces) : []).toEqual([])
  const plain = ocm(home, "add", dir)
  if (plain.status !== 0) throw new Error(`ocm add ${dir} exited ${plain.status}: ${plain.stderr}`)
  assertResolves(commandLink(home, "demo", "run.md"), join(dir, "plugins", "demo", "commands", "run.md"))
  expect(JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8")).model).toBe("user-model")
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
})

phase("5. a ref deleted upstream fails the update naming the ref; the pin, the revision and the links survive", async (home) => {
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { demo: { "plugin.json": PLUGIN_JSON, commands: { "run.md": COMMAND } } } })
  git(remote, ["branch", "temp"])
  expect(ocm(home, "add", `file://${remote}`, "--name", "mp", "--ref", "temp").status).toBe(0)
  const pinned = readRegistry(home).marketplaces.mp.revision
  git(remote, ["branch", "-D", "temp"])
  const updated = ocm(home, "update", "mp")
  expect(updated.status).not.toBe(0)
  expect(`${updated.stdout}\n${updated.stderr}`).toContain(`has no ref "temp"`)
  const entry = readRegistry(home).marketplaces.mp
  expect(entry.ref).toBe("temp")
  expect(entry.revision).toBe(pinned)
  assertResolves(commandLink(home, "demo", "run.md"), join(cloneDir(home), "plugins", "demo", "commands", "run.md"))
  // a second failing update drifts nothing
  expect(ocm(home, "update", "mp").status).not.toBe(0)
  expect(readRegistry(home).marketplaces.mp.revision).toBe(pinned)
})

phase("6. a git lock during the loader's startup sync lands in lastSync.error; the loader never throws", async (home) => {
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { demo: { "plugin.json": PLUGIN_JSON, commands: { "run.md": COMMAND } } } })
  expect(ocm(home, "add", `file://${remote}`, "--name", "mp").status).toBe(0)
  writeFileSync(join(cloneDir(home), ".git", "shallow.lock"), "")
  const synced = loaderSync(home, { OCM_SYNC_INTERVAL_MS: "0" })
  expect(synced.status).toBe(0)
  const lastSync = readRegistry(home).marketplaces.mp.lastSync
  if (!lastSync || lastSync.ok !== false || !lastSync.error?.includes("holds a git lock left by an interrupted git process")) {
    throw new Error(`expected the stale-lock message in lastSync.error of ${registryFile(home)}, got ${JSON.stringify(lastSync)}`)
  }
})

phase("7. git off PATH stops ocm update once, before any per-marketplace work", async (home) => {
  // distinct plugin names: a second marketplace cannot claim mp-a's command link
  const pluginTree = (name) => ({ plugins: { [name]: { "plugin.json": PLUGIN_JSON, commands: { "run.md": COMMAND } } } })
  const remoteA = join(home, "remote-a")
  const remoteB = join(home, "remote-b")
  gitRepo(remoteA, pluginTree("demo-a"))
  gitRepo(remoteB, pluginTree("demo-b"))
  expect(ocm(home, "add", `file://${remoteA}`, "--name", "mp-a").status).toBe(0)
  expect(ocm(home, "add", `file://${remoteB}`, "--name", "mp-b").status).toBe(0)
  const registryBytes = readFileSync(registryFile(home), "utf8")
  // process.execPath is absolute, so bun is still found; only git becomes unfindable
  const noGit = join(home, "no-git")
  mkdirSync(noGit)
  const updated = spawnSync(process.execPath, [OCM_BIN, "update"], {
    env: { ...process.env, HOME: home, PATH: noGit }, encoding: "utf8", timeout: 120_000,
  })
  expect(updated.status).toBe(1)
  const output = `${updated.stdout ?? ""}\n${updated.stderr ?? ""}`
  const count = output.split("git is not on PATH").length - 1
  if (count !== 1) throw new Error(`expected exactly one "git is not on PATH" in ocm update output, got ${count}:\n${output}`)
  expect(output).toContain("install git, then re-run")
  expect(output).not.toContain("the repository is private, unreachable, or the URL is wrong")
  expect(output).not.toContain("updating ")
  // invariant: idempotence — the stopped run wrote nothing, lastSync included
  expect(readFileSync(registryFile(home), "utf8")).toBe(registryBytes)
})

test("8. a missing git binary classifies as git-missing from bun's stderr wording and from the spawn error's code alone", async () => {
  const { classifyGitFailure } = await import("../loader/git-errors.js")
  const REMOTE = "https://example.com/x.git"
  const DIR = "/cache/ocm/roots/default-9f2c1/marketplaces/mp"
  const MESSAGE = "git is not on PATH — ocm needs git to clone and update marketplaces\n  install git, then re-run"
  // bun's real wording for a missing binary — String(spawnSync("git", …).error)
  const bun = classifyGitFailure({
    operation: "clone",
    result: { ok: false, stdout: "", stderr: 'Error: Executable not found in $PATH: "git"' },
    url: REMOTE, ref: null, dir: DIR,
  })
  if (bun.code !== "git-missing" || bun.message !== MESSAGE) {
    throw new Error(`bun's stderr wording: expected code "git-missing" and message\n${MESSAGE}\ngot code "${bun.code}" and message\n${bun.message}`)
  }
  // the spawn error's code property, with stderr empty so only the code can classify it
  const enoent = classifyGitFailure({
    operation: "clone",
    result: { ok: false, stdout: "", stderr: "", error: { code: "ENOENT" } },
    url: REMOTE, ref: null, dir: DIR,
  })
  if (enoent.code !== "git-missing" || enoent.message !== MESSAGE) {
    throw new Error(`spawn error code ENOENT with empty stderr: expected code "git-missing" and message\n${MESSAGE}\ngot code "${enoent.code}" and message\n${enoent.message}`)
  }
}, 120_000)

phase("9. git off PATH during the loader's startup sync lands the git-missing message in lastSync.error; the loader never throws", async (home) => {
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { demo: { "plugin.json": PLUGIN_JSON, commands: { "run.md": COMMAND } } } })
  // invariant: config safety — a user key predates every ocm write this test makes
  mkdirSync(cfg(home), { recursive: true })
  writeFileSync(join(cfg(home), "opencode.json"), `${JSON.stringify({ model: "user-model" }, null, 2)}\n`)
  expect(ocm(home, "add", `file://${remote}`, "--name", "mp").status).toBe(0)
  // process.execPath is absolute, so bun is still found; only git becomes unfindable
  const noGit = join(home, "no-git")
  mkdirSync(noGit)
  const synced = loaderSync(home, { OCM_SYNC_INTERVAL_MS: "0", PATH: noGit })
  expect(synced.status).toBe(0)
  const lastSync = readRegistry(home).marketplaces.mp.lastSync
  if (!lastSync || lastSync.ok !== false ||
    !lastSync.error?.includes("git is not on PATH") ||
    !lastSync.error?.includes("install git, then re-run") ||
    lastSync.error?.includes("the repository is private, unreachable, or the URL is wrong")) {
    throw new Error(`expected the git-missing message in lastSync.error of ${registryFile(home)}, got ${JSON.stringify(lastSync)}`)
  }
  expect(JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8")).model).toBe("user-model")
})
