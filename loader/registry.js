import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { LEGACY_REGISTRY_FILE, MARKETPLACES_DIR, OCM_DIR, REGISTRY_FILE } from "./paths.js"

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

// Mutating commands report the v1 → v2 upgrade when they save the migrated
// registry, so this load also says what version was on disk.
export function loadRegistryForWrite() {
  // pre-02 layout; read as a fallback, never written
  const file = existsSync(REGISTRY_FILE) ? REGISTRY_FILE : LEGACY_REGISTRY_FILE
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"))
    return { registry: normalizeRegistry(raw), wasV1: isRecord(raw) && raw.version === 1 }
  } catch {
    return { registry: { version: 2, marketplaces: {} }, wasV1: false }
  }
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
  return `${JSON.stringify(canonicalObject({ ...registry, version: 2, marketplaces }, ["version", "marketplaces"]), null, 2)}\n`
}

export function saveRegistry(registry) {
  mkdirSync(OCM_DIR, { recursive: true })
  const tmp = `${REGISTRY_FILE}.tmp`
  try {
    writeFileSync(tmp, serializeRegistry(registry))
    renameSync(tmp, REGISTRY_FILE)
  } catch (err) {
    throw new Error(`cannot write ${REGISTRY_FILE}: ${err instanceof Error ? err.message : String(err)}`)
  }
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
    const tmp = `${REGISTRY_FILE}.tmp`
    writeFileSync(tmp, JSON.stringify(raw, null, 2))
    renameSync(tmp, REGISTRY_FILE)
  } catch {}
}
