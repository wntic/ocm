import { incumbentMarketplace } from "./install"
import type { DiscoveredPlugin, MarketplaceEntry, MarketplacePlugin, Registry } from "./types"

export interface RenameResult {
  renamed: { from: string; to: string }[]
  removed: string[]
  refused: { from: string; to: string; incumbent: string }[]
  // rename targets refused for colliding with another marketplace's plugin
  // name: excluded from registration so the incumbent keeps the name
  excluded: Set<string>
  // records a refusal kept at their old name, re-added after registration
  kept: Record<string, MarketplacePlugin>
}

// spec 08 rename chains: walk each source while its target is itself a
// source. A walk that revisits a name is a cycle — reported by the caller
// and ignored, so its keys stay unresolved.
export function resolveChains(renames: Record<string, string | null>): {
  resolved: Record<string, string | null>
  cycles: string[][]
} {
  const resolved: Record<string, string | null> = {}
  const cycles: string[][] = []
  const reported = new Set<string>()
  for (const start of Object.keys(renames)) {
    if (start in resolved) continue
    const path: string[] = []
    const visited = new Set<string>()
    let current: string | null = start
    let cyclic = false
    while (current !== null && current in renames) {
      if (visited.has(current)) {
        const cycle = path.slice(path.indexOf(current))
        const id = [...cycle].sort().join("\u0000")
        if (!reported.has(id)) {
          reported.add(id)
          cycles.push(cycle)
        }
        cyclic = true
        break
      }
      visited.add(current)
      path.push(current)
      current = renames[current] ?? null
    }
    if (!cyclic) for (const key of path) resolved[key] = current
  }
  return { resolved, cycles }
}

// applied after discovery, before registration: migrate records along the
// resolved renames, drop removals, refuse cross-marketplace collisions
export function applyRenames(
  registry: Registry,
  name: string,
  entry: MarketplaceEntry,
  discovered: Map<string, DiscoveredPlugin>,
  resolved: Record<string, string | null>,
): RenameResult {
  const result: RenameResult = { renamed: [], removed: [], refused: [], excluded: new Set(), kept: {} }
  for (const [from, to] of Object.entries(resolved)) {
    const record = entry.plugins[from]
    if (!record) continue
    if (to === null) {
      delete entry.plugins[from]
      result.removed.push(from)
      continue
    }
    const incumbent = incumbentMarketplace(registry, name, to)
    if (incumbent) {
      result.refused.push({ from, to, incumbent })
      result.excluded.add(to)
      result.kept[from] = record
      continue
    }
    // the target is not shipped (yet): the record dangles rather than moves
    if (!discovered.has(to)) continue
    entry.plugins[to] = record
    delete entry.plugins[from]
    result.renamed.push({ from, to })
  }
  return result
}
