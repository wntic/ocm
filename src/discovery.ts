import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { discoverPlugins } from "../loader/core.js"

export interface DiscoveredPlugin {
  name: string
  dir: string
  source: string
  components: Partial<Record<"agent" | "command" | "skill", string[]>>
}

export function discoverMarketplace(marketplaceDir: string): Map<string, DiscoveredPlugin> {
  const plugins = new Map<string, DiscoveredPlugin>()
  for (const plugin of discoverPlugins(marketplaceDir)) {
    plugins.set(plugin.name, {
      name: plugin.name,
      dir: plugin.dir,
      source: plugin.dir,
      components: plugin.components,
    })
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
