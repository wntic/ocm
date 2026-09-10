import { homedir } from "node:os"
import { join } from "node:path"

export const HOME = homedir()
export const OPENCODE_DIR = join(HOME, ".config", "opencode")
export const OPENCODE_CONFIG_FILE = join(OPENCODE_DIR, "opencode.json")
export const OPENCODE_COMMANDS_DIR = join(OPENCODE_DIR, "commands")
export const OPENCODE_AGENTS_DIR = join(OPENCODE_DIR, "agents")
export const OPENCODE_PLUGINS_DIR = join(OPENCODE_DIR, "plugins")
export const OCM_DIR = join(OPENCODE_DIR, "ocm")
export const CACHE_DIR = join(HOME, ".cache", "ocm")
export const MARKETPLACES_DIR = join(CACHE_DIR, "marketplaces")
export const LINKS_DIR = join(CACHE_DIR, "links")
export const DISPLACED_DIR = join(CACHE_DIR, "displaced")
export const REGISTRY_FILE = join(OCM_DIR, "registry.json")
// pre-01 layout; read as a fallback for one release
export const LEGACY_REGISTRY_FILE = join(OPENCODE_PLUGINS_DIR, "ocm-registry.json")
export const STAMP_FILE = join(CACHE_DIR, "last-sync.json")

export const DEFAULT_SYNC_INTERVAL_MS = 60 * 60 * 1000
