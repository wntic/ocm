import { homedir } from "node:os"
import { join } from "node:path"

export const HOME = homedir()

// opencode's own rule: XDG_CONFIG_HOME replaces $HOME/.config; empty falls back
const configHome = process.env.XDG_CONFIG_HOME || join(HOME, ".config")
export const OPENCODE_GLOBAL_DIR = join(configHome, "opencode")
export const OPENCODE_GLOBAL_CONFIG = join(OPENCODE_GLOBAL_DIR, "opencode.json")
export const OPENCODE_TUI_CONFIG = join(OPENCODE_GLOBAL_DIR, "tui.json")
export const OPENCODE_COMMANDS_DIR = join(OPENCODE_GLOBAL_DIR, "commands")
export const OPENCODE_AGENTS_DIR = join(OPENCODE_GLOBAL_DIR, "agents")
export const OPENCODE_PLUGINS_DIR = join(OPENCODE_GLOBAL_DIR, "plugins")

export const OCM_CACHE_DIR = join(HOME, ".cache", "ocm")
export const OCM_MARKETPLACES_DIR = join(OCM_CACHE_DIR, "marketplaces")
export const OCM_LINKS_DIR = join(OCM_CACHE_DIR, "links")
// spec 21: originals displaced by --force takeovers, one copy per <ts>/
export const OCM_DISPLACED_DIR = join(OCM_CACHE_DIR, "displaced")
export const OCM_DISPLACED_RECORD_FILE = join(OCM_CACHE_DIR, "displaced-records.json")
// pre-08 global sync stamp, folded into per-marketplace lastSync by the migration
export const OCM_STAMP_FILE = join(OCM_CACHE_DIR, "last-sync.json")

export const OCM_DIR = join(OPENCODE_GLOBAL_DIR, "ocm")
export const OCM_REGISTRY_FILE = join(OCM_DIR, "registry.json")
export const OCM_LEGACY_REGISTRY_FILE = join(OPENCODE_PLUGINS_DIR, "ocm-registry.json")

export const OCM_LOADER_NAME = "ocm-loader.js"
