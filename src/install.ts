import { join, relative } from "node:path"
import { OCM_LINKS_DIR } from "./paths"
import { enabledPlugins, materialize as coreMaterialize, removeLinksFor, setSkillsPath } from "../loader/core.js"
import type { CoreMaterializeReport } from "../loader/core.js"
import type { DiscoveredPlugin, MarketplaceEntry, MarketplacePlugin } from "./types"

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

export function registerPlugins(entry: MarketplaceEntry, plugins: DiscoveredPlugin[]): void {
  const updated: Record<string, MarketplacePlugin> = {}
  for (const plugin of plugins) {
    const existing = entry.plugins[plugin.name]
    updated[plugin.name] = {
      source: relative(entry.dir, plugin.dir),
      components: plugin.components,
      enabled: existing?.enabled ?? true,
      installedAt: existing?.installedAt ?? entry.addedAt,
      version: existing?.version ?? null,
      manifest: existing?.manifest ?? {},
    }
  }
  entry.plugins = updated
}
