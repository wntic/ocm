import { DEFAULT_SYNC_INTERVAL_MS } from "../../loader/core.js"
import { loadRegistry } from "../registry"
import type { MarketplaceEntry, MarketplacePlugin, Registry } from "../types"

export interface SearchOptions {
  enabledOnly?: boolean
  json?: boolean
}

interface Match {
  marketplace: string
  plugin: string
  entry: MarketplaceEntry
  record: MarketplacePlugin
  rank: number
  matched: string[]
}

// spec 09 ranking, first rule that matches wins; the marketplace name is a
// match surface ranked below every plugin-level rule
function rankOf(
  query: string,
  plugin: string,
  record: MarketplacePlugin,
  marketplace: string,
): { rank: number; matched: string[] } | null {
  const name = plugin.toLowerCase()
  if (name === query) return { rank: 0, matched: [] }
  if (name.startsWith(query)) return { rank: 1, matched: [] }
  if (name.includes(query)) return { rank: 2, matched: [] }
  const manifest = record.manifest
  const words = [...(manifest.tags ?? []), ...(manifest.keywords ?? [])].map((word) => word.toLowerCase())
  const category = manifest.category?.toLowerCase()
  if (category === query || words.includes(query)) return { rank: 3, matched: [] }
  if (
    (manifest.description?.toLowerCase().includes(query) ?? false) ||
    category?.includes(query) ||
    words.some((word) => word.includes(query))
  ) {
    return { rank: 4, matched: [] }
  }
  const matched: string[] = []
  for (const file of record.components.command ?? []) {
    const name = file.replace(/\.md$/, "")
    if (name.toLowerCase().includes(query)) matched.push(`commands/${name}`)
  }
  for (const file of record.components.agent ?? []) {
    const name = file.replace(/\.md$/, "")
    if (name.toLowerCase().includes(query)) matched.push(`agents/${name}`)
  }
  for (const rel of record.components.skill ?? []) {
    if (rel.toLowerCase().includes(query)) matched.push(`skills/${rel}`)
  }
  if (matched.length) return { rank: 5, matched }
  if (marketplace.toLowerCase().includes(query)) return { rank: 6, matched: [] }
  return null
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
  const query = queryArg.toLowerCase()
  const registry = loadRegistry()
  const matches: Match[] = []
  for (const [marketplace, entry] of Object.entries(registry.marketplaces)) {
    for (const [plugin, record] of Object.entries(entry.plugins)) {
      if (options.enabledOnly && !record.enabled) continue
      const found = rankOf(query, plugin, record, marketplace)
      if (found) matches.push({ marketplace, plugin, entry, record, rank: found.rank, matched: found.matched })
    }
  }
  if (!matches.length) {
    const hint = Object.values(registry.marketplaces).some(staleSync)
      ? "\n  a marketplace sync is stale or failed; run ocm update"
      : ""
    throw new Error(`no matches for "${queryArg}"${hint}`)
  }
  // ties break alphabetically by plugin@marketplace, so output is stable
  const key = (match: Match) => `${match.plugin}@${match.marketplace}`
  matches.sort((a, b) => a.rank - b.rank || (key(a) < key(b) ? -1 : 1))
  if (options.json) {
    console.log(JSON.stringify(matches.map((match) => ({
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
