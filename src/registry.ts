import {
  loadRegistryForWrite as coreLoadRegistryForWrite,
  normalizeRegistry as coreNormalizeRegistry,
  parseRegistryStrict,
  saveRegistry as coreSaveRegistry,
} from "../loader/core.js"
import type { Registry } from "./types"

// thin facade over the core registry: the CLI keeps its typed surface, the
// canonical atomic save lives in the core (spec 10a)
// spec 27 §5 — the CLI surfaces a corrupt registry instead of reporting an
// empty one; the loader's tolerant readRegistry keeps its behaviour so
// opencode's startup never breaks
export function loadRegistry(): Registry {
  return coreNormalizeRegistry(parseRegistryStrict())
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
