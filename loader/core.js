// Public surface of the ocm runtime core. Consumers (the startup loader, the
// TUI plugin, and src/ via core.d.ts) import this module; the implementation
// lives in the siblings it re-exports. Siblings never import core.js — shared
// constants come from paths.js, so no module's top level depends on this one.
export { writeJsonAtomic } from "./atomic.js"
export {
  CACHE_DIR,
  DEFAULT_SYNC_INTERVAL_MS,
  HOME,
  LEGACY_REGISTRY_FILE,
  LINKS_DIR,
  MARKETPLACES_DIR,
  OCM_DIR,
  OPENCODE_AGENTS_DIR,
  OPENCODE_COMMANDS_DIR,
  OPENCODE_CONFIG_FILE,
  OPENCODE_DIR,
  OPENCODE_PLUGINS_DIR,
  REGISTRY_FILE,
  STAMP_FILE,
} from "./paths.js"
export { dirClashes, discoverPlugins, mcpShapeError, readMcpServers } from "./discovery.js"
export { displacedRecords, restoreDisplaced } from "./displaced.js"
export { git, isGitRepo } from "./git.js"
export { foldedComponentGroups, foldedDirPairs, pluginLimitViolation } from "./limits.js"
export { marketplaceGateFindings, pluginGateFindings } from "./manifest-gate.js"
export { lintCrossTool } from "./lint.js"
export { tryRegistryLock, withRegistryLock } from "./lock.js"
export { loadRegistryForWrite, normalizeRegistry, parseRegistryStrict, pluginRootEnv, readRegistry, registryWriterVersion, saveRegistry, versionCompare } from "./registry.js"
export { reconcilePluginRecords } from "./reconcile.js"
export { enabledPlugins, materialize, removeLinksFor } from "./materialize.js"
export { setSkillsPath } from "./config.js"
export { pullRepo, syncAll } from "./sync.js"
export { denyComponentsEntry, denyEntry, executableComponents, grantEntry, pendingComponents, skipEntry, trustFingerprint } from "./trust.js"
export { duplicateRefusal, isGitUrl, manifestName, marketplaceNameFromUrl, normaliseMarketplaceName, parseSource } from "./source.js"
export { discoveryError, discoverMarketplace, marketplaceManifestFile, nameDisagreement, readManifest } from "./manifest.js"
export {
  addMarketplace,
  addRefusalChain,
  componentRoot,
  pinMarketplace,
  registerPlugins,
  removeMarketplace,
} from "./marketplace.js"
export { incumbentMarketplace } from "./collisions.js"
export { denyTrust, grantTrust, resolvePlugin, revokeTrust, setEnabled, skipTrust } from "./mutations.js"
export { mcpTrustLine } from "./mcp-line.js"
export { removeMcpKeys } from "./mcp.js"
export { searchPlugins } from "./search.js"
