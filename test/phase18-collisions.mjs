// Phase 18 — docs/specs/18-collisions.md: one test per numbered item, plus
// the two scan edge cases its table spells out (an installed plugin reads
// "already linked"; a foreign file at the destination is a named collision)
// and the four invariants (idempotence and ownership in 1, config safety,
// ownership, idempotence and no plugin errors in 2). A recorded collision is
// only reachable retroactively — add-time refusal (spec 04) blocks the
// head-on route — so colliding() adds two disjoint marketplaces and lets an
// update of "collide" meet the name "review-tools" that "big" already owns.
import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
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
const registryFile = (home) => join(cfg(home), "ocm", "registry.json")
const readRegistry = (home) => JSON.parse(readFileSync(registryFile(home), "utf8"))
const json = (value) => `${JSON.stringify(value, null, 2)}\n`

// realpath on both sides: macOS temp dirs sit behind /var -> /private/var
function assertResolves(dest, source) {
  if (!existsSync(dest) || !lstatSync(dest).isSymbolicLink()) throw new Error(`expected a symlink at ${dest}`)
  expect(realpathSync(dest)).toBe(realpathSync(source))
}

const COMMAND = "---\ndescription: commit helper\n---\n\nCommit body.\n"
const AGENT = "---\ndescription: code reviewer\n---\n\nReviewer body.\n"
const SKILL = "---\nname: style\ndescription: style guidance\n---\n\n# Style\n\nBody.\n"
const JS_PLUGIN = 'export default { id: "phase18-notify", server: async () => ({}) }\n'
const MCP = json({ db: { type: "local", command: ["npx", "-y", "@acme/db-mcp"], enabled: true } })

// the retroactive collision: "collide" ships "review-tools" only after both
// marketplaces are already registered, so the update — not add — meets it
function colliding(home) {
  const big = join(home, "big")
  const collide = join(home, "collide")
  writeTree(big, { plugins: { "review-tools": { commands: { "review.md": COMMAND } } } })
  writeTree(collide, { plugins: { filler: { commands: { "fill.md": COMMAND } } } })
  expect(ocm(home, ["add", big]).status).toBe(0)
  expect(ocm(home, ["add", collide]).status).toBe(0)
  writeTree(collide, { plugins: { "review-tools": { commands: { "review.md": COMMAND } } } })
  const updated = ocm(home, ["update", "collide"])
  expect(updated.status).toBe(0)
  return { big, collide, updated }
}

phase("1. install of a colliding plugin refuses: both marketplaces and the paths named, exit 1, registry byte-identical, incumbent's link untouched", async (home) => {
  const { big } = colliding(home)
  const before = readFileSync(registryFile(home), "utf8")
  const refused = ocm(home, ["install", "review-tools@collide"])
  if (refused.status !== 1) throw new Error(`expected exit 1 from the collision install, got ${refused.status}:\n${refused.output}`)
  for (const needle of ['plugin "review-tools" is already provided by marketplace "big"', "collide", "review.md", "--force"]) {
    expect(refused.output).toContain(needle)
  }
  expect(readFileSync(registryFile(home), "utf8")).toBe(before) // invariant: idempotence — a refusal writes nothing
  // invariant: ownership — the incumbent's link is never displaced by a refusal
  assertResolves(join(cfg(home), "commands", "review-tools:review.md"), join(big, "plugins", "review-tools", "commands", "review.md"))
})

phase("2. install --force takes over: the report states it, the incumbent yields, the user's config survives; a second --force is a clean no-op; the probe stays clean", async (home) => {
  // invariants: config safety and ownership — the user's files predate every ocm run
  const userConfig = { model: "claude-sonnet-4-6", mcp: { "user-server": { type: "local", command: ["echo"] } } }
  writeTree(cfg(home), { "opencode.json": json(userConfig), "tui.json": json({ plugin: ["my-own-tui-plugin"] }), commands: { "mine.md": "# my own command\n" } })
  const configBytes = readFileSync(join(cfg(home), "opencode.json"), "utf8")
  const { collide } = colliding(home)
  const forced = ocm(home, ["install", "review-tools@collide", "--force"])
  if (forced.status !== 0) throw new Error(`install --force exited ${forced.status}:\n${forced.output}`)
  expect(forced.output).toContain('took over "review-tools" from marketplace "big"')
  assertResolves(join(cfg(home), "commands", "review-tools:review.md"), join(collide, "plugins", "review-tools", "commands", "review.md"))
  expect(readRegistry(home).marketplaces.big.plugins["review-tools"].enabled).toBe(false) // the incumbent yields the name
  expect(readFileSync(join(cfg(home), "opencode.json"), "utf8")).toBe(configBytes)
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
  expect(JSON.parse(readFileSync(join(cfg(home), "tui.json"), "utf8")).plugin).toContain("my-own-tui-plugin")
  // invariant: idempotence — the second --force re-takes nothing and warns about nothing
  const registryBytes = readFileSync(registryFile(home), "utf8")
  const again = ocm(home, ["install", "review-tools@collide", "--force"])
  expect(again.status).toBe(0)
  expect(again.output).toContain("already installed")
  expect(again.output).not.toContain("took over")
  expect(again.output).not.toContain("warning")
  expect(readFileSync(registryFile(home), "utf8")).toBe(registryBytes)
  // invariant: no plugin-load errors attributable to ocm-installed files
  const probe = opencodeProbe(cfg(home), home)
  if (!probe.available) console.log("skipped: opencode is not on PATH")
  else if (probe.unreliable) throw new Error("probe cannot trust itself: the canary broken plugin produced no error line")
  else expect(probe.pluginErrors).toEqual([])
}, 420_000)

phase("3. update reports the collision as a line, not an action, and never flips an explicit install back to disabled", async (home) => {
  const { collide, updated } = colliding(home)
  for (const needle of ['name owned by marketplace "big"', "kept disabled", "ocm install review-tools@collide --force"]) {
    expect(updated.output).toContain(needle)
  }
  expect(ocm(home, ["install", "review-tools@collide", "--force"]).status).toBe(0)
  expect(readRegistry(home).marketplaces.collide.plugins["review-tools"].enabled).toBe(true)
  expect(ocm(home, ["update", "collide"]).status).toBe(0)
  expect(readRegistry(home).marketplaces.collide.plugins["review-tools"].enabled).toBe(true) // the explicit choice survives
  assertResolves(join(cfg(home), "commands", "review-tools:review.md"), join(collide, "plugins", "review-tools", "commands", "review.md"))
})

phase("4. add-time refusal lists every colliding plugin with its paths, capped at 10 with an ellipsis", async (home) => {
  const big = join(home, "big")
  writeTree(big, { plugins: { "review-tools": { commands: { "review.md": COMMAND } }, "lint-tools": { commands: { "lint.md": COMMAND } } } })
  expect(ocm(home, ["add", big]).status).toBe(0)
  const rival = join(home, "rival")
  writeTree(rival, { plugins: { "review-tools": { commands: { "review.md": COMMAND } }, "lint-tools": { commands: { "lint.md": COMMAND } } } })
  const refused = ocm(home, ["add", rival])
  if (refused.status === 0) throw new Error(`expected a non-zero exit from "ocm add ${rival}"`)
  for (const needle of ['"review-tools"', "review.md", '"lint-tools"', "lint.md"]) expect(refused.output).toContain(needle)
  expect(readRegistry(home).marketplaces.rival).toBeUndefined()
  // the cap: 12 colliding names list 10, then point at the rest
  const names = Array.from({ length: 12 }, (_, i) => `tool-${String(i + 1).padStart(2, "0")}`)
  const wide = (dir) => writeTree(dir, { plugins: Object.fromEntries(names.map((n) => [n, { commands: { "work.md": COMMAND } }])) })
  wide(join(home, "wide"))
  expect(ocm(home, ["add", join(home, "wide")]).status).toBe(0)
  const wideRival = join(home, "wide-rival")
  wide(wideRival)
  const capped = ocm(home, ["add", wideRival])
  expect(capped.status).not.toBe(0)
  expect(capped.output).toContain("… and 2 more")
})

phase("5. doctor reports a recorded collision with the install remedy and exits 1; --fix changes nothing", async (home) => {
  colliding(home)
  const bytes = readFileSync(registryFile(home), "utf8")
  const diagnosed = ocm(home, ["doctor"], 300_000)
  if (diagnosed.status !== 1) throw new Error(`expected doctor to exit 1 on a recorded collision, got ${diagnosed.status}:\n${diagnosed.output}`)
  for (const needle of ['plugin "review-tools"', '"big"', '"collide"', "ocm install review-tools@collide --force"]) {
    expect(diagnosed.output).toContain(needle)
  }
  const fixed = ocm(home, ["doctor", "--fix"], 300_000)
  expect(fixed.status).toBe(1) // no --fix action: the remedy is a user decision, not a repair
  expect(fixed.output).toContain("ocm install review-tools@collide --force")
  expect(readFileSync(registryFile(home), "utf8")).toBe(bytes)
}, 600_000)

phase("6. scan of an uninstalled plugin: every component 'would create', executables '(trust-gated)', zero collision lines; the real install then needs no --force", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { "review-tools": {
    commands: { "review.md": COMMAND }, agents: { "reviewer.md": AGENT }, skills: { style: { "SKILL.md": SKILL } },
    plugin: { "notify.js": JS_PLUGIN }, "mcp.json": MCP,
  } } })
  expect(ocm(home, ["add", mp, "--explicit"]).status).toBe(0)
  const scanned = ocm(home, ["scan", "review-tools@mp"])
  expect(scanned.status).toBe(0)
  const lines = scanned.stdout.split("\n")
  expect(lines.filter((l) => l.includes("collision"))).toEqual([])
  for (const marker of ["review.md", "reviewer", "style", "notify", "ocm--review-tools--db"]) {
    const line = lines.find((l) => l.includes(marker))
    if (!line) throw new Error(`scan output lacks a line for ${marker}:\n${scanned.stdout}`)
    expect(line).toContain("would create")
    if (marker === "notify" || marker === "ocm--review-tools--db") expect(line).toContain("trust-gated")
  }
  expect(ocm(home, ["install", "review-tools@mp"]).status).toBe(0)
  assertResolves(join(cfg(home), "commands", "review-tools:review.md"), join(mp, "plugins", "review-tools", "commands", "review.md"))
})

phase("7. scan of a directory with no plugins explains the expected layout and points at ocm validate", async (home) => {
  const empty = join(home, "empty")
  writeTree(empty, { "readme.md": "not a marketplace\n" })
  const scanned = ocm(home, ["scan", empty])
  expect(scanned.status).toBe(0)
  for (const needle of ["no plugins found", "plugins/<name>", "see ocm validate and the README's marketplace format"]) {
    expect(scanned.output).toContain(needle)
  }
})

phase("8. validate flags duplicate plugins[] entries and a cross-plugin basename clash in one run", async (home) => {
  const dir = join(home, "mp")
  writeTree(dir, {
    "marketplace.json": json({ name: "mp", plugins: [
      { name: "dup", source: "./plugins/dup" }, { name: "dup", source: "./plugins/dup" },
      { name: "alpha", source: "./plugins/alpha" }, { name: "beta", source: "./plugins/beta" },
    ] }),
    plugins: {
      dup: { commands: { "work.md": COMMAND } },
      alpha: { commands: { "commit.md": COMMAND } },
      beta: { commands: { "commit.md": COMMAND } },
    },
  })
  const result = ocm(home, ["validate", dir])
  if (result.status !== 1) throw new Error(`validate exited ${result.status}, expected 1:\n${result.output}`)
  const errorLine = (...needles) => {
    const line = result.output.split("\n").find((l) => /^\s*error\b/.test(l) && needles.every((n) => l.includes(n)))
    if (!line) throw new Error(`expected an error finding containing ${JSON.stringify(needles)}:\n${result.output}`)
  }
  errorLine("marketplace.json", 'plugin "dup" listed twice')
  errorLine("alpha", "beta", "commit.md")
})

phase("scan of an installed plugin reads 'already linked' for every component, with no collision noise", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { adw: {
    commands: { "commit.md": COMMAND }, agents: { "reviewer.md": AGENT },
    skills: { style: { "SKILL.md": SKILL } }, plugin: { "notify.js": JS_PLUGIN },
  } } })
  expect(ocm(home, ["add", mp, "--trust"]).status).toBe(0)
  const scanned = ocm(home, ["scan", "adw@mp"])
  expect(scanned.status).toBe(0)
  const lines = scanned.stdout.split("\n")
  expect(lines.filter((l) => l.includes("collision"))).toEqual([])
  for (const marker of ["commit.md", "reviewer", "style", "notify"]) {
    const line = lines.find((l) => l.includes(marker))
    if (!line) throw new Error(`scan output lacks a line for ${marker}:\n${scanned.stdout}`)
    expect(line).toContain("already linked")
  }
})

phase("scan with a hand-written file at a destination reports that one collision, names the file, and leaves it untouched", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { adw: { commands: { "review.md": COMMAND }, agents: { "reviewer.md": AGENT } } } })
  expect(ocm(home, ["add", mp, "--explicit"]).status).toBe(0)
  const foreign = join(cfg(home), "commands", "adw:review.md")
  writeTree(join(cfg(home), "commands"), { "adw:review.md": "# my own review command\n" })
  const scanned = ocm(home, ["scan", "adw@mp"])
  expect(scanned.status).toBe(0)
  const commandLine = scanned.stdout.split("\n").find((l) => l.includes("review.md"))
  if (!commandLine) throw new Error(`scan output lacks the command line:\n${scanned.stdout}`)
  expect(commandLine).toContain("collision")
  expect(commandLine).toContain(foreign)
  expect(readFileSync(foreign, "utf8")).toBe("# my own review command\n") // invariant: ownership — scan never touches it
  const agentLine = scanned.stdout.split("\n").find((l) => l.includes("reviewer"))
  if (!agentLine) throw new Error(`scan output lacks the agent line:\n${scanned.stdout}`)
  expect(agentLine).toContain("would create") // the empty destination is not a collision
})
