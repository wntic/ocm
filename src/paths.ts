import { homedir } from "node:os"
import { join } from "node:path"

export const HOME = homedir()

export const OPENCODE_GLOBAL_DIR = join(HOME, ".config", "opencode")
export const OPENCODE_GLOBAL_CONFIG = join(OPENCODE_GLOBAL_DIR, "opencode.json")
export const OPENCODE_COMMANDS_DIR = join(OPENCODE_GLOBAL_DIR, "commands")
export const OPENCODE_AGENTS_DIR = join(OPENCODE_GLOBAL_DIR, "agents")
export const OPENCODE_PLUGINS_DIR = join(OPENCODE_GLOBAL_DIR, "plugins")

export const OCM_CACHE_DIR = join(HOME, ".cache", "ocm")
export const OCM_MARKETPLACES_DIR = join(OCM_CACHE_DIR, "marketplaces")
export const OCM_LINKS_DIR = join(OCM_CACHE_DIR, "links")

export const OCM_DIR = join(OPENCODE_GLOBAL_DIR, "ocm")
export const OCM_REGISTRY_FILE = join(OCM_DIR, "registry.json")
export const OCM_LEGACY_REGISTRY_FILE = join(OPENCODE_PLUGINS_DIR, "ocm-registry.json")

export const OCM_LOADER_NAME = "ocm-loader.js"
