import { readdirSync, statSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ComponentType } from "./types"
import { componentDir } from "./registry"

export interface DiscoveredPlugin {
  name: string
  dir: string
  source: string
  components: Partial<Record<ComponentType, string[]>>
}

function listMdFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
}

function listSkillDirs(dir: string): string[] {
  return readdirSync(dir)
    .filter((d) => {
      const p = join(dir, d)
      return statSync(p).isDirectory() && existsSync(join(p, "SKILL.md"))
    })
    .sort()
}

export function discoverPlugin(pluginDir: string): DiscoveredPlugin | null {
  const components: Partial<Record<ComponentType, string[]>> = {}
  for (const type of ["agent", "command", "skill"] as ComponentType[]) {
    const dir = join(pluginDir, componentDir(type))
    if (!existsSync(dir)) continue
    if (type === "skill") {
      const skills = listSkillDirs(dir)
      if (skills.length) components.skill = skills
    } else {
      const files = listMdFiles(dir)
      if (files.length) components[type] = files
    }
  }
  if (!Object.keys(components).length) return null
  return {
    name: pluginDir.split("/").filter(Boolean).pop()!.toLowerCase(),
    dir: pluginDir,
    source: pluginDir,
    components,
  }
}

export function discoverMarketplace(marketplaceDir: string): Map<string, DiscoveredPlugin> {
  const plugins = new Map<string, DiscoveredPlugin>()

  const pluginsDir = join(marketplaceDir, "plugins")
  if (existsSync(pluginsDir)) {
    for (const entry of readdirSync(pluginsDir).sort()) {
      const pluginDir = join(pluginsDir, entry)
      if (!statSync(pluginDir).isDirectory()) continue
      const plugin = discoverPlugin(pluginDir)
      if (plugin) plugins.set(plugin.name, plugin)
    }
  }

  if (!plugins.size) {
    const plugin = discoverPlugin(marketplaceDir)
    if (plugin) plugins.set(plugin.name, plugin)
  }

  return plugins
}

interface MarketplaceManifest {
  name?: unknown
  description?: unknown
}

export function readManifest(marketplaceDir: string): { name?: string; description?: string } {
  const file = join(marketplaceDir, "marketplace.json")
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as MarketplaceManifest
    return {
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      description: typeof parsed.description === "string" ? parsed.description : undefined,
    }
  } catch {
    return {}
  }
}
