import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  OCM_LINKS_DIR,
  OCM_REGISTRY_DIR,
  OCM_REGISTRY_FILE,
  OPENCODE_GLOBAL_CONFIG,
  OPENCODE_GLOBAL_DIR,
} from "./paths"
import { emptyRegistry, normalizeRegistry } from "./registry"
import type { DiscoveredPlugin, MarketplaceEntry, Registry } from "./types"

export function loadRegistry(): Registry {
  if (!existsSync(OCM_REGISTRY_FILE)) return emptyRegistry()
  try {
    return normalizeRegistry(JSON.parse(readFileSync(OCM_REGISTRY_FILE, "utf8")))
  } catch {
    return emptyRegistry()
  }
}

export function saveRegistry(registry: Registry): void {
  mkdirSync(OCM_REGISTRY_DIR, { recursive: true })
  writeFileSync(OCM_REGISTRY_FILE, `${JSON.stringify(registry, null, 2)}\n`)
}

export function readGlobalConfig(): Record<string, unknown> {
  if (!existsSync(OPENCODE_GLOBAL_CONFIG)) return {}
  return JSON.parse(readFileSync(OPENCODE_GLOBAL_CONFIG, "utf8")) as Record<string, unknown>
}

export function writeGlobalConfig(config: Record<string, unknown>): void {
  mkdirSync(OPENCODE_GLOBAL_DIR, { recursive: true })
  writeFileSync(OPENCODE_GLOBAL_CONFIG, `${JSON.stringify(config, null, 2)}\n`)
}

function skillsPaths(config: Record<string, unknown>): string[] {
  const skills = config.skills
  if (!skills || typeof skills !== "object" || !Array.isArray((skills as { paths?: unknown }).paths)) return []
  return ((skills as { paths: unknown[] }).paths as unknown[]).filter(
    (p): p is string => typeof p === "string",
  )
}

export function addSkillsPath(path: string): void {
  const config = readGlobalConfig()
  const paths = skillsPaths(config)
  if (paths.includes(path)) return
  config.skills = { ...(config.skills as object | undefined), paths: [...paths, path] }
  writeGlobalConfig(config)
}

export function removeSkillsPath(path: string): void {
  const config = readGlobalConfig()
  const paths = skillsPaths(config).filter((p) => p !== path)
  if (!paths.length) {
    delete config.skills
  } else {
    config.skills = { ...(config.skills as object | undefined), paths }
  }
  writeGlobalConfig(config)
}

export function linksDirFor(marketplaceName: string, type: "agents" | "commands" | "skills"): string {
  return join(OCM_LINKS_DIR, marketplaceName, type)
}

export function refreshLinks(marketplaceName: string, plugins: DiscoveredPlugin[]): {
  agents: number
  commands: number
  skills: number
} {
  const counts = { agents: 0, commands: 0, skills: 0 }
  rmSync(join(OCM_LINKS_DIR, marketplaceName), { recursive: true, force: true })

  for (const type of ["agents", "commands", "skills"] as const) {
    const dir = linksDirFor(marketplaceName, type)
    mkdirSync(dir, { recursive: true })
  }

  for (const plugin of plugins) {
    for (const type of ["agents", "commands", "skills"] as const) {
      const source = join(plugin.dir, type)
      if (!existsSync(source)) continue
      symlinkSync(source, join(linksDirFor(marketplaceName, type), plugin.name))
      counts[type] += 1
    }
  }

  mkdirSync(join(OPENCODE_GLOBAL_DIR, "agents"), { recursive: true })
  mkdirSync(join(OPENCODE_GLOBAL_DIR, "commands"), { recursive: true })
  const agentsContainer = join(OPENCODE_GLOBAL_DIR, "agents", `ocm--${marketplaceName}`)
  const commandsContainer = join(OPENCODE_GLOBAL_DIR, "commands", `ocm--${marketplaceName}`)
  rmSync(agentsContainer, { recursive: true, force: true })
  rmSync(commandsContainer, { recursive: true, force: true })
  if (counts.agents > 0) symlinkSync(linksDirFor(marketplaceName, "agents"), agentsContainer)
  if (counts.commands > 0) symlinkSync(linksDirFor(marketplaceName, "commands"), commandsContainer)

  addSkillsPath(linksDirFor(marketplaceName, "skills"))

  return counts
}

export function removeLinks(marketplaceName: string): void {
  rmSync(join(OPENCODE_GLOBAL_DIR, "agents", `ocm--${marketplaceName}`), { recursive: true, force: true })
  rmSync(join(OPENCODE_GLOBAL_DIR, "commands", `ocm--${marketplaceName}`), { recursive: true, force: true })
  rmSync(join(OCM_LINKS_DIR, marketplaceName), { recursive: true, force: true })
  removeSkillsPath(linksDirFor(marketplaceName, "skills"))
}

export function registerPlugins(marketplaceName: string, entry: MarketplaceEntry, plugins: DiscoveredPlugin[]): void {
  entry.plugins = {}
  for (const plugin of plugins) {
    entry.plugins[plugin.name] = {
      source: plugin.source,
      components: plugin.components,
    }
  }
}
