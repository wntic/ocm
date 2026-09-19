// Search and display: ranking by name, tag, description and component
// name; what list and info show.

import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { assertAbsent, opencodeProbe, withFakeHome } from "./harness.mjs"

// Helpers shared verbatim by the absorbed files below.

const OCM_BIN = fileURLToPath(new URL("../bin/ocm.ts", import.meta.url))

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

const cfg = (home) => join(home, ".config", "opencode")

const registryFile = (home) => join(cfg(home), "ocm", "registry.json")

const readRegistry = (home) => JSON.parse(readFileSync(registryFile(home), "utf8"))

function editRegistry(home, edit) {
  const registry = readRegistry(home)
  edit(registry)
  writeFileSync(registryFile(home), `${JSON.stringify(registry, null, 2)}\n`)
}

const manifest = (plugins) => `${JSON.stringify({ plugins }, null, 2)}\n`

function addNamed(home, name, tree, ...flags) {
  const dir = join(home, name)
  writeTree(dir, tree)
  const result = ocm(home, "add", dir, ...flags)
  if (result.status !== 0) throw new Error(`ocm add ${name} exited ${result.status}: ${result.stderr}`)
  return dir
}

function assertNoResult(output, plugin) {
  const re = new RegExp(`^\\s*${plugin}(@|\\s|$)`)
  if (output.split("\n").some((line) => re.test(line))) {
    throw new Error(`expected no result line for "${plugin}" in:\n${output}`)
  }
}

const COMMAND = "---\ndescription: commit helper\n---\n\nCommit body.\n"

const AGENT = "---\ndescription: code reviewer\n---\n\nReviewer body.\n"

const SKILL = "---\nname: code-review\ndescription: code review checklist\n---\n\n# Code review\n\nUse the checklist.\n"

const JS_PLUGIN = 'export default { id: "phase09-notify", server: async () => ({}) }\n'

const CORE_MODULE = fileURLToPath(new URL("../loader/core.js", import.meta.url))

function git(dir, args) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: 120_000 })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${r.stderr}`)
}

const commitAll = (dir, msg) => { git(dir, ["add", "-A"]); git(dir, ["-c", "user.email=ocm@test", "-c", "user.name=ocm", "commit", "-m", msg]) }

const gitRepo = (dir, tree) => { writeTree(dir, tree); git(dir, ["init", "-b", "main"]); commitAll(dir, "fixture") }

// the loader's startup sync, forced so the add-time throttle cannot skip it
const SYNC_RUNNER = "const mod = await import(process.argv[2]); await mod.syncAll({ force: true })\n"

function loaderSync(home) {
  const runner = join(home, "sync-runner.mjs")
  writeFileSync(runner, SYNC_RUNNER)
  const r = spawnSync(process.execPath, [runner, CORE_MODULE], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 120_000 })
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`

const PLUGIN_JSON = json({ description: "demo plugin" }) // spec 19

const JS_PLUGIN_CHANGED = `// v2\n${JS_PLUGIN}`

const JS_PLUGIN_PING = 'export default { id: "phase25-ping", server: async () => ({}) }\n'

const SERVER = { type: "local", command: ["npx", "-y", "@acme/db-mcp"], enabled: true }

const mcpJson = (servers) => json(servers)

const lineWith = (output, needle) => {
  const line = output.split("\n").find((l) => l.includes(needle))
  if (line === undefined) throw new Error(`expected a line containing "${needle}" in:\n${output}`)
  return line
}

// runs `ocm pin mp` under a pty; when the ref list appears (the marker is a
// ref only that list prints), the answer is written as the interactive choice
const PIN_PTY = `
import fcntl, json, os, pty, select, signal, sys, termios, time
answer, cmd = sys.argv[1], sys.argv[2:]
master, slave = pty.openpty(); pid = os.fork()
if pid == 0:
    os.setsid(); fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    os.dup2(slave, 0); os.dup2(slave, 1); os.dup2(slave, 2)
    os.close(master); os.execvp(cmd[0], cmd)
os.close(slave)
MARKER, deadline, acted, timed_out = b"v1.0.0", time.time() + 60, False, False
out, fds = b"", [master]
while fds:
    if time.time() > deadline: timed_out = True; os.kill(pid, signal.SIGKILL); break
    for fd in select.select(fds, [], [], 1.0)[0]:
        try: data = os.read(fd, 65536)
        except OSError: data = b""
        out += data
        if not acted and MARKER in out: acted = True; os.write(master, answer.encode())
        if not data: fds.remove(fd)
_, ws = os.waitpid(pid, 0)
status = -(ws & 0x7f) or (ws >> 8)
print(json.dumps({"status": status, "acted": acted, "timed_out": timed_out, "output": out.decode("utf-8", "replace")}))
`

function ptyPin(home, answer) {
  const script = join(home, "pin-pty.py")
  writeFileSync(script, PIN_PTY)
  const r = spawnSync("python3", [script, answer, process.execPath, OCM_BIN, "pin", "mp"], {
    env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 120_000,
  })
  if (r.error || r.status === null) throw new Error(`the pty run failed: ${r.error?.message ?? r.stderr}`)
  try {
    return JSON.parse(r.stdout)
  } catch {
    throw new Error(`the pty helper printed no JSON: ${r.stdout}\n${r.stderr}`)
  }
}

// search: ranking by name, tag, description and component name — absorbed from test/phase09-search.mjs
{
// a plugin's result line: result lines lead with plugin@marketplace (the
// spec's example output), so "review" must not match "reviewer",
// "code-review", a description mentioning review, or a summary header
function findResult(output, plugin) {
  const re = new RegExp(`^\\s*${plugin}(@|\\s|$)`)
  const lines = output.split("\n")
  const index = lines.findIndex((line) => re.test(line))
  if (index === -1) throw new Error(`expected a result line for "${plugin}" in:\n${output}`)
  return { index, line: lines[index] }
}

// spec 19: every installable plugin carries a plugin.json with a description;
// "demo plugin" matches no query these tests search for
const PLUGIN_JSON = `${JSON.stringify({ description: "demo plugin" }, null, 2)}\n`

phase("1. ranking: name exact beats prefix beats substring beats tag beats description beats component name", async (home) => {
  addNamed(home, "mp", {
    "marketplace.json": manifest([
      { name: "quality-gate", source: "./plugins/quality-gate", tags: ["review"] },
      { name: "polish", source: "./plugins/polish", description: "polish and review your diffs" },
    ]),
    plugins: {
      review: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } }, // name exact
      reviewer: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } }, // name prefix
      "code-review": { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } }, // name substring
      "quality-gate": { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } }, // tag exact
      polish: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } }, // description substring
      adw: { "plugin.json": PLUGIN_JSON, commands: { "pr-review.md": COMMAND } }, // component name substring
    },
  })
  const result = ocm(home, "search", "review")
  if (result.status !== 0) throw new Error(`ocm search review exited ${result.status}: ${result.stderr}`)
  const output = result.stdout
  const ranked = ["review", "reviewer", "code-review", "quality-gate", "polish", "adw"]
  const indexes = ranked.map((plugin) => findResult(output, plugin).index)
  for (let i = 1; i < indexes.length; i++) {
    if (!(indexes[i - 1] < indexes[i])) {
      throw new Error(`expected "${ranked[i - 1]}" to rank above "${ranked[i]}" in:\n${output}`)
    }
  }
})

phase("2. a component-name match surfaces a plugin whose own name does not match, and the output says which component matched", async (home) => {
  addNamed(home, "mp", { plugins: { adw: { "plugin.json": PLUGIN_JSON, commands: { "commit.md": COMMAND } } } })
  const result = ocm(home, "search", "commit")
  if (result.status !== 0) throw new Error(`ocm search commit exited ${result.status}: ${result.stderr}`)
  const output = result.stdout
  findResult(output, "adw") // "adw" does not match "commit"; only its command does
  if (!/matched[^\n]*commit/.test(output)) {
    throw new Error(`expected a "matched: <component>" line naming commit in:\n${output}`)
  }
})

phase("3. disabled and blocked markers; --enabled-only drops the disabled plugin", async (home) => {
  addNamed(home, "mp-a", {
    "marketplace.json": manifest([{ name: "tool-old", source: "./plugins/tool-old", defaultEnabled: false }]),
    plugins: { "tool-old": { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } } },
  })
  // no --trust and no TTY: the executable component is discovered, recorded
  // and blocked, never linked
  addNamed(home, "mp-b", {
    plugins: { "tool-new": { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND }, plugin: { "notify.js": JS_PLUGIN } } },
  })
  const result = ocm(home, "search", "tool")
  if (result.status !== 0) throw new Error(`ocm search tool exited ${result.status}: ${result.stderr}`)
  const output = result.stdout
  expect(findResult(output, "tool-old").line).toContain("disabled")
  expect(findResult(output, "tool-new").line).toContain("blocked")
  const enabled = ocm(home, "search", "tool", "--enabled-only")
  if (enabled.status !== 0) throw new Error(`ocm search tool --enabled-only exited ${enabled.status}: ${enabled.stderr}`)
  assertNoResult(enabled.stdout, "tool-old")
  // blocked is a trust state, not an enabled state: the plugin stays listed
  findResult(enabled.stdout, "tool-new")
  assertAbsent(join(cfg(home), "plugins", "ocm--tool-new--notify.js"))
  // invariant: no plugin-load errors attributable to ocm-installed files
  const probe = opencodeProbe(cfg(home), home)
  if (!probe.available) console.log("skipped: opencode is not on PATH")
  else {
    if (probe.unreliable) throw new Error("probe cannot trust itself: the canary broken plugin produced no error line")
    expect(probe.pluginErrors).toEqual([])
  }
}, 420_000) // opencode spawns with plugin files present: canary + error scan

phase("4. an empty result exits 1 with no matches for the query, and hints at ocm update only when a marketplace is stale or failed", async (home) => {
  addNamed(home, "mp", { plugins: { solo: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } } } })
  editRegistry(home, (registry) => {
    registry.marketplaces.mp.lastSync = { at: new Date().toISOString(), ok: true, error: null }
  })
  const fresh = ocm(home, "search", "zzz-nothing")
  const freshOutput = `${fresh.stdout}\n${fresh.stderr}`
  if (fresh.status !== 1) throw new Error(`expected exit 1 from an empty search, got ${fresh.status}: ${freshOutput}`)
  if (!freshOutput.includes(`no matches for "zzz-nothing"`)) {
    throw new Error(`expected 'no matches for "zzz-nothing"' in:\n${freshOutput}`)
  }
  if (freshOutput.includes("ocm update")) {
    throw new Error(`a fresh marketplace must not produce an update hint:\n${freshOutput}`)
  }
  // a failed sync and a stale one both explain that the cache may be behind
  for (const lastSync of [
    { at: new Date().toISOString(), ok: false, error: "pull failed" },
    { at: new Date(Date.now() - 30 * 24 * 3_600_000).toISOString(), ok: true, error: null },
  ]) {
    editRegistry(home, (registry) => {
      registry.marketplaces.mp.lastSync = lastSync
    })
    const stale = ocm(home, "search", "zzz-nothing")
    const staleOutput = `${stale.stdout}\n${stale.stderr}`
    if (stale.status !== 1) throw new Error(`expected exit 1 from an empty search, got ${stale.status}: ${staleOutput}`)
    if (!staleOutput.includes(`no matches for "zzz-nothing"`)) {
      throw new Error(`expected 'no matches for "zzz-nothing"' in:\n${staleOutput}`)
    }
    if (!staleOutput.includes("ocm update")) {
      throw new Error(`expected an "ocm update" hint with lastSync ${JSON.stringify(lastSync)} in:\n${staleOutput}`)
    }
  }
})

phase("5. info shows resulting opencode names, annotates origins only on disagreement, and works for a disabled plugin", async (home) => {
  addNamed(home, "mp", {
    "marketplace.json": manifest([
      {
        name: "quality-review", source: "./plugins/quality-review",
        description: "from marketplace", version: "1.2.0", category: "review", tags: ["review", "quality"],
      },
      { name: "quiet-tool", source: "./plugins/quiet-tool", defaultEnabled: false },
    ]),
    plugins: {
      "quality-review": {
        // version and description disagree with the marketplace entry;
        // category agrees — that difference is what the annotations track
        "plugin.json": `${JSON.stringify({ description: "from plugin.json", version: "1.0.0", category: "review" }, null, 2)}\n`,
        commands: { "commit.md": COMMAND },
        agents: { "reviewer.md": AGENT },
        skills: { "code-review": { "SKILL.md": SKILL } },
      },
      "quiet-tool": {
        "plugin.json": `${JSON.stringify({ description: "quiet tool, off by default" }, null, 2)}\n`,
        commands: { "work.md": COMMAND },
      },
    },
  })
  const result = ocm(home, "info", "quality-review")
  if (result.status !== 0) throw new Error(`ocm info quality-review exited ${result.status}: ${result.stderr}`)
  const output = result.stdout
  // the resulting opencode names, not the source filenames: the command
  // drops its .md, the skill is namespaced from its frontmatter name
  for (const name of ["quality-review:commit", "quality-review:reviewer", "quality-review:code-review"]) {
    if (!output.includes(name)) throw new Error(`expected the resulting opencode name "${name}" in:\n${output}`)
  }
  const versionLine = output.split("\n").find((line) => line.includes("1.2.0"))
  if (!versionLine) throw new Error(`expected the version 1.2.0 in:\n${output}`)
  if (!versionLine.includes("marketplace.json")) {
    throw new Error(`expected a (marketplace.json) origin on the conflicting version line: ${versionLine}`)
  }
  const categoryLine = output.split("\n").find((line) => line.includes("category"))
  if (!categoryLine) throw new Error(`expected a category line in:\n${output}`)
  for (const origin of ["marketplace.json", "plugin.json", "inferred"]) {
    if (categoryLine.includes(origin)) {
      throw new Error(`an agreeing field carries no origin annotation: ${categoryLine}`)
    }
  }
  const disabled = ocm(home, "info", "quiet-tool")
  if (disabled.status !== 0) throw new Error(`ocm info quiet-tool exited ${disabled.status}: ${disabled.stderr}`)
  const disabledOutput = disabled.stdout
  if (!disabledOutput.includes("quiet tool, off by default")) {
    throw new Error(`expected the cached description in:\n${disabledOutput}`)
  }
  const enabledLine = disabledOutput.split("\n").find((line) => line.includes("enabled"))
  if (!enabledLine || !/\b(no|false)\b/.test(enabledLine)) {
    throw new Error(`expected the enabled field to read no/false for the disabled plugin in:\n${disabledOutput}`)
  }
})

phase("6. search and info both answer from the registry cache with the marketplace directory deleted", async (home) => {
  // invariants: the user's config keys and their own command predate every
  // ocm run and must survive both commands byte-identically
  writeTree(cfg(home), {
    "opencode.json": `${JSON.stringify({ model: "claude-sonnet-4-6", permission: { edit: "allow" } }, null, 2)}\n`,
    commands: { "mine.md": "# my own command\n" },
  })
  addNamed(home, "mp", {
    plugins: {
      solo: {
        "plugin.json": `${JSON.stringify({ description: "works standalone", version: "0.1.0" }, null, 2)}\n`,
        commands: { "work.md": COMMAND },
      },
    },
  })
  const configBytes = readFileSync(join(cfg(home), "opencode.json"), "utf8")
  const registryBytes = readFileSync(registryFile(home), "utf8")
  rmSync(join(home, "mp"), { recursive: true, force: true }) // registry cache only
  const first = ocm(home, "search", "solo")
  if (first.status !== 0) throw new Error(`ocm search solo exited ${first.status}: ${first.stderr}`)
  if (!first.stdout.includes("solo")) throw new Error(`expected solo in:\n${first.stdout}`)
  const info = ocm(home, "info", "solo")
  if (info.status !== 0) throw new Error(`ocm info solo exited ${info.status}: ${info.stderr}`)
  if (!info.stdout.includes("works standalone")) throw new Error(`expected the cached description in:\n${info.stdout}`)
  // invariant: idempotence — a second search prints the same thing
  const second = ocm(home, "search", "solo")
  if (second.status !== 0) throw new Error(`ocm search solo exited ${second.status}: ${second.stderr}`)
  expect(second.stdout).toBe(first.stdout)
  expect(readFileSync(registryFile(home), "utf8")).toBe(registryBytes)
  expect(readFileSync(join(cfg(home), "opencode.json"), "utf8")).toBe(configBytes)
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
})
}

// display: what list and info show — absorbed from test/phase25-display.mjs
{
function ocm(home, args, timeout = 120_000) {
  const r = spawnSync(process.execPath, [OCM_BIN, ...args], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout })
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` }
}

// a marketplace row of `list`: the bare name, or the name plus (markers)
const row = (output, name) => {
  const line = output.split("\n").find((l) => new RegExp(`^${name}(\\s|\\(|$)`).test(l))
  if (!line) throw new Error(`expected a marketplace line for ${name} in:\n${output}`)
  return line
}


const JS_PLUGIN = 'export default { id: "phase25-notify", server: async () => ({}) }\n'

phase("1. a denied marketplace's executable components list as blocked with the trust remedy; list --json stays byte-stable", async (home) => {
  // invariants: config safety and ownership — the user's keys and their own
  // command predate every ocm run and must survive the renders
  writeTree(cfg(home), {
    "opencode.json": json({ model: "claude-sonnet-4-6", permission: { edit: "allow" }, mcp: { "user-server": { type: "local", command: ["echo"] } } }),
    commands: { "mine.md": "# my own command\n" },
  })
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { kit: {
    "plugin.json": PLUGIN_JSON,
    commands: { "work.md": COMMAND },
    plugin: { "notify.js": JS_PLUGIN },
    "mcp.json": mcpJson({ everything: SERVER }),
  } } })
  expect(ocm(home, ["add", mp, "--no-trust"]).status).toBe(0)
  const registryBytes = readFileSync(registryFile(home), "utf8")
  const configBytes = readFileSync(join(cfg(home), "opencode.json"), "utf8")

  const listed = ocm(home, ["list"])
  if (listed.status !== 0) throw new Error(`ocm list exited ${listed.status}: ${listed.output}`)
  const marker = "(blocked \u2014 ocm trust mp)"
  expect(lineWith(listed.stdout, "plugins: notify.js")).toContain(marker)
  expect(lineWith(listed.stdout, "mcp: everything")).toContain(marker)

  const asJson = ocm(home, ["list", "--json"])
  if (asJson.status !== 0) throw new Error(`ocm list --json exited ${asJson.status}: ${asJson.output}`)
  expect(asJson.stdout).toBe(registryBytes) // byte-stable versus today: the json half was already truthful
  expect(asJson.stdout).not.toContain("blocked \u2014 ocm trust")

  // invariant: idempotence — the second render is identical and writes nothing
  expect(ocm(home, ["list"]).stdout).toBe(listed.stdout)
  expect(readFileSync(registryFile(home), "utf8")).toBe(registryBytes)
  expect(readFileSync(join(cfg(home), "opencode.json"), "utf8")).toBe(configBytes)
  expect(readFileSync(join(cfg(home), "commands", "mine.md"), "utf8")).toBe("# my own command\n")
})

phase("2. trust-pending is visible: a list marker, pending lines in list --all and info, and a doctor error", async (home) => {
  const mp = join(home, "mp")
  writeTree(mp, { plugins: { kit: {
    "plugin.json": PLUGIN_JSON,
    commands: { "work.md": COMMAND },
    plugin: { "notify.js": JS_PLUGIN },
  } } })
  expect(ocm(home, ["add", mp, "--trust"]).status).toBe(0)
  // the threat model's shape: a quiet sync pulls a new executable component
  writeFileSync(join(mp, "plugins", "kit", "plugin", "ping.js"), JS_PLUGIN_PING)
  const synced = loaderSync(home)
  if (synced.status !== 0) throw new Error(`loader sync exited ${synced.status}: ${synced.stderr}`)
  expect(readRegistry(home).marketplaces.mp.trustPending).toBe(true) // the state the displays render

  const listed = ocm(home, ["list"])
  if (listed.status !== 0) throw new Error(`ocm list exited ${listed.status}: ${listed.output}`)
  expect(row(listed.stdout, "mp")).toContain("1 component awaiting trust")

  const all = ocm(home, ["list", "--all"])
  if (all.status !== 0) throw new Error(`ocm list --all exited ${all.status}: ${all.output}`)
  lineWith(all.output, "ping.js") // the pending component, one line
  expect(all.output).toContain("ocm trust mp") // …with the hint

  const info = ocm(home, ["info", "kit"])
  if (info.status !== 0) throw new Error(`ocm info kit exited ${info.status}: ${info.output}`)
  lineWith(info.stdout, "ping.js")
  expect(info.stdout).toContain("ocm trust mp")

  const doctor = ocm(home, ["doctor"], 300_000)
  if (doctor.status === 0) throw new Error(`a trust-pending marketplace must be exit-code-relevant in doctor:\n${doctor.output}`)
  for (const needle of ["pulled but not trusted", "ocm trust mp"]) {
    if (!doctor.output.includes(needle)) throw new Error(`expected "${needle}" in doctor's report:\n${doctor.output}`)
  }
}, 420_000)

phase("3. info renders disk, not registry fiction: (not linked) for absent targets; the trust line states denied, granted or changed", async (home) => {
  const addKit = (mpName, plugin, ...flags) => {
    const dir = join(home, mpName)
    writeTree(dir, { plugins: { [plugin]: {
      "plugin.json": PLUGIN_JSON,
      commands: { "tdd.md": COMMAND },
      plugin: { "notify.js": JS_PLUGIN },
      "mcp.json": mcpJson({ db: SERVER }),
    } } })
    expect(ocm(home, ["add", dir, ...flags]).status).toBe(0)
    return dir
  }
  addKit("mp-deny", "deny-kit", "--no-trust")
  addKit("mp-ok", "ok-kit", "--trust")
  const drifted = addKit("mp-drift", "drift-kit", "--trust")
  writeFileSync(join(drifted, "plugins", "drift-kit", "plugin", "notify.js"), JS_PLUGIN_CHANGED)

  const info = (plugin) => {
    const result = ocm(home, ["info", plugin])
    if (result.status !== 0) throw new Error(`ocm info ${plugin} exited ${result.status}: ${result.output}`)
    return result.stdout
  }
  const trustLine = (output) => {
    const line = output.split("\n").find((l) => /^\s*trust\b/.test(l))
    if (!line) throw new Error(`expected a trust line in:\n${output}`)
    return line
  }

  // denied: stuff links, executables do not, and the trust line says denied
  const denied = info("deny-kit")
  expect(lineWith(denied, "deny-kit:tdd")).toContain("→")
  for (const needle of ["ocm--deny-kit--notify.js", "ocm--deny-kit--db"]) {
    const line = lineWith(denied, needle)
    expect(line).toContain("(not linked)")
    expect(line).not.toContain("→")
  }
  expect(trustLine(denied)).toContain("denied")

  // granted and unchanged: the arrow form, and "trust granted"
  const granted = info("ok-kit")
  expect(lineWith(granted, "ocm--ok-kit--notify.js")).toContain("→")
  const okTrust = trustLine(granted)
  expect(okTrust).toContain("granted")
  expect(okTrust).not.toContain("changed")

  // granted but the code moved since the grant: the line says so, with the remedy
  const driftTrust = trustLine(info("drift-kit"))
  expect(driftTrust).toContain("changed")
  expect(driftTrust).toContain("ocm trust mp-drift")

  // disabled: every target is absent, so the command line says (not linked)
  expect(ocm(home, ["uninstall", "ok-kit"]).status).toBe(0)
  const disabledCommand = lineWith(info("ok-kit"), "ok-kit:tdd")
  expect(disabledCommand).toContain("(not linked)")
  expect(disabledCommand).not.toContain("→")

  // invariant: no plugin-load errors attributable to ocm-installed files
  const probe = opencodeProbe(cfg(home), home)
  if (!probe.available) console.log("skipped: opencode is not on PATH")
  else {
    if (probe.unreliable) throw new Error("probe cannot trust itself: the canary broken plugin produced no error line")
    expect(probe.pluginErrors).toEqual([])
  }
}, 420_000)

phase("4. a plugin auto-installed by update gets installedAt from the materialization, not the marketplace's addedAt", async (home) => {
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { solo: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } } } })
  expect(ocm(home, ["add", `file://${remote}`, "--name", "mp"]).status).toBe(0)
  writeTree(join(remote, "plugins", "fresh"), { "plugin.json": PLUGIN_JSON, commands: { "new.md": COMMAND } })
  commitAll(remote, "ship a new plugin")
  const before = Date.now()
  const result = ocm(home, ["update", "mp"])
  if (result.status !== 0) throw new Error(`ocm update mp exited ${result.status}: ${result.output}`)
  const entry = readRegistry(home).marketplaces.mp
  const installedAt = entry.plugins.fresh?.installedAt
  if (typeof installedAt !== "string") {
    throw new Error(`expected fresh.installedAt to be recorded in ${registryFile(home)}, got ${JSON.stringify(installedAt)}`)
  }
  const at = Date.parse(installedAt)
  if (!(at >= before && at <= Date.now() + 1_000)) {
    throw new Error(`expected fresh.installedAt "${installedAt}" inside the test run's window, not the marketplace's addedAt ${entry.addedAt}`)
  }
  const info = ocm(home, ["info", "fresh"])
  if (info.status !== 0) throw new Error(`ocm info fresh exited ${info.status}: ${info.output}`)
  expect(info.output).not.toContain(entry.addedAt) // no backdated install date in info
})

phase("5. a held pin shows on the marketplace line in ocm list", async (home) => {
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { tool: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } } } })
  git(remote, ["tag", "v1.0.0"])
  expect(ocm(home, ["add", `file://${remote}`, "--name", "mp"]).status).toBe(0)
  expect(ocm(home, ["pin", "mp", "v1.0.0"]).status).toBe(0)
  writeTree(join(home, "mp-local"), { plugins: { loc: { "plugin.json": PLUGIN_JSON, commands: { "x.md": COMMAND } } } })
  expect(ocm(home, ["add", join(home, "mp-local")]).status).toBe(0)
  const listed = ocm(home, ["list"])
  if (listed.status !== 0) throw new Error(`ocm list exited ${listed.status}: ${listed.output}`)
  expect(row(listed.stdout, "mp")).toContain("pinned @ v1.0.0")
  expect(row(listed.stdout, "mp-local")).not.toContain("pinned") // never claim a pin that is not held
})

phase("6. ocm pin mp with no ref offers the remote refs and records the choice; non-interactively it errors listing them", async (home) => {
  const remote = join(home, "remote")
  gitRepo(remote, { plugins: { tool: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } } } })
  git(remote, ["tag", "v1.0.0"])
  expect(ocm(home, ["add", `file://${remote}`, "--name", "mp"]).status).toBe(0)

  // spawned stdio is not a TTY: an error naming the available refs, saving nothing
  const plain = ocm(home, ["pin", "mp"])
  expect(plain.status).not.toBe(0)
  for (const ref of ["v1.0.0", "main"]) {
    if (!plain.output.includes(ref)) throw new Error(`the non-interactive pin error must list the ref "${ref}":\n${plain.output}`)
  }
  expect(readRegistry(home).marketplaces.mp.ref).toBe(null)

  const run = ptyPin(home, "v1.0.0\r")
  if (run.timed_out) throw new Error("ocm never exited after the ref choice")
  if (!run.acted) throw new Error(`the ref list never appeared under the pty:\n${run.output}`)
  expect(run.status).toBe(0)
  expect(run.output).toContain("main") // the heads are offered alongside the tags
  expect(readRegistry(home).marketplaces.mp.ref).toBe("v1.0.0") // the choice is recorded
}, 240_000)

phase("7. list --all shows each marketplace's sync age; a failed sync marks the row in plain list, which stays silent about mere age", async (home) => {
  for (const name of ["mp-age", "mp-never", "mp-fail"]) {
    gitRepo(join(home, `remote-${name}`), { plugins: { [`tool-${name}`]: { "plugin.json": PLUGIN_JSON, commands: { "work.md": COMMAND } } } })
    const added = ocm(home, ["add", `file://${join(home, `remote-${name}`)}`, "--name", name])
    if (added.status !== 0) throw new Error(`ocm add ${name} exited ${added.status}: ${added.output}`)
  }
  editRegistry(home, (registry) => {
    registry.marketplaces["mp-age"].lastSync = { at: new Date(Date.now() - 125 * 60_000).toISOString(), ok: true, error: null }
    registry.marketplaces["mp-never"].lastSync = null
    registry.marketplaces["mp-fail"].lastSync = { at: new Date(Date.now() - 5.5 * 60_000).toISOString(), ok: false, error: "cannot access the remote" }
  })
  const all = ocm(home, ["list", "--all"])
  if (all.status !== 0) throw new Error(`ocm list --all exited ${all.status}: ${all.output}`)
  for (const needle of ["synced 2h ago", "never synced", "sync failed 5m ago"]) {
    if (!all.output.includes(needle)) throw new Error(`expected "${needle}" in list --all:\n${all.output}`)
  }
  const plain = ocm(home, ["list"])
  if (plain.status !== 0) throw new Error(`ocm list exited ${plain.status}: ${plain.output}`)
  expect(row(plain.stdout, "mp-fail")).toContain("sync failed 5m ago")
  expect(plain.output).not.toContain("synced") // plain list is silent about mere age
})

phase("8. search matches plugin JS file names and MCP server names, with matched: annotations for both", async (home) => {
  writeTree(join(home, "mp"), { plugins: { "demo-kit": {
    "plugin.json": PLUGIN_JSON,
    commands: { "work.md": COMMAND },
    plugin: { "notify.js": JS_PLUGIN },
    "mcp.json": mcpJson({ everything: SERVER, hook: SERVER }),
  } } })
  expect(ocm(home, ["add", join(home, "mp"), "--trust"]).status).toBe(0)
  const cases = [
    ["notify", /matched:\s*plugin\s+notify\.js/],
    ["everything", /matched:\s*mcp\s+everything/],
    ["hook", /matched:\s*mcp\s+hook/],
  ]
  for (const [query, annotation] of cases) {
    const result = ocm(home, ["search", query])
    if (result.status !== 0) throw new Error(`ocm search ${query} exited ${result.status}: ${result.output}`)
    if (!new RegExp(`^demo-kit@mp\\b`, "m").test(result.stdout)) {
      throw new Error(`expected a demo-kit result for "${query}":\n${result.stdout}`)
    }
    if (!annotation.test(result.stdout)) {
      throw new Error(`expected "${String(annotation)}" in ocm search ${query}:\n${result.stdout}`)
    }
  }
})
}
