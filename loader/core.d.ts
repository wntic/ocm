export interface CorePluginComponents {
  agent?: string[]
  command?: string[]
  skill?: string[]
  plugin?: string[]
  mcp?: string[]
}

export interface CoreDiscoveredPlugin {
  name: string
  dir: string
  components: CorePluginComponents
}

export interface CoreGateFinding {
  plugin: string
  path: string
  code: string
  message: string
}

export interface CorePullResult {
  ok: boolean
  changed: boolean
  before: string
  after: string
  dirty: boolean
  localChanges: number
  untracked: number
  output: string
}

export interface CoreMaterializeReport {
  counts: { command: number; agent: number; skill: number; plugin: number; mcp: number }
  created: number
  removed: number
  skipped: number
  warnings: string[]
}

export interface CoreSyncResult {
  ran: boolean
  changed: boolean
  updated: string[]
  unchanged: string[]
  failed: string[]
  errors: Record<string, string>
  warnings?: string[]
  skipped?: boolean
}

export interface CoreExecutableComponent {
  rel: string
  hash: string
  kind: "plugin" | "mcp"
  plugin: string
  name: string
  value?: unknown
}

// the merged manifest cached in the registry (spec 06); a structural mirror
// of PluginManifest in src/types.ts so src types and core types assign
// without casts
export interface CorePluginManifest {
  description?: string
  category?: string
  tags?: string[]
  keywords?: string[]
  version?: string
  homepage?: string
  license?: string
  defaultEnabled?: boolean
  mcpServers?: string
  conflicts?: string[]
}

export interface CoreManifestPlugin {
  name: string
  dir: string
  source: string
  components: Partial<Record<"agent" | "command" | "skill" | "plugin" | "mcp", string[]>>
  manifest: CorePluginManifest
}

export interface CoreDiscoveredMarketplace {
  plugins: Map<string, CoreManifestPlugin>
  warnings: string[]
}

export interface CoreMarketplacePlugin {
  source: string
  components: Partial<Record<"agent" | "command" | "skill" | "plugin" | "mcp", string[]>>
  enabled: boolean
  collision?: string
  installedAt: string | null
  version: string | null
  manifest: CorePluginManifest
}

export interface CoreMarketplaceEntry {
  url: string
  dir: string
  local: boolean
  addedAt: string
  mode: "auto" | "explicit"
  ref: string | null
  subdir?: string | null
  revision: string | null
  syncIntervalMs: number | null
  trust: {
    code: "none" | "granted" | "denied"
    grantedAt?: string
    fingerprint?: string
    components?: Record<string, string>
  }
  trustPending?: boolean
  lastSync: { at: string; ok: boolean; error: string | null } | null
  plugins: Record<string, CoreMarketplacePlugin>
}

export interface CoreRegistry {
  version: 2
  ocmVersion?: string
  marketplaces: Record<string, CoreMarketplaceEntry>
}

export interface CoreParsedSource {
  url: string
  name: string
  subdir: string | null
  isGit: boolean
  ref: string | null
}

export interface CoreReconcileOptions {
  // the discovered plugins to register; discovered fresh when omitted
  discovered?: CoreManifestPlugin[]
  // rename targets refused for a cross-marketplace collision
  excluded?: Set<string>
  // a plugin-scoped pass registers no newly shipped plugin
  plugin?: string
  // resolved renames: a pruned name that is a rename source survives
  resolved?: Record<string, string | null>
  // plugins whose files changed in this pull; a changed manifest-less
  // install loses its grandfather
  changed?: Set<string>
}

export interface CoreReconcileResult {
  warnings: string[]
  pruned: string[]
  // installed plugins the manifest gate dropped: uninstalled, one report
  // line each (brief 29 §3)
  dropped: { name: string; reason: string }[]
}

export interface CoreAddOptions {
  explicit?: boolean
  name?: string
  ref?: string
  trust?: boolean
}

export interface CoreAddResult {
  name: string
  url: string
  dir: string
  root: string
  mode: "auto" | "explicit"
  plugins: { name: string; components: CorePluginComponents }[]
  warnings: string[]
  report: CoreMaterializeReport
  trustComponents: CoreExecutableComponent[]
  wasV1: boolean
}

export interface CoreDisplacementRecord {
  marketplace: string
  plugin: string
  dest: string
  dir: string
}

export interface CoreRemoveResult {
  name: string
  owned: { name: string; components: CorePluginComponents }[]
  restore: string[]
  warnings: string[]
  wasV1: boolean
}

export interface CoreSetEnabledResult {
  marketplace: string
  plugin: string
  components: CorePluginComponents
  disagreement: string | null
  already: boolean
  takeover: string | null
  wasV1: boolean
  restore: string[]
  report: CoreMaterializeReport
}

export interface CoreGrantResult {
  granted: boolean
  report: CoreMaterializeReport | null
  wasV1: boolean
}

export interface CoreDenyResult {
  report: CoreMaterializeReport
  wasV1: boolean
}

export interface CorePinResult {
  name: string
  ref: string | null
  cleared: boolean
  wasV1: boolean
}

export interface CoreSearchMatch {
  marketplace: string
  plugin: string
  entry: CoreMarketplaceEntry
  record: CoreMarketplacePlugin
  rank: number
  matched: string[]
}

export interface CoreResolvedPlugin {
  marketplace: string
  plugin: string
  entry: CoreMarketplaceEntry
}

export declare const HOME: string
export declare const OPENCODE_DIR: string
export declare const OPENCODE_CONFIG_FILE: string
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

export declare function writeJsonAtomic(path: string, content: string): void
export declare function withRegistryLock<T>(command: string, fn: () => T | Promise<T>): Promise<T>
export declare function tryRegistryLock<T>(fn: () => T | Promise<T>): Promise<T | { skipped: true }>
export declare function discoverPlugins(marketplaceDir: string): CoreDiscoveredPlugin[]
export declare function pluginGateFindings(marketplaceDir: string, plugin: CoreDiscoveredPlugin): CoreGateFinding[]
export declare function marketplaceGateFindings(marketplaceDir: string, plugins: CoreDiscoveredPlugin[]): CoreGateFinding[]
export declare function dirClashes(pluginDir: string): string[]
export declare function displacedRecords(): CoreDisplacementRecord[]
export declare function restoreDisplaced(scope: { marketplace?: string; plugin?: string }): { lines: string[]; resolved: CoreDisplacementRecord[] | null }
export declare function pluginLimitViolation(plugin: CoreManifestPlugin): string | null
export declare function foldedDirPairs(names: string[]): string[][]
export declare function foldedComponentGroups(
  components: CorePluginComponents,
): { type: "command" | "agent" | "skill" | "plugin"; names: string[] }[]
export declare function lintCrossTool(marketplaceDir: string): string[]
export declare function isGitRepo(dir: string): boolean
export declare function git(args: string[], cwd?: string): Promise<{ ok: boolean; stdout: string; stderr: string }>
export declare function pullRepo(entry: CoreMarketplaceEntry, name: string): Promise<CorePullResult>
export declare function readRegistry(): CoreRegistry
export declare function registryWriterVersion(): string | null
export declare function versionCompare(a: string, b: string): number
export declare function pluginRootEnv(): Record<string, string>
export declare function normalizeRegistry(raw: unknown): CoreRegistry
export declare function parseRegistryStrict(): unknown
export declare function loadRegistryForWrite(): { registry: CoreRegistry; wasV1: boolean }
export declare function saveRegistry(registry: CoreRegistry): void
export declare function materialize(
  name: string,
  dir: string,
  options?: { enabled?: Set<string> | null; force?: boolean; plugin?: string },
): CoreMaterializeReport
export declare function enabledPlugins(entry: unknown, dir: string): Set<string> | null
export declare function setSkillsPath(skillsDir: string, present: boolean): string | null
export declare function removeLinksFor(name: string, marketplaceDir: string): void
export declare function executableComponents(dir: string, entry: unknown): CoreExecutableComponent[]
export declare function trustFingerprint(components: CoreExecutableComponent[]): string
export declare function grantEntry(entry: CoreMarketplaceEntry, components: CoreExecutableComponent[]): void
export declare function denyEntry(entry: CoreMarketplaceEntry): void
export declare function pendingComponents(entry: CoreMarketplaceEntry, components: CoreExecutableComponent[]): CoreExecutableComponent[]
export declare function skipEntry(entry: CoreMarketplaceEntry, components: CoreExecutableComponent[]): void
export declare function denyComponentsEntry(entry: CoreMarketplaceEntry, pending: CoreExecutableComponent[]): void
export declare function syncAll(options?: {
  force?: boolean
  reason?: string
}): Promise<CoreSyncResult>
export declare function isGitUrl(source: string): boolean
export declare function manifestName(name: string | undefined): string | undefined
export declare function normaliseMarketplaceName(name: string): string
export declare function marketplaceNameFromUrl(url: string): string
export declare function parseSource(source: string): CoreParsedSource
export declare function duplicateRefusal(registry: CoreRegistry, parsed: CoreParsedSource, wanted: string): string | null
export declare function discoverMarketplace(marketplaceDir: string): CoreDiscoveredMarketplace
export declare function discoveryError(plugins: CoreManifestPlugin[]): string | null
export declare function nameDisagreement(pluginDir: string, pluginName: string): string | null
export declare function readManifest(marketplaceDir: string): { name?: string; description?: string }
export declare function marketplaceManifestFile(marketplaceDir: string): string
export declare function componentRoot(entry: CoreMarketplaceEntry): string
export declare function incumbentMarketplace(registry: CoreRegistry, self: string, pluginName: string): string | undefined
export declare function registerPlugins(registry: CoreRegistry, name: string, plugins: CoreManifestPlugin[]): void
export declare function reconcilePluginRecords(
  registry: CoreRegistry,
  name: string,
  root: string,
  options?: CoreReconcileOptions,
): CoreReconcileResult
export declare function addMarketplace(source: string, options?: CoreAddOptions): Promise<CoreAddResult>
export declare function addRefusalChain(
  name: string,
  parsed: CoreParsedSource,
  dir: string,
  head: string,
  plugins: CoreManifestPlugin[],
  registry: CoreRegistry,
): Promise<string | null>
export declare function removeMarketplace(name: string): CoreRemoveResult
export declare function pinMarketplace(name: string, ref?: string | null): Promise<CorePinResult>
export declare function resolvePlugin(registry: CoreRegistry, arg: string): CoreResolvedPlugin
export declare function setEnabled(arg: string, enabled: boolean, options?: { force?: boolean }): CoreSetEnabledResult
export declare function grantTrust(name: string): CoreGrantResult
export declare function skipTrust(name: string): void
export declare function denyTrust(name: string): CoreDenyResult
export declare function revokeTrust(name: string): CoreDenyResult
export declare function removeMcpKeys(pluginNames: string[]): string | null
export declare function searchPlugins(query: string, options?: { enabledOnly?: boolean }): CoreSearchMatch[]
