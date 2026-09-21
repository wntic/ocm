import { componentRoot, enabledPlugins, materialize as coreMaterialize } from "../loader/core.js"
import type { CoreMaterializeReport } from "../loader/core.js"
import type { MarketplaceEntry } from "./types"

export { componentRoot, deriveComponents, incumbentMarketplace, registerPlugins, removeMcpKeys } from "../loader/core.js"

export function materializeLinks(
  name: string,
  entry: MarketplaceEntry,
  force = false,
  changed?: Set<string> | null,
  aliases?: Map<string, string>,
): CoreMaterializeReport {
  const dir = componentRoot(entry)
  return coreMaterialize(name, dir, {
    enabled: enabledPlugins(entry, dir),
    force,
    changed: changed ?? undefined,
    aliases: aliases ?? undefined,
  })
}
