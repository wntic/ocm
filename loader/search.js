import { readRegistry } from "./registry.js"

// spec 09 ranking, first rule that matches wins; the marketplace name is a
// match surface ranked below every plugin-level rule
function rankOf(query, plugin, record, marketplace) {
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
  const matched = []
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

// spec 09: every match carries its registry records so the CLI renders
// without re-reading the registry; ties break alphabetically by
// plugin@marketplace so output is stable
export function searchPlugins(queryArg, options = {}) {
  const query = queryArg.toLowerCase()
  const registry = readRegistry()
  const matches = []
  for (const [marketplace, entry] of Object.entries(registry.marketplaces)) {
    for (const [plugin, record] of Object.entries(entry.plugins)) {
      if (options.enabledOnly && !record.enabled) continue
      const found = rankOf(query, plugin, record, marketplace)
      if (found) matches.push({ marketplace, plugin, entry, record, rank: found.rank, matched: found.matched })
    }
  }
  const key = (match) => `${match.plugin}@${match.marketplace}`
  matches.sort((a, b) => a.rank - b.rank || (key(a) < key(b) ? -1 : 1))
  return matches
}
