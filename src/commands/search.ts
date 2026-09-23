import { existsSync } from "node:fs"
import { DEFAULT_SYNC_INTERVAL_MS, searchPlugins } from "../../loader/core.js"
import type { CoreSearchMatch } from "../../loader/core.js"
import { loadRegistry } from "../registry"
import type { MarketplaceEntry, MarketplacePlugin } from "../types"
import { bareComponents, componentSummary, shippedExecutables, wrapLine, wrapping } from "./display"

export interface SearchOptions {
  enabledOnly?: boolean
  json?: boolean
}

// blocked is a trust state, not an enabled state: executable components of
// an untrusted marketplace stay listed, just not linked (spec 07). The
// record drops executables that never linked, so the tree is the source
function isBlocked(entry: MarketplaceEntry, plugin: string, record: MarketplacePlugin): boolean {
  if (entry.trust.code === "granted") return false
  if (record.components.plugin?.length || record.components.mcp?.length) return true
  return shippedExecutables(entry).has(plugin)
}

// a stale or failed sync is a common cause of a plugin appearing not to exist
function staleSync(entry: MarketplaceEntry): boolean {
  // a local marketplace has nothing to sync: a null lastSync is its steady
  // state, not a failure — only a missing directory is suspect (spec 17)
  if (entry.local && !entry.lastSync) return !existsSync(entry.dir)
  const sync = entry.lastSync
  if (!sync || !sync.ok) return true
  const at = Date.parse(sync.at)
  if (Number.isNaN(at)) return true
  return Date.now() - at >= (entry.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS)
}

export function search(queryArg: string, options: SearchOptions = {}): void {
  const matches = searchPlugins(queryArg, { enabledOnly: options.enabledOnly })
  if (!matches.length) {
    const registry = loadRegistry()
    const hint = Object.values(registry.marketplaces).some(staleSync)
      ? "\n  a marketplace sync is stale or failed; run ocm update"
      : ""
    throw new Error(`no matches for "${queryArg}"${hint}`)
  }
  if (options.json) {
    console.log(JSON.stringify(matches.map((match: CoreSearchMatch) => ({
      plugin: match.plugin,
      marketplace: match.marketplace,
      version: match.record.version,
      category: match.record.manifest.category ?? null,
      description: match.record.manifest.description ?? null,
      enabled: match.record.enabled,
      blocked: isBlocked(match.entry, match.plugin, match.record),
      matched: match.matched.length ? match.matched : null,
      components: bareComponents(match.record.components),
    })), null, 2))
    return
  }
  for (const match of matches) {
    const headParts = [
      `${match.plugin}@${match.marketplace}`,
      match.record.version,
      match.record.manifest.category,
    ]
    const description = match.record.manifest.description
    const markers = `${!match.record.enabled ? " (disabled)" : ""}${isBlocked(match.entry, match.plugin, match.record) ? " (blocked)" : ""}`
    if (wrapping()) {
      // brief 36 §1: the description wraps beneath the head line, indented two
      console.log(`${headParts.filter(Boolean).join("  ")}${markers}`)
      if (description) for (const line of wrapLine(2, description.split(" "))) console.log(line)
    } else {
      console.log(`${[...headParts, description].filter(Boolean).join("  ")}${markers}`)
    }
    if (match.matched.length) {
      for (const component of match.matched) console.log(`  matched: ${component}`)
    } else {
      const summary = componentSummary(match.record.components)
      if (summary) console.log(`  ${summary}`)
    }
  }
}
