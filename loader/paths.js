import { createHash } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

export const HOME = homedir()
// opencode's own rule: XDG_CONFIG_HOME replaces $HOME/.config; empty falls back
const CONFIG_HOME = process.env.XDG_CONFIG_HOME || join(HOME, ".config")
export const OPENCODE_DIR = join(CONFIG_HOME, "opencode")
export const OPENCODE_CONFIG_FILE = join(OPENCODE_DIR, "opencode.json")
export const OPENCODE_COMMANDS_DIR = join(OPENCODE_DIR, "commands")
export const OPENCODE_AGENTS_DIR = join(OPENCODE_DIR, "agents")
export const OPENCODE_PLUGINS_DIR = join(OPENCODE_DIR, "plugins")
export const OCM_DIR = join(OPENCODE_DIR, "ocm")
export const CACHE_DIR = join(HOME, ".cache", "ocm")

// brief 38: the cache is namespaced per config root so two roots referencing
// the same marketplace cannot collide. The slug hashes the config root's
// canonical absolute path — realpathSync when the root exists, otherwise the
// realpath of the deepest existing ancestor with the missing tail joined back
// on. macOS temp homes sit behind /var -> /private/var, so a literal resolve()
// fallback yields a different string than realpathSync will once the config
// root is created, splitting one root across two namespaces; the ancestor walk
// keeps the slug stable across the root's creation and folds symlinked
// spellings of the root into one namespace.
function canonicalPath(dir) {
  let cur = dir
  const tail = []
  for (;;) {
    if (existsSync(cur)) return join(realpathSync(cur), ...tail)
    tail.unshift(basename(cur))
    const parent = dirname(cur)
    if (parent === cur) return resolve(dir)
    cur = parent
  }
}

const SLUG_PREFIX = process.env.XDG_CONFIG_HOME ? "xdg" : "default"
export const ROOT_SLUG = `${SLUG_PREFIX}-${createHash("sha256").update(canonicalPath(OPENCODE_DIR)).digest("hex").slice(0, 6)}`
export const ROOTS_DIR = join(CACHE_DIR, "roots")
export const ROOT_CACHE_DIR = join(ROOTS_DIR, ROOT_SLUG)
export const MARKETPLACES_DIR = join(ROOT_CACHE_DIR, "marketplaces")
export const LINKS_DIR = join(ROOT_CACHE_DIR, "links")
export const DISPLACED_DIR = join(ROOT_CACHE_DIR, "displaced")
// spec 21: the displacement index lives beside the tree, not in it — the
// tree holds nothing but <ts>/<absolute-original-path> copies
export const DISPLACED_RECORD_FILE = join(ROOT_CACHE_DIR, "displaced-records.json")
export const REGISTRY_FILE = join(OCM_DIR, "registry.json")
// pre-01 layout; read as a fallback for one release
export const LEGACY_REGISTRY_FILE = join(OPENCODE_PLUGINS_DIR, "ocm-registry.json")
export const STAMP_FILE = join(CACHE_DIR, "last-sync.json")

export const DEFAULT_SYNC_INTERVAL_MS = 60 * 60 * 1000
