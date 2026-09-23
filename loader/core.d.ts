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
  // brief 32 §4 (F99): the dirty paths as porcelain reports them, relative
  // to the clone root
  paths: string[]
  output: string
}

export type CoreState = "created" | "current" | "refreshed" | "removed" | "skipped" | "blocked" | "refused"

export interface CoreOutcome {
  type: "command" | "agent" | "skill" | "plugin" | "mcp"
  plugin: string
  component: string
  source: string | null
  dest: string
  state: CoreState
  reason: string | null
  // brief 31 §6: for a created outcome whose dest held a user's file, the
  // displaced cache target that file moved to
  displaced?: string
  // brief 45 §3: set when a component was withheld because its dest held a file ocm does not own — the partial-install signal
  skip?: "unowned-dest"
}

// brief 31 §2: the per-component outcome record every report is derived
// from
export interface CoreMaterializeReport {
  marketplace: string
  outcomes: CoreOutcome[]
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
  // spec 30: content digests by plugin-relative path, local marketplaces only
  hashes?: Record<string, string>
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
  // brief 40: renames refused for a cross-marketplace collision, as
  // from → to; the record stays under `from` until the collision clears
  refusedRenames?: Record<string, string>
  lastSync: { at: string; ok: boolean; error: string | null; warnings?: string[] } | null
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
  // brief 40: records migrated along resolved renames before the prune
  renamed: { from: string; to: string }[]
  removed: string[]
  // brief 40: renames refused for a cross-marketplace collision — the
  // record stays under its old name and the refusal is recorded on the
  // entry's refusedRenames
  refused: { from: string; to: string; incumbent: string; dir: string | null }[]
  // brief 40: records a refusal kept at their old name, re-added after
  // registration replaces the plugins map
  kept: Record<string, CoreMarketplacePlugin>
  // brief 31 §3: the plugins left for the caller to register after it
  // materializes — registration from outcomes is the caller's job
  registrable: CoreManifestPlugin[]
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
  // brief 33 §3 (F70): collision records that named this marketplace,
  // cleared in the same save — the plugin stays disabled
  freed: { plugin: string; marketplace: string }[]
  restore: string[]
  warnings: string[]
  // brief 31 §6: the teardown's outcomes — links and mcp keys removed
  report: CoreMaterializeReport
  wasV1: boolean
}

// brief 33 §3 (F92): a pre-existing record's collision transition across a
// registration — rendered by the update report, ignored by the loader's
// own callers
export interface CoreCollisionTransition {
  plugin: string
  incumbent: string
  state: "recorded" | "cleared"
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
  // brief 45 §2: whether the deny revoked a grant — the untrust headline is
  // derived from the record transition, recorded where it happens
  wasGranted: boolean
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

// brief 38 §2: what setSkillsPath actually did — "wrote" only when the
// config was written, so no caller can claim a fix it did not make
export interface CoreSkillsPathOutcome {
  state: "wrote" | "noop" | "skipped" | "failed"
  reason: string | null
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
export declare const DISPLACED_DIR: string
export declare const DISPLACED_RECORD_FILE: string
export declare const ROOTS_DIR: string
export declare const ROOT_CACHE_DIR: string
export declare const ROOT_SLUG: string
export declare const REGISTRY_FILE: string
export declare const LEGACY_REGISTRY_FILE: string
export declare const STAMP_FILE: string
export declare const DEFAULT_SYNC_INTERVAL_MS: number

export declare function writeJsonAtomic(path: string, content: string): void
// brief 32 §3: a node system error renders as an ocm error naming the path
// and the remedy, never an errno code
export declare function errorMessage(err: unknown): string
export declare function withRegistryLock<T>(command: string, fn: () => T | Promise<T>): Promise<T>
export declare function tryRegistryLock<T>(fn: () => T | Promise<T>): Promise<T | { skipped: true }>
export declare function discoverPlugins(marketplaceDir: string): CoreDiscoveredPlugin[]
export declare function manifestOnlyMessages(marketplaceDir: string): string[]
export declare function mcpShapeError(server: unknown): string | null
export declare function mcpTrustLine(component: CoreExecutableComponent): string
export declare function readMcpServers(file: string): Record<string, unknown> | null
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
export declare function git(args: string[], cwd?: string): Promise<{ ok: boolean; stdout: string; stderr: string; error?: Error }>
export declare function classifyGitFailure(input: {
  operation: "fetch" | "clone"
  result: { ok: boolean; stdout: string; stderr: string; error?: Error }
  url: string
  ref: string | null
  dir: string
}): { code: string; message: string }
// brief 32 §1: null when git is on PATH, else the git-missing message —
// one `git --version` per process, cached
export declare function gitProbe(): string | null
export declare function pullRepo(entry: CoreMarketplaceEntry, name: string): Promise<CorePullResult>
export declare function isRenderedFile(path: string): boolean
export declare function readRegistry(): CoreRegistry
export declare function registryWriterVersion(): string | null
export declare function versionCompare(a: string, b: string): number
export declare function pluginRootEnv(): Record<string, string>
export declare function normalizeRegistry(raw: unknown): CoreRegistry
export declare function parseRegistryStrict(): unknown
export declare function loadRegistryForWrite(): { registry: CoreRegistry; wasV1: boolean }
export declare function saveRegistry(registry: CoreRegistry): void
export declare function saveRegistryIfChanged(registry: CoreRegistry): void
export declare function materialize(
  name: string,
  dir: string,
  options?: {
    enabled?: Set<string> | null
    force?: boolean
    // internal: scope the pass to one plugin — setEnabled's --force
    // takeover tears down only the incumbent's yielded plugin
    plugin?: string
    // source paths relative to the marketplace root that changed in this
    // pass; a current outcome for one of them is reported as refreshed
    changed?: Set<string>
    // brief 31 §5: discovered name → kept name for a refused rename; the
    // whole run links under the kept name
    aliases?: Map<string, string>
  },
): CoreMaterializeReport
export declare function enabledPlugins(entry: unknown, dir: string): Set<string> | null
export declare function setSkillsPath(skillsDir: string, present: boolean): CoreSkillsPathOutcome
export declare function removeLinksFor(name: string, marketplaceDir: string): CoreMaterializeReport
export declare function executableComponents(dir: string, entry: unknown): CoreExecutableComponent[]
export declare function approvedComponents(dir: string, entry: unknown): Map<string, boolean>
export declare function componentKey(kind: string, plugin: string, name: string): string
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
export declare function registerPlugins(registry: CoreRegistry, name: string, plugins: CoreManifestPlugin[]): { collisions: CoreCollisionTransition[] }
export declare function pluginHashes(plugin: CoreManifestPlugin): Record<string, string>
// brief 30 §2: the recorded digests diffed against the current ones — the
// shared comparison behind the CLI's local report and the loader's startup
// changed-set
export declare function digestChanges(
  hashes: Record<string, string>,
  plugin: CoreManifestPlugin,
): { mark: "+" | "~" | "-"; path: string }[]
export declare function deriveComponents(registry: CoreRegistry, name: string, outcomes: CoreOutcome[]): void
export declare function reconcilePluginRecords(
  registry: CoreRegistry,
  name: string,
  root: string,
  options?: CoreReconcileOptions,
): CoreReconcileResult
export declare function readRenames(marketplaceDir: string, plugins: CoreManifestPlugin[]): Record<string, string | null>
export declare function resolveChains(renames: Record<string, string | null>): {
  resolved: Record<string, string | null>
  cycles: string[][]
}
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
export declare function removeMcpKeys(pluginNames: string[]): { outcomes: CoreOutcome[]; warning: string | null }
export declare function removeMcpKeysExact(keys: string[]): { outcomes: CoreOutcome[]; warning: string | null }
export declare function displayPath(dest: string): string
export declare function searchPlugins(query: string, options?: { enabledOnly?: boolean }): CoreSearchMatch[]
