import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { OCM_DIR, OCM_LEGACY_REGISTRY_FILE, OCM_MARKETPLACES_DIR, OCM_REGISTRY_FILE } from "./paths"
import type { MarketplaceEntry, MarketplacePlugin, Registry } from "./types"

// Canonical key order: a no-op save must be byte-identical, and unknown
// fields ride after the known ones so they survive round-trips.
const MARKETPLACE_KEYS = [
  "url", "dir", "local", "addedAt", "mode", "ref", "subdir", "revision",
  "syncIntervalMs", "trust", "lastSync", "plugins",
]
const PLUGIN_KEYS = ["source", "components", "enabled", "collision", "installedAt", "version", "manifest"]

export function emptyRegistry(): Registry {
  return { version: 2, marketplaces: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function relativeSource(dir: string, source: string): string {
  if (dir && source.startsWith(`${dir}/`)) return source.slice(dir.length + 1)
  return source
}

export function normalizeRegistry(raw: unknown): Registry {
  if (!isRecord(raw) || !isRecord(raw.marketplaces)) return emptyRegistry()
  if (raw.version === 2) return raw as unknown as Registry
  if (raw.version === 1) return migrateV1(raw.marketplaces)
  return emptyRegistry()
}

function migrateV1(rawMarketplaces: Record<string, unknown>): Registry {
  const marketplaces: Record<string, MarketplaceEntry> = {}
  for (const [name, rawEntry] of Object.entries(rawMarketplaces)) {
    if (!isRecord(rawEntry)) continue
    const dir = typeof rawEntry.dir === "string" ? rawEntry.dir : ""
    const addedAt = typeof rawEntry.addedAt === "string" ? rawEntry.addedAt : ""
    const plugins: Record<string, MarketplacePlugin> = {}
    if (isRecord(rawEntry.plugins)) {
      for (const [pluginName, rawPlugin] of Object.entries(rawEntry.plugins)) {
        if (!isRecord(rawPlugin)) continue
        const source = typeof rawPlugin.source === "string" ? rawPlugin.source : ""
        plugins[pluginName] = {
          source: relativeSource(dir, source),
          components: isRecord(rawPlugin.components)
            ? (rawPlugin.components as unknown as MarketplacePlugin["components"])
            : {},
          enabled: true,
          installedAt: addedAt,
          version: null,
          manifest: {},
        }
      }
    }
    marketplaces[name] = {
      url: typeof rawEntry.url === "string" ? rawEntry.url : "",
      dir,
      local: !dir.startsWith(OCM_MARKETPLACES_DIR),
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

export function loadRegistry(): Registry {
  return loadRegistryForWrite().registry
}

// Mutating commands report the v1 → v2 upgrade when they save the migrated
// registry, so this load also says what version was on disk.
export function loadRegistryForWrite(): { registry: Registry; wasV1: boolean } {
  // pre-02 layout; read as a fallback, never written
  const file = existsSync(OCM_REGISTRY_FILE) ? OCM_REGISTRY_FILE : OCM_LEGACY_REGISTRY_FILE
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"))
    return { registry: normalizeRegistry(raw), wasV1: isRecord(raw) && raw.version === 1 }
  } catch {
    return { registry: emptyRegistry(), wasV1: false }
  }
}

function canonicalObject(source: object, keys: string[]): Record<string, unknown> {
  const record = source as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of keys) if (key in record) out[key] = record[key]
  for (const key of Object.keys(record)) if (!keys.includes(key)) out[key] = record[key]
  return out
}

function serializeRegistry(registry: Registry): string {
  const marketplaces: Record<string, unknown> = {}
  for (const [name, entry] of Object.entries(registry.marketplaces)) {
    const plugins: Record<string, unknown> = {}
    for (const [pluginName, plugin] of Object.entries(entry.plugins)) {
      plugins[pluginName] = canonicalObject(plugin, PLUGIN_KEYS)
    }
    marketplaces[name] = canonicalObject({ ...entry, plugins }, MARKETPLACE_KEYS)
  }
  return `${JSON.stringify({ version: 2, marketplaces }, null, 2)}\n`
}

export function saveRegistry(registry: Registry): void {
  mkdirSync(OCM_DIR, { recursive: true })
  const tmp = `${OCM_REGISTRY_FILE}.tmp`
  try {
    writeFileSync(tmp, serializeRegistry(registry))
    renameSync(tmp, OCM_REGISTRY_FILE)
  } catch (err) {
    throw new Error(`cannot write ${OCM_REGISTRY_FILE}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
