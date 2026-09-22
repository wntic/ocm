import { homedir } from "node:os"
import { join } from "node:path"
import {
  CACHE_DIR,
  DISPLACED_DIR,
  DISPLACED_RECORD_FILE,
  LINKS_DIR,
  MARKETPLACES_DIR,
  ROOT_CACHE_DIR,
  ROOT_SLUG,
  STAMP_FILE,
} from "../loader/core.js"

export const HOME = homedir()

// opencode's own rule: XDG_CONFIG_HOME replaces $HOME/.config; empty falls back
const configHome = process.env.XDG_CONFIG_HOME || join(HOME, ".config")
export const OPENCODE_GLOBAL_DIR = join(configHome, "opencode")
export const OPENCODE_GLOBAL_CONFIG = join(OPENCODE_GLOBAL_DIR, "opencode.json")
export const OPENCODE_TUI_CONFIG = join(OPENCODE_GLOBAL_DIR, "tui.json")
export const OPENCODE_COMMANDS_DIR = join(OPENCODE_GLOBAL_DIR, "commands")
export const OPENCODE_AGENTS_DIR = join(OPENCODE_GLOBAL_DIR, "agents")
export const OPENCODE_PLUGINS_DIR = join(OPENCODE_GLOBAL_DIR, "plugins")

// brief 38: the cache constants come from loader/core.js — the per-config-root
// namespace — so both paths modules produce identical paths for identical env
// by construction
export const OCM_CACHE_DIR = CACHE_DIR
export const OCM_MARKETPLACES_DIR = MARKETPLACES_DIR
export const OCM_LINKS_DIR = LINKS_DIR
// spec 21: originals displaced by --force takeovers, one copy per <ts>/
export const OCM_DISPLACED_DIR = DISPLACED_DIR
export const OCM_DISPLACED_RECORD_FILE = DISPLACED_RECORD_FILE
// pre-08 global sync stamp, folded into per-marketplace lastSync by the migration
export const OCM_STAMP_FILE = STAMP_FILE
export const OCM_ROOT_CACHE_DIR = ROOT_CACHE_DIR
export const OCM_ROOT_SLUG = ROOT_SLUG

export const OCM_DIR = join(OPENCODE_GLOBAL_DIR, "ocm")
export const OCM_REGISTRY_FILE = join(OCM_DIR, "registry.json")
export const OCM_LEGACY_REGISTRY_FILE = join(OPENCODE_PLUGINS_DIR, "ocm-registry.json")

export const OCM_LOADER_NAME = "ocm-loader.js"
