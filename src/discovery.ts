import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { DiscoveredPlugin } from "./types"

export { discoverMarketplace, discoveryError, nameDisagreement, readManifest } from "../loader/core.js"

export type { DiscoveredPlugin }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readJsonRecord(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (isRecord(parsed)) return parsed
  } catch {}
  return undefined
}

function collectRenames(raw: Record<string, unknown> | undefined, into: Record<string, string | null>): void {
  if (!raw || !isRecord(raw.renames)) return
  for (const [from, to] of Object.entries(raw.renames)) {
    if (typeof to === "string" || to === null) into[from] = to
  }
}

// spec 08: renames come from each discovered plugin's plugin.json, with the
// marketplace manifest winning on conflict
export function readRenames(marketplaceDir: string, plugins: DiscoveredPlugin[]): Record<string, string | null> {
  const renames: Record<string, string | null> = {}
  for (const plugin of plugins) collectRenames(readJsonRecord(join(plugin.dir, "plugin.json")), renames)
  collectRenames(readJsonRecord(join(marketplaceDir, "marketplace.json")), renames)
  return renames
}
