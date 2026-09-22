// Write safety (brief 27). §1: one writer at a time — every mutating command
// holds <cfg>/ocm/registry.lock for the whole command and releases it in a
// finally, a live holder is waited on then refused, a stale lock is broken
// with one warning, read-only commands never touch the lock, and the loader's
// sync never waits. §2: every ocm-owned JSON is written atomically — the
// displacement records are replaced by rename, never truncated in place —
// and a records file that cannot be parsed is reported by doctor, never
// silently treated as empty and never auto-repaired. §4: a registry stamped
// by a newer ocm refuses every mutation before any write (F118) while doctor
// warns, read-only commands and the loader's sync never refuse, and a
// pre-0.6.0 home without a stamp is accepted and stamped by the next write.
// §5: a registry that exists but does not parse, or is not a version 1|2
// object, is refused by every command that loads it and reported by doctor
// with a restore-or-remove remedy — never read as an empty installation —
// while an absent registry stays a fresh install and the loader's sync stays
// tolerant.

import { spawn, spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, rootCacheDir, withFakeHome, withFakeOpencode } from "./harness.mjs"

const OCM_BIN = fileURLToPath(new URL("../bin/ocm.ts", import.meta.url))

function ocm(home, ...args) {
  const result = spawnSync(process.execPath, [OCM_BIN, ...args], {
    env: withFakeOpencode({ ...process.env, HOME: home }), encoding: "utf8", timeout: 120_000,
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

const cfg = (home) => join(home, ".config", "opencode")

const json = (value) => `${JSON.stringify(value, null, 2)}\n`

const PLUGIN_JSON = json({ description: "demo plugin" })

const COMMAND = "---\ndescription: greet helper\n---\n\nGreet body.\n"

const GREET = "---\ndescription: my own greet\n---\n\nMy hand-written greet.\n"

const LINT = "---\ndescription: my own lint\n---\n\nMy hand-written lint.\n"

const USER_CONFIG = json({ model: "claude-sonnet-4-6" })

const recordsFile = (home) => join(rootCacheDir(home), "displaced-records.json")

const displacedRoot = (home) => join(rootCacheDir(home), "displaced")

function walkPaths(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? [path, ...walkPaths(path)] : [path]
  })
}

const displacedCopies = (home, name) => walkPaths(displacedRoot(home)).filter((path) => path.endsWith(name))

// two plugins whose command destinations hold hand-written files; the first
// install --force displaces greet and records it, leaving lint's displacement
// for the test to trigger
function displaceFirst(home) {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: {
    "alpha-kit": { "plugin.json": PLUGIN_JSON, commands: { "greet.md": COMMAND } },
    "beta-kit": { "plugin.json": PLUGIN_JSON, commands: { "lint.md": COMMAND } },
  } })
  const added = ocm(home, "add", mp, "--explicit")
  if (added.status !== 0) throw new Error(`ocm add exited ${added.status}: ${added.output}`)
  writeTree(cfg(home), { "opencode.json": USER_CONFIG, commands: { "alpha-kit:greet.md": GREET, "beta-kit:lint.md": LINT } })
  const forced = ocm(home, "install", "alpha-kit", "--force")
  if (forced.status !== 0) throw new Error(`ocm install alpha-kit --force exited ${forced.status}: ${forced.output}`)
  if (!existsSync(recordsFile(home))) throw new Error(`expected a records file at ${recordsFile(home)} after the displacement`)
  return {
    greet: join(cfg(home), "commands", "alpha-kit:greet.md"),
    lint: join(cfg(home), "commands", "beta-kit:lint.md"),
  }
}

phase("writeJsonAtomic creates the parent dirs, writes the exact content, leaves no temp, and replaces on a second write", async (home) => {
  const { writeJsonAtomic } = await import("../loader/atomic.js")
  const path = join(home, "x", "y", "f.json")
  writeJsonAtomic(path, '[{"k":1}]\n')
  expect(readFileSync(path, "utf8")).toBe('[{"k":1}]\n')
  expect(readdirSync(join(home, "x", "y")).filter((name) => name.includes(".tmp"))).toEqual([])
  writeJsonAtomic(path, '[{"k":2}]\n')
  expect(readFileSync(path, "utf8")).toBe('[{"k":2}]\n')
  expect(readdirSync(join(home, "x", "y")).filter((name) => name.includes(".tmp"))).toEqual([])
})

phase("a second displacement appends by rename: both records survive, the inode changes, no temp file remains", async (home) => {
  const { greet, lint } = displaceFirst(home)
  const ino = lstatSync(recordsFile(home)).ino
  const second = ocm(home, "install", "beta-kit", "--force")
  if (second.status !== 0) throw new Error(`ocm install beta-kit --force exited ${second.status}: ${second.output}`)
  const records = JSON.parse(readFileSync(recordsFile(home), "utf8"))
  if (!Array.isArray(records)) throw new Error(`expected a JSON array in ${recordsFile(home)}, got ${JSON.stringify(records).slice(0, 60)}`)
  const dests = records.map((record) => record.dest)
  // the F79 data-loss assertion: the pre-existing record is never lost
  for (const dest of [greet, lint]) {
    if (!dests.includes(dest)) throw new Error(`expected a displacement record for ${dest} in ${recordsFile(home)}, got ${JSON.stringify(dests)}`)
  }
  expect(dests).toHaveLength(2)
  // the write is a rename, not an in-place truncate
  const inoAfter = lstatSync(recordsFile(home)).ino
  if (inoAfter === ino) {
    throw new Error(`expected ${recordsFile(home)} to be replaced by rename (a new inode), got the same inode ${ino} — the file was truncated in place`)
  }
  // the other converted writers must not leave temps either
  const temps = [...walkPaths(join(home, ".cache", "ocm")), ...walkPaths(join(cfg(home), "ocm"))].filter((path) => path.includes(".tmp"))
  expect(temps).toEqual([])
  // invariants: ownership — both displaced originals survive in the cache;
  // config safety — no opencode.json byte changes
  expect(displacedCopies(home, "alpha-kit:greet.md").map((p) => readFileSync(p, "utf8"))).toEqual([GREET])
  expect(displacedCopies(home, "beta-kit:lint.md").map((p) => readFileSync(p, "utf8"))).toEqual([LINT])
  expect(readFileSync(join(cfg(home), "opencode.json"), "utf8")).toBe(USER_CONFIG)
})

phase("a killed install --force leaves the records file a whole generation — never short, never empty", async (home) => {
  const { greet } = displaceFirst(home)
  for (const delay of [150, 400, 800]) {
    const child = spawn(process.execPath, [OCM_BIN, "install", "beta-kit", "--force"], {
      env: withFakeOpencode({ ...process.env, HOME: home }), stdio: "ignore",
    })
    const closed = new Promise((resolve) => child.once("close", resolve))
    await new Promise((resolve) => setTimeout(resolve, delay))
    child.kill("SIGKILL")
    await closed
    if (!existsSync(recordsFile(home))) continue
    const raw = readFileSync(recordsFile(home), "utf8")
    if (raw.length === 0) throw new Error(`${recordsFile(home)} is empty after a kill at ${delay}ms — a truncated write`)
    let records
    try {
      records = JSON.parse(raw)
    } catch {
      throw new Error(`${recordsFile(home)} is not whole JSON after a kill at ${delay}ms: ${JSON.stringify(raw.slice(0, 40))}`)
    }
    if (!Array.isArray(records)) throw new Error(`expected a JSON array in ${recordsFile(home)} after a kill at ${delay}ms`)
    if (!records.some((record) => record.dest === greet)) {
      throw new Error(`the pre-existing record for ${greet} was lost from ${recordsFile(home)} after a kill at ${delay}ms`)
    }
  }
}, 240_000)

phase("doctor reports a corrupt displaced-records.json as an error; --fix leaves the file and the cache copies alone", async (home) => {
  displaceFirst(home)
  const copies = displacedCopies(home, "alpha-kit:greet.md")
  if (copies.length !== 1) throw new Error(`expected one displaced copy under ${displacedRoot(home)}, found ${copies.length}`)
  const corrupt = "{\n"
  writeFileSync(recordsFile(home), corrupt)
  const diagnosed = ocm(home, "doctor")
  if (diagnosed.status !== 1) throw new Error(`expected doctor to exit 1 on a corrupt ${recordsFile(home)}, got ${diagnosed.status}:\n${diagnosed.output}`)
  for (const needle of [recordsFile(home), "not valid JSON — displaced originals cannot be restored", "move them back by hand, then delete the records file"]) {
    expect(diagnosed.output).toContain(needle)
  }
  ocm(home, "doctor", "--fix")
  // never auto-repaired: an unreadable index is the one state where ocm
  // cannot prove which cache copy belongs where
  expect(readFileSync(recordsFile(home), "utf8")).toBe(corrupt)
  expect(displacedCopies(home, "alpha-kit:greet.md")).toEqual(copies)
  expect(readFileSync(copies[0], "utf8")).toBe(GREET)
  expect(readFileSync(join(cfg(home), "opencode.json"), "utf8")).toBe(USER_CONFIG)
}, 300_000)

// ---------------------------------------------------------------------------
// §1 — one writer at a time: the registry lock

const lockFile = (home) => join(cfg(home), "ocm", "registry.lock")

function writeLock(home, { pid, at, command }) {
  mkdirSync(join(cfg(home), "ocm"), { recursive: true })
  writeFileSync(lockFile(home), json({ pid, at, command }))
}

// a local git fixture, no network (the test/update.test.mjs pattern)
function gitRepo(dir, tree) {
  writeTree(dir, tree)
  for (const args of [["init", "-b", "main"], ["add", "-A"], ["-c", "user.email=ocm@test", "-c", "user.name=ocm", "commit", "-m", "fixture"]]) {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" })
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${result.stderr}`)
  }
}

// one command-only plugin in a local marketplace: the shared §1 fixture
function seedMarketplace(home) {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { "a-kit": { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
  const added = ocm(home, "add", mp)
  if (added.status !== 0) throw new Error(`ocm add ${mp} exited ${added.status}: ${added.output}`)
}

test("concurrent ocm add and ocm update leave both marketplaces in the registry and doctor exiting 0 (F64)", async () => {
  for (let iteration = 0; iteration < 3; iteration++) {
    await withFakeHome(async (home) => {
      gitRepo(join(home, "repo-a"), { plugins: { "a-kit": { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
      gitRepo(join(home, "repo-b"), { plugins: { "b-kit": { "plugin.json": PLUGIN_JSON, commands: { "deploy.md": COMMAND } } } })
      writeTree(cfg(home), { "opencode.json": USER_CONFIG })
      const added = ocm(home, "add", `file://${join(home, "repo-a")}`, "--name", "mp-a")
      if (added.status !== 0) throw new Error(`ocm add mp-a exited ${added.status} (iteration ${iteration}): ${added.output}`)
      // both children start together, so B's clone overlaps update's pull of A
      const run = (args) => new Promise((resolve) => {
        const child = spawn(process.execPath, [OCM_BIN, ...args], {
          env: withFakeOpencode({ ...process.env, HOME: home }), encoding: "utf8",
        })
        let stdout = ""
        let stderr = ""
        child.stdout.on("data", (chunk) => (stdout += chunk))
        child.stderr.on("data", (chunk) => (stderr += chunk))
        child.once("close", (status) => resolve({ status, stdout, stderr }))
      })
      const [addedB, updated] = await Promise.all([
        run(["add", `file://${join(home, "repo-b")}`, "--name", "mp-b"]),
        run(["update"]),
      ])
      if (addedB.status !== 0) throw new Error(`concurrent ocm add mp-b exited ${addedB.status} (iteration ${iteration}): ${addedB.stdout}\n${addedB.stderr}`)
      if (updated.status !== 0) throw new Error(`concurrent ocm update exited ${updated.status} (iteration ${iteration}): ${updated.stdout}\n${updated.stderr}`)
      const registryPath = join(cfg(home), "ocm", "registry.json")
      const registry = JSON.parse(readFileSync(registryPath, "utf8"))
      for (const name of ["mp-a", "mp-b"]) {
        if (!registry.marketplaces[name]) {
          throw new Error(`marketplace "${name}" is missing from ${registryPath} after the concurrent add+update (iteration ${iteration}) — the F64 lost update`)
        }
      }
      for (const link of [join(cfg(home), "commands", "a-kit:commit.md"), join(cfg(home), "commands", "b-kit:deploy.md")]) {
        if (!existsSync(link) || !lstatSync(link).isSymbolicLink()) throw new Error(`expected a command symlink at ${link} (iteration ${iteration})`)
      }
      const doctor = ocm(home, "doctor")
      if (doctor.status !== 0) throw new Error(`ocm doctor exited ${doctor.status} after the concurrent add+update (iteration ${iteration}):\n${doctor.output}`)
      // item 13: command-only plugins leave the user's config byte-identical, and nothing lands in other tools' directories
      expect(readFileSync(join(cfg(home), "opencode.json"), "utf8")).toBe(USER_CONFIG)
      expect(existsSync(join(home, ".claude"))).toBe(false)
      expect(existsSync(join(home, ".agents"))).toBe(false)
    })
  }
}, 360_000)

phase("a held lock makes a mutating command print one waiting line, then refuse with the pid and the next action", async (home) => {
  seedMarketplace(home)
  writeLock(home, { pid: process.pid, at: new Date().toISOString(), command: "ocm add" })
  const stub = readFileSync(lockFile(home), "utf8")
  const result = ocm(home, "update")
  if (result.status !== 1) throw new Error(`ocm update under a held lock exited ${result.status}, expected 1:\n${result.output}`)
  const waiting = result.stderr.split("\n").filter((line) => line.includes("waiting for another ocm to finish"))
  expect(waiting).toHaveLength(1)
  expect(waiting[0]).toBe(`waiting for another ocm to finish (pid ${process.pid}, ocm add)...`)
  expect(result.stderr).toContain(`another ocm is writing this installation (pid ${process.pid}, ocm add`)
  expect(result.stderr).toContain("run ocm doctor")
  // the refuser never removes a live holder's lock
  expect(readFileSync(lockFile(home), "utf8")).toBe(stub)
})

phase("a stale lock — dead pid, or an unparseable file — is broken with one warning and the mutation succeeds", async (home) => {
  seedMarketplace(home)
  const dead = spawnSync("git", ["--version"]).pid
  writeLock(home, { pid: dead, at: new Date().toISOString(), command: "ocm update" })
  const broken = ocm(home, "update")
  if (broken.status !== 0) throw new Error(`ocm update with a stale lock (pid ${dead}) exited ${broken.status}:\n${broken.output}`)
  expect(broken.stderr.split("\n").filter((line) => line.includes("removed a stale ocm lock"))).toHaveLength(1)
  expect(broken.stderr).toContain(`removed a stale ocm lock (pid ${dead}`)
  expect(broken.stderr).toContain("a previous ocm was killed")
  expect(existsSync(lockFile(home))).toBe(false)
  writeFileSync(lockFile(home), "not json")
  const unreadable = ocm(home, "update")
  if (unreadable.status !== 0) throw new Error(`ocm update with an unparseable ${lockFile(home)} exited ${unreadable.status}:\n${unreadable.output}`)
  expect(unreadable.stderr.split("\n").filter((line) => line.includes("removed a stale ocm lock"))).toHaveLength(1)
  expect(unreadable.stderr).toContain("removed a stale ocm lock (unreadable)")
  expect(unreadable.stderr).toContain("a previous ocm was killed")
  expect(existsSync(lockFile(home))).toBe(false)
})

phase("a holder whose lock was broken mid-hold releases nothing: the breaker's lock survives (review finding)", async (home) => {
  // a hold longer than STALE_MS can be broken by another ocm while this one is
  // still running. The file then belongs to the breaker, and removing it on the
  // way out would admit a second writer behind them — so release() unlinks only
  // a lock that still names this process.
  const lockModule = fileURLToPath(new URL("../loader/lock.js", import.meta.url))
  const script = [
    `import { withRegistryLock } from ${JSON.stringify(lockModule)}`,
    'import { writeFileSync } from "node:fs"',
    "await withRegistryLock('ocm test', async () => {",
    "  writeFileSync(process.env.LOCK_PATH, JSON.stringify({ pid: 999999, at: new Date().toISOString(), command: 'ocm add' }) + '\\n')",
    "})",
  ].join("\n")
  const run = spawnSync(process.execPath, ["-e", script], {
    env: { ...process.env, HOME: home, LOCK_PATH: lockFile(home) },
    encoding: "utf8",
    timeout: 60_000,
  })
  if (run.status !== 0) throw new Error(`the holder exited ${run.status}: ${run.stderr}`)
  expect(existsSync(lockFile(home))).toBe(true)
  expect(JSON.parse(readFileSync(lockFile(home), "utf8")).pid).toBe(999999)
  expect(run.stderr).toContain("lock was broken by another process")
}, 60_000)

phase("a live pid in a lock older than ten minutes is stale: one warning naming the age, mutation succeeds", async (home) => {
  seedMarketplace(home)
  writeLock(home, { pid: process.pid, at: new Date(Date.now() - 20 * 60_000).toISOString(), command: "ocm update" })
  const result = ocm(home, "update")
  if (result.status !== 0) throw new Error(`ocm update with a 20-minute-old lock exited ${result.status}:\n${result.output}`)
  expect(result.stderr.split("\n").filter((line) => line.includes("removed a stale ocm lock"))).toHaveLength(1)
  expect(result.stderr).toContain(`removed a stale ocm lock (pid ${process.pid}, 20m old)`)
  expect(result.stderr).toContain("a previous ocm was killed")
  expect(existsSync(lockFile(home))).toBe(false)
})

phase("no lock file remains after a refused mutation or a thrown command", async (home) => {
  seedMarketplace(home)
  const refused = ocm(home, "remove", "nonexistent")
  if (refused.status !== 1) throw new Error(`ocm remove nonexistent exited ${refused.status}, expected 1:\n${refused.output}`)
  expect(existsSync(lockFile(home))).toBe(false)
  const empty = join(home, "empty")
  mkdirSync(empty)
  const thrown = ocm(home, "add", empty)
  if (thrown.status !== 1) throw new Error(`ocm add of an empty directory exited ${thrown.status}, expected 1:\n${thrown.output}`)
  expect(thrown.output).toContain("no plugins found")
  expect(existsSync(lockFile(home))).toBe(false)
})

const CORE_MODULE = fileURLToPath(new URL("../loader/core.js", import.meta.url))
const SYNC_RESULT_RUNNER = 'const mod = await import(process.argv[2]); console.log(JSON.stringify(await mod.syncAll({ reason: "startup" })))\n'

phase("a held lock skips the loader's startup sync silently; once free it runs and records lastSync", async (home) => {
  seedMarketplace(home)
  const registryPath = join(cfg(home), "ocm", "registry.json")
  const before = readFileSync(registryPath, "utf8")
  const runSync = () => {
    const runner = join(home, "sync-result-runner.mjs")
    writeFileSync(runner, SYNC_RESULT_RUNNER)
    const result = spawnSync(process.execPath, [runner, CORE_MODULE], {
      env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 120_000,
    })
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
  }
  writeLock(home, { pid: process.pid, at: new Date().toISOString(), command: "ocm add" })
  const blocked = runSync()
  if (blocked.status !== 0) throw new Error(`the sync runner exited ${blocked.status} under a held lock:\n${blocked.stderr}`)
  expect(blocked.stderr).toBe("")
  expect(JSON.parse(blocked.stdout).skipped).toBe(true)
  expect(readFileSync(registryPath, "utf8")).toBe(before)
  rmSync(lockFile(home))
  const ran = runSync()
  if (ran.status !== 0) throw new Error(`the sync runner exited ${ran.status} after the lock was removed:\n${ran.stderr}`)
  expect(JSON.parse(ran.stdout).skipped).toBeUndefined()
  expect(JSON.parse(readFileSync(registryPath, "utf8")).marketplaces.mp.lastSync).toBeTruthy()
})

phase("a read-only command under a held lock exits 0, waits for nothing, and leaves the lock untouched", async (home) => {
  seedMarketplace(home)
  writeLock(home, { pid: process.pid, at: new Date().toISOString(), command: "ocm add" })
  const stub = readFileSync(lockFile(home), "utf8")
  const listed = ocm(home, "list")
  if (listed.status !== 0) throw new Error(`ocm list under a held lock exited ${listed.status}:\n${listed.output}`)
  expect(listed.stderr).not.toContain("waiting for another ocm")
  expect(readFileSync(lockFile(home), "utf8")).toBe(stub)
})

phase("a read-only command still migrates a v1 home to v2 and leaves no lock behind", async (home) => {
  writeTree(join(cfg(home), "plugins"), { "ocm-registry.json": json({ version: 1, marketplaces: {} }) })
  const listed = ocm(home, "list")
  if (listed.status !== 0) throw new Error(`ocm list on a v1 home exited ${listed.status}:\n${listed.output}`)
  const registryPath = join(cfg(home), "ocm", "registry.json")
  expect(JSON.parse(readFileSync(registryPath, "utf8")).version).toBe(2)
  expect(existsSync(lockFile(home))).toBe(false)
})

phase("a held lock blocks a read-only command's migration like a mutation: refusal, and the v1 registry untouched", async (home) => {
  const legacy = join(cfg(home), "plugins", "ocm-registry.json")
  writeTree(join(cfg(home), "plugins"), { "ocm-registry.json": json({ version: 1, marketplaces: {} }) })
  const legacyBytes = readFileSync(legacy, "utf8")
  writeLock(home, { pid: process.pid, at: new Date().toISOString(), command: "ocm add" })
  const listed = ocm(home, "list")
  if (listed.status !== 1) throw new Error(`ocm list under a held lock on a v1 home exited ${listed.status}, expected 1:\n${listed.output}`)
  expect(listed.stderr.split("\n").filter((line) => line.includes("waiting for another ocm to finish"))).toHaveLength(1)
  expect(listed.stderr).toContain(`another ocm is writing this installation (pid ${process.pid}`)
  expect(readFileSync(legacy, "utf8")).toBe(legacyBytes)
  expect(existsSync(join(cfg(home), "ocm", "registry.json"))).toBe(false)
})

phase("doctor --fix on a never-initialized home refuses with one line and creates nothing — no ocm dir, no lock", async (home) => {
  const result = ocm(home, "doctor", "--fix")
  if (result.status !== 1) throw new Error(`ocm doctor --fix exited ${result.status} on a never-initialized home, expected 1:\n${result.output}`)
  expect(result.stderr).toBe("error: ocm is not installed here — run ocm init\n")
  expect(existsSync(join(cfg(home), "ocm"))).toBe(false)
  expect(existsSync(lockFile(home))).toBe(false)
})

// ---------------------------------------------------------------------------
// §3 — a restored displacement stops being a displacement (F87): a consumed
// record is pruned from the records file while its cache copy is kept

// content a user recreated at a taken path that differs from the original
const GREET_RECREATED = "---\ndescription: my own greet again\n---\n\nNot the original.\n"

function recordsFor(home, dest) {
  if (!existsSync(recordsFile(home))) return []
  let parsed
  try {
    parsed = JSON.parse(readFileSync(recordsFile(home), "utf8"))
  } catch {
    throw new Error(`${recordsFile(home)} is not valid JSON`)
  }
  if (!Array.isArray(parsed)) throw new Error(`expected a JSON array in ${recordsFile(home)}`)
  return parsed.filter((record) => record.dest === dest)
}

phase("a restored displacement is consumed: the second teardown of a re-added marketplace prints no displacement line and prunes the record", async (home) => {
  const { greet } = displaceFirst(home)
  const first = ocm(home, "remove", "mp")
  if (first.status !== 0) throw new Error(`ocm remove mp exited ${first.status}:\n${first.output}`)
  expect(first.output).toContain("restored your")
  expect(readFileSync(greet, "utf8")).toBe(GREET)
  const readded = ocm(home, "add", join(home, "mp"), "--explicit")
  if (readded.status !== 0) throw new Error(`ocm add ${join(home, "mp")} --explicit exited ${readded.status}:\n${readded.output}`)
  const second = ocm(home, "remove", "mp")
  if (second.status !== 0) throw new Error(`the second ocm remove mp exited ${second.status}:\n${second.output}`)
  for (const needle of ["displaced", "path is taken", "restored your", "nothing to restore"]) {
    if (second.output.includes(needle)) {
      throw new Error(`the second teardown of mp printed a displacement line containing "${needle}" — the restored record for ${greet} should have been consumed:\n${second.output}`)
    }
  }
  const kept = recordsFor(home, greet)
  if (kept.length > 0) throw new Error(`${recordsFile(home)} still holds ${kept.length} record(s) for ${greet} after the restore was consumed`)
  const copies = displacedCopies(home, "alpha-kit:greet.md")
  if (copies.length !== 1 || readFileSync(copies[0], "utf8") !== GREET) {
    throw new Error(`expected the kept cache copy of ${greet} under ${displacedRoot(home)} to still hold the original, found ${copies.length} cop(ies)`)
  }
  expect(readFileSync(join(cfg(home), "opencode.json"), "utf8")).toBe(USER_CONFIG)
})

phase("a destination taken by different content keeps the record and prints the path-is-taken line", async (home) => {
  const { greet } = displaceFirst(home)
  rmSync(greet)
  writeFileSync(greet, GREET_RECREATED)
  const result = ocm(home, "remove", "mp")
  if (result.status !== 0) throw new Error(`ocm remove mp exited ${result.status}:\n${result.output}`)
  for (const needle of ["path is taken", "alpha-kit:greet.md", "alpha-kit", displacedRoot(home)]) {
    expect(result.output).toContain(needle)
  }
  const kept = recordsFor(home, greet)
  if (kept.length !== 1) throw new Error(`expected ${recordsFile(home)} to keep exactly one record for ${greet} after the path was taken by different content, found ${kept.length}`)
  expect(readFileSync(greet, "utf8")).toBe(GREET_RECREATED)
  const copies = displacedCopies(home, "alpha-kit:greet.md")
  if (copies.length !== 1 || readFileSync(copies[0], "utf8") !== GREET) {
    throw new Error(`expected the cache copy under ${displacedRoot(home)} to still hold the original, found ${copies.length} cop(ies)`)
  }
  expect(readFileSync(join(cfg(home), "opencode.json"), "utf8")).toBe(USER_CONFIG)
})

phase("a destination already holding the original content consumes the record silently", async (home) => {
  const { greet } = displaceFirst(home)
  rmSync(greet)
  writeFileSync(greet, GREET)
  const result = ocm(home, "remove", "mp")
  if (result.status !== 0) throw new Error(`ocm remove mp exited ${result.status}:\n${result.output}`)
  for (const needle of ["displaced", "path is taken", "restored your", "displacement copy missing", "nothing to restore"]) {
    if (result.output.includes(needle)) {
      throw new Error(`ocm remove mp printed a displacement line containing "${needle}" although ${greet} already holds the original:\n${result.output}`)
    }
  }
  const kept = recordsFor(home, greet)
  if (kept.length > 0) throw new Error(`${recordsFile(home)} still holds ${kept.length} record(s) for ${greet} although the original is back at its path`)
  const copies = displacedCopies(home, "alpha-kit:greet.md")
  if (copies.length !== 1 || readFileSync(copies[0], "utf8") !== GREET) {
    throw new Error(`expected the kept cache copy under ${displacedRoot(home)}, found ${copies.length} cop(ies)`)
  }
  expect(readFileSync(greet, "utf8")).toBe(GREET)
  expect(readFileSync(join(cfg(home), "opencode.json"), "utf8")).toBe(USER_CONFIG)
})

phase("a missing displacement copy reports nothing-to-restore exactly once across uninstall and remove, then the record is consumed", async (home) => {
  const { greet } = displaceFirst(home)
  const copies = displacedCopies(home, "alpha-kit:greet.md")
  if (copies.length !== 1) throw new Error(`expected one displaced copy under ${displacedRoot(home)}, found ${copies.length}`)
  rmSync(copies[0])
  const uninstalled = ocm(home, "uninstall", "alpha-kit")
  if (uninstalled.status !== 0) throw new Error(`ocm uninstall alpha-kit exited ${uninstalled.status}:\n${uninstalled.output}`)
  const removed = ocm(home, "remove", "mp")
  if (removed.status !== 0) throw new Error(`ocm remove mp exited ${removed.status}:\n${removed.output}`)
  const combined = `${uninstalled.output}\n${removed.output}`
  const count = combined.split("nothing to restore").length - 1
  if (count !== 1) {
    throw new Error(`expected the nothing-to-restore line exactly once across ocm uninstall alpha-kit and ocm remove mp, saw it ${count} time(s):\n${combined}`)
  }
  const kept = recordsFor(home, greet)
  if (kept.length > 0) throw new Error(`${recordsFile(home)} still holds ${kept.length} record(s) for ${greet} after the missing copy was reported`)
  expect(readFileSync(join(cfg(home), "opencode.json"), "utf8")).toBe(USER_CONFIG)
})

// ---------------------------------------------------------------------------
// §4 — an older binary refuses a newer home (F118). The guard is forward-only:
// these tests stamp a *newer* version ("9.9.9") into the registry; they never
// imply the published-0.2.0 F118 transcript now passes.

const SELF_VERSION = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version

// rewrite the registry with ocmVersion set (or deleted, for a pre-0.6.0 home)
// and return the bytes now on disk
function stampRegistry(home, ocmVersion) {
  const path = join(cfg(home), "ocm", "registry.json")
  const registry = JSON.parse(readFileSync(path, "utf8"))
  if (ocmVersion === undefined) delete registry.ocmVersion
  else registry.ocmVersion = ocmVersion
  writeFileSync(path, json(registry))
  return readFileSync(path, "utf8")
}

phase("a newer-written home refuses mutating commands before any write: exit 1, both versions named, registry untouched, no lock", async (home) => {
  seedMarketplace(home)
  const bytes = stampRegistry(home, "9.9.9")
  const registryPath = join(cfg(home), "ocm", "registry.json")
  const refused = ocm(home, "update")
  if (refused.status !== 1) throw new Error(`ocm update under a newer-stamped ${registryPath} exited ${refused.status}, expected 1:\n${refused.output}`)
  expect(refused.stderr).toContain(`error: this installation was last written by ocm 9.9.9; you are running ${SELF_VERSION}`)
  expect(refused.stderr).toContain("upgrade with `npm i -g @wntic/ocm`, or run the newer ocm")
  expect(readFileSync(registryPath, "utf8")).toBe(bytes)
  expect(existsSync(lockFile(home))).toBe(false)
  const removed = ocm(home, "remove", "mp")
  if (removed.status !== 1) throw new Error(`ocm remove mp under a newer-stamped ${registryPath} exited ${removed.status}, expected 1:\n${removed.output}`)
  expect(removed.stderr).toContain(`error: this installation was last written by ocm 9.9.9; you are running ${SELF_VERSION}`)
  expect(readFileSync(registryPath, "utf8")).toBe(bytes)
  expect(existsSync(lockFile(home))).toBe(false)
})

phase("a newer-written home never refuses read-only commands, and doctor warns while still running every other check", async (home) => {
  seedMarketplace(home)
  stampRegistry(home, "9.9.9")
  const listed = ocm(home, "list")
  if (listed.status !== 0) throw new Error(`ocm list under a newer-stamped registry exited ${listed.status}, expected 0:\n${listed.output}`)
  const diagnosed = ocm(home, "doctor")
  if (diagnosed.status !== 0) throw new Error(`ocm doctor under a newer-stamped registry exited ${diagnosed.status}, expected 0 — the mismatch is a warning, not an error:\n${diagnosed.output}`)
  // every other check still ran: the header and the loader status lines
  expect(diagnosed.output).toContain("doctor")
  expect(diagnosed.output).toContain("(current)")
  // the warning names both versions and the upgrade command
  expect(diagnosed.output).toContain("9.9.9")
  expect(diagnosed.output).toContain(SELF_VERSION)
  expect(diagnosed.output).toContain("npm i -g @wntic/ocm")
}, 300_000)

phase("a pre-0.6.0 home with no ocmVersion is accepted silently and stamped by the next mutating write", async (home) => {
  seedMarketplace(home)
  stampRegistry(home, undefined)
  const registryPath = join(cfg(home), "ocm", "registry.json")
  const updated = ocm(home, "update")
  if (updated.status !== 0) throw new Error(`ocm update on a pre-0.6.0 ${registryPath} exited ${updated.status}:\n${updated.output}`)
  expect(updated.output).not.toContain("last written by ocm")
  expect(updated.output).not.toContain("upgrade with")
  const after = JSON.parse(readFileSync(registryPath, "utf8"))
  if (after.ocmVersion !== SELF_VERSION) {
    throw new Error(`expected ${registryPath} to be stamped ocmVersion "${SELF_VERSION}" by the mutating write, got ${JSON.stringify(after.ocmVersion)}`)
  }
  expect(after.version).toBe(2)
})

phase("the loader's startup sync silently skips a newer-written home and leaves the registry byte-identical", async (home) => {
  seedMarketplace(home)
  const bytes = stampRegistry(home, "9.9.9")
  const registryPath = join(cfg(home), "ocm", "registry.json")
  const runner = join(home, "sync-result-runner.mjs")
  writeFileSync(runner, SYNC_RESULT_RUNNER)
  const result = spawnSync(process.execPath, [runner, CORE_MODULE], {
    env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 120_000,
  })
  if (result.status !== 0) throw new Error(`the sync runner exited ${result.status} under a newer-stamped ${registryPath}:\n${result.stderr}`)
  expect(result.stderr).toBe("")
  expect(JSON.parse(result.stdout).skipped).toBe(true)
  expect(readFileSync(registryPath, "utf8")).toBe(bytes)
})

// ---------------------------------------------------------------------------
// §5 — a corrupt registry is an error, never an empty one (F86)

const registryFile = (home) => join(cfg(home), "ocm", "registry.json")

const corruptError = (path) =>
  `error: registry at ${path} is not valid JSON — ocm will not overwrite it\n` +
  "  inspect or move the file, then run ocm doctor; to start over, remove it and re-add your marketplaces"

phase("a corrupt registry refuses every mutating command: exit 1, the named error, the file byte-identical, no lock left", async (home) => {
  seedMarketplace(home)
  const corrupt = "{\n"
  writeFileSync(registryFile(home), corrupt)
  const mutations = [
    ["update"],
    ["remove", "mp"],
    ["pin", "mp", "main"],
    ["install", "a-kit"],
    ["uninstall", "a-kit"],
    ["mode", "mp", "auto"],
    ["trust", "mp", "--yes"],
    ["untrust", "mp"],
    ["add", join(home, "mp")],
  ]
  for (const args of mutations) {
    const result = ocm(home, ...args)
    if (result.status !== 1) {
      throw new Error(`ocm ${args.join(" ")} on a corrupt ${registryFile(home)} exited ${result.status}, expected 1 — a corrupt registry must be refused, not read as empty:\n${result.output}`)
    }
    expect(result.stderr).toContain(corruptError(registryFile(home)))
    // the F86 data-loss assertion: no command may save over a failed parse
    expect(readFileSync(registryFile(home), "utf8")).toBe(corrupt)
    // the refusal happens inside the §1 lock; the finally releases it
    expect(existsSync(lockFile(home))).toBe(false)
  }
})

phase("a registry that parses but is not a version 1|2 object refuses a mutation the same way", async (home) => {
  seedMarketplace(home)
  const wrongShape = json({ version: 7, marketplaces: {} })
  writeFileSync(registryFile(home), wrongShape)
  const result = ocm(home, "update")
  if (result.status !== 1) {
    throw new Error(`ocm update on a wrong-shape ${registryFile(home)} exited ${result.status}, expected 1:\n${result.output}`)
  }
  expect(result.stderr).toContain(corruptError(registryFile(home)))
  expect(readFileSync(registryFile(home), "utf8")).toBe(wrongShape)
  expect(existsSync(lockFile(home))).toBe(false)
})

phase("read-only commands report a corrupt registry instead of no marketplaces", async (home) => {
  seedMarketplace(home)
  const corrupt = "{\n"
  writeFileSync(registryFile(home), corrupt)
  for (const args of [["list"], ["info", "a-kit"], ["search", "commit"]]) {
    const result = ocm(home, ...args)
    if (result.status !== 1) {
      throw new Error(`ocm ${args.join(" ")} on a corrupt ${registryFile(home)} exited ${result.status}, expected 1 — the corruption must be reported, not presented as an empty installation:\n${result.output}`)
    }
    expect(result.stderr).toContain(corruptError(registryFile(home)))
  }
  expect(readFileSync(registryFile(home), "utf8")).toBe(corrupt)
})

phase("doctor reports a corrupt registry with the restore-or-remove remedy, runs its checks, and never names ocm update", async (home) => {
  seedMarketplace(home)
  const corrupt = "{\n"
  writeFileSync(registryFile(home), corrupt)
  const result = ocm(home, "doctor")
  if (result.status !== 1) {
    throw new Error(`ocm doctor on a corrupt ${registryFile(home)} exited ${result.status}, expected 1:\n${result.output}`)
  }
  // the checks ran: the header is printed even on a corrupt registry, so the
  // pre-dispatch migration detection did not throw on it either
  expect(result.output).toContain("doctor")
  expect(result.output).toContain(
    `${registryFile(home)}: not valid JSON — restore it from a backup, or remove it and re-add your marketplaces`,
  )
  const finding = result.output.split("\n").find((line) => line.includes(registryFile(home)) && line.includes("not valid JSON"))
  if (finding === undefined) throw new Error(`no "not valid JSON" finding naming ${registryFile(home)} in the doctor output:\n${result.output}`)
  expect(finding.includes("(ocm update)")).toBe(false)
  expect(readFileSync(registryFile(home), "utf8")).toBe(corrupt)
}, 300_000)

phase("an absent registry is a fresh install: ocm add succeeds and creates it", async (home) => {
  writeTree(join(home, "mp"), { plugins: { "a-kit": { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
  const result = ocm(home, "add", join(home, "mp"))
  if (result.status !== 0) {
    throw new Error(`ocm add on a virgin home with no ${registryFile(home)} exited ${result.status} — a missing registry is a fresh install, not an error:\n${result.output}`)
  }
  expect(existsSync(registryFile(home))).toBe(true)
})

phase("the loader's startup sync tolerates a corrupt registry: exit 0, silent, byte-identical", async (home) => {
  seedMarketplace(home)
  const corrupt = "{\n"
  writeFileSync(registryFile(home), corrupt)
  const runner = join(home, "sync-result-runner.mjs")
  writeFileSync(runner, SYNC_RESULT_RUNNER)
  const result = spawnSync(process.execPath, [runner, CORE_MODULE], {
    env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 120_000,
  })
  if (result.status !== 0) {
    throw new Error(`the sync runner exited ${result.status} on a corrupt ${registryFile(home)} — the loader must never break opencode's startup:\n${result.stderr}`)
  }
  expect(result.stderr).toBe("")
  expect(readFileSync(registryFile(home), "utf8")).toBe(corrupt)
})

// ---------------------------------------------------------------------------
// brief 31 §8: the ownership invariants across an update that blocks an
// executable change and an untrust — the same invariants update.test.mjs
// phase 12 asserts for the refused rename, here for the blocked-trust path.
// The record stays outcome-derived (a nameless skill is never recorded), the
// user's config keys and hand-written files are untouched, nothing lands
// under .claude or .agents, and the denied-but-recorded plugin component is
// not a stale record.

const SKILL = "---\nname: style\ndescription: style guidance\n---\n\n# Style\n\nBody.\n"

const NAMELESS_SKILL = "---\ndescription: no name in this frontmatter\n---\n\nBody.\n"

const JS_PLUGIN = 'export default { id: "adw-notify", server: async () => ({}) }\n'

const USER_PLUGIN = 'export default { id: "mine", server: async () => ({}) }\n'

const MCP_V1 = json({ db: { type: "local", command: ["npx", "-y", "@acme/db-mcp"], enabled: true } })

const MCP_V2 = json({ db: { type: "local", command: ["npx", "-y", "@acme/db-mcp@2"], enabled: true } })

phase("an update past a blocked mcp change and an untrust keep the user's config and files intact, the nameless skill unrecorded, and doctor clean", async (home) => {
  // the user's own config and hand-written files predate everything ocm does
  const userConfig = { model: "claude-sonnet-4-6", permission: { edit: "allow" }, mcp: { "user-server": { type: "local", command: ["echo"] } } }
  writeTree(cfg(home), {
    "opencode.json": json(userConfig),
    commands: { "mine.md": GREET },
    plugins: { "my-own.js": USER_PLUGIN },
  })
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { adw: {
    "plugin.json": PLUGIN_JSON,
    commands: { "commit.md": COMMAND },
    skills: { style: { "SKILL.md": SKILL } },
    plugin: { "notify.js": JS_PLUGIN },
    "mcp.json": MCP_V1,
  } } })
  const run = (args, timeout = 300_000) => {
    const r = spawnSync(process.execPath, [OCM_BIN, ...args], {
      env: withFakeOpencode({ ...process.env, HOME: home }), encoding: "utf8", timeout,
    })
    return { status: r.status, output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` }
  }
  const added = run(["add", `file://${remote}`, "--name", "mp", "--trust"])
  if (added.status !== 0) throw new Error(`ocm add exited ${added.status}:\n${added.output}`)
  expect(existsSync(join(cfg(home), "plugins", "ocm--adw--notify.js"))).toBe(true) // trusted, so materialized
  // upstream ships a nameless skill and changes the mcp command — a trust-surface change
  writeTree(join(remote, "plugins", "adw", "skills", "broken"), { "SKILL.md": NAMELESS_SKILL })
  writeFileSync(join(remote, "plugins", "adw", "mcp.json"), MCP_V2)
  for (const args of [["add", "-A"], ["-c", "user.email=ocm@test", "-c", "user.name=ocm", "commit", "-m", "nameless skill + mcp change"]]) {
    const r = spawnSync("git", args, { cwd: remote, encoding: "utf8" })
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${remote}: ${r.stderr}`)
  }
  const updated = run(["update", "mp"])
  if (updated.status !== 0) throw new Error(`ocm update exited ${updated.status} — a blocked executable change must not fail the update:\n${updated.output}`)
  const skillsLinks = join(rootCacheDir(home), "links", "mp", "skills")
  assertAbsent(join(skillsLinks, "adw--broken")) // a nameless skill never materializes
  expect(lstatSync(join(skillsLinks, "adw--style")).isDirectory()).toBe(true)
  const record = JSON.parse(readFileSync(registryFile(home), "utf8")).marketplaces.mp.plugins.adw
  expect(record.components.skill).toEqual(["style"]) // and never enters the record
  expect(JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8")).mcp["ocm--adw--db"]).toBeUndefined() // the blocked change removes the old key
  const untrusted = run(["untrust", "mp"])
  if (untrusted.status !== 0) throw new Error(`ocm untrust exited ${untrusted.status}:\n${untrusted.output}`)
  assertAbsent(join(cfg(home), "plugins", "ocm--adw--notify.js")) // the executable materialization is gone
  const finalRecord = JSON.parse(readFileSync(registryFile(home), "utf8")).marketplaces.mp.plugins.adw
  if (!(finalRecord.components.plugin ?? []).includes("notify.js")) {
    throw new Error(`expected the record to still name the denied plugin after untrust, got ${JSON.stringify(finalRecord.components)} in ${registryFile(home)}`)
  }
  // config safety: the user's keys are intact and no ocm-owned mcp key remains
  const after = JSON.parse(readFileSync(join(cfg(home), "opencode.json"), "utf8"))
  expect(after.model).toBe(userConfig.model)
  expect(JSON.stringify(after.permission)).toBe(JSON.stringify(userConfig.permission))
  expect(JSON.stringify(after.mcp["user-server"])).toBe(JSON.stringify(userConfig.mcp["user-server"]))
  expect(Object.keys(after.mcp).filter((key) => key.startsWith("ocm--"))).toEqual([])
  // ownership: the user's hand-written files are byte-identical
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe(GREET)
  expect(readFileSync(join(cfg(home), "plugins", "my-own.js"), "utf8")).toBe(USER_PLUGIN)
  const foreign = walkPaths(home).filter((path) => path.includes("/.claude") || path.includes("/.agents"))
  if (foreign.length) throw new Error(`ocm wrote outside its ownership:\n${foreign.join("\n")}`)
  // the denied-but-recorded plugin component is blocked, not stale
  const diagnosed = run(["doctor"])
  if (diagnosed.status !== 0) throw new Error(`ocm doctor exited ${diagnosed.status} after update + untrust:\n${diagnosed.output}`)
}, 600_000)
