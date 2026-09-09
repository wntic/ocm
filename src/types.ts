export type ComponentType = "agent" | "command" | "skill" | "plugin" | "mcp"

// the merged manifest cached in the registry: marketplace entry >
// plugin.json > filesystem inference (spec 06)
export type PluginManifest = {
  description?: string
  category?: string
  tags?: string[]
  version?: string
  defaultEnabled?: boolean
  mcpServers?: string
}

export interface DiscoveredPlugin {
  name: string
  dir: string
  source: string
  components: Partial<Record<ComponentType, string[]>>
  manifest: PluginManifest
}

export interface MarketplacePlugin {
  source: string
  components: Partial<Record<ComponentType, string[]>>
  enabled: boolean
  // names the marketplace that already provides this plugin name; set only
  // while the collision exists, and the plugin stays disabled until it clears
  collision?: string
  installedAt: string | null
  version: string | null
  manifest: PluginManifest
}

export interface MarketplaceEntry {
  url: string
  dir: string
  local: boolean
  addedAt: string
  mode: "auto" | "explicit"
  ref: string | null
  // set when the source was a github tree url: discovery roots here while
  // git operations run against the clone root
  subdir?: string | null
  revision: string | null
  syncIntervalMs: number | null
  trust: {
    code: "none" | "granted" | "denied"
    grantedAt?: string
    fingerprint?: string
    // per-component hashes recorded at grant time; absent on grants written
    // before spec 07, which approve everything (spec 07)
    components?: Record<string, string>
  }
  // set by the loader when executable components changed since the grant;
  // cleared by the next trust decision (spec 07)
  trustPending?: boolean
  lastSync: { at: string; ok: boolean; error: string | null } | null
  plugins: Record<string, MarketplacePlugin>
}

export interface Registry {
  version: 2
  marketplaces: Record<string, MarketplaceEntry>
}
