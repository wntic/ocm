import {
  loadRegistryForWrite as coreLoadRegistryForWrite,
  normalizeRegistry as coreNormalizeRegistry,
  readRegistry,
  saveRegistry as coreSaveRegistry,
} from "../loader/core.js"
import type { Registry } from "./types"

// thin facade over the core registry: the CLI keeps its typed surface, the
// canonical atomic save lives in the core (spec 10a)
export function loadRegistry(): Registry {
  return readRegistry()
}

export function loadRegistryForWrite(): { registry: Registry; wasV1: boolean } {
  return coreLoadRegistryForWrite()
}

export function normalizeRegistry(raw: unknown): Registry {
  return coreNormalizeRegistry(raw)
}

export function saveRegistry(registry: Registry): void {
  coreSaveRegistry(registry)
}
