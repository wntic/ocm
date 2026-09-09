export type ComponentType = "agent" | "command" | "skill" | "plugin" | "mcp"

export interface DiscoveredPlugin {
  name: string
  dir: string
  source: string
  components: Partial<Record<ComponentType, string[]>>
}

export interface MarketplacePlugin {
  source: string
  components: Partial<Record<ComponentType, string[]>>
  enabled: boolean
  installedAt: string | null
  version: string | null
  manifest: Record<string, unknown>
}

export interface MarketplaceEntry {
  url: string
  dir: string
  local: boolean
  addedAt: string
  mode: "auto" | "explicit"
  ref: string | null
  revision: string | null
  syncIntervalMs: number | null
  trust: { code: "none" | "granted" | "denied"; grantedAt?: string; fingerprint?: string }
  lastSync: { at: string; ok: boolean; error: string | null } | null
  plugins: Record<string, MarketplacePlugin>
}

export interface Registry {
  version: 2
  marketplaces: Record<string, MarketplaceEntry>
}
