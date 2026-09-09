import { existsSync, readdirSync, realpathSync, statSync } from "node:fs"
import { join } from "node:path"

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
