export interface CorePluginComponents {
  agent?: string[]
  command?: string[]
  skill?: string[]
}

export interface CoreDiscoveredPlugin {
  name: string
  dir: string
  components: CorePluginComponents
}

export interface CorePullResult {
  ok: boolean
  changed: boolean
  output: string
}

export interface CoreRefreshResult {
  counts: { agents: number; commands: number; skills: number }
  created: number
  warnings: string[]
}

export interface CoreSyncResult {
  ran: boolean
  changed: boolean
  updated: string[]
  failed: string[]
  warnings?: string[]
}

export declare const HOME: string
export declare const OPENCODE_DIR: string
export declare const OPENCODE_COMMANDS_DIR: string
export declare const OPENCODE_AGENTS_DIR: string
export declare const OPENCODE_PLUGINS_DIR: string
export declare const OCM_DIR: string
export declare const CACHE_DIR: string
export declare const MARKETPLACES_DIR: string
export declare const LINKS_DIR: string
export declare const REGISTRY_FILE: string
export declare const LEGACY_REGISTRY_FILE: string
export declare const STAMP_FILE: string
export declare const DEFAULT_SYNC_INTERVAL_MS: number

export interface CoreRegistry {
  version: number
  marketplaces: Record<string, Record<string, unknown>>
}

export declare function discoverPlugins(marketplaceDir: string): CoreDiscoveredPlugin[]
export declare function isGitRepo(dir: string): boolean
export declare function pullRepo(dir: string): Promise<CorePullResult>
export declare function readRegistry(): CoreRegistry
export declare function normalizeRegistry(raw: unknown): CoreRegistry
export declare function refreshLinks(name: string, marketplaceDir: string): CoreRefreshResult
export declare function removeLinksFor(name: string, marketplaceDir: string): void
export declare function syncAll(options?: {
  minIntervalMs?: number
  force?: boolean
  reason?: string
}): Promise<CoreSyncResult>
