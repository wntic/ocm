import type { ComponentType, MarketplaceEntry, Registry } from "./types"

export function emptyRegistry(): Registry {
  return { version: 1, marketplaces: {} }
}

export function normalizeRegistry(raw: unknown): Registry {
  if (
    raw &&
    typeof raw === "object" &&
    (raw as Registry).version === 1 &&
    typeof (raw as Registry).marketplaces === "object"
  ) {
    return raw as Registry
  }
  return emptyRegistry()
}

export function entryFor(registry: Registry, name: string): MarketplaceEntry | undefined {
  return registry.marketplaces[name]
}

export function findPluginOwner(registry: Registry, pluginName: string): string | undefined {
  for (const [marketplaceName, entry] of Object.entries(registry.marketplaces)) {
    if (Object.keys(entry.plugins).includes(pluginName)) return marketplaceName
  }
  return undefined
}

export function componentDir(type: ComponentType): string {
  return type === "skill" ? "skills" : `${type}s`
}
