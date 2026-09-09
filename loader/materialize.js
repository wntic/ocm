import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, rmdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { setSkillsPath } from "./config.js"
import { discoverPlugins } from "./discovery.js"
import { gcTargets, isRenderedFile, link, mirror } from "./links.js"
import { LINKS_DIR, OPENCODE_AGENTS_DIR, OPENCODE_COMMANDS_DIR } from "./paths.js"
import { readRegistry } from "./registry.js"

const PLUGIN_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

function managedDirs(dir, registry) {
  const dirs = [dir]
  for (const entry of Object.values(registry.marketplaces ?? {})) {
    if (entry && typeof entry.dir === "string" && entry.dir && entry.dir !== dir) dirs.push(entry.dir)
  }
  return dirs.sort((a, b) => b.length - a.length)
}

function gitRevision(dir) {
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, timeout: 5000, encoding: "utf8" })
    if (result.status === 0) return result.stdout.trim()
  } catch {}
  return "unknown"
}

// `commands` and `command` are both opencode-valid; a name resolvable in
// both is a clash we refuse rather than guess
function resolveSource(pluginDir, dirs, name, ctx, plugin) {
  const found = dirs.map((d) => join(pluginDir, d, name)).filter((p) => existsSync(p))
  if (found.length > 1) {
    ctx.warnings.push(`skipped ${plugin}:${name}: found in both ${dirs[0]} and ${dirs[1]}`)
    return undefined
  }
  return found[0]
}

// the single transform: `name: <value>` becomes `name: "<plugin>:<value>"`;
// everything else in the file is preserved byte-for-byte
function renderSkillMd(content, plugin) {
  if (!content.startsWith("---\n")) return null
  const close = content.indexOf("\n---\n", 3)
  if (close === -1) return null
  const frontmatter = content.slice(4, close)
  const match = frontmatter.match(/^name:[^\n]*/m)
  if (!match) return null
  const value = match[0].slice(5).trim().replace(/^["']|["']$/g, "")
  if (!value) return null
  const renamed = `name: "${plugin}:${value}"`
  const updated = frontmatter.slice(0, match.index) + renamed + frontmatter.slice(match.index + match[0].length)
  return content.slice(0, 4) + updated + content.slice(close)
}

function removeLegacyContainers(name) {
  rmSync(join(OPENCODE_COMMANDS_DIR, `ocm--${name}`), { recursive: true, force: true })
  rmSync(join(OPENCODE_AGENTS_DIR, `ocm--${name}`), { recursive: true, force: true })
}

export function materialize(name, dir, options = {}) {
  const warnings = []
  const counts = { command: 0, agent: 0, skill: 0, plugin: 0, mcp: 0 }
  let created = 0
  let removed = 0
  let skipped = 0

  removeLegacyContainers(name)

  if (!existsSync(dir)) {
    warnings.push(`marketplace "${name}" directory missing (${dir}), links left untouched`)
    return { counts, created, removed, skipped, warnings }
  }

  const registry = readRegistry()
  const entry = (registry.marketplaces ?? {})[name]
  const revision = (entry && typeof entry.revision === "string" && entry.revision) || gitRevision(dir)
  const ctx = { name, dir, managed: managedDirs(dir, registry), revision, warnings }
  const enabled = options.enabled ?? null
  const skillsDir = join(LINKS_DIR, name, "skills")
  const desiredCommands = new Set()
  const desiredAgents = new Set()
  const desiredMirrors = new Set()

  mkdirSync(OPENCODE_COMMANDS_DIR, { recursive: true })
  mkdirSync(OPENCODE_AGENTS_DIR, { recursive: true })

  for (const plugin of discoverPlugins(dir)) {
    if (enabled !== null && !enabled.has(plugin.name)) continue
    if (!PLUGIN_NAME_RE.test(plugin.name)) {
      warnings.push(`skipped plugin "${plugin.name}": name must match ${PLUGIN_NAME_RE}`)
      continue
    }
    for (const file of plugin.components.command ?? []) {
      const source = resolveSource(plugin.dir, ["commands", "command"], file, ctx, plugin.name)
      if (!source) continue
      counts.command += 1
      const dest = `${plugin.name}:${file}`
      desiredCommands.add(dest)
      const status = link(source, join(OPENCODE_COMMANDS_DIR, dest), ctx, plugin.name, file)
      if (status === "created") created += 1
      else if (status !== "ok") skipped += 1
    }
    for (const file of plugin.components.agent ?? []) {
      const source = resolveSource(plugin.dir, ["agents", "agent"], file, ctx, plugin.name)
      if (!source) continue
      counts.agent += 1
      const dest = `${plugin.name}:${file}`
      desiredAgents.add(dest)
      const status = link(source, join(OPENCODE_AGENTS_DIR, dest), ctx, plugin.name, file)
      if (status === "created") created += 1
      else if (status !== "ok") skipped += 1
    }
    for (const rel of plugin.components.skill ?? []) {
      const sourceDir = resolveSource(plugin.dir, ["skills", "skill"], rel, ctx, plugin.name)
      if (!sourceDir) continue
      const skillMd = join(sourceDir, "SKILL.md")
      let transformed = null
      try {
        transformed = renderSkillMd(readFileSync(skillMd, "utf8"), plugin.name)
      } catch {}
      if (transformed === null) {
        warnings.push(`skipped ${skillMd}: no name in frontmatter`)
        continue
      }
      counts.skill += 1
      const mirrorName = `${plugin.name}--${rel.split("/").join("-")}`
      desiredMirrors.add(mirrorName)
      removed += mirror(sourceDir, join(skillsDir, mirrorName), { "SKILL.md": () => transformed }, ctx, plugin.name, rel)
    }
  }

  removed += gcTargets(OPENCODE_COMMANDS_DIR, desiredCommands, ctx)
  removed += gcTargets(OPENCODE_AGENTS_DIR, desiredAgents, ctx)
  removed += gcTargets(skillsDir, desiredMirrors, ctx, (path) => isRenderedFile(join(path, "SKILL.md")))

  const warning = setSkillsPath(skillsDir, counts.skill > 0)
  if (warning) warnings.push(warning)

  return { counts, created, removed, skipped, warnings }
}

// the enabled set a caller drives materialize with: registry plugins that
// are not disabled, plus discovered-but-unregistered ones in auto mode
export function enabledPlugins(entry, dir) {
  if (!entry || typeof entry.dir !== "string" || !entry.dir) return null
  const registered = entry.plugins ?? {}
  const enabled = new Set()
  for (const [name, plugin] of Object.entries(registered)) {
    if (plugin && plugin.enabled !== false) enabled.add(name)
  }
  if (entry.mode !== "explicit") {
    for (const plugin of discoverPlugins(dir)) {
      if (!(plugin.name in registered)) enabled.add(plugin.name)
    }
  }
  return enabled
}

export function removeLinksFor(name, marketplaceDir) {
  removeLegacyContainers(name)
  const ctx = { name, dir: marketplaceDir, managed: [], revision: null, warnings: [] }
  gcTargets(OPENCODE_COMMANDS_DIR, new Set(), ctx)
  gcTargets(OPENCODE_AGENTS_DIR, new Set(), ctx)
  const skillsDir = join(LINKS_DIR, name, "skills")
  gcTargets(skillsDir, new Set(), ctx, (path) => isRenderedFile(join(path, "SKILL.md")))
  // prune the cache dirs only when nothing unowned is left in them
  try {
    rmdirSync(skillsDir)
    rmdirSync(dirname(skillsDir))
  } catch {}
}
