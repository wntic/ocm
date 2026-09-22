import { join } from "node:path"
import { marketplaceManifestFile, readJsonRecord } from "./manifest.js"
import { isRecord } from "./registry.js"

function collectRenames(raw, into) {
  if (!raw || !isRecord(raw.renames)) return
  for (const [from, to] of Object.entries(raw.renames)) {
    if (typeof to === "string" || to === null) into[from] = to
  }
}

// spec 08: renames come from each discovered plugin's plugin.json, with the
// marketplace manifest winning on conflict
export function readRenames(marketplaceDir, plugins) {
  const renames = {}
  for (const plugin of plugins) collectRenames(readJsonRecord(join(plugin.dir, "plugin.json")), renames)
  collectRenames(readJsonRecord(marketplaceManifestFile(marketplaceDir)), renames)
  return renames
}

// spec 08 rename chains: walk each source while its target is itself a
// source. A walk that revisits a name is a cycle — reported by the caller
// and ignored, so its keys stay unresolved.
export function resolveChains(renames) {
  const resolved = {}
  const cycles = []
  const reported = new Set()
  for (const start of Object.keys(renames)) {
    if (start in resolved) continue
    const path = []
    const visited = new Set()
    let current = start
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

// brief 40: the alias map a recorded refusal implies — discovered name →
// kept name — shared by the materializer and the trust fingerprint, so both
// see the plugin under the name its record kept
export function refusalAliases(entry) {
  const aliases = new Map()
  if (isRecord(entry?.refusedRenames)) {
    for (const [from, to] of Object.entries(entry.refusedRenames)) aliases.set(to, from)
  }
  return aliases
}
