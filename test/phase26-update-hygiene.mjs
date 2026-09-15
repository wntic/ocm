// Phase 26 — docs/specs/26-update-hygiene.md: one test per numbered item,
// plus the four invariants (ownership in 1 and 3, idempotence in 2, config
// safety in 3, no plugin-load errors in 1). The dirty-cache remedy must make
// its own warning true (F22): reset --hard AND git clean -fd, so an untracked
// file is actually gone, the warning names what was discarded, and the next
// update is silent. The no-op registry write stays (F41, rejected): lastSync.at
// is the throttle's clock. Item 5 is the README grep-test — prose-compatible
// fragments of the spec's claims, never quoted sentences.
import { spawnSync } from "node:child_process"
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, opencodeProbe, withFakeHome } from "./harness.mjs"

const OCM_BIN = fileURLToPath(new URL("../bin/ocm.ts", import.meta.url))
const README = fileURLToPath(new URL("../README.md", import.meta.url))

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
const registryFile = (home) => join(cfg(home), "ocm", "registry.json")
const readRegistry = (home) => JSON.parse(readFileSync(registryFile(home), "utf8"))
const cloneDir = (home, name = "mp") => join(home, ".cache", "ocm", "marketplaces", name)
const commandLink = (home, plugin, file) => join(cfg(home), "commands", `${plugin}:${file}`)
const json = (value) => `${JSON.stringify(value, null, 2)}\n`

const COMMAND = "---\ndescription: commit helper\n---\n\nCommit body.\n"
const PLUGIN_JSON = json({ description: "demo plugin" }) // spec 19

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
  const probe = opencodeProbe(cfg(home), home)
  if (!probe.available) console.log("skipped: opencode is not on PATH")
  else if (probe.unreliable) throw new Error("probe cannot trust itself: the canary broken plugin produced no error line")
  else expect(probe.pluginErrors).toEqual([])
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
