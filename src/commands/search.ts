import { DEFAULT_SYNC_INTERVAL_MS, searchPlugins } from "../../loader/core.js"
import type { CoreSearchMatch } from "../../loader/core.js"
import { loadRegistry } from "../registry"
import type { MarketplaceEntry, MarketplacePlugin } from "../types"

export interface SearchOptions {
  enabledOnly?: boolean
  json?: boolean
}

// blocked is a trust state, not an enabled state: executable components of
// an untrusted marketplace stay listed, just not linked (spec 07)
function isBlocked(entry: MarketplaceEntry, record: MarketplacePlugin): boolean {
  if (entry.trust.code === "granted") return false
  return Boolean(record.components.plugin?.length || record.components.mcp?.length)
}

// the names the summary line prints: commands and agents drop their .md
function bareComponents(components: Partial<Record<string, string[]>>): Partial<Record<string, string[]>> {
  const out: Partial<Record<string, string[]>> = {}
  for (const type of ["command", "agent"] as const) {
    if (components[type]?.length) out[type] = components[type]!.map((file) => file.replace(/\.md$/, ""))
  }
  for (const type of ["skill", "plugin", "mcp"] as const) {
    if (components[type]?.length) out[type] = [...components[type]!]
  }
  return out
}

const LABELS: Record<string, string> = { command: "commands", agent: "agents", skill: "skills", plugin: "plugins", mcp: "mcp" }

function componentSummary(components: Partial<Record<string, string[]>>): string {
  return Object.entries(bareComponents(components))
    .map(([type, names]) => `${LABELS[type]}: ${names!.join(", ")}`)
    .join(" · ")
}

// a stale or failed sync is a common cause of a plugin appearing not to exist
function staleSync(entry: MarketplaceEntry): boolean {
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
      blocked: isBlocked(match.entry, match.record),
      matched: match.matched.length ? match.matched : null,
      components: bareComponents(match.record.components),
    })), null, 2))
    return
  }
  for (const match of matches) {
    const head = [
      `${match.plugin}@${match.marketplace}`,
      match.record.version,
      match.record.manifest.category,
      match.record.manifest.description,
    ].filter(Boolean).join("  ")
    const markers = `${!match.record.enabled ? " (disabled)" : ""}${isBlocked(match.entry, match.record) ? " (blocked)" : ""}`
    console.log(`${head}${markers}`)
    if (match.matched.length) {
      for (const component of match.matched) console.log(`  matched: ${component}`)
    } else {
      const summary = componentSummary(match.record.components)
      if (summary) console.log(`  ${summary}`)
    }
  }
}
