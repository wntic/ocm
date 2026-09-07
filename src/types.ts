export type ComponentType = "agent" | "command" | "skill"

export interface DiscoveredPlugin {
  name: string
  dir: string
  source: string
  components: Partial<Record<ComponentType, string[]>>
}

export interface MarketplacePlugin {
  source: string
  components: Partial<Record<ComponentType, string[]>>
}

export interface MarketplaceEntry {
  url: string
  path: string
  dir: string
  addedAt: string
  plugins: Record<string, MarketplacePlugin>
}

export interface Registry {
  version: 1
  marketplaces: Record<string, MarketplaceEntry>
}
