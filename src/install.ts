import { join, relative } from "node:path"
import { OCM_LINKS_DIR } from "./paths"
import { enabledPlugins, materialize as coreMaterialize, removeLinksFor, setSkillsPath } from "../loader/core.js"
import type { CoreMaterializeReport } from "../loader/core.js"
import type { DiscoveredPlugin, MarketplaceEntry, MarketplacePlugin, Registry } from "./types"

export function skillsLinksDir(marketplaceName: string): string {
  return join(OCM_LINKS_DIR, marketplaceName, "skills")
}

export function materializeLinks(name: string, dir: string, entry: MarketplaceEntry): CoreMaterializeReport {
  return coreMaterialize(name, dir, { enabled: enabledPlugins(entry, dir) })
}

export function removeLinks(marketplaceName: string, marketplaceDir: string): void {
  removeLinksFor(marketplaceName, marketplaceDir)
  const warning = setSkillsPath(skillsLinksDir(marketplaceName), false)
  if (warning) console.error(`  warning: ${warning}`)
}

// plugin names are globally unique across marketplaces (spec 04, axis 4):
// the first marketplace to provide a name is the incumbent
export function incumbentMarketplace(registry: Registry, self: string, pluginName: string): string | undefined {
  for (const [name, entry] of Object.entries(registry.marketplaces)) {
    if (name !== self && entry.plugins[pluginName]) return name
  }
}

export function registerPlugins(registry: Registry, name: string, plugins: DiscoveredPlugin[]): void {
  // every caller assigns or verifies the entry in the registry right before this
  const entry = registry.marketplaces[name]!
  const updated: Record<string, MarketplacePlugin> = {}
  for (const plugin of plugins) {
    const existing = entry.plugins[plugin.name]
    const incumbent = incumbentMarketplace(registry, name, plugin.name)
    // a colliding name registers disabled; a collision that has cleared
    // registers normally again (the user never disabled it themselves)
    let enabled = existing?.collision ? true : existing?.enabled ?? true
    if (incumbent) enabled = false
    const record: MarketplacePlugin = {
      source: relative(entry.dir, plugin.dir),
      components: plugin.components,
      enabled,
      installedAt: existing?.installedAt ?? entry.addedAt,
      version: existing?.version ?? null,
      manifest: existing?.manifest ?? {},
    }
    if (incumbent) record.collision = incumbent
    updated[plugin.name] = record
  }
  entry.plugins = updated
}
