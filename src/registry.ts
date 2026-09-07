import type { MarketplaceEntry, Registry } from "./types"

export function emptyRegistry(): Registry {
  return { version: 1, marketplaces: {} }
}

export function normalizeRegistry(raw: unknown): Registry {
  if (
    raw &&
    typeof raw === "object" &&
    (raw as Registry).version === 1 &&
    typeof (raw as Registry).marketplaces === "object"
  ) {
    return raw as Registry
  }
  return emptyRegistry()
}
