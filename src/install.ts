import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { OCM_LINKS_DIR, OPENCODE_GLOBAL_CONFIG } from "./paths"
import { enabledPlugins, materialize as coreMaterialize, removeLinksFor, setSkillsPath } from "../loader/core.js"
import type { CoreMaterializeReport } from "../loader/core.js"
import type { DiscoveredPlugin, MarketplaceEntry, MarketplacePlugin, Registry } from "./types"

export function skillsLinksDir(marketplaceName: string): string {
  return join(OCM_LINKS_DIR, marketplaceName, "skills")
}

// discovery roots at the subdir when the source was a tree url; git
// operations keep running against the clone root (spec 05)
export function componentRoot(entry: MarketplaceEntry): string {
  return entry.subdir ? join(entry.dir, entry.subdir) : entry.dir
}

export function materializeLinks(
  name: string,
  entry: MarketplaceEntry,
  force = false,
  plugin?: string,
): CoreMaterializeReport {
  const dir = componentRoot(entry)
  return coreMaterialize(name, dir, { enabled: enabledPlugins(entry, dir), force, plugin })
}

export function removeLinks(marketplaceName: string, marketplaceDir: string): void {
  removeLinksFor(marketplaceName, marketplaceDir)
  const warning = setSkillsPath(skillsLinksDir(marketplaceName), false)
  if (warning) console.error(`  warning: ${warning}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// spec 05 ocm remove: every ocm--<plugin>--* mcp key of these plugins goes,
// keeping the mcp object when the user has their own servers left in it
export function removeMcpKeys(pluginNames: string[]): void {
  let raw: string
  try {
    raw = readFileSync(OPENCODE_GLOBAL_CONFIG, "utf8")
  } catch {
    return
  }
  let config: unknown
  try {
    config = JSON.parse(raw)
  } catch {
    console.error(`warning: ${OPENCODE_GLOBAL_CONFIG} is not valid JSON, left untouched`)
    return
  }
  if (!isRecord(config) || !isRecord(config.mcp)) return
  const mcp = config.mcp
  const owned = Object.keys(mcp).filter((key) =>
    pluginNames.some((name) => key === `ocm--${name}` || key.startsWith(`ocm--${name}--`)),
  )
  if (!owned.length) return
  for (const key of owned) delete mcp[key]
  if (!Object.keys(mcp).length) delete config.mcp
  try {
    const tmp = `${OPENCODE_GLOBAL_CONFIG}.tmp`
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`)
    renameSync(tmp, OPENCODE_GLOBAL_CONFIG)
  } catch (err) {
    console.error(`warning: cannot write ${OPENCODE_GLOBAL_CONFIG}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// plugin names are globally unique across marketplaces (spec 04, axis 4):
// the first marketplace to provide a name is the incumbent
export function incumbentMarketplace(registry: Registry, self: string, pluginName: string): string | undefined {
  for (const [name, entry] of Object.entries(registry.marketplaces)) {
    if (name !== self && entry.plugins[pluginName]) return name
  }
}

export function registerPlugins(registry: Registry, name: string, plugins: DiscoveredPlugin[]): void {
  // every caller assigns or verifies the entry in the registry right before this
  const entry = registry.marketplaces[name]!
  const root = componentRoot(entry)
  const updated: Record<string, MarketplacePlugin> = {}
  for (const plugin of plugins) {
    const existing = entry.plugins[plugin.name]
    const incumbent = incumbentMarketplace(registry, name, plugin.name)
    // a colliding name registers disabled; a collision that has cleared
    // registers as if fresh — enabled in auto, and in explicit only when
    // the user installed it while it was colliding. A collision record
    // was never chosen, so installedAt stays null (spec 02)
    let enabled = existing?.collision
      ? entry.mode === "auto" || existing.installedAt !== null
      : existing?.enabled ?? (entry.mode !== "explicit" && plugin.manifest.defaultEnabled !== false)
    if (incumbent) enabled = false
    const record: MarketplacePlugin = {
      source: relative(root, plugin.dir),
      components: plugin.components,
      enabled,
      installedAt: existing?.installedAt ?? (incumbent || entry.mode === "explicit" || !enabled ? null : entry.addedAt),
      version: plugin.manifest.version ?? null,
      manifest: plugin.manifest,
    }
    if (incumbent) record.collision = incumbent
    updated[plugin.name] = record
  }
  entry.plugins = updated
}
