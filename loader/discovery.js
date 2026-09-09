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

// mcp.json holds opencode's mcp entry shape; the server names are its keys
function listMcpServers(pluginDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(pluginDir, "mcp.json"), "utf8"))
    if (isRecord(parsed)) return Object.keys(parsed).sort()
  } catch {}
  return []
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
