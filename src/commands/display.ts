// Shared rendering helpers of the display commands (spec 25): list and info
// read the sync age and the trust-pending components the same way, so those
// two live here rather than in either verb.
import { componentRoot, executableComponents, pendingComponents } from "../../loader/core.js"
import type { CoreExecutableComponent } from "../../loader/core.js"
import type { MarketplaceEntry } from "../types"

export function age(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  if (Number.isNaN(ms) || ms < 60_000) return "just now"
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

// the components a trust prompt would be about, read from the marketplace
// tree; null when the tree cannot be read, so info still answers from the
// registry alone (spec 09)
export function driftedComponents(entry: MarketplaceEntry): CoreExecutableComponent[] | null {
  try {
    return pendingComponents(entry, executableComponents(componentRoot(entry), entry))
  } catch {
    return null
  }
}

// spec 25 §2: the displays render the loader-recorded pending state
export function pendingExecutables(entry: MarketplaceEntry): CoreExecutableComponent[] {
  return entry.trustPending ? driftedComponents(entry) ?? [] : []
}

// the executables a marketplace ships, read from the tree: the outcome
// derivation leaves never-linked executables out of the record, so the
// blocked markers render from the same list the trust prompt offers
export function shippedExecutables(entry: MarketplaceEntry): Map<string, { plugin: string[]; mcp: string[] }> {
  const shipped = new Map<string, { plugin: string[]; mcp: string[] }>()
  try {
    for (const component of executableComponents(componentRoot(entry), entry)) {
      let list = shipped.get(component.plugin)
      if (!list) shipped.set(component.plugin, (list = { plugin: [], mcp: [] }))
      list[component.kind].push(component.name)
    }
  } catch {}
  return shipped
}
