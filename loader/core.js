// Public surface of the ocm runtime core. Consumers (the startup loader, the
// TUI plugin, and src/ via core.d.ts) import this module; the implementation
// lives in the siblings it re-exports. Siblings never import core.js — shared
// constants come from paths.js, so no module's top level depends on this one.
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
export { dirClashes, discoverPlugins } from "./discovery.js"
export { loadRegistryForWrite, normalizeRegistry, readRegistry, saveRegistry } from "./registry.js"
export { enabledPlugins, materialize, removeLinksFor } from "./materialize.js"
export { setSkillsPath } from "./config.js"
export { git, isGitRepo, pullRepo, syncAll } from "./sync.js"
export { denyEntry, executableComponents, grantEntry, trustFingerprint } from "./trust.js"
export { isGitUrl, manifestName, marketplaceNameFromUrl, normaliseMarketplaceName, parseSource } from "./source.js"
export { discoveryError, discoverMarketplace, nameDisagreement, readManifest } from "./manifest.js"
export {
  addMarketplace,
  componentRoot,
  incumbentMarketplace,
  pinMarketplace,
  registerPlugins,
  removeMarketplace,
} from "./marketplace.js"
export { denyTrust, grantTrust, resolvePlugin, revokeTrust, setEnabled } from "./mutations.js"
export { removeMcpKeys } from "./mcp.js"
export { searchPlugins } from "./search.js"
