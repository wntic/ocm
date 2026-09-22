import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { join } from "node:path"
import { pluginGateFindings } from "./manifest-gate.js"
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
    } catch {
      // a missing or unreadable dir lists nothing
    }
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
      // an unreachable dir is not walked
      return
    }
    if (seen.has(real)) return
    seen.add(real)
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      // an unreadable dir is not walked
      return
    }
    for (const entry of entries) {
      const child = join(dir, entry)
      let isDir = false
      try {
        isDir = statSync(child).isDirectory()
      } catch {
        // an unstattable entry is not a directory
      }
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
    } catch {
      // a missing or unreadable dir lists nothing
    }
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
    // an unreadable or unparseable file reads as no servers — callers warn
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

// brief 34 §1.1: the shape every ocm-written mcp entry must have — opencode
// refuses to start over anything else. Operates on a post-readMcpServers
// object (translated for Agent Plugins files, verbatim for native ones) so
// every consumer agrees. Returns null when the entry is writable, else the
// reason; an absent "enabled" is not an error — it is normalised at the
// write (§1.2), never here, because this reader's output is what the trust
// fingerprint hashes.
export function mcpShapeError(server) {
  if (!isRecord(server)) return "not a JSON object"
  if (server.type === undefined) return 'is missing "type" (expected "local" or "remote")'
  if (server.type !== "local" && server.type !== "remote") {
    return `has "type" ${JSON.stringify(server.type)} (expected "local" or "remote")`
  }
  if (server.type === "local") {
    const command = server.command
    if (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== "string")) {
      return '"command" must be an array of strings, e.g. ["node", "server.js"]'
    }
    return null
  }
  if (typeof server.url !== "string" || !server.url) return '"url" must be a string'
  return null
}

function listMcpServers(pluginDir) {
  const servers = readMcpServers(join(pluginDir, "mcp.json"))
  // $schema is metadata, not a server. A native-shape file carrying one used
  // to surface it as a component everywhere — listed by ocm list, offered for
  // approval in the trust prompt, and written into opencode.json, which
  // refused to start. syncMcp and lintMcpJson already skip it; these are the
  // remaining two readers that must agree (brief 34 §1.1).
  return servers ? Object.keys(servers).filter((name) => name !== "$schema").sort() : []
}

// the mcp source file: the marketplace entry's mcpServers path when it
// declares one, else the plugin directory's own mcp.json (spec 06). The
// declared path is plugin-relative; the marketplace root is a deprecated
// fallback discovery has already warned about (spec 15 §3)
export function mcpSourceFile(dir, entry, plugin) {
  const declared = entry?.plugins?.[plugin.name]?.manifest?.mcpServers
  if (typeof declared !== "string") return join(plugin.dir, "mcp.json")
  const pluginFile = join(plugin.dir, declared.slice(2))
  return existsSync(pluginFile) ? pluginFile : join(dir, declared.slice(2))
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
    // an unreachable dir holds no SKILL.md
    return false
  }
  if (seen.has(real)) return false
  seen.add(real)
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    // an unreadable dir holds no SKILL.md
    return false
  }
  for (const entry of entries) {
    if (entry === "SKILL.md") return true
    const child = join(dir, entry)
    let isDir = false
    try {
      isDir = statSync(child).isDirectory()
    } catch {
      // an unstattable entry is not a directory
    }
    if (isDir && containsSkillMd(child, seen)) return true
  }
  return false
}

function componentsOf(pluginDir) {
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
  return components
}

export function discoverPlugins(marketplaceDir) {
  const plugins = []
  const collect = (pluginDir) => {
    const components = componentsOf(pluginDir)
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
      } catch {
        // an unstattable entry is not a plugin directory
      }
    }
  }
  if (!plugins.length) collect(marketplaceDir)
  return plugins
}

// brief 39 §4: discovery reaches a plugin only through a component file, so
// a directory whose only content is a plugin.json is invisible to it. This
// is diagnostic only — nothing installs, so each message says users are
// unaffected; the manifest wording is the gate's verbatim (brief 29).
export function manifestOnlyMessages(marketplaceDir) {
  const messages = []
  const pluginsDir = join(marketplaceDir, "plugins")
  if (!existsSync(pluginsDir)) return messages
  for (const entry of readdirSync(pluginsDir).sort()) {
    const dir = join(pluginsDir, entry)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      // an unstattable entry is not a plugin directory
      continue
    }
    if (!existsSync(join(dir, "plugin.json"))) continue
    if (Object.keys(componentsOf(dir)).length) continue
    const findings = pluginGateFindings(marketplaceDir, { name: entry.toLowerCase(), dir, components: {} })
    messages.push(
      findings.length
        ? `${findings.map((finding) => finding.message).join("\n")}\n  plugins/${entry} has no components — nothing installs, so users are unaffected`
        : `plugins/${entry}: has a plugin.json but no components — either the manifest is wrong or the components are missing\n  nothing installs, so users are unaffected`,
    )
  }
  return messages
}
