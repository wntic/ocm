import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { writeJsonAtomic } from "./atomic.js"
import { CACHE_DIR, LEGACY_REGISTRY_FILE, MARKETPLACES_DIR, OPENCODE_DIR, REGISTRY_FILE } from "./paths.js"

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function relativeSource(dir, source) {
  if (typeof dir === "string" && typeof source === "string" && source.startsWith(dir + "/")) {
    return source.slice(dir.length + 1)
  }
  return source
}

// read-only mirror of normalizeRegistry in src/registry.ts, so a core that
// predates a schema change still reads v1 and v2 registries uniformly
export function normalizeRegistry(raw) {
  if (!isRecord(raw) || !isRecord(raw.marketplaces)) return { version: 2, marketplaces: {} }
  if (raw.version === 2) return raw
  if (raw.version !== 1) return { version: 2, marketplaces: {} }
  const marketplaces = {}
  for (const [name, entry] of Object.entries(raw.marketplaces)) {
    if (!isRecord(entry)) continue
    const dir = typeof entry.dir === "string" ? entry.dir : ""
    const addedAt = typeof entry.addedAt === "string" ? entry.addedAt : ""
    const plugins = {}
    if (isRecord(entry.plugins)) {
      for (const [pluginName, plugin] of Object.entries(entry.plugins)) {
        if (!isRecord(plugin)) continue
        const source = typeof plugin.source === "string" ? plugin.source : ""
        plugins[pluginName] = {
          source: relativeSource(dir, source),
          components: isRecord(plugin.components) ? plugin.components : {},
          enabled: true,
          installedAt: addedAt,
          version: null,
          manifest: {},
        }
      }
    }
    marketplaces[name] = {
      url: typeof entry.url === "string" ? entry.url : "",
      dir,
      local: !dir.startsWith(MARKETPLACES_DIR),
      addedAt,
      mode: "auto",
      ref: null,
      revision: null,
      syncIntervalMs: null,
      trust: { code: "none" },
      lastSync: null,
      plugins,
    }
  }
  return { version: 2, marketplaces }
}

export function readRegistry() {
  if (existsSync(REGISTRY_FILE)) {
    try {
      return normalizeRegistry(JSON.parse(readFileSync(REGISTRY_FILE, "utf8")))
    } catch {}
    return { version: 2, marketplaces: {} }
  }
  try {
    return normalizeRegistry(JSON.parse(readFileSync(LEGACY_REGISTRY_FILE, "utf8")))
  } catch {}
  return { version: 2, marketplaces: {} }
}

// spec 27 §4: the running ocm's own version. An installed loader has no
// package.json beside it — the version comment src/loader.ts appends to every
// installed file is its only source; the repo/npm layout falls back to the
// package.json beside loader/
export function ocmSelfVersion() {
  try {
    const stamped = readFileSync(new URL(import.meta.url), "utf8").match(/^\/\/ ocm-version: (\S+)/m)
    if (stamped) return stamped[1]
  } catch {}
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    if (isRecord(pkg) && typeof pkg.version === "string") return pkg.version
  } catch {}
  return null
}

// spec 27 §4: numeric compare of the first three dot-separated segments,
// missing ones counting as 0; the field is always written by ocm itself, so
// no prerelease handling
export function versionCompare(a, b) {
  const as = a.split(".")
  const bs = b.split(".")
  for (let i = 0; i < 3; i++) {
    const x = Number(as[i]) || 0
    const y = Number(bs[i]) || 0
    if (x !== y) return x - y
  }
  return 0
}

// spec 27 §4: the version of the ocm that last wrote the registry; a missing
// file or field is a pre-0.6.0 home, not a newer one
export function registryWriterVersion() {
  try {
    const raw = JSON.parse(readFileSync(REGISTRY_FILE, "utf8"))
    if (isRecord(raw) && typeof raw.ocmVersion === "string") return raw.ocmVersion
  } catch {}
  return null
}

// spec 27 §5: a registry that exists but does not parse, or is not a
// version 1|2 object, is corruption — the CLI reports it instead of reading
// an empty registry and saving over the file. Absent is a fresh install.
export function parseRegistryStrict() {
  // pre-02 layout; read as a fallback, never written
  const file = existsSync(REGISTRY_FILE) ? REGISTRY_FILE : LEGACY_REGISTRY_FILE
  let raw
  try {
    raw = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    if (!existsSync(file)) return null
    raw = null
  }
  if (!isRecord(raw) || (raw.version !== 1 && raw.version !== 2)) {
    throw new Error(
      `error: registry at ${file} is not valid JSON — ocm will not overwrite it\n` +
        "  inspect or move the file, then run ocm doctor; to start over, remove it and re-add your marketplaces",
    )
  }
  return raw
}

// Mutating commands report the v1 → v2 upgrade when they save the migrated
// registry, so this load also says what version was on disk.
export function loadRegistryForWrite() {
  const raw = parseRegistryStrict()
  const loaded = raw === null
    ? { registry: { version: 2, marketplaces: {} }, wasV1: false }
    : { registry: normalizeRegistry(raw), wasV1: raw.version === 1 }
  // spec 27 §4: the stamp lives on the load-for-write path, not in
  // saveRegistry, so a read-path save of a read-path load stays byte-identical
  const self = ocmSelfVersion()
  if (self) loaded.registry.ocmVersion = self
  return loaded
}

// Canonical key order: a no-op save must be byte-identical, and unknown
// fields ride after the known ones so they survive round-trips.
const MARKETPLACE_KEYS = [
  "url", "dir", "local", "addedAt", "mode", "ref", "subdir", "revision",
  "syncIntervalMs", "trust", "lastSync", "plugins",
]
const PLUGIN_KEYS = ["source", "components", "enabled", "collision", "installedAt", "version", "manifest"]

function canonicalObject(source, keys) {
  const out = {}
  for (const key of keys) if (key in source) out[key] = source[key]
  for (const key of Object.keys(source)) if (!keys.includes(key)) out[key] = source[key]
  return out
}

function serializeRegistry(registry) {
  const marketplaces = {}
  for (const [name, entry] of Object.entries(registry.marketplaces ?? {})) {
    const plugins = {}
    for (const [pluginName, plugin] of Object.entries(entry.plugins ?? {})) {
      plugins[pluginName] = canonicalObject(plugin, PLUGIN_KEYS)
    }
    marketplaces[name] = canonicalObject({ ...entry, plugins }, MARKETPLACE_KEYS)
  }
  return `${JSON.stringify(canonicalObject({ ...registry, version: 2, marketplaces }, ["version", "ocmVersion", "marketplaces"]), null, 2)}\n`
}

// brief 28 §2.1: every registry write breadcrumbs the config root it wrote
// under. The cache stays anchored to $HOME while the config root follows
// XDG_CONFIG_HOME, so this file is what makes a stranded install detectable
// in both directions. Best-effort: a breadcrumb that cannot be written must
// not fail the mutation it accompanies.
const ROOTS_FILE = join(CACHE_DIR, "roots.json")

function recordConfigRoot() {
  const root = resolve(OPENCODE_DIR)
  let roots = []
  try {
    const raw = JSON.parse(readFileSync(ROOTS_FILE, "utf8"))
    if (isRecord(raw) && Array.isArray(raw.roots)) roots = raw.roots.filter((r) => typeof r === "string")
  } catch {}
  if (roots.includes(root)) return
  try {
    writeJsonAtomic(ROOTS_FILE, `${JSON.stringify({ roots: [...roots, root] }, null, 2)}\n`)
  } catch {}
}

export function saveRegistry(registry) {
  try {
    writeJsonAtomic(REGISTRY_FILE, serializeRegistry(registry))
  } catch (err) {
    throw new Error(`cannot write ${REGISTRY_FILE}: ${err instanceof Error ? err.message : String(err)}`)
  }
  recordConfigRoot()
}

// spec 11: the variables the loader's shell.env hook exports. Every added
// marketplace root is available under both families — OCM_PLUGIN_ROOT for
// bodies authored for opencode, CLAUDE_PLUGIN_ROOT as an alias so a Claude
// Code command file runs unmodified. The flat pair exists only when one
// marketplace is added: a flat name cannot say which of several roots it
// means, and an unset variable fails louder than a silently wrong one.
export function pluginRootEnv() {
  const entries = Object.entries(readRegistry().marketplaces ?? {}).filter(
    ([, entry]) => entry && typeof entry.dir === "string" && entry.dir,
  )
  const roots = entries.map(([name, entry]) => ({
    suffix: name.replaceAll("-", "_").toUpperCase(),
    root: entry.subdir ? join(entry.dir, entry.subdir) : entry.dir,
  }))
  const env = {}
  for (const { suffix, root } of roots) {
    env[`OCM_PLUGIN_ROOT_${suffix}`] = root
    env[`CLAUDE_PLUGIN_ROOT_${suffix}`] = root
  }
  if (roots.length === 1) {
    env.OCM_PLUGIN_ROOT = roots[0].root
    env.CLAUDE_PLUGIN_ROOT = roots[0].root
  }
  return env
}

// the loader's only registry write: flag that a marketplace's executable
// components changed since its grant. The raw file is preserved verbatim
// outside the flag — never migrated — and an existing flag is left alone.
export function markTrustPending(name) {
  try {
    const raw = JSON.parse(readFileSync(REGISTRY_FILE, "utf8"))
    if (!isRecord(raw) || !isRecord(raw.marketplaces) || !isRecord(raw.marketplaces[name])) return
    const entry = raw.marketplaces[name]
    if (entry.trustPending === true) return
    entry.trustPending = true
    writeJsonAtomic(REGISTRY_FILE, JSON.stringify(raw, null, 2))
  } catch {}
}
