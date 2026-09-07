import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { spawn } from "node:child_process"

export const HOME = homedir()
export const OPENCODE_DIR = join(HOME, ".config", "opencode")
export const OPENCODE_COMMANDS_DIR = join(OPENCODE_DIR, "commands")
export const OPENCODE_AGENTS_DIR = join(OPENCODE_DIR, "agents")
export const OPENCODE_PLUGINS_DIR = join(OPENCODE_DIR, "plugins")
export const CACHE_DIR = join(HOME, ".cache", "ocm")
export const MARKETPLACES_DIR = join(CACHE_DIR, "marketplaces")
export const LINKS_DIR = join(CACHE_DIR, "links")
export const REGISTRY_FILE = join(OPENCODE_PLUGINS_DIR, "ocm-registry.json")
export const STAMP_FILE = join(CACHE_DIR, "last-sync.json")

export const DEFAULT_SYNC_INTERVAL_MS = 60 * 60 * 1000

function listMdFiles(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".md")).sort()
  } catch {
    return []
  }
}

function listSkillDirs(dir) {
  try {
    return readdirSync(dir).filter((d) => existsSync(join(dir, d, "SKILL.md"))).sort()
  } catch {
    return []
  }
}

export function discoverPlugins(marketplaceDir) {
  const plugins = []
  const collect = (pluginDir) => {
    const components = {}
    const commands = listMdFiles(join(pluginDir, "commands"))
    if (commands.length) components.command = commands
    const agents = listMdFiles(join(pluginDir, "agents"))
    if (agents.length) components.agent = agents
    const skills = listSkillDirs(join(pluginDir, "skills"))
    if (skills.length) components.skill = skills
    if (!Object.keys(components).length) return
    const name = pluginDir.replace(/\/+$/, "").split("/").pop()
    plugins.push({ name: name.toLowerCase(), dir: pluginDir, components })
  }
  const pluginsDir = join(marketplaceDir, "plugins")
  if (existsSync(pluginsDir)) {
    for (const entry of readdirSync(pluginsDir).sort()) {
      const dir = join(pluginsDir, entry)
      try {
        if (statSync(dir).isDirectory()) collect(dir)
      } catch {}
    }
  }
  if (!plugins.length) collect(marketplaceDir)
  return plugins
}

export function isGitRepo(dir) {
  return existsSync(join(dir, ".git"))
}

function git(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ ok: false, stdout: "", stderr: "git timed out" })
    }, 120_000)
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", (err) => finish({ ok: false, stdout: "", stderr: String(err) }))
    child.on("close", (code) => finish({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() }))
  })
}

export async function pullRepo(dir) {
  const before = (await git(["rev-parse", "HEAD"], dir)).stdout
  const fetch = await git(["fetch", "--depth", "1", "origin"], dir)
  if (!fetch.ok) return { ok: false, changed: false, output: fetch.stderr || fetch.stdout }
  let reset = await git(["reset", "--hard", "@{u}"], dir)
  if (!reset.ok) reset = await git(["reset", "--hard", "FETCH_HEAD"], dir)
  if (!reset.ok) return { ok: false, changed: false, output: reset.stderr || reset.stdout }
  const after = (await git(["rev-parse", "HEAD"], dir)).stdout
  return { ok: true, changed: before !== after, output: after }
}

export function readRegistry() {
  try {
    const parsed = JSON.parse(readFileSync(REGISTRY_FILE, "utf8"))
    if (parsed && typeof parsed === "object" && typeof parsed.marketplaces === "object") return parsed
  } catch {}
  return { version: 1, marketplaces: {} }
}

function readTarget(path) {
  try {
    return readlinkSync(path)
  } catch {
    return undefined
  }
}

function ownedLinks(dir, root) {
  const owned = []
  if (!existsSync(dir)) return owned
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const target = readTarget(path)
    if (target && (target === root || target.startsWith(root + "/"))) owned.push({ path, target })
  }
  return owned
}

function linkFile(source, dest, warnings) {
  const existing = readTarget(dest)
  if (existing === source) return "ok"
  if (existing !== undefined) {
    if (!existsSync(dest)) {
      try {
        rmSync(dest, { force: true })
      } catch {}
    } else {
      warnings.push(`skipped ${dest}: already linked to ${existing}`)
      return "skipped"
    }
  } else if (existsSync(dest)) {
    warnings.push(`skipped ${dest}: exists and is not managed by ocm`)
    return "skipped"
  }
  try {
    symlinkSync(source, dest)
    return "created"
  } catch (err) {
    warnings.push(`failed ${dest}: ${err instanceof Error ? err.message : String(err)}`)
    return "skipped"
  }
}

function removeLegacyContainers(name) {
  rmSync(join(OPENCODE_COMMANDS_DIR, `ocm--${name}`), { recursive: true, force: true })
  rmSync(join(OPENCODE_AGENTS_DIR, `ocm--${name}`), { recursive: true, force: true })
}

export function refreshLinks(name, marketplaceDir) {
  const warnings = []
  const counts = { agents: 0, commands: 0, skills: 0 }
  let created = 0

  removeLegacyContainers(name)

  const plugins = discoverPlugins(marketplaceDir)
  const desiredCommands = new Map()
  const desiredAgents = new Map()
  const desiredSkills = new Map()
  const skillsDir = join(LINKS_DIR, name, "skills")

  for (const plugin of plugins) {
    for (const file of plugin.components.command ?? []) {
      desiredCommands.set(join(OPENCODE_COMMANDS_DIR, `${plugin.name}:${file}`), join(plugin.dir, "commands", file))
    }
    for (const file of plugin.components.agent ?? []) {
      desiredAgents.set(join(OPENCODE_AGENTS_DIR, `${plugin.name}:${file}`), join(plugin.dir, "agents", file))
    }
    if ((plugin.components.skill ?? []).length) {
      desiredSkills.set(join(skillsDir, plugin.name), join(plugin.dir, "skills"))
      counts.skills += plugin.components.skill.length
    }
  }

  for (const [dir, desired] of [
    [OPENCODE_COMMANDS_DIR, desiredCommands],
    [OPENCODE_AGENTS_DIR, desiredAgents],
    [skillsDir, desiredSkills],
  ]) {
    for (const link of ownedLinks(dir, marketplaceDir)) {
      if (!desired.has(link.path)) rmSync(link.path, { force: true })
    }
  }

  mkdirSync(OPENCODE_COMMANDS_DIR, { recursive: true })
  mkdirSync(OPENCODE_AGENTS_DIR, { recursive: true })

  for (const [dest, source] of desiredCommands) {
    if (linkFile(source, dest, warnings) === "created") created += 1
    counts.commands += 1
  }
  for (const [dest, source] of desiredAgents) {
    if (linkFile(source, dest, warnings) === "created") created += 1
    counts.agents += 1
  }
  for (const [dest, source] of desiredSkills) {
    mkdirSync(dirname(dest), { recursive: true })
    if (linkFile(source, dest, warnings) === "created") created += 1
  }

  return { counts, created, warnings }
}

export function removeLinksFor(name, marketplaceDir) {
  removeLegacyContainers(name)
  for (const link of ownedLinks(OPENCODE_COMMANDS_DIR, marketplaceDir)) rmSync(link.path, { force: true })
  for (const link of ownedLinks(OPENCODE_AGENTS_DIR, marketplaceDir)) rmSync(link.path, { force: true })
  rmSync(join(LINKS_DIR, name), { recursive: true, force: true })
}

export async function syncAll(options = {}) {
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS
  const result = { ran: false, changed: false, updated: [], failed: [] }
  const registry = readRegistry()
  const entries = Object.entries(registry.marketplaces ?? {})
  if (!entries.length) return result
  if (!options.force) {
    let lastSync = 0
    try {
      lastSync = JSON.parse(readFileSync(STAMP_FILE, "utf8")).lastSync ?? 0
    } catch {}
    if (typeof lastSync === "number" && Date.now() - lastSync < minIntervalMs) return result
  }
  result.ran = true
  for (const [name, entry] of entries) {
    if (!entry || typeof entry.dir !== "string" || !existsSync(entry.dir)) continue
    let changed = false
    if (entry.dir.startsWith(MARKETPLACES_DIR) && isGitRepo(entry.dir)) {
      const pull = await pullRepo(entry.dir)
      if (!pull.ok) {
        result.failed.push(name)
        continue
      }
      changed = pull.changed
      if (changed) result.updated.push(name)
    }
    const links = refreshLinks(name, entry.dir)
    if (links.warnings.length) result.warnings = [...(result.warnings ?? []), ...links.warnings.map((w) => `${name}: ${w}`)]
    if (changed || links.created > 0) result.changed = true
  }
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(STAMP_FILE, `${JSON.stringify({ lastSync: Date.now() })}\n`)
  } catch {}
  return result
}
