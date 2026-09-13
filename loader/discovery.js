import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { join } from "node:path"
import { isRecord } from "./registry.js"

// plugin names become command/agent namespaces and file-name prefixes, so
// they must be lowercase kebab
export const PLUGIN_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

// `commands` and `command` (likewise agents, skills) are both opencode-valid
// source directories, so both are discovered
function listMdFiles(pluginDir, dirs) {
  const names = new Set()
  for (const dir of dirs) {
    try {
      for (const file of readdirSync(join(pluginDir, dir))) if (file.endsWith(".md")) names.add(file)
    } catch {}
  }
  return [...names].sort()
}

function listSkillDirs(pluginDir, dirs) {
  const found = new Set()
  const seen = new Set()
  const walk = (dir, rel) => {
    let real
    try {
      real = realpathSync(dir)
    } catch {
      return
    }
    if (seen.has(real)) return
    seen.add(real)
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const child = join(dir, entry)
      let isDir = false
      try {
        isDir = statSync(child).isDirectory()
      } catch {}
      if (!isDir) continue
      const childRel = rel ? `${rel}/${entry}` : entry
      if (existsSync(join(child, "SKILL.md"))) found.add(childRel)
      walk(child, childRel)
    }
  }
  for (const dir of dirs) walk(join(pluginDir, dir), "")
  return [...found].sort()
}

// `plugin` and `plugins` are both opencode-valid source directories for
// server plugin modules (spec 06)
function listJsFiles(pluginDir, dirs) {
  const names = new Set()
  for (const dir of dirs) {
    try {
      for (const file of readdirSync(join(pluginDir, dir))) {
        if (file.endsWith(".js") || file.endsWith(".ts")) names.add(file)
      }
    } catch {}
  }
  return [...names].sort()
}

// An Agent Plugins server entry, translated to opencode's mcp shape. Only the
// fields opencode has a home for survive: it has no equivalent of `cwd`.
function toOpencodeServer(entry) {
  if (entry.type === "stdio") {
    // AP requires "command"; without it the file is malformed and the entry
    // is skipped rather than materialized as a broken server (spec 14 §9)
    if (typeof entry.command !== "string") return null
    const args = Array.isArray(entry.args) ? entry.args : []
    const server = { type: "local", command: [entry.command, ...args], enabled: true }
    if (isRecord(entry.env)) server.environment = entry.env
    return server
  }
  if (entry.type === "streamable-http" || entry.type === "sse") {
    const server = { type: "remote", url: entry.url, enabled: true }
    if (isRecord(entry.headers)) server.headers = entry.headers
    return server
  }
  return entry
}

// A plugin's mcp.json is either opencode's own shape — a bare map of server
// name to entry — or the Agent Plugins shape, `{ $schema, mcpServers }`, which
// Codex and Cursor read. Accepting both means one file per plugin serves every
// client and the two cannot drift apart.
export function readMcpServers(file) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (!isRecord(parsed.mcpServers)) return parsed
  const servers = {}
  for (const [name, entry] of Object.entries(parsed.mcpServers)) {
    if (!isRecord(entry)) continue
    const server = toOpencodeServer(entry)
    if (server !== null) servers[name] = server
  }
  return servers
}

function listMcpServers(pluginDir) {
  const servers = readMcpServers(join(pluginDir, "mcp.json"))
  return servers ? Object.keys(servers).sort() : []
}

// the mcp source file: the marketplace entry's mcpServers path when it
// declares one, else the plugin directory's own mcp.json (spec 06)
export function mcpSourceFile(dir, entry, plugin) {
  const declared = entry?.plugins?.[plugin.name]?.manifest?.mcpServers
  return typeof declared === "string" ? join(dir, declared) : join(plugin.dir, "mcp.json")
}

// a name defined in both the singular and plural form of a component
// directory is a clash add refuses rather than guess (spec 06)
export function dirClashes(pluginDir) {
  const clashes = []
  const pairs = [
    ["commands", "command", listMdFiles],
    ["agents", "agent", listMdFiles],
    ["skills", "skill", listSkillDirs],
    ["plugin", "plugins", listJsFiles],
  ]
  for (const [a, b, list] of pairs) {
    const other = list(pluginDir, [b])
    for (const name of list(pluginDir, [a])) {
      if (other.includes(name)) clashes.push(`${name} in both "${a}" and "${b}"`)
    }
  }
  return clashes
}

// does this directory hold a SKILL.md at any depth? such entries get their
// own mirror, so they must never be linked into a sibling mirror
export function containsSkillMd(dir, seen = new Set()) {
  let real
  try {
    real = realpathSync(dir)
  } catch {
    return false
  }
  if (seen.has(real)) return false
  seen.add(real)
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return false
  }
  for (const entry of entries) {
    if (entry === "SKILL.md") return true
    const child = join(dir, entry)
    let isDir = false
    try {
      isDir = statSync(child).isDirectory()
    } catch {}
    if (isDir && containsSkillMd(child, seen)) return true
  }
  return false
}

export function discoverPlugins(marketplaceDir) {
  const plugins = []
  const collect = (pluginDir) => {
    const components = {}
    const commands = listMdFiles(pluginDir, ["commands", "command"])
    if (commands.length) components.command = commands
    const agents = listMdFiles(pluginDir, ["agents", "agent"])
    if (agents.length) components.agent = agents
    const skills = listSkillDirs(pluginDir, ["skills", "skill"])
    if (skills.length) components.skill = skills
    const pluginFiles = listJsFiles(pluginDir, ["plugin", "plugins"])
    if (pluginFiles.length) components.plugin = pluginFiles
    const mcpServers = listMcpServers(pluginDir)
    if (mcpServers.length) components.mcp = mcpServers
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
