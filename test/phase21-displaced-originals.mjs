// Phase 21 — docs/specs/21-displaced-originals.md: one test per numbered
// item, with the four invariants riding the items that exercise them —
// idempotence in 1 (a second --force displaces nothing new), config safety,
// ownership and no plugin-load errors in 6. Item 5 is the spec's "unchanged
// from today" as a byte-compare against the exact strings today's teardown
// prints. The spec's body also gives doctor an informational
// displaced-originals line, but its Tests section lists no doctor test, so
// none is written here. Report lines are asserted in the spec's own wording
// ("displaced your …", "restored your … (was displaced by …)", "the path is
// taken"); cache paths are asserted absolute, this repo's convention for
// paths in output.
import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { opencodeProbe, withFakeHome } from "./harness.mjs"

const OCM_BIN = fileURLToPath(new URL("../bin/ocm.ts", import.meta.url))

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

const cfg = (home) => join(home, ".config", "opencode")
const configFile = (home) => join(cfg(home), "opencode.json")
const displacedRoot = (home) => join(home, ".cache", "ocm", "displaced")
const json = (value) => `${JSON.stringify(value, null, 2)}\n`

// the displaced cache nests copies under <ts>/<absolute-original-path>, so a
// flat readdir cannot find them
function findUnder(dir, name) {
  const found = []
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.name === name) found.push(path)
    }
  }
  return found
}

function lineWith(output, word) {
  const line = output.split("\n").find((l) => l.includes(word))
  if (!line) throw new Error(`expected a "${word}" line in:\n${output}`)
  return line
}

const COMMAND = "---\ndescription: greet helper\n---\n\nGreet body.\n"
const GREET = "---\ndescription: my own greet\n---\n\nMy hand-written greet.\n"
const GREET_RECREATED = "---\ndescription: my newer greet\n---\n\nRe-created by hand after the takeover.\n"
const USER_PLUGIN = 'export default { id: "mine", server: async () => ({}) }\n'
const PLUGIN_JSON = json({ description: "demo plugin" }) // spec 19: installable plugins carry a manifest

// the F9 scenario: a hand-written command sits at the exact destination
// alpha-kit will claim, and `install --force` takes it over
function displaced(home) {
  const mp = join(home, "alpha")
  writeTree(mp, { plugins: { "alpha-kit": { "plugin.json": PLUGIN_JSON, commands: { "greet.md": COMMAND } } } })
  const added = ocm(home, ["add", mp, "--explicit"])
  if (added.status !== 0) throw new Error(`ocm add exited ${added.status}:\n${added.output}`)
  const greet = join(cfg(home), "commands", "alpha-kit:greet.md")
  writeTree(join(cfg(home), "commands"), { "alpha-kit:greet.md": GREET })
  const forced = ocm(home, ["install", "alpha-kit", "--force"])
  if (forced.status !== 0) throw new Error(`ocm install alpha-kit --force exited ${forced.status}:\n${forced.output}`)
  return { greet, forced }
}

phase("1. install --force displaces a hand-written command: the report names where it went, the file leaves commands/, and a second --force displaces nothing new", async (home) => {
  const { greet, forced } = displaced(home)
  const line = lineWith(forced.output, "displaced")
  for (const needle of ["displaced your", "greet.md", displacedRoot(home)]) {
    if (!line.includes(needle)) throw new Error(`the displacement line lacks "${needle}":\n${line}`)
  }
  // the original path now belongs to the takeover: ocm's symlink to the
  // marketplace copy occupies it, so the user's bytes are gone from commands/
  // (they survive only in the displaced cache copy asserted below)
  if (!existsSync(greet) || !lstatSync(greet).isSymbolicLink()) throw new Error(`expected a symlink at ${greet}`)
  expect(realpathSync(greet)).toBe(realpathSync(join(home, "alpha", "plugins", "alpha-kit", "commands", "greet.md")))
  expect(readFileSync(greet, "utf8")).toBe(COMMAND)
  const copies = findUnder(displacedRoot(home), "alpha-kit:greet.md")
  if (copies.length !== 1) throw new Error(`expected one displaced copy under ${displacedRoot(home)}, found ${copies.length}`)
  expect(readFileSync(copies[0], "utf8")).toBe(GREET) // moved, not deleted
  // invariant: idempotence — the second --force re-takes nothing
  const again = ocm(home, ["install", "alpha-kit", "--force"])
  expect(again.status).toBe(0)
  expect(again.output).not.toContain("displaced")
  expect(findUnder(displacedRoot(home), "alpha-kit:greet.md")).toEqual(copies)
})

phase("2. ocm remove restores the displaced original byte-identically, reports the restore, and keeps the cache copy", async (home) => {
  const { greet } = displaced(home)
  const removed = ocm(home, ["remove", "alpha"])
  if (removed.status !== 0) throw new Error(`ocm remove exited ${removed.status}:\n${removed.output}`)
  if (!existsSync(greet)) throw new Error(`expected ${greet} restored by ocm remove alpha`)
  expect(readFileSync(greet, "utf8")).toBe(GREET) // content only; mtime is irrelevant
  const line = lineWith(removed.output, "restored")
  for (const needle of ["restored your", "greet.md", "was displaced by alpha-kit"]) {
    if (!line.includes(needle)) throw new Error(`the restore line lacks "${needle}":\n${line}`)
  }
  const copies = findUnder(displacedRoot(home), "alpha-kit:greet.md")
  if (!copies.length) throw new Error(`expected the cache copy to survive the restore under ${displacedRoot(home)}`)
  expect(readFileSync(copies[0], "utf8")).toBe(GREET) // restore is a copy-back, not a move
})

phase("3. occupied target: a hand-re-created greet.md wins over the restore, and the cache path is reported", async (home) => {
  const { greet } = displaced(home)
  // the link comes down first: a user re-creating the path cannot write
  // through ocm's symlink into the marketplace
  rmSync(greet)
  writeFileSync(greet, GREET_RECREATED) // the user re-created it after the takeover
  const removed = ocm(home, ["remove", "alpha"])
  if (removed.status !== 0) throw new Error(`ocm remove exited ${removed.status}:\n${removed.output}`)
  expect(readFileSync(greet, "utf8")).toBe(GREET_RECREATED) // no restore: theirs wins
  const line = lineWith(removed.output, "displaced")
  for (const needle of ["greet.md", "alpha-kit", "path is taken", displacedRoot(home)]) {
    if (!line.includes(needle)) throw new Error(`the occupied-target line lacks "${needle}":\n${line}`)
  }
  const copies = findUnder(displacedRoot(home), "alpha-kit:greet.md")
  if (!copies.length) throw new Error(`expected the cache copy kept under ${displacedRoot(home)}`)
  expect(readFileSync(copies[0], "utf8")).toBe(GREET)
})

phase("4. uninstalling just the plugin restores the displaced original like a marketplace remove", async (home) => {
  const { greet } = displaced(home)
  const un = ocm(home, ["uninstall", "alpha-kit"])
  if (un.status !== 0) throw new Error(`ocm uninstall exited ${un.status}:\n${un.output}`)
  if (!existsSync(greet)) throw new Error(`expected ${greet} restored by ocm uninstall alpha-kit`)
  expect(readFileSync(greet, "utf8")).toBe(GREET)
  const line = lineWith(un.output, "restored")
  for (const needle of ["restored your", "greet.md", "was displaced by alpha-kit"]) {
    if (!line.includes(needle)) throw new Error(`the restore line lacks "${needle}":\n${line}`)
  }
  const copies = findUnder(displacedRoot(home), "alpha-kit:greet.md")
  if (!copies.length) throw new Error(`expected the cache copy to survive the restore under ${displacedRoot(home)}`)
  expect(readFileSync(copies[0], "utf8")).toBe(GREET)
})

phase("5. a teardown with no displaced files prints nothing extra: remove and uninstall outputs byte-identical to today", async (home) => {
  const mp = join(home, "alpha")
  writeTree(mp, { plugins: { "alpha-kit": { "plugin.json": PLUGIN_JSON, commands: { "greet.md": COMMAND } } } })
  expect(ocm(home, ["add", mp]).status).toBe(0)
  const removed = ocm(home, ["remove", "alpha"])
  expect(removed.status).toBe(0)
  expect(removed.stdout).toBe('removed marketplace "alpha"\n  alpha-kit: 1 commands removed\n')
  expect(removed.stderr).toBe("")
  expect(ocm(home, ["add", mp]).status).toBe(0)
  const un = ocm(home, ["uninstall", "alpha-kit"])
  expect(un.status).toBe(0)
  expect(un.stdout).toBe("restart opencode to activate\nuninstalled alpha-kit@alpha\n")
  expect(un.stderr).toBe("")
})

phase("6. ownership and cache layout: user config and files survive the cycle, the copy keeps <ts>/<absolute-path>, nothing under ~/.claude or ~/.agents, probe clean", async (home) => {
  const userConfig = { model: "claude-sonnet-4-6", permission: { edit: "allow" }, mcp: { "user-server": { type: "local", command: ["echo"] } } }
  writeTree(cfg(home), {
    "opencode.json": json(userConfig), "tui.json": json({ plugin: ["my-own-tui-plugin"] }),
    commands: { "mine.md": "# my own command\n" }, plugins: { "my-own.js": USER_PLUGIN },
  })
  const { greet } = displaced(home)
  // the cache layout is unchanged, so older caches stay readable:
  // <timestamp>/<absolute-original-path>
  const root = displacedRoot(home)
  const copies = findUnder(root, "alpha-kit:greet.md")
  if (copies.length !== 1) throw new Error(`expected one displaced copy under ${root}, found ${copies.length}`)
  const rel = relative(root, copies[0])
  const slash = rel.indexOf("/")
  if (!/^\d{4}-/.test(rel.slice(0, slash))) throw new Error(`expected a timestamp directory in the displaced layout, got ${rel}`)
  if (`/${rel.slice(slash + 1)}` !== greet) throw new Error(`the displaced copy must mirror the absolute original path ${greet}, got ${rel}`)
  const removed = ocm(home, ["remove", "alpha"])
  expect(removed.status).toBe(0)
  if (!existsSync(greet)) throw new Error(`expected ${greet} restored by ocm remove alpha`)
  expect(readFileSync(greet, "utf8")).toBe(GREET)
  expect(readFileSync(copies[0], "utf8")).toBe(GREET) // the cache copy is never consumed
  // invariant: config safety — this flow owns no opencode.json key, so the
  // user's file survives byte-identically
  expect(readFileSync(configFile(home), "utf8")).toBe(json(userConfig))
  // invariant: ownership — files ocm cannot prove it created are untouched
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
  expect(readFileSync(join(cfg(home), "plugins", "my-own.js"), "utf8")).toBe(USER_PLUGIN)
  expect(JSON.parse(readFileSync(join(cfg(home), "tui.json"), "utf8")).plugin).toContain("my-own-tui-plugin")
  const forbidden = []
  const stack = [home]
  while (stack.length) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".claude" || entry.name === ".agents") forbidden.push(join(dir, entry.name))
      if (entry.isDirectory()) stack.push(join(dir, entry.name))
    }
  }
  if (forbidden.length) throw new Error(`expected nothing under ~/.claude or ~/.agents, found: ${forbidden.join(", ")}`)
  // invariant: no plugin-load errors attributable to ocm-installed files
  const probe = opencodeProbe(cfg(home), home)
  if (!probe.available) console.log("skipped: opencode is not on PATH")
  else if (probe.unreliable) throw new Error("probe cannot trust itself: the canary broken plugin produced no error line")
  else expect(probe.pluginErrors).toEqual([])
}, 900_000)
