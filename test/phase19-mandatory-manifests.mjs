// Phase 19 — docs/specs/19-mandatory-manifests.md: one test per numbered
// item. plugin.json becomes required with a non-empty description: add
// refuses the marketplace whole before any write, validate reports one
// error per missing manifest plus a copy-pasteable stub, update refuses
// new manifest-less plugins while their siblings proceed, and installed
// plugins are grandfathered — update keeps them enabled, doctor warns
// once. The four invariants: config safety and ownership in 1 (the whole
// home is byte-compared across the refusal), idempotence in 2, no
// plugin-load errors in 8. Items 2, 7 and 8 pin behaviour the spec says
// must hold regardless, so they pass before spec 19 by design, like
// phase 15's unchanged-behaviour items.
import { spawnSync } from "node:child_process"
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, opencodeProbe, withFakeHome } from "./harness.mjs"

const OCM_BIN = fileURLToPath(new URL("../bin/ocm.ts", import.meta.url))
const TEMPLATE = fileURLToPath(new URL("../template", import.meta.url))
const AP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
const COMMAND = "---\ndescription: commit helper\n---\n\nCommit body.\n"

function ocm(home, args, timeout = 120_000) {
  const result = spawnSync(process.execPath, [OCM_BIN, ...args], {
    env: { ...process.env, HOME: home }, encoding: "utf8", timeout,
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
}
const commitAll = (dir, message) => { git(dir, ["add", "-A"]); git(dir, ["-c", "user.email=ocm@test", "-c", "user.name=ocm", "commit", "-m", message]) }
const gitRepo = (dir, tree) => { writeTree(dir, tree); git(dir, ["init", "-b", "main"]); commitAll(dir, "fixture") }

const cfg = (home) => join(home, ".config", "opencode")
const registryFile = (home) => join(cfg(home), "ocm", "registry.json")
const readRegistry = (home) => JSON.parse(readFileSync(registryFile(home), "utf8"))
const cloneDir = (home, name = "mp") => join(home, ".cache", "ocm", "marketplaces", name)
const commandLink = (home, plugin, file) => join(cfg(home), "commands", `${plugin}:${file}`)
const json = (value) => `${JSON.stringify(value, null, 2)}\n`

// realpath on both sides: macOS temp dirs sit behind /var -> /private/var
function assertResolves(dest, source) {
  if (!existsSync(dest) || !lstatSync(dest).isSymbolicLink()) throw new Error(`expected a symlink at ${dest}`)
  expect(realpathSync(dest)).toBe(realpathSync(source))
}

// every byte of the home — file contents, symlink targets, sorted for a
// stable comparison — the zero-writes proof for a refused add
function snapHome(dir) {
  let out = ""
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) out += `${path} -> ${readlinkSync(path)}\n`
    else if (entry.isDirectory()) out += snapHome(path)
    else out += `${path}\0${readFileSync(path, "utf8")}\n`
  }
  return out
}

// a home created before spec 19: the registry was written while plugin.json
// was optional, so legacy-kit is legitimately installed without one
function preSpecHome(home) {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { "legacy-kit": { commands: { "work.md": COMMAND } } } })
  const real = realpathSync(mp)
  const at = "2026-01-01T00:00:00.000Z"
  mkdirSync(join(cfg(home), "ocm"), { recursive: true })
  writeFileSync(registryFile(home), json({
    version: 2,
    marketplaces: {
      mp: {
        url: real, dir: real, local: true, addedAt: at, mode: "auto", ref: null,
        subdir: null, revision: null, syncIntervalMs: null, trust: { code: "none" },
        lastSync: null,
        plugins: {
          "legacy-kit": {
            source: "plugins/legacy-kit", components: { command: ["work.md"] },
            enabled: true, installedAt: at, version: null, manifest: {},
          },
        },
      },
    },
  }))
  return mp
}

phase("1. add of a marketplace with one manifest-less plugin is refused whole: the plugin and its missing file listed, exit 1, zero writes", async (home) => {
  // the user's config and files predate the refused add (invariants: config safety, ownership)
  writeTree(cfg(home), {
    "opencode.json": json({ model: "claude-sonnet-4-6", mcp: { "user-server": { type: "local", command: ["echo"] } } }),
    commands: { "mine.md": "# my own command\n" },
  })
  const good = join(home, "good")
  writeTree(good, { plugins: { "keep-kit": { "plugin.json": json({ description: "the good plugin" }), commands: { "keep.md": COMMAND } } } })
  expect(ocm(home, ["add", good]).status).toBe(0)
  const bad = join(home, "bad")
  writeTree(bad, { plugins: { "alpha-kit": { commands: { "work.md": COMMAND } } } })
  const before = snapHome(home)

  const result = ocm(home, ["add", bad])
  if (result.status !== 1) throw new Error(`expected exit 1 from the manifest-less add, got ${result.status}:\n${result.output}`)
  for (const needle of ["alpha-kit", "plugins/alpha-kit/plugin.json", "ocm validate"]) expect(result.output).toContain(needle)
  expect(snapHome(home)).toBe(before) // zero writes: the refusal touches nothing, anywhere
  expect(readRegistry(home).marketplaces.bad).toBeUndefined() // refused whole
})

phase("2. the same marketplace with manifests authored adds cleanly, and search finds the plugin by its description", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { "alpha-kit": { commands: { "work.md": COMMAND } } } })
  // the fix test 1's refusal points at: author the manifest
  writeFileSync(join(mp, "plugins", "alpha-kit", "plugin.json"), json({ description: "deployment helpers for clusters" }))
  const added = ocm(home, ["add", mp])
  if (added.status !== 0) throw new Error(`ocm add ${mp} exited ${added.status}:\n${added.output}`)
  expect(readRegistry(home).marketplaces.mp.plugins["alpha-kit"].manifest.description).toBe("deployment helpers for clusters")
  assertResolves(commandLink(home, "alpha-kit", "work.md"), join(mp, "plugins", "alpha-kit", "commands", "work.md"))
  const found = ocm(home, ["search", "deployment"])
  if (found.status !== 0) throw new Error(`ocm search deployment exited ${found.status}:\n${found.output}`)
  expect(found.stdout).toContain("alpha-kit@mp")
  expect(found.stdout).toContain("deployment helpers for clusters")
  // invariant: idempotence — an update of an unchanged marketplace re-creates nothing
  const ino = lstatSync(commandLink(home, "alpha-kit", "work.md")).ino
  const again = ocm(home, ["update", "mp"])
  if (again.status !== 0) throw new Error(`ocm update mp exited ${again.status}:\n${again.output}`)
  expect(lstatSync(commandLink(home, "alpha-kit", "work.md")).ino).toBe(ino)
  expect(Object.keys(readRegistry(home).marketplaces.mp.plugins)).toEqual(["alpha-kit"])
})

phase("3. validate reports one error per missing manifest and prints the copy-pasteable stub once, exit 1", async (home) => {
  const dir = join(home, "mp")
  writeTree(dir, { plugins: {
    "alpha-kit": { commands: { "work.md": COMMAND } },
    "beta-kit": { commands: { "lint.md": COMMAND } },
  } })
  const result = ocm(home, ["validate", dir])
  if (result.status !== 1) throw new Error(`validate exited ${result.status}, expected 1:\n${result.output}`)
  for (const plugin of ["alpha-kit", "beta-kit"]) {
    const lines = result.output.split("\n").filter((l) => /^\s*error\b/.test(l) && l.includes(plugin) && l.includes("plugin.json"))
    if (lines.length !== 1) throw new Error(`expected exactly one error finding for ${plugin}, got ${lines.length}:\n${result.output}`)
  }
  const stubs = result.output.split("\n").filter((l) => l.includes("minimal content"))
  if (stubs.length !== 1) throw new Error(`expected the stub printed once, got ${stubs.length}:\n${result.output}`)
  expect(stubs[0]).toContain('"description"')
})

phase("4. an empty description and a name mismatch are two distinct validate errors", async (home) => {
  const dir = join(home, "mp")
  writeTree(dir, { plugins: {
    "empty-kit": { "plugin.json": json({ $schema: AP_SCHEMA, description: "" }), commands: { "work.md": COMMAND } },
    "wrong-name": { "plugin.json": json({ $schema: AP_SCHEMA, name: "other-name", description: "descriptive" }), commands: { "lint.md": COMMAND } },
  } })
  const result = ocm(home, ["validate", dir])
  if (result.status !== 1) throw new Error(`validate exited ${result.status}, expected 1:\n${result.output}`)
  const errorLine = (...needles) => {
    const line = result.output.split("\n").find((l) => /^\s*error\b/.test(l) && needles.every((n) => l.includes(n)))
    if (!line) throw new Error(`expected an error finding containing ${JSON.stringify(needles)}:\n${result.output}`)
    return line
  }
  const empty = errorLine("empty-kit", "description")
  const mismatch = errorLine("other-name", "wrong-name")
  expect(empty).not.toBe(mismatch)
})

phase("5. update pulling a new manifest-less plugin refuses and reports that plugin while its siblings update", async (home) => {
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { "stable-kit": { "plugin.json": json({ description: "stable helpers" }), commands: { "base.md": COMMAND } } } })
  const added = ocm(home, ["add", `file://${remote}`, "--name", "mp"])
  if (added.status !== 0) throw new Error(`ocm add exited ${added.status}:\n${added.output}`)
  writeTree(remote, { plugins: {
    "rogue-kit": { commands: { "work.md": COMMAND } }, // new upstream plugin, no plugin.json
    "stable-kit": { commands: { "extra.md": COMMAND } }, // the sibling gains a command
  } })
  commitAll(remote, "upstream adds rogue-kit")
  const updated = ocm(home, ["update", "mp"])
  if (updated.status !== 0) throw new Error(`update exited ${updated.status} — the rest of the update must proceed:\n${updated.output}`)
  const refusal = updated.output.split("\n").find((l) => l.includes("rogue-kit") && l.includes("plugin.json"))
  if (!refusal) throw new Error(`expected a report line naming "rogue-kit" and its missing plugin.json:\n${updated.output}`)
  expect(readRegistry(home).marketplaces.mp.plugins["rogue-kit"]).toBeUndefined() // refused, not installed
  assertAbsent(join(cfg(home), "commands", "rogue-kit:work.md"))
  assertResolves(commandLink(home, "stable-kit", "extra.md"), join(cloneDir(home), "plugins", "stable-kit", "commands", "extra.md"))
})

phase("6. a grandfathered install survives update enabled, and doctor reports the legacy warning exactly once", async (home) => {
  preSpecHome(home)
  const updated = ocm(home, ["update", "mp"])
  if (updated.status !== 0) throw new Error(`ocm update mp exited ${updated.status}:\n${updated.output}`)
  const record = readRegistry(home).marketplaces.mp.plugins["legacy-kit"]
  if (!record || record.enabled !== true) {
    throw new Error(`expected legacy-kit to stay enabled across the update in ${registryFile(home)}, got ${JSON.stringify(record)}`)
  }
  assertResolves(commandLink(home, "legacy-kit", "work.md"), join(home, "mp", "plugins", "legacy-kit", "commands", "work.md"))
  const diagnosed = ocm(home, ["doctor"], 300_000)
  if (diagnosed.status !== 0) throw new Error(`the legacy warning is exit-code-neutral, but doctor exited ${diagnosed.status}:\n${diagnosed.output}`)
  const warnings = diagnosed.output.split("\n").filter((l) => l.includes("legacy-kit") && l.includes("plugin.json"))
  if (warnings.length !== 1) throw new Error(`expected exactly one legacy warning for legacy-kit, got ${warnings.length}:\n${diagnosed.output}`)
}, 420_000)

phase("7. template/ passes ocm validate with zero findings, every plugin manifest-bearing", async (home) => {
  const result = ocm(home, ["validate", TEMPLATE])
  const output = `${result.stdout}\n${result.stderr}`
  if (result.status !== 0) throw new Error(`ocm validate ${TEMPLATE} exited ${result.status}:\n${output}`)
  const header = output.trim()
  if (header !== `validate ${TEMPLATE}` && header !== `validate ${realpathSync(TEMPLATE)}`) {
    throw new Error(`expected only the header "validate ${TEMPLATE}", got:\n${header}`)
  }
  for (const entry of readdirSync(join(TEMPLATE, "plugins"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(TEMPLATE, "plugins", entry.name, "plugin.json")
    if (!existsSync(file)) throw new Error(`template plugin "${entry.name}" has no plugin.json — spec 19 requires one`)
    const manifest = JSON.parse(readFileSync(file, "utf8"))
    if (typeof manifest.description !== "string" || !manifest.description) {
      throw new Error(`template plugin "${entry.name}" needs a non-empty description in ${file}`)
    }
  }
})

phase("8. a pre-spec home keeps working end to end: list, update and opencode resolution, zero errors", async (home) => {
  preSpecHome(home)
  const listed = ocm(home, ["list"])
  if (listed.status !== 0) throw new Error(`ocm list exited ${listed.status}:\n${listed.output}`)
  expect(listed.stdout).toContain("legacy-kit")
  const updated = ocm(home, ["update"])
  if (updated.status !== 0) throw new Error(`ocm update exited ${updated.status}:\n${updated.output}`)
  assertResolves(commandLink(home, "legacy-kit", "work.md"), join(home, "mp", "plugins", "legacy-kit", "commands", "work.md"))
  // invariant: no plugin-load errors attributable to ocm-installed files
  const probe = opencodeProbe(cfg(home), home)
  if (!probe.available) console.log("skipped: opencode is not on PATH")
  else if (probe.unreliable) throw new Error("probe cannot trust itself: the canary broken plugin produced no error line")
  else {
    expect(probe.commands.join("\n")).toContain("legacy-kit:work")
    expect(probe.pluginErrors).toEqual([])
  }
}, 420_000)
