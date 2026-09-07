import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  OCM_LINKS_DIR,
  OCM_REGISTRY_DIR,
  OCM_REGISTRY_FILE,
  OPENCODE_GLOBAL_CONFIG,
  OPENCODE_GLOBAL_DIR,
} from "./paths"
import { emptyRegistry, normalizeRegistry } from "./registry"
import { refreshLinks as coreRefreshLinks, removeLinksFor } from "../loader/ocm-core.js"
import type { CoreRefreshResult } from "../loader/ocm-core.js"
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

export function skillsLinksDir(marketplaceName: string): string {
  return join(OCM_LINKS_DIR, marketplaceName, "skills")
}

export function refreshLinks(marketplaceName: string, marketplaceDir: string): CoreRefreshResult {
  const result = coreRefreshLinks(marketplaceName, marketplaceDir)
  if (result.counts.skills > 0) addSkillsPath(skillsLinksDir(marketplaceName))
  return result
}

export function removeLinks(marketplaceName: string, marketplaceDir: string): void {
  removeLinksFor(marketplaceName, marketplaceDir)
  removeSkillsPath(skillsLinksDir(marketplaceName))
}

export function registerPlugins(_marketplaceName: string, entry: MarketplaceEntry, plugins: DiscoveredPlugin[]): void {
  entry.plugins = {}
  for (const plugin of plugins) {
    entry.plugins[plugin.name] = {
      source: plugin.source,
      components: plugin.components,
    }
  }
}
